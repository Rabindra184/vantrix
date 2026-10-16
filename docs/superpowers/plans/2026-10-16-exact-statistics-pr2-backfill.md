# Exact statistics, PR 2: recompute existing runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every existing run whose statistics are estimated is recomputed exactly from its stored raw log, its SLA verdict re-judged with its frozen rules, and any change recorded and shown; runs that cannot be recomputed are labelled as estimated.

**Architecture:** A `RecomputeService` in `apps/worker` reuses the pipeline's log reader and the PR 1 engine, holds the same per-run advisory lock as ingest, and in ONE transaction deletes the run's metric and assertion rows, writes exact ones, re-evaluates the run's stored rule snapshots, records verdict changes and flips `run.stats_method` to `exact-v1`. A dedicated BullMQ `recompute` queue (concurrency 1, yielding to ingest) is filled at worker start and every ten minutes; `pnpm recompute` runs the same service from a shell. The API exposes verdict changes on the run identity and backfill progress to admins; the web marks estimated percentile figures with ≈ and shows a changed verdict.

**Tech Stack:** TypeScript, Node 22, PostgreSQL (Prisma migrations + raw `pg`), BullMQ/Redis, NestJS, React + TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-exact-statistics-design.md` — §5 Backfill, §3 `run_verdict_change`, §7 (≈ labels, verdict-changed line, admin progress). PR 1 is merged (`#277`).

## Global Constraints

- Node 22 (`nvm use`) in every command; read each command's own exit code, never a pipeline's.
- Recompute is per run, ONE transaction: delete its metric rows (all metric tables), insert the exact ones, set `stats_method = 'exact-v1'`. Idempotent; a run already exact is skipped.
- Preserved on a recomputed run: identity, run number, note, test, lifecycle timestamps (`started_at`, `tool_started_at`, `ingested_at`, `parsing_started_at`, …), logs, `status`, `simulation`, `description`.
- SLA verdicts are re-evaluated with each run's frozen `rule_snapshot` (from `run_assertion`), never the project's current rules. A changed verdict writes `run_verdict_change` and is shown on the run.
- A run without a usable raw log stays `estimated`, is labelled as such, and is not retried.
- Selection of work is by STORED FORMAT as well as the label: a run is a candidate when `stats_method = 'estimated'` OR any of its `run_stat` rows has `sketch IS NOT NULL` or `histogram_kind IS DISTINCT FROM 'sparse-ms-v2'` (PR 1 ruling: `stats_method` is set at INSERT, so an old worker during a rolling deploy can write v1 rows under `exact-v1`).
- Queue: `recompute`, concurrency 1, lower priority than ingest.
- Operator command: `pnpm recompute [--project <slug>] [--run <id>]`.
- Admins see progress ("Recomputing exact statistics: 412 of 1,030 runs") only while work remains.
- Clean-UI copy rules: marks and labels on screen, detail behind one ⓘ; no description line under a card or section title.
- Integration and e2e run on a SCRATCH database and Redis index, never the developer database `perfportal`.
- Every new route declares exactly one access decorator, is in `ACCESS_BY_ROUTE`, documented in OpenAPI with its role sentence, and parsed through its contract schema.
- Every new run-identity field goes through BOTH builders via `RunsService.lifecycleOf` and is `.optional()` on the contract.
- Commits: `git commit -F - <<'MSG'`, name paths, never `git add -A`; no backticks in SQL comments; no `prisma format`; rebuild workspace packages (`tsc -b --force` after deleting `.tsbuildinfo`) before integration runs that cross a package boundary.

## Review Focus

1. A run whose raw object is gone, or whose `bundle_sha256` is `''` (a zero-byte live close, an abandoned stream with no whole record) — expect: recorded as `raw_log_missing`, stays `estimated`, never retried, never thrown into an endless retry loop. Pinned in Task 3.
2. A run being ingested or live-folded at the moment recompute picks it — expect: recompute does not wait or race; it reports `locked` and the job is retried later. Pinned in Task 3.
3. A crash after the deletes but before COMMIT — expect: the legacy rows are intact and the run is still `estimated`. Pinned in Task 3.
4. A run whose stored assertion had `actual_value` null (not applicable) and becomes applicable, or a rule snapshot naming a request that no longer exists — expect: re-evaluated faithfully, a change recorded only when the OUTCOME changed. Pinned in Task 3.
5. A deleted run (cascade) or a run deleted mid-recompute — expect: the job ends quietly (`gone`), no orphan rows in the FK-free metric tables. Pinned in Task 3.

---

### Task 1: Schema — `run_verdict_change`, recompute bookkeeping, deletes and candidate queries

**Files:**
- Create: `packages/persistence/prisma/migrations/20261016120000_exact_statistics_backfill/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (model `Run`: two fields; new model `RunVerdictChange`)
- Modify: `packages/persistence/src/metrics/write.ts` (add `deleteForRun`)
- Create: `packages/persistence/src/repositories/recompute.ts`; export from `packages/persistence/src/index.ts`
- Modify: `packages/persistence/src/repositories/run.ts` (`RunRecord.recomputeError`, `RunRecord.recomputedAt`, mapping, SQL selects)
- Test: `packages/persistence/test/recompute.integration.test.ts` (new)

**Interfaces:**
- Produces:
  - `MetricWriter#deleteForRun(client: pg.PoolClient, ctx: { runId: string; runStartedOn: Date }): Promise<void>` — deletes from `run_stat`, `run_error` (by `run_id`) and `run_series_bucket`, `run_user_bucket`, `run_error_bucket` (by `run_started_on = $2 AND run_id = $1`), and from `run_assertion` (by `run_id`).
  - `export type RecomputeError = 'raw_log_missing' | 'checksum_mismatch' | 'parse_failed';`
  - `export interface RecomputeFilter { orgId?: string; projectSlug?: string; runId?: string }`
  - `class RecomputeRepository { constructor(pool: pg.Pool); candidates(filter: RecomputeFilter, limit: number): Promise<string[]>; progress(orgId: string): Promise<{ total: number; remaining: number; failed: number }>; markFailed(runId: string, reason: RecomputeError): Promise<void>; verdictChanges(runId: string): Promise<VerdictChangeRecord[]> }`
  - `export interface VerdictChangeRecord { ruleSnapshot: unknown; oldOutcome: string; newOutcome: string; oldValue: number | null; newValue: number | null; oldVerdict: string; newVerdict: string; changedAt: Date }`
  - `export const CANDIDATE_PREDICATE_SQL: string` — the one definition of "this run still needs recomputing", reused by `candidates` and `progress`.
  - `RunRecord.recomputeError: RecomputeError | null`, `RunRecord.recomputedAt: Date | null`.

- [ ] **Step 1: Write the migration**

```sql
-- Exact statistics PR 2: recompute bookkeeping and verdict changes.
-- No backticks in comments: Prisma runs this file as-is, and the repo's
-- SQL also lives inside template literals elsewhere.

ALTER TABLE run ADD COLUMN recompute_error text NULL;
ALTER TABLE run ADD CONSTRAINT run_recompute_error_check
  CHECK (recompute_error IN ('raw_log_missing', 'checksum_mismatch', 'parse_failed'));
ALTER TABLE run ADD COLUMN recomputed_at timestamptz NULL;

-- A run with no statistics rows has no estimated figure to show. Labelling
-- it exact is vacuous and keeps the backfill's progress count honest.
UPDATE run SET stats_method = 'exact-v1'
 WHERE stats_method = 'estimated'
   AND NOT EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = run.id);

CREATE TABLE run_verdict_change (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_snapshot jsonb NOT NULL,
  old_outcome text NOT NULL,
  new_outcome text NOT NULL,
  old_value double precision NULL,
  new_value double precision NULL,
  old_verdict text NOT NULL,
  new_verdict text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_verdict_change_run_id_idx ON run_verdict_change (run_id);
```

Mirror it in `schema.prisma` by hand (do NOT run `prisma format`): on `Run`, `recomputeError String? @map("recompute_error")` and `recomputedAt DateTime? @map("recomputed_at") @db.Timestamptz(3)`; a `RunVerdictChange` model mapped to `run_verdict_change` with the columns above, relation to `Run` with `onDelete: Cascade`, and `@@index([runId])`. Run `infra/test/schema-matches-migrations.sh` (it must exit 0) — the schema must describe what the migration built.

- [ ] **Step 2: Write the failing integration tests** (`packages/persistence/test/recompute.integration.test.ts`)

Use the existing persistence integration helpers (`packages/persistence/test/*.integration.test.ts` set up org/project/run with `prisma` and `createPool`; copy the TRUNCATE-and-seed shape from `metrics.integration.test.ts`). Cases:

```ts
it('selects a run labelled estimated, and one labelled exact whose rows are still legacy', async () => {
  const a = await seedRunWithStatRow({ statsMethod: 'estimated', sketch: true, histogramKind: 'sparse-ms-v1' });
  const b = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: true, histogramKind: 'sparse-ms-v1' });
  const c = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
  const ids = await new RecomputeRepository(pool).candidates({}, 100);
  expect(ids.sort()).toEqual([a, b].sort());
  expect(ids).not.toContain(c);
});

it('skips a failed run, a run with no stat rows and a run marked unrecoverable', async () => {
  const failed = await seedRunWithStatRow({ statsMethod: 'estimated', status: 'failed' });
  const noRows = await seedRun({ statsMethod: 'estimated', status: 'complete' }); // no run_stat row
  const lost = await seedRunWithStatRow({ statsMethod: 'estimated' });
  await new RecomputeRepository(pool).markFailed(lost, 'raw_log_missing');
  const ids = await new RecomputeRepository(pool).candidates({}, 100);
  expect(ids).not.toContain(failed);
  expect(ids).not.toContain(noRows);
  expect(ids).not.toContain(lost);
});

it('counts progress per org: total runs with statistics, remaining candidates, failed', async () => {
  const done = await seedRunWithStatRow({ statsMethod: 'exact-v1', sketch: false, histogramKind: 'sparse-ms-v2' });
  const todo = await seedRunWithStatRow({ statsMethod: 'estimated' });
  const lost = await seedRunWithStatRow({ statsMethod: 'estimated' });
  await new RecomputeRepository(pool).markFailed(lost, 'raw_log_missing');
  expect(await new RecomputeRepository(pool).progress(orgId)).toEqual({ total: 3, remaining: 1, failed: 1 });
  void done; void todo;
});

it('filters candidates by project slug and by run id', async () => { /* two projects; assert each filter */ });

it('deleteForRun removes every metric and assertion row of that run and no other', async () => {
  // seed two runs, each with one row in run_stat, run_error, run_series_bucket,
  // run_user_bucket, run_error_bucket and run_assertion (insert directly);
  // deleteForRun(first) in a transaction; count rows per table per run.
});
```

`seedRunWithStatRow` and `seedRun` are file-local helpers you write: insert an org, a project and a run (`status` default `'complete'`, `startedOn` `2026-08-07`), then optionally one `run_stat` row with `sketch` set to `Buffer.from([1])` or NULL and the given `histogram_kind`. The run's `stats_method` is set with a raw `UPDATE` (the Prisma default is `exact-v1`).

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/recompute.integration.test.ts`
Expected: FAIL (module not found / columns missing until the migration is applied — apply it with `pnpm --filter @perfportal/persistence run migrate:deploy` against the scratch DB first, then the failure is the missing repository).

- [ ] **Step 4: Implement**

`packages/persistence/src/repositories/recompute.ts`:

```ts
import type pg from 'pg';

export type RecomputeError = 'raw_log_missing' | 'checksum_mismatch' | 'parse_failed';

export interface RecomputeFilter {
  orgId?: string;
  projectSlug?: string;
  runId?: string;
}

export interface VerdictChangeRecord {
  ruleSnapshot: unknown;
  oldOutcome: string;
  newOutcome: string;
  oldValue: number | null;
  newValue: number | null;
  oldVerdict: string;
  newVerdict: string;
  changedAt: Date;
}

/**
 * The ONE definition of a run that still needs recomputing. Both by label and
 * by stored format: stats_method is written at INSERT, so a run an older
 * worker parsed during a rolling deploy carries exact-v1 over legacy rows.
 * A run with no stat rows has nothing to recompute; a run marked with a
 * recompute_error is never retried.
 */
export const CANDIDATE_PREDICATE_SQL = `
  r.status IN ('complete', 'incomplete')
  AND r.recompute_error IS NULL
  AND EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)
  AND (
    r.stats_method = 'estimated'
    OR EXISTS (
      SELECT 1 FROM run_stat s
       WHERE s.run_id = r.id
         AND (s.sketch IS NOT NULL OR s.histogram_kind IS DISTINCT FROM 'sparse-ms-v2')
    )
  )`;

export class RecomputeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async candidates(filter: RecomputeFilter, limit: number): Promise<string[]> {
    const where: string[] = [CANDIDATE_PREDICATE_SQL];
    const params: unknown[] = [];
    if (filter.orgId !== undefined) { params.push(filter.orgId); where.push(`r.org_id = $${params.length}`); }
    if (filter.runId !== undefined) { params.push(filter.runId); where.push(`r.id = $${params.length}::uuid`); }
    if (filter.projectSlug !== undefined) {
      params.push(filter.projectSlug);
      where.push(`r.project_id IN (SELECT p.id FROM project p WHERE p.slug = $${params.length})`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM run r WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => r.id);
  }

  async progress(orgId: string): Promise<{ total: number; remaining: number; failed: number }> {
    const { rows } = await this.pool.query<{ total: string; remaining: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id)) AS total,
         count(*) FILTER (WHERE ${CANDIDATE_PREDICATE_SQL}) AS remaining,
         count(*) FILTER (WHERE r.recompute_error IS NOT NULL AND r.stats_method = 'estimated') AS failed
       FROM run r WHERE r.org_id = $1 AND r.status IN ('complete', 'incomplete')`,
      [orgId],
    );
    const row = rows[0]!;
    return { total: Number(row.total), remaining: Number(row.remaining), failed: Number(row.failed) };
  }

  async markFailed(runId: string, reason: RecomputeError): Promise<void> {
    await this.pool.query(`UPDATE run SET recompute_error = $2 WHERE id = $1`, [runId, reason]);
  }

  async verdictChanges(runId: string): Promise<VerdictChangeRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT rule_snapshot, old_outcome, new_outcome, old_value, new_value,
              old_verdict, new_verdict, changed_at
         FROM run_verdict_change WHERE run_id = $1 ORDER BY changed_at, id`,
      [runId],
    );
    return rows.map((r) => ({
      ruleSnapshot: r.rule_snapshot,
      oldOutcome: r.old_outcome,
      newOutcome: r.new_outcome,
      oldValue: r.old_value,
      newValue: r.new_value,
      oldVerdict: r.old_verdict,
      newVerdict: r.new_verdict,
      changedAt: r.changed_at,
    }));
  }
}
```

`MetricWriter#deleteForRun` in `write.ts`:

```ts
/**
 * Every metric and assertion row of one run, for a recompute that rewrites
 * them in the same transaction. The partitioned tables are addressed by
 * (run_started_on, run_id) — their primary keys' prefix — so each DELETE
 * prunes to one partition. The six metric tables carry no foreign key to
 * run, so nothing else removes these rows.
 */
async deleteForRun(client: pg.PoolClient, ctx: { runId: string; runStartedOn: Date }): Promise<void> {
  const day = ctx.runStartedOn.toISOString().slice(0, 10);
  for (const table of ['run_series_bucket', 'run_user_bucket', 'run_error_bucket']) {
    await client.query(`DELETE FROM ${table} WHERE run_started_on = $2::date AND run_id = $1`, [ctx.runId, day]);
  }
  for (const table of ['run_stat', 'run_error', 'run_assertion']) {
    await client.query(`DELETE FROM ${table} WHERE run_id = $1`, [ctx.runId]);
  }
}
```

Check `persist`'s own handling of `runStartedOn` and bind the day the same way it does (if it passes the `Date`, do the same); the point is partition pruning, not a string format.

`RunRecord`: add the two fields, map them in the row mapper and add the two columns to every SQL select that builds a `RunRecord` (grep `stats_method` in `run.ts` — each place that selects it must select the new columns too).

- [ ] **Step 5: Run the tests to verify they pass**, then `pnpm typecheck` (after deleting `.tsbuildinfo`) and `pnpm lint`. Expected: PASS, exit 0 each.

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/prisma/migrations/20261016120000_exact_statistics_backfill packages/persistence/prisma/schema.prisma packages/persistence/src packages/persistence/test/recompute.integration.test.ts
git commit -F - <<'MSG'
Record verdict changes and which runs still need exact statistics

run_verdict_change keeps the rule, both outcomes, both values and both
run verdicts for a re-judged run. A run selects for recompute by label
OR by stored format, so legacy rows under an exact-v1 label are found.
MSG
```

---

### Task 2: One reader for a run's raw log

**Files:**
- Create: `apps/worker/src/pipeline/run-source.ts`
- Modify: `apps/worker/src/pipeline/pipeline.service.ts` (use it; move `rawLogBundleSource` and the checksum check there)
- Test: existing `apps/worker/test/pipeline.integration.test.ts` (unchanged, guards the refactor) plus `apps/worker/test/run-source.test.ts` (new, unit)

**Interfaces:**
- Produces:
  - `export async function openRunSource(run: Pick<RunRecord, 'bundleKey' | 'bundleSha256' | 'projectId'>, deps: { blobs: BlobStore; maxTotalBytes: number }): Promise<BundleSource>` — reads `run.bundleKey`, verifies SHA-256 against `run.bundleSha256` (throws the existing `BUNDLE_CHECKSUM_MISMATCH` ingest error), and returns `rawLogBundleSource` for a `/simulation.log` key or `openTarGzBundle` otherwise.
  - `export class RawLogMissingError extends Error` — thrown when `bundleSha256 === ''` (a live run that never stored a log) or the object does not exist (`blobs.exists(key) === false`), checked BEFORE reading.

- [ ] **Step 1: Write the failing unit tests** (`apps/worker/test/run-source.test.ts`) with a fake `BlobStore` (an object with `get`/`exists`):

```ts
it('throws RawLogMissingError for a run that stored no log', async () => {
  await expect(openRunSource({ bundleKey: 'runs/x/simulation.log', bundleSha256: '', projectId: 'p' },
    { blobs: fakeBlobs({}), maxTotalBytes: 1e9 })).rejects.toBeInstanceOf(RawLogMissingError);
});
it('throws RawLogMissingError when the object is gone', async () => { /* exists → false */ });
it('throws BUNDLE_CHECKSUM_MISMATCH when the bytes differ', async () => { /* code === 'BUNDLE_CHECKSUM_MISMATCH' */ });
it('opens a raw log as a one-file source', async () => { /* index.files === ['simulation.log']; read returns the bytes */ });
```

- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm vitest run apps/worker/test/run-source.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** by MOVING the code: `rawLogBundleSource` and its docstring, the SHA check and the source choice from `#ingest` into `run-source.ts`; `#ingest` becomes `const source = await openRunSource(run, { blobs: this.blobs, maxTotalBytes });`. The pipeline must NOT start treating a missing log differently: in `#ingest`, a `RawLogMissingError` is rethrown as the same ingest error the pipeline produced before for that case (read what `blobs.get` threw for a missing key and what the checksum check produced for `''`, and keep the run's recorded failure identical — `pipeline.integration.test.ts` is the guard).

- [ ] **Step 4: Run** the new unit file and `pnpm vitest run --config vitest.integration.config.ts apps/worker/test/pipeline.integration.test.ts` (scratch stores; rebuild packages first). Expected: PASS.

- [ ] **Step 5: Commit** (`git add apps/worker/src/pipeline apps/worker/test/run-source.test.ts`; message "Open a run's raw log in one place").

---

### Task 3: `RecomputeService` — one run, one transaction

**Files:**
- Create: `apps/worker/src/recompute/recompute.service.ts`
- Test: `apps/worker/test/recompute.integration.test.ts` (new)

**Interfaces:**
- Consumes: `openRunSource`, `RawLogMissingError` (Task 2); `MetricWriter#persist`, `MetricWriter#deleteForRun`, `RecomputeRepository#markFailed` (Task 1); `selectPlugin`, `runEngineAsync`, `toEvaluableStats`, `evaluateRules`, `holdClient`, `RUN_INGEST_LOCK_NAMESPACE`, `RunRepository#findByIdUnscoped`, `ProjectRepository#byId`.
- Produces:
  - `export type RecomputeOutcome = 'recomputed' | 'already_exact' | 'locked' | 'gone' | 'not_eligible' | RecomputeError;`
  - `export class RecomputeService { constructor(config: WorkerConfig, prisma: PrismaClient, pool: pg.Pool, blobs: BlobStore); recompute(runId: string): Promise<RecomputeOutcome> }`

Behaviour, in order:
1. Take `pg_try_advisory_lock(RUN_INGEST_LOCK_NAMESPACE, hashtext(runId))` on a held client (same as `PipelineService.process`). Not acquired → return `'locked'` (the queue retries later). Always unlock in `finally`.
2. Load the run (`findByIdUnscoped`). Missing → `'gone'`. Status not `complete`/`incomplete` → `'not_eligible'`. Not a candidate (re-check `CANDIDATE_PREDICATE_SQL` for this id with `RecomputeRepository.candidates({ runId }, 1)`) → `'already_exact'`.
3. `openRunSource`; `RawLogMissingError` → `markFailed('raw_log_missing')`, return it; `BUNDLE_CHECKSUM_MISMATCH` → `markFailed('checksum_mismatch')`; any error from `selectPlugin`/the engine → `markFailed('parse_failed')`. Transient errors (`isTransient`) are rethrown, not recorded.
4. `runEngineAsync(plugin.parse(source), run.engineOptions as EngineOptions)` — the run's FROZEN engine options.
5. Load the stored assertions: `SELECT rule_snapshot, outcome, actual_value FROM run_assertion WHERE run_id = $1 ORDER BY id`. Re-evaluate: `evaluateRules(snapshots as EvaluableRule[], toEvaluableStats(result.stats))`. The OLD run verdict is `run.verdict`. Pair new and old assertions by `ruleSnapshot.id` (the snapshot's `id`).
6. ONE transaction on a second held client: `deleteForRun`; `persist`; re-insert one `run_assertion` per new assertion (same columns as the pipeline, `rule_id` = `ruleSnapshot.id`); for each pair whose OUTCOME differs, insert a `run_verdict_change` row (`old_verdict` = `run.verdict`, `new_verdict` = the new verdict — both stored on every row); then
   ```sql
   UPDATE run SET stats_method = 'exact-v1', verdict = $2, tool_assertions = $3,
          duration_ms = $4, activity_ms = $5, recomputed_at = now()
    WHERE id = $1
   ```
   (`tool_assertions` and the two durations are re-derived from the same log by the same engine; every other column is left untouched — the Global Constraints list what is preserved.) COMMIT; on any error ROLLBACK without letting a ROLLBACK error replace the original (copy the pipeline's pattern) and rethrow.
7. Do NOT publish `run_terminal` or touch the run number, test, status or timestamps.

- [ ] **Step 1: Write the failing integration tests** (`apps/worker/test/recompute.integration.test.ts`). Copy `pipeline.integration.test.ts`'s setup (config, pool, prisma, blobs, `seedRun`, `seedLiveRun`, `FIXTURE_LOG` tarball). Helper `makeLegacy(runId)`: after `pipeline().process(runId, { queueWillRetry: false })`, run raw SQL to make the run look pre-PR-1 — `UPDATE run SET stats_method = 'estimated'`; `UPDATE run_stat SET sketch = '\x01'::bytea, histogram_kind = 'sparse-ms-v1', percentiles = jsonb_set(percentiles, '{p95}', to_jsonb((percentiles->>'p95')::float8 + 0.46))` — so a recompute that changed nothing would be visible. Compute expected figures from the raw log (nearest rank, integer rank arithmetic, as `packages/statistics` does) — never hard-code fixture numbers.

```ts
it('rewrites an estimated run exactly and marks it exact-v1', async () => {
  const { runId } = await seedRun(bundle); await pipeline().process(runId, { queueWillRetry: false });
  await makeLegacy(runId);
  expect(await service().recompute(runId)).toBe('recomputed');
  const row = await runStatRow(runId, 'run', '');
  expect(row.sketch).toBeNull();
  expect(row.histogram_kind).toBe('sparse-ms-v2');
  expect(row.percentiles.p95).toBe(exactPercentile(allDurations(log), 95));
  expect((await runRow(runId)).stats_method).toBe('exact-v1');
});

it('is idempotent: a second recompute reports already_exact and writes nothing', async () => {
  /* recompute twice; second returns 'already_exact'; recomputed_at unchanged; row counts unchanged */
});

it('preserves identity, number, test, note, status and timestamps', async () => {
  /* snapshot run row before (minus stats_method, verdict, tool_assertions, duration_ms, activity_ms, recomputed_at);
     set a note first; recompute; compare */
});

it('records a verdict change when an exact value crosses a frozen threshold', async () => {
  const { runId, orgId, projectId } = await seedRun(bundle);
  await pipeline().process(runId, { queueWillRetry: false });
  await makeLegacy(runId);
  const exactP95 = exactPercentile(allDurations(log), 95);
  // A rule the ESTIMATED value passed and the exact one fails: threshold below exact, stored outcome passed.
  const snapshot = { id: randomUUID(), scope: 'run', targetName: null, family: 'response_time',
                     metric: 'p95', comparator: 'lte', threshold: exactP95 - 0.5 };
  await pool.query(`DELETE FROM run_assertion WHERE run_id = $1`, [runId]);
  await pool.query(`INSERT INTO run_assertion (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
                    VALUES ($1,$2,$3,$4,$5,$6,'passed',$7,'legacy')`,
    [randomUUID(), runId, orgId, projectId, snapshot.id, JSON.stringify(snapshot), exactP95 - 0.6]);
  await pool.query(`UPDATE run SET verdict = 'passed' WHERE id = $1`, [runId]);
  expect(await service().recompute(runId)).toBe('recomputed');
  expect((await runRow(runId)).verdict).toBe('failed');
  const changes = await new RecomputeRepository(pool).verdictChanges(runId);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ oldOutcome: 'passed', newOutcome: 'failed', oldVerdict: 'passed', newVerdict: 'failed', newValue: exactP95 });
});

it('judges with the frozen snapshot, not the current rule', async () => {
  /* insert an sla_rule for the project with a DIFFERENT threshold that would flip the verdict;
     recompute; assert the verdict follows the stored snapshot and no change row is written */
});

it('writes no change row when the outcome is the same', async () => { /* threshold far from both values */ });

it('marks a run with no stored log raw_log_missing, leaves it estimated, and never selects it again', async () => {
  /* seed, process, makeLegacy, delete the object (blobs.delete(bundleKey)); recompute → 'raw_log_missing';
     stats_method still 'estimated'; legacy rows intact; candidates({ runId }) is empty */
});

it('marks a live run that stored no log (sha empty) raw_log_missing', async () => { /* bundle_sha256 = '' */ });

it('reports locked while another session holds the run lock, and changes nothing', async () => {
  /* take pg_advisory_lock(RUN_INGEST_LOCK_NAMESPACE, hashtext(runId)) on a separate client; recompute → 'locked'; rows unchanged; release */
});

it('leaves the legacy rows intact when the transaction fails after the deletes', async () => {
  /* vi.spyOn(MetricWriter.prototype, 'persist').mockRejectedValueOnce(new Error('boom'));
     expect(recompute).rejects; legacy run_stat row (sketch NOT NULL) still present; stats_method 'estimated' */
});

it('recomputes a live run whose log is a raw simulation.log', async () => { /* seedLiveRun path */ });

it('returns gone for a run that no longer exists', async () => { /* random uuid */ });
```

`service()` is `new RecomputeService(config, prisma, pool, blobs)`. `exactPercentile(values, p)` sorts ascending and returns `values[Math.ceil((p * n) / 100) - 1]` with integer `p` (p = 0 → min); `allDurations(log)` decodes with `parseSimulationLog` from `../../../packages/plugin-gatling/dist/src/index.js` (the relative import `apps/api/test/parity.e2e.test.ts` uses, if `@perfportal/plugin-gatling` does not resolve from `apps/worker` — check `apps/worker/package.json` first) and returns `endMs - startMs` of every request event.

- [ ] **Step 2: Run them to verify they fail.** Run: `pnpm vitest run --config vitest.integration.config.ts apps/worker/test/recompute.integration.test.ts` (scratch DB migrated; packages rebuilt). Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `recompute.service.ts` per the behaviour list. Write the transaction as a private `#write(run, result, assertions, verdict, oldAssertions)`; keep held-client handling identical to `PipelineService` (`holdClient`, release WITH the error when broken).

- [ ] **Step 4: Run the tests to verify they pass**, plus `pipeline.integration.test.ts` (unchanged behaviour). Expected: PASS.

- [ ] **Step 5: Commit** (`git add apps/worker/src/recompute apps/worker/test/recompute.integration.test.ts`; message "Recompute one run exactly, in one transaction").

---

### Task 4: The `recompute` queue, its scheduler and `pnpm recompute`

**Files:**
- Create: `apps/worker/src/recompute/recompute-queue.ts`
- Create: `apps/worker/src/scripts/recompute.ts`
- Modify: `apps/worker/src/main.ts` (start the consumer and scheduler; close both on shutdown)
- Modify: `apps/worker/src/config.ts` (`recomputeEnabled`, default true, `RECOMPUTE_ENABLED=false` turns it off; `recomputeScanIntervalMs`, default 600_000)
- Modify: `apps/worker/package.json` (`"recompute": "node dist/scripts/recompute.js"`), root `package.json` (`"recompute": "pnpm --filter @perfportal/worker run recompute"`)
- Test: `apps/worker/test/recompute-queue.integration.test.ts` (new), `apps/worker/test/recompute-args.test.ts` (new), `apps/worker/test/config.test.ts` (two cases)

**Interfaces:**
- Consumes: `RecomputeService` (Task 3), `RecomputeRepository#candidates` (Task 1).
- Produces:
  - `export const RECOMPUTE_QUEUE = 'recompute';`
  - `export function startRecomputeConsumer(config: WorkerConfig, service: RecomputeService): Worker` — concurrency 1. Before working a job it checks the INGEST queue (`new Queue('ingest')#getJobCounts('waiting', 'active', 'delayed')`); if any ingest work exists it moves the job to delayed for 5 s and returns (BullMQ `job.moveToDelayed(Date.now() + 5000, token)` then `throw new DelayedError()`). A `'locked'` outcome is retried the same way (delayed 30 s). Every other outcome completes the job.
  - `export async function enqueueCandidates(queue: Queue, repo: RecomputeRepository, batch = 500): Promise<number>` — adds every current candidate with `jobId: runId` (BullMQ dedupes), `removeOnComplete: true`, `removeOnFail: 1000`, `attempts: 3`, exponential backoff; returns how many it added.
  - `export function parseRecomputeArgs(argv: string[]): { projectSlug?: string; runId?: string }` — `--project <slug>`, `--run <uuid>`; rejects a missing value, a value starting with `--` and unknown flags (copy `bootstrap.ts`'s `parseArgs` shape).
  - The script: builds config, pool, prisma, blobs, `RecomputeService`; loops `candidates(filter, 50)` and recomputes each in turn, printing `Recomputed <id> (<outcome>)` and a final `Recomputed N runs; M could not be (raw_log_missing: a, checksum_mismatch: b, parse_failed: c); K were locked and are left for the worker.` Exits 1 on an unexpected error. It does NOT go through the queue: it is what an operator runs with the worker stopped.

- [ ] **Step 1: Write the failing tests**
  - `recompute-args.test.ts`: `--project checkout` → `{ projectSlug: 'checkout' }`; `--run <uuid>` → `{ runId }`; both together; `--project` with no value throws; `--project --run x` throws; `--frobnicate` throws; no args → `{}`.
  - `config.test.ts`: `RECOMPUTE_ENABLED` absent → true; `'false'` → false (exact string comparison, `'0'` stays true — read `=== 'false'`); `RECOMPUTE_SCAN_INTERVAL_MS` parses with the file's existing integer helper.
  - `recompute-queue.integration.test.ts` (scratch Redis db): seed two legacy runs (Task 3's helpers); `enqueueCandidates` returns 2 and a second call adds 0 new jobs (dedupe by jobId); with `startRecomputeConsumer` running and NO ingest work, both runs end `exact-v1` (poll the DB with `until` from `backends.ts`); with an ingest job waiting (add a job to the `ingest` queue that no consumer takes), the recompute job is delayed and the run stays `estimated` for at least 2 s, then completes after the ingest job is removed.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.** In `main.ts`, after the ingest consumer: if `config.recomputeEnabled`, create the queue, the consumer, call `enqueueCandidates` once at start (log the count), and `setInterval(enqueueCandidates, config.recomputeScanIntervalMs).unref()`; add `{ name: 'recompute.close', run: … }` entries to the shutdown list (consumer `close()`, queue `close()`, clear the interval). Size: the recompute consumer holds at most two pool clients (lock + transaction) — add `2` to the pg pool `max` computation and `1` to Prisma's `connectionLimit`, with a one-line comment beside the existing arithmetic.

- [ ] **Step 4: Run the tests to verify they pass**, then the worker's other integration files (`pipeline*`, `fold-owner`, `connection-loss`) — the pool sizing change must not break them.

- [ ] **Step 5: Commit** (`git add apps/worker package.json`; message "Recompute estimated runs in the background, behind ingest").

---

### Task 5: API — verdict changes on the run, progress for admins

**Files:**
- Modify: `packages/contracts/src/run.ts` (`RunIdentitySchema.verdictChanges`), `packages/contracts/src/admin.ts` (`RecomputeProgressSchema`)
- Modify: `apps/api/src/runs/runs.service.ts` (`lifecycleOf` returns `verdictChanges`; `toResponse` sets it), `apps/api/src/runs/runs.controller.ts` (the 202 sets it)
- Modify: `apps/api/src/admin/admin.controller.ts` (`GET /v1/admin/recompute`), `apps/api/src/admin/admin.module.ts` if a provider is needed
- Modify: `apps/api/src/openapi/schemas.ts`, `apps/api/src/openapi/document.ts`
- Modify: `apps/api/test/access-routes.integration.test.ts` (`ACCESS_BY_ROUTE` row)
- Test: `packages/contracts/test/run.test.ts` or the file holding `RunIdentitySchema` cases, `packages/contracts/test/admin.test.ts`, `apps/api/test/read.integration.test.ts`, `apps/api/test/admin.integration.test.ts`

**Interfaces:**
- Produces:
  - Contract:
    ```ts
    export const VerdictChangeSchema = z.object({
      rule: AssertionRuleSchema,                 // the frozen snapshot, same shape the gates table reads
      oldOutcome: z.enum(['passed', 'failed', 'not_applicable']),
      newOutcome: z.enum(['passed', 'failed', 'not_applicable']),
      oldValue: z.number().nullable(),
      newValue: z.number().nullable(),
      oldVerdict: VerdictSchema,
      newVerdict: VerdictSchema,
      changedAt: z.string().datetime(),
    });
    // on RunIdentitySchema, after statsMethod:
    verdictChanges: z.array(VerdictChangeSchema).optional(),
    ```
    Use the existing exported names for the assertion-rule and verdict schemas (`AssertionRuleSchema` exists since the live-banner branch; find the verdict enum's exported schema name in `run.ts`). A snapshot that does not parse as `AssertionRuleSchema` is dropped from the list on the server (log it) rather than failing the whole response.
  - `export const RecomputeProgressSchema = z.object({ total: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });`
  - `GET /v1/admin/recompute` → `RecomputeProgress` for the caller's org; `@Requires('users:manage')` (the admin action every admin route uses), session only, documented in OpenAPI under the admin tag with `sessionAccessSentence('users:manage') + ' '` opening its description, `401 Unauthorized`, `403 SessionRequired`.

- [ ] **Step 1: Write the failing tests**
  - contracts: `verdictChanges` absent parses (rolling deploy); a populated list parses; an unknown outcome is refused. `RecomputeProgressSchema` refuses a negative count.
  - `read.integration.test.ts`: a run with one `run_verdict_change` row (insert it directly) reads back `verdictChanges` with the rule, both outcomes and values, in BOTH builders (a processed run → 200; a `waitMs: 0` unprocessed run carrying a row → 202) — the same two-builder shape `statsMethod`'s cases use; a run with none reads `[]`.
  - `admin.integration.test.ts`: an admin gets `{ total, remaining, failed }` matching seeded rows (seed per Task 1's helpers); a non-admin session gets 403 `ADMIN_REQUIRED`; a bearer token gets 403 `SessionRequired`'s code; counts are per org (a second org's run is not counted).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.** `lifecycleOf` calls `new RecomputeRepository(pool).verdictChanges(run.id)` (inject the pool the controller already has, or add a Prisma raw query — follow how `RunsService` reaches the database today) and maps each to the contract shape. Add the `ACCESS_BY_ROUTE` row (`'GET /v1/admin/recompute': 'users:manage'` in the file's format) and the OpenAPI operation `getRecomputeProgress`.
- [ ] **Step 4: Run** the contracts unit tests and `read`, `admin`, `access-routes`, `openapi` integration files. Expected: PASS.
- [ ] **Step 5: Commit** (message "Serve verdict changes on the run and backfill progress to admins").

---

### Task 6: Web — ≈ on estimated figures, the changed verdict, admin progress

**Files:**
- Create: `apps/web/src/components/Approx.tsx`
- Create: `apps/web/src/routes/VerdictChanged.tsx`
- Create: `apps/web/src/routes/RecomputeProgress.tsx`; `apps/web/src/api/admin.ts` (`fetchRecomputeProgress`, `recomputeProgressQueryKey`)
- Modify: `apps/web/src/routes/RunStats.tsx` (p95 tile value), `apps/web/src/tables/StatisticsTable.tsx` (percentile column headers), `apps/web/src/tables/ScopedStatistics.tsx` + `RequestDetail.tsx`/`GroupDetail.tsx` (thread `exact`), `apps/web/src/routes/GroupsList.tsx` + `RunReport.tsx` (thread `exact`), `apps/web/src/routes/RunDecisionBand.tsx` (mount `VerdictChanged`), `apps/web/src/routes/AdminShell.tsx` (mount `RecomputeProgress`)
- Test: `apps/web/test/Approx.test.tsx`, `apps/web/test/VerdictChanged.test.tsx`, `apps/web/test/RecomputeProgress.test.tsx` (new); one case each in `RunStats.test.tsx`, `StatisticsTable.test.tsx`, `ScopedStatistics.test.tsx` (or the drill-down page tests), `GroupsList` (its existing test file), `RunDecisionBand.test.tsx`, `AdminShell`'s or `AdminUsers.test.tsx`

**Interfaces:**
- Consumes: `isExact` (`apps/web/src/routes/statsMethod.ts`), `InfoTip`, `RunIdentity.verdictChanges`, `RecomputeProgressSchema`, `describeSlaRule`/`formatSlaMeasured` from `@perfportal/contracts`.
- Produces:
  - `export function Approx({ exact, children }: { exact: boolean; children: ReactNode }): JSX.Element` — renders `children` alone when `exact`; otherwise `<span aria-hidden="true">≈ </span><span className="sr-only">approximately </span>{children}`.
  - `export function VerdictChanged({ changes }: { changes: readonly VerdictChange[] }): JSX.Element | null` — null for an empty list; otherwise one line `Verdict changed by exact statistics` and an `InfoTip label="About the verdict change"` whose content lists, per change, the rule (`describeSlaRule`), and `was <old value> (<old outcome>), now <new value> (<new outcome>)` with values through `formatSlaMeasured(metric, value, threshold)`.
  - `export function RecomputeProgress(): JSX.Element | null` — queries `/v1/admin/recompute`; `refetchInterval: (q) => (q.state.data?.remaining ?? 0) > 0 ? 10_000 : false`; renders `role="status"` text `Recomputing exact statistics: {total - remaining} of {total} runs` (numbers via the app's existing integer formatter) only while `remaining > 0`; appends `· {failed} could not be recomputed` when `failed > 0`; renders nothing otherwise, and nothing on a query error (a progress strip must not put an error on every admin page).

Placement rules (clean-UI): ≈ goes on the p95 TILE VALUE and on each percentile COLUMN HEADER of the statistics tables (not on every cell); the existing estimate ⓘ (PR 1) already explains it — reuse that text, no new sentence under any title. The ≈ inside a `<th>` is plain text (never an InfoTip). `VerdictChanged` sits in `RunDecisionBand`'s first column directly after the "Release gate" overline. `RecomputeProgress` sits in `AdminShell` between the section nav and the children.

- [ ] **Step 1: Write the failing tests**
  - `Approx`: exact → no ≈ in `textContent`; estimated → `textContent` contains `≈` and the accessible text contains "approximately".
  - `RunStats`: `exact={false}` → the p95 value contains ≈; `exact={true}` → it does not (pair, in one case).
  - `StatisticsTable`: `exact={false}` → every percentile column header's text contains ≈ and the Total/OK/KO/Min/Max/Mean headers do not; `exact={true}` → none does.
  - Drill-downs and `GroupsList`: the same pair for one percentile figure each, proving `exact` is threaded from the run identity (render the page with `statsMethod: 'estimated'` vs `'exact-v1'`, as PR 1's `RunReport.test.tsx` wiring cases do).
  - `VerdictChanged`: empty → renders nothing; one change → the line is present and the ⓘ description names both outcomes and both values; in `RunDecisionBand`, an identity with `verdictChanges: [change]` renders the line, and one with `[]` or absent does not.
  - `RecomputeProgress`: `{ total: 1030, remaining: 618, failed: 0 }` → `Recomputing exact statistics: 412 of 1,030 runs`; `remaining: 0` → nothing; `failed: 3` while remaining > 0 → the failed clause; a 500 → nothing.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.** `exact` is a REQUIRED prop wherever a figure is marked (no default — this repo's rule for a prop whose wrong value is silent); let `tsc` name every caller, tests included.
- [ ] **Step 4: Run** the touched test files, then the whole `apps/web/test` directory, forced typecheck and lint. Expected: PASS; no `Errors` line in the vitest output.
- [ ] **Step 5: Commit** (message "Mark estimated figures, show a changed verdict, and show admins the backfill").

---

### Task 7: Gates, a real backfill, CLAUDE.md, PR

**Files:**
- Modify: `CLAUDE.md`, `DEPLOYMENT.md` (Upgrading: the backfill runs by itself after upgrade; `pnpm recompute` for a specific project or run; `RECOMPUTE_ENABLED=false` to defer it)

- [ ] **Step 1: Predict the floors** from per-file case deltas (unit, integration, e2e) before running anything.
- [ ] **Step 2: Run every gate** on Node 22 and scratch stores, each to its own file, reading each exit code: `pnpm build`, `pnpm typecheck` (after deleting `.tsbuildinfo`), `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `PERFPORTAL_E2E_PORT=3730 pnpm test:e2e --workers=2`. Integration before e2e, nothing else on the stack.
- [ ] **Step 3: A real backfill on a COPY of the developer database** (read-only on the original): `pg_dump perfportal` into a scratch database, `prisma migrate deploy` against the copy, then run this branch's worker against the copy on a fresh Redis index with `RECOMPUTE_ENABLED=true`. Record: candidate count before, runs recomputed per minute, how many ended `raw_log_missing`/`checksum_mismatch`/`parse_failed`, every verdict change (rule, old/new value), and for three runs the before/after p95 against the raw log's nearest rank (the BasicSimulation comparison script from PR 1's Task 7 if its run is in the copy). Then run `pnpm recompute --run <id>` on one already-exact run and confirm it reports nothing to do. Drop the copy afterwards; confirm the developer database's counts and `stats_method` values are unchanged.
- [ ] **Step 4: CLAUDE.md entry** at the top of the Verification section's branch entries in the file's style: what the backfill does, the candidate rule (label OR stored format), what is preserved, the verdict-change record, the failure reasons, the queue's yield-to-ingest, each gate's total and exit code, the real-backfill numbers, and the new floors (also update the floor line near the top).
- [ ] **Step 5: Commit, push, PR** — `gh pr create --base main --title "Exact statistics, PR 2: recompute existing runs"`; the body lists the spec, the delivery table, what changes for existing runs, the gates and the real-backfill numbers. Merge only on a SHA-pinned green read, `--merge`, after the user's go-ahead.

---

## Self-review notes

- Spec §5: dedicated `recompute` queue, concurrency 1, lower priority (Task 4); operator command (Task 4); one transaction, idempotent, skip exact (Task 3); preserved fields (Task 3 test); frozen `ruleSnapshot` and `run_verdict_change` (Tasks 1, 3); runs without a raw log stay estimated and are labelled (Tasks 1, 3, 6); admin progress only while work remains (Tasks 5, 6).
- Spec §3 `run_verdict_change` columns: all present, plus `old_outcome`/`new_outcome` and `org_id`/`project_id` (the rule-level outcome is what the ⓘ explains; the ids follow every run-scoped table's convention).
- Spec §7 ≈ labels: placed on the single-run surfaces (Summary tile, Report and drill-down tables, groups list). The multi-run views (trends, compare, run list p95, home sparkline) carry no per-run `statsMethod` today; after the backfill only unrecoverable runs remain estimated, and those views gain the per-run mark with PR 3's verified mark, which needs the same per-run field. Recorded as a deliberate scope line, not a gap.
- The browser clamp (`apps/web/src/percentile.ts`) and `clampPercentile` stay: unrecoverable runs keep sketch values, and PR 5 decides their fate when it drops the sketch columns.
- `stats_method` for runs with no statistics is set to `exact-v1` by the migration (vacuous), so progress counts only runs with figures.
