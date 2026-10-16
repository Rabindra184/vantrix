# Exact statistics, PR 3: verify every run against its raw log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run's stored statistics are checked against its raw `simulation.log` by an independent verifier; each run shows ✓ Verified / Verifying… / ✕ Verification failed / Not verified; raw logs are kept for a configurable period; admins see a Data integrity page; and the multi-run views mark estimated runs with ≈.

**Architecture:** A new pure package `packages/verify` decodes the log with `@perfportal/plugin-gatling`, recomputes every stored figure from sorted value arrays (never importing `@perfportal/statistics`, enforced by lint) and compares it with the stored rows. A `verify` BullMQ queue in the worker runs it after every successful ingest and recompute, and a scheduler catches up every other run; results land in `run_verification` (one row per run). The sweeper deletes raw logs past `RAW_LOG_RETENTION_DAYS`. The API serves `GET /v1/runs/{id}/verification`, a verification summary on the run identity and an admin data-integrity endpoint; the web draws the header mark, a verification panel and the admin page.

**Tech Stack:** TypeScript, Node 22, PostgreSQL (Prisma migrations + raw `pg`), BullMQ/Redis, NestJS, React + TanStack Query, Radix Popover, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-exact-statistics-design.md` — §3 (`run_verification`, retention), §6 (verifier), §7 (mark, panel, Data integrity, API), §8. PRs 1 (#277) and 2 (#278) are merged.

## Global Constraints

- The verifier is the separate package `packages/verify`; a lint rule forbids it importing `@perfportal/statistics` (and its subpaths). It decodes with the shared decoder (`@perfportal/plugin-gatling`).
- Compares counts, min, max and percentiles EXACTLY; mean, standard deviation, rates (throughput) and ratios (error rate) within relative 1e-9 (absolute 1e-9 when the expected value is 0).
- `run_verification` (one row per run): `run_id` PK FK cascade, `status` pending | verified | mismatch | unverifiable, `checked_at`, `verifier_version` (integer, bumped when rules change), `figures_checked`, `mismatches` JSON list (scope, name, family, population, bucket?, figure, stored, recomputed), `gatling_differences` JSON list (empty until PR 4), `unverifiable_reason`, `raw_log_retained_until` (date, or null for forever). The row outlives the raw log.
- Verify job: own queue, runs after each ingest and each recompute, while the raw log exists. Mismatch → status `mismatch`, an error-level log line, listed in Administration › Data integrity.
- Raw log retention: `RAW_LOG_RETENTION_DAYS` (default 90, `0` = forever); the sweeper deletes logs past retention and updates the verification row (`raw_log_retained_until`, reason `raw_log_deleted` for a run never verified).
- UI (clean-UI rules): run header mark ✓ Verified / Verifying… (muted) / ✕ Verification failed (failed colour) / Not verified + ⓘ with the reason; a verification panel from the mark (figures checked, verifier version, time, raw-log retention date, mismatches with stored and recomputed values on a mismatch; the "Differences from Gatling's report" table is PR 4's); Administration › Data integrity (backfill progress, failed verifications, unverifiable runs, retention setting read-only); `GET /v1/runs/{id}/verification` (read scope, OpenAPI).
- Multi-run views (run list p95, trends, compare, home sparkline) mark estimated runs with ≈ (PR 2's deferred scope).
- Integration and e2e on a SCRATCH database and Redis index, never the developer database `perfportal`; a real-run check reads the developer database/bucket only, never writes them.
- Every new route: exactly one access decorator, a row in `ACCESS_BY_ROUTE`, OpenAPI with its role sentence first, parsed through its contract schema. A new run-scoped GET joins the cross-org guard's endpoint list. A new identity field goes through BOTH builders via `lifecycleOf` and is `.optional()`.
- Repo rules: Node 22 via nvm; read each command's own exit code; `git commit -F -`, name paths, never `git add -A`; no backticks in SQL comments; no `prisma format`; new tables go in `SCHEMA_TABLES`; rebuild packages before integration runs; bind `run_started_on` through `partitionDay` (PR 2).

## Review Focus

1. A run whose raw log was deleted by retention before it was ever verified — expect `unverifiable` / `raw_log_deleted`, never a retried job, and the header says "Not verified" with that reason. Pinned in Tasks 5 and 6.
2. A run being re-ingested or recomputed while it is verified — expect the verifier holds the run lock (no torn read), or reports `locked` and retries; never a false `mismatch`. Pinned in Task 5.
3. A run with warm-up configured, groups, standalone error records, more than 200 error messages, and a series that coalesced (width > 1 s) — expect `verified` on correct data. Pinned in Tasks 2–4 (synthetic logs) and Task 5 (the reference fixture through the real pipeline).
4. An estimated run (PR 2 could not recompute it) — expect `unverifiable` with reason `not_exact`, not a flood of mismatches. Pinned in Task 5.
5. A single corrupted stored value (a count, a percentile, one bucket's ok_count) — expect `mismatch` naming exactly that figure with stored and recomputed values. Pinned in Tasks 2–5.

---

## Appendix A — what the verifier must recompute (the engine's exact semantics)

Read this before Tasks 2–4. It is the contract the verifier recomputes INDEPENDENTLY; it was read out of the engine at `19087fe6` (file:line references are to that tree).

**Events** (`packages/core/src/events.ts`, decoder `packages/plugin-gatling/src/record-decoder.ts`): meta `{simulation, toolVersion, startedAtMs, description?, assertions?}` first; request `{name, groups[], startMs, endMs, ok, message?}` (absolute epoch ms = runStart + int32 offset; empty message → undefined); user `{scenario, kind: 'start'|'end', tsMs}`; group `{groups[], startMs, endMs, cumulatedResponseTimeMs, ok}`; error `{message, tsMs}` (no name). `runStartMs` = meta `startedAtMs`. No warm-up on any event: `warmupMs` comes from the run's frozen `engine_options`.

**Value per observation**: request `endMs − startMs`; group_cumulated `cumulatedResponseTimeMs`; group_duration `endMs − startMs`; every value is `Math.max(0, Math.round(v))`.

**Warm-up**: an event is warm-up when `warmupMs > 0 && t − runStartMs < warmupMs`, with `t` = `startMs` for requests and groups, `tsMs` for error records. Warm-up is EXCLUDED from every `run_stat` row and every `run_error` count; INCLUDED in every series bucket, user bucket, error bucket, the first/last span and the endpoint cap.

**`run_stat` rows**: `('run','','response_time')` over all non-warm-up requests; `('request', [...groups, name].join('/'), 'response_time')`; `('group', groups.join('/'), 'group_cumulated')` and `(… 'group_duration')`. A row exists only if it received at least one non-warm-up observation. Per row: `count`, `ok_count`, `ko_count = count − ok`, `error_rate = count ? ko/count : 0`, `min_ms`/`max_ms` (0 when empty), `mean_ms = sum/count`, `stddev_ms = sqrt(Σ(v−mean)²/count)` (population), `throughput_rps = windowMs === 0 ? 0 : count / windowMs * 1000` with ONE `windowMs` for every row: `windowMs = max(0, lastMs − max(firstMs, runStartMs + warmupMs))`, where `firstMs` = min `startMs` and `lastMs` = max `endMs` over ALL request events (warm-up included; groups/users/errors never move them). `percentiles` JSON keys `` `p${String(p)}` `` (`p50`, `p99.9`) for `p` in `engine_options.percentiles ?? [50, 75, 95, 99]`; a rank is omitted for an empty population; value = sorted ascending values at 0-based index `nearestRankIndex(p, n)`:

```ts
// reimplement this in packages/verify — do NOT import it
function nearestRankIndex(p: number, n: number): number {
  if (n <= 0) return -1;
  const decimals = (String(p).split('.')[1] ?? '').length;
  const scale = 10 ** decimals;
  const rank = Math.ceil((Math.round(p * scale) * n) / (100 * scale));
  return Math.min(n, Math.max(1, rank)) - 1;
}
```

**`run_series_bucket`**: series `('run','','response_time')` cap `maxBucketsRun` (default 1200), `('request', path, 'response_time')` cap `maxBucketsEndpoint` (default 300), `('group', path, 'group_cumulated'|'group_duration')` cap 300 (not configurable). Every event (warm-up included) contributes TWICE: at `startMs` (start edge) and at `endMs` (end edge). Width W = the smallest `1000 · 2^k` such that the number of distinct `floor((t − runStartMs)/W)` over ALL start and end timestamps of that series is ≤ cap; `start_offset_ms = floor((t − runStartMs)/W) · W` (may be negative). Start edge: `started_count`, `started_ok_count`/`started_ko_count`, and the observation feeds the bucket's latency population. End edge: `ended_count`, `ok_count`/`ko_count`. Latency columns over the start-edge population: `min_ms`/`max_ms` (0 when none), `mean_ms` (0 when none), `percentiles` over all, `percentiles_ok`/`percentiles_ko` per status, for the FIXED set `[25, 50, 75, 80, 85, 90, 95, 99]` (empty population → `{}`). A bucket exists if any timestamp of the series falls in it.

**`run_error`**: label `message ?? '(no message)'` (empty string also → `'(no message)'`). Non-warm-up KO requests add to `('run','')` AND `('request', path)`; non-warm-up error records add to `('run','')` only. Per (scope, name): sort by count desc then `a.localeCompare(b)`; keep 200; the rest summed into one row `message = ''`, `is_other = true`.

**`run_error_bucket`** (run scope only): KO requests only (error records excluded), warm-up included, attributed by `endMs`; width = the run series' W; messages admitted first-seen up to 200 distinct (later new messages → overflow); top 5 messages by run-wide total (count desc, then `localeCompare`) keep their own rows; per bucket an `is_other` row (`message = ''`) = overflow + non-top counts, omitted when 0; column `bucket_width_ms` = W.

**`run_user_bucket`**: per scenario, every user event, warm-up included. Sort by `tsMs`, starts before ends at the same ms; walk at width 1000: a bucket is created with `max_concurrent` = current concurrency, then `started++`/`concurrent++` or `ended++`/`concurrent--`, `max_concurrent` = running peak. Gap-fill every index between first and last occupied with `{started 0, ended 0, max_concurrent: standing}` (standing = cumulative started − ended). Then coalesce while bucket count > 1200: width doubles, `floor(idx/2)`, started/ended summed, max_concurrent max.

**`run` columns**: `duration_ms = lastMs === 0 ? 0 : max(0, lastMs − runStartMs)`; `activity_ms = lastMs === 0 ? 0 : windowMs`.

**Not verified in PR 3** (recorded, not an omission): `tool_assertions` (re-checks Gatling's own assertions — PR 4's subject), histogram BYTES (an encoding; the figures derived from them are verified).

---

### Task 1: Schema — `run_verification`, raw-log deletion marker, repository

**Files:**
- Create: `packages/persistence/prisma/migrations/20261017120000_run_verification/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (model `RunVerification`; `Run.rawLogDeletedAt`), `packages/persistence/src/client.ts` (`SCHEMA_TABLES`), `packages/persistence/src/repositories/run.ts` (`RunRecord.rawLogDeletedAt` + selects)
- Create: `packages/persistence/src/repositories/verification.ts`; export from `packages/persistence/src/index.ts`
- Create: `packages/persistence/src/metrics/stored-figures.ts` (reads every stored metric row of one run for comparison); export it
- Test: `packages/persistence/test/verification.integration.test.ts`

**Interfaces — Produces:**
```ts
export type VerificationStatus = 'pending' | 'verified' | 'mismatch' | 'unverifiable';
export type UnverifiableReason = 'raw_log_deleted' | 'raw_log_missing' | 'raw_log_unreadable' | 'not_exact';
export interface FigureMismatch {
  scope: string; name: string; family: string;
  population: 'all' | 'ok' | 'ko' | null;   // null for non-latency figures
  bucket: number | null;                    // start_offset_ms, null for a run_stat/run_error figure
  table: 'run_stat' | 'run_series_bucket' | 'run_error' | 'run_error_bucket' | 'run_user_bucket' | 'run';
  figure: string;                           // e.g. 'count', 'p95', 'ok_count', 'row' (a row missing/extra)
  stored: number | string | null; recomputed: number | string | null;
}
export interface VerificationRecord {
  runId: string; status: VerificationStatus; checkedAt: Date | null; verifierVersion: number | null;
  figuresChecked: number; mismatches: FigureMismatch[]; gatlingDifferences: unknown[];
  unverifiableReason: UnverifiableReason | null; rawLogRetainedUntil: Date | null;
}
export class VerificationRepository {
  constructor(pool: pg.Pool);
  markPending(runId: string): Promise<void>;                  // upsert; resets to pending, keeps rawLogRetainedUntil
  record(runId: string, r: { status: 'verified' | 'mismatch'; verifierVersion: number; figuresChecked: number; mismatches: FigureMismatch[]; rawLogRetainedUntil: Date | null }): Promise<void>;
  markUnverifiable(runId: string, reason: UnverifiableReason, verifierVersion: number): Promise<void>;
  find(runId: string): Promise<VerificationRecord | null>;
  /** Terminal runs with statistics whose row is missing, pending, or older than `version`, newest first, keyset-paged like RecomputeRepository.candidatePage. */
  candidatePage(version: number, after: { createdAt: Date; id: string } | null, limit: number): Promise<{ ids: string[]; next: { createdAt: Date; id: string } | null }>;
  /** Runs whose raw log is past retention and not yet deleted. */
  retentionDue(days: number, limit: number): Promise<{ id: string; bundleKey: string }[]>;
  markRawLogDeleted(runId: string): Promise<void>;           // sets run.raw_log_deleted_at; a never-verified row becomes unverifiable/raw_log_deleted
  summary(orgId: string): Promise<{ verified: number; mismatch: number; unverifiable: number; pending: number }>;
  problems(orgId: string, limit: number): Promise<{ runId: string; projectSlug: string; status: 'mismatch' | 'unverifiable'; reason: UnverifiableReason | null; mismatchCount: number; checkedAt: Date | null }[]>;
}
export interface StoredFigures { /* the rows of the five metric tables for one run, decoded (no histogram bytes) */ }
export function readStoredFigures(pool: pg.Pool, runId: string, runStartedOn: Date): Promise<StoredFigures>;
```
Define `StoredFigures` as plain arrays mirroring the columns listed in Appendix A (stat rows incl. `percentiles` JSON; series buckets incl. the three percentile maps; error rows incl. `is_other`; error buckets incl. `bucket_width_ms`; user buckets) plus `run: { durationMs, activityMs }`. `packages/verify` (Task 2) defines its OWN mirror type and the worker maps between them — the verifier must not import persistence either (keep it pure: core + plugin-gatling types only).

- [ ] **Step 1: Migration**

```sql
-- Exact statistics PR 3: one verification row per run, and when a raw log was deleted.

CREATE TABLE run_verification (
  run_id uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  status text NOT NULL,
  checked_at timestamptz(3) NULL,
  verifier_version integer NULL,
  figures_checked integer NOT NULL DEFAULT 0,
  mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  gatling_differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  unverifiable_reason text NULL,
  raw_log_retained_until date NULL,
  CONSTRAINT run_verification_status_check
    CHECK (status IN ('pending', 'verified', 'mismatch', 'unverifiable')),
  CONSTRAINT run_verification_reason_check
    CHECK (unverifiable_reason IN ('raw_log_deleted', 'raw_log_missing', 'raw_log_unreadable', 'not_exact'))
);
CREATE INDEX run_verification_status_idx ON run_verification (status);

ALTER TABLE run ADD COLUMN raw_log_deleted_at timestamptz(3) NULL;
CREATE INDEX run_ingested_at_idx ON run (ingested_at);
```

Hand-edit `schema.prisma` (model `RunVerification` mapped to `run_verification` — `Verification` is Better Auth's, do not reuse the name; `Run.rawLogDeletedAt`; `@@index([ingestedAt])`), add `run_verification` to `SCHEMA_TABLES`, run `infra/test/schema-matches-migrations.sh` (exit 0).

- [ ] **Step 2: Failing integration tests** for every repository method: `markPending` then `record` round-trips mismatches JSON; `candidatePage` returns a run with no row, a `pending` row and a row at an older version, never a current-version verified row, never a non-terminal run, pages via the cursor including a `created_at` tie; `retentionDue(30)` returns a run ingested 31 days ago with a bundle and no `raw_log_deleted_at`, not one ingested 29 days ago, not one already deleted; `retentionDue(0)` returns nothing (forever); `markRawLogDeleted` on a never-verified run leaves it `unverifiable`/`raw_log_deleted` and on a verified run keeps `verified`; `summary`/`problems` are per org; `readStoredFigures` returns every row of a seeded run across the five tables and none of another run (partitioned tables addressed through `partitionDay`).
- [ ] **Step 3: Run them to verify they fail.** `pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/verification.integration.test.ts` (scratch DB migrated).
- [ ] **Step 4: Implement** (raw-SQL `pg.Pool` repository in `RecomputeRepository`'s style).
- [ ] **Step 5: Run to pass**, typecheck, lint.
- [ ] **Step 6: Commit** ("Record one verification per run and when its raw log was deleted").

---

### Task 2: `packages/verify` — scaffold, rank, and `run_stat` rows

**Files:**
- Create: `packages/verify/package.json`, `packages/verify/tsconfig.json`, `packages/verify/src/index.ts`, `src/rank.ts`, `src/figures.ts` (types), `src/stats.ts`, `src/compare.ts`
- Modify: root `tsconfig.json` (reference `packages/verify` after `plugin-gatling`), `eslint.config.js` (a SEPARATE block for `packages/verify/src/**/*.ts`: `no-restricted-imports` with `FORBIDDEN_IN_PURE` plus `@perfportal/statistics` and `@perfportal/statistics/*`, message "The verifier must not share code with the engine it checks."), `packages/core/test/lint-rules-compose.test.ts` (a probe proving the rule fires at a real verify path)
- Test: `packages/verify/test/rank.test.ts`, `packages/verify/test/stats.test.ts`

**Interfaces — Produces:**
```ts
export const VERIFIER_VERSION = 1;
export interface VerifyOptions { runStartMs: number; warmupMs: number; percentiles: readonly number[]; maxBucketsRun: number; maxBucketsEndpoint: number }
export function optionsFrom(engineOptions: Record<string, unknown>, runStartMs: number): VerifyOptions; // defaults per Appendix A
export interface ExpectedStat { scope: string; name: string; family: string; count: number; okCount: number; koCount: number; errorRate: number; minMs: number; maxMs: number; meanMs: number; stddevMs: number; throughputRps: number; percentiles: Record<string, number> }
export interface Expected { stats: ExpectedStat[]; run: { durationMs: number; activityMs: number }; /* Tasks 3–4 add series, errors, errorBuckets, users */ }
export function expectedFrom(events: Iterable<CanonicalEvent>, opts: VerifyOptions): Expected;
export interface StoredStat extends ExpectedStat {}
export interface Stored { stats: StoredStat[]; run: { durationMs: number; activityMs: number }; /* Tasks 3–4 extend */ }
export function compare(expected: Expected, stored: Stored): { figuresChecked: number; mismatches: FigureMismatch[] };  // FigureMismatch: the same shape as Task 1's (define it here; the worker maps)
export function nearestRankIndex(p: number, n: number): number; // Appendix A, reimplemented
```
`compare` counts each compared value as one figure; a row present on one side only is ONE mismatch with `figure: 'row'` (stored or recomputed `null`). Exact for counts, min, max, percentiles; relative 1e-9 (absolute when expected is 0) for mean, stddev, throughput, error rate.

- [ ] **Step 1: Failing tests.** `rank.test.ts`: the integer rule against a sorting oracle over generated datasets (n = 1, ties, p = 50/95/99/99.9, n = 1000 and 100 at p = 99.9 and 7 — the float-rank cases PR 1 measured), p = 0/100. `stats.test.ts`: synthetic event lists (build `CanonicalEvent` objects directly) proving every rule in Appendix A for `run_stat` — the request path join, group rows for both families, warm-up exclusion with `windowMs` anchored at `max(firstMs, runStart + warmupMs)`, a row absent when all its events are warm-up, negative values clamped to 0, the percentile key spelling for 99.9, the throughput window shared by group rows; and `compare` reporting exactly one mismatch for a single corrupted figure in each of: count, p95, mean (beyond 1e-9), a missing row, an extra row. Plus the reference fixture: decode `fixtures/gatling-3.15.1.2/reference-report/simulation.log` with `parseSimulationLog` and assert the run row's count/ok/ko equal the fixture report's numbers derived by counting events (never hard-coded).
- [ ] **Step 2: Run to verify they fail.** `pnpm vitest run packages/verify/test`.
- [ ] **Step 3: Implement.** Collect values per row into arrays, sort ascending once, compute every figure from the sorted array and running sums. No histogram class.
- [ ] **Step 4: Run to pass**; `pnpm lint` (and the new lint probe), typecheck. Red-verify the lint rule by importing `@perfportal/statistics` in a verify source file (lint must fail), then remove it.
- [ ] **Step 5: Commit** ("Add the independent verifier: rank and run statistics").

---

### Task 3: Verifier — series buckets

**Files:** `packages/verify/src/series.ts`, extend `figures.ts`/`compare.ts`/`index.ts`; test `packages/verify/test/series.test.ts`

**Interfaces — Produces:** `ExpectedSeriesBucket { scope; name; family; startOffsetMs; startedCount; endedCount; okCount; koCount; startedOkCount; startedKoCount; minMs; maxMs; meanMs; percentiles; percentilesOk; percentilesKo }`; `Expected.series: ExpectedSeriesBucket[]`; `Stored.series` mirror; compare by key `(scope, name, family, startOffsetMs)`.

- [ ] **Step 1: Failing tests:** width selection (a series whose timestamps span more than `cap` seconds coalesces to the smallest sufficient `1000·2^k`, offsets aligned, negative offsets for events before runStart); start-edge vs end-edge attribution (a request starting in bucket 0 and ending in bucket 2 counts `started` in 0 and `ended`/`ok` in 2, its latency only in 0); empty latency population → zeros and `{}`; the fixed percentile set; warm-up INCLUDED; group series at cap 300; compare catching one corrupted `ok_count` in one bucket (`bucket` = its offset).
- [ ] **Step 2–5:** fail, implement, pass, commit ("Verify series buckets").

---

### Task 4: Verifier — errors, error buckets, users

**Files:** `packages/verify/src/errors.ts`, `src/users.ts`, extend compare/index; tests `packages/verify/test/errors.test.ts`, `users.test.ts`

- [ ] **Step 1: Failing tests:** `(no message)` labelling; KO requests counted at run AND request scope, error records at run scope only; warm-up excluded from `run_error`; the top-200 cut with `localeCompare` tie-break and one `is_other` row (`message ''`) carrying the remainder; error buckets: KO requests only, by `endMs`, width = run series W, first-seen admission to 200, top 5 rows plus a per-bucket other row omitted at 0, `bucket_width_ms`; users: starts before ends at one ms, gap-fill with the standing concurrency, coalescing above 1200 with `max_concurrent` as a max, per scenario. Compare catches one corrupted value in each table.
- [ ] **Step 2–5:** fail, implement, pass, commit ("Verify errors, error buckets and users").

---

### Task 5: `VerifyService`, the `verify` queue, retention

**Files:**
- Create: `apps/worker/src/verify/verify.service.ts`, `apps/worker/src/verify/verify-queue.ts`
- Modify: `apps/worker/src/pipeline/pipeline.service.ts` (enqueue verify after a successful finalize — next to the success `#publish`, never on the failure path), `apps/worker/src/recompute/recompute-queue.ts` (enqueue verify after a `'recomputed'` outcome), `apps/worker/src/sweeper.ts` (retention pass), `apps/worker/src/main.ts` (queue, consumer, scheduler, shutdown, pool/Prisma terms), `apps/worker/src/config.ts` (`rawLogRetentionDays` default 90, `0` = forever, blank = default; `verifyEnabled` default true, `VERIFY_ENABLED=false` defers; `verifyScanIntervalMs` default 600_000), `apps/worker/package.json` (`@perfportal/verify`), `infra/docker-compose.yml` + `infra/.env.example` (`PERFPORTAL_RAW_LOG_RETENTION_DAYS`, `PERFPORTAL_VERIFY_ENABLED`, `PERFPORTAL_VERIFY_SCAN_INTERVAL_MS`, each `${…:-}`)
- Test: `apps/worker/test/verify.integration.test.ts`, `apps/worker/test/verify-queue.integration.test.ts`, `apps/worker/test/retention.integration.test.ts`, `apps/worker/test/config.test.ts`

**Interfaces:**
- Consumes: `openRunSource`/`RawLogMissingError` (`run-source.ts`), `selectPlugin`, `VerificationRepository`, `readStoredFigures`, `expectedFrom`/`compare`/`optionsFrom`/`VERIFIER_VERSION`.
- Produces: `type VerifyOutcome = 'verified' | 'mismatch' | 'locked' | 'gone' | 'not_eligible' | UnverifiableReason`; `class VerifyService { verify(runId): Promise<VerifyOutcome> }`; `const VERIFY_QUEUE = 'verify'`; `startVerifyConsumer`, `enqueueVerification(queue, runId)`, `enqueueVerifyCandidates(queue, repo, batch)` (keyset paging, failed-job re-queue with a logged run id — PR 2's lesson), the Sweeper retention pass.

Behaviour of `verify(runId)`: take the run advisory lock (`RUN_INGEST_LOCK_NAMESPACE`) on a held client → `'locked'` if not acquired (queue delays 30 s, as recompute does); load run → `'gone'`; status not `complete`/`incomplete` or no `run_stat` rows → `'not_eligible'`; `stats_method = 'estimated'` or any legacy row → `markUnverifiable('not_exact')`; `raw_log_deleted_at` set → `markUnverifiable('raw_log_deleted')`; `openRunSource` → `RawLogMissingError` → `raw_log_missing`, checksum or parse failure → `raw_log_unreadable`, transient/`BUNDLE_TOO_LARGE` rethrown (open with `max(project limit, config)` as recompute does); decode with `selectPlugin(...).plugin.parse(source)` into an array; `expectedFrom(events, optionsFrom(run.engineOptions, runStartMs))` where `runStartMs` = the meta event's `startedAtMs`; `readStoredFigures`; `compare`; `record({ status: mismatches.length ? 'mismatch' : 'verified', … rawLogRetainedUntil: days === 0 ? null : ingestedAt + days })`; on mismatch `console.error` one line naming the run and the mismatch count. The queue yields to ingest (waiting/active/delayed), concurrency 1. `markPending` is called when a job is enqueued so the header can say "Verifying…".

Retention pass (in the Sweeper, after its existing work, outside its transaction): when `rawLogRetentionDays > 0`, `retentionDue(days, 100)`; for each: `blobs.delete(bundleKey)` (an object already missing counts as deleted), then `markRawLogDeleted(runId)`. Never touches a run whose verify or recompute job is queued or active — skip a run if `pg_try_advisory_lock` on its run lock fails.

- [ ] **Step 1: Failing tests.** `verify.integration.test.ts` (copy `recompute.integration.test.ts`'s setup): the reference fixture through the REAL pipeline then `verify` → `'verified'` with `figuresChecked > 0` and no mismatches; a live run (raw `simulation.log`) → verified; a run with warm-up `engine_options` → verified; corrupt one stored value per table (`UPDATE run_stat SET count = count + 1 …`, a `run_series_bucket.ok_count`, a `run_error.count`, a `run_user_bucket.max_concurrent`, `run.activity_ms`) → `'mismatch'` naming that table/figure with stored and recomputed values; an estimated run → `not_exact`; deleted object → `raw_log_missing`; `raw_log_deleted_at` set → `raw_log_deleted`; lock held elsewhere → `'locked'` and the row unchanged; pipeline success enqueues a verify job and a pipeline failure does not; a `'recomputed'` outcome enqueues one. `verify-queue.integration.test.ts`: scheduler pages all candidates and re-queues failed jobs (PR 2's two cases, adapted); yields while ingest work waits. `retention.integration.test.ts`: days = 30 deletes the object of a run ingested 31 days ago and not of one 29 days ago; days = 0 deletes nothing; a run whose lock is held is skipped; a never-verified run becomes `unverifiable`/`raw_log_deleted`, a verified run stays verified with `raw_log_deleted_at` set. `config.test.ts`: blank → defaults; `RAW_LOG_RETENTION_DAYS=0` → 0; negative or non-integer → refused at startup with a message naming the variable.
- [ ] **Step 2–4:** fail, implement, pass (plus `pipeline*`, `recompute*`, `fold-owner`, `connection-loss` integration files and `node infra/test/env-example-covers-compose.mjs`, `docker compose -f infra/docker-compose.yml config --quiet` with only the three documented variables).
- [ ] **Step 5: Commit** ("Verify every run against its raw log, and keep raw logs for a set period").

---

### Task 6: API — verification on the run, the verification endpoint, data integrity

**Files:** `packages/contracts/src/run.ts` (`VerificationSchema`, `VerificationSummarySchema`, `RunIdentitySchema.verification` optional), `packages/contracts/src/admin.ts` (`DataIntegritySchema`), `apps/api/src/runs/run-verification.controller.ts` (new, `@Controller('/v1/runs/:id')`, template `run-events.controller.ts`), `apps/api/src/runs/runs.module.ts`, `runs.service.ts` (`lifecycleOf` → `verification` summary), `runs.controller.ts` (202 builder), `apps/api/src/admin/admin.controller.ts` (`GET /v1/admin/data-integrity`), `admin.module.ts`, OpenAPI `schemas.ts`/`document.ts`; tests: contracts, `read.integration.test.ts`, `admin.integration.test.ts`, `access-routes` (two rows), `session-auth` (cross-org endpoint list), `openapi`.

**Interfaces — Produces:**
```ts
VerificationSummarySchema = z.object({ status: z.enum(['pending','verified','mismatch','unverifiable']), reason: z.enum(['raw_log_deleted','raw_log_missing','raw_log_unreadable','not_exact']).nullable() });
// RunIdentitySchema: verification: VerificationSummarySchema.nullable().optional()   // null = no row yet (treated as pending by the web)
VerificationSchema = z.object({ status, reason, checkedAt: z.string().datetime().nullable(), verifierVersion: z.number().int().nullable(), figuresChecked: z.number().int().nonnegative(), mismatches: z.array(FigureMismatchSchema), rawLogRetainedUntil: z.string().date().nullable(), rawLogDeleted: z.boolean() });
DataIntegritySchema = z.object({ recompute: RecomputeProgressSchema, verification: z.object({ verified, mismatch, unverifiable, pending }), problems: z.array(z.object({ runId, projectSlug, status: z.enum(['mismatch','unverifiable']), reason, mismatchCount, checkedAt })), rawLogRetentionDays: z.number().int().nonnegative() });
```
`GET /v1/runs/{id}/verification` → `Verification` (`@Requires('project:read')`, `@Scopes('read')`, 404 for another org/project as every run-scoped read). `GET /v1/admin/data-integrity` (`users:manage`, session only, own org; `problems` limited to 100, newest first). The API reads `RAW_LOG_RETENTION_DAYS` with the worker's rule (default 90, 0 = forever) so the page states the setting.

- [ ] Steps: failing tests (both builders carry `verification`; endpoint 200/404/400 and cross-org 404; admin 200 for admin, 403 for others, counts per org; OpenAPI documented), implement, pass, commit ("Serve each run's verification and the data-integrity summary").

---

### Task 7: Web — header mark, verification panel, Data integrity page

**Files:** `apps/web/src/routes/marks.tsx` (`VERIFICATION` marks), `apps/web/src/routes/VerificationMark.tsx` (new), `apps/web/src/routes/VerificationPanel.tsx` (new), `apps/web/src/api/verification.ts`, `apps/web/src/routes/RunHeader.tsx` (mount beside the status/verdict cluster), `apps/web/src/routes/AdminDataIntegrity.tsx` (new), `AdminShell.tsx` (`SECTIONS` + tab), `paths.ts`, `App.tsx`; tests for each.

- Mark: ✓ "Verified" (passed colour), "Verifying…" (muted; for `pending` or a null summary on a terminal run), ✕ "Verification failed" (failed colour), "Not verified" + the reason in its ⓘ (`raw_log_deleted` "The raw log was deleted after N days, before this run was checked." / `raw_log_missing` / `raw_log_unreadable` / `not_exact` "Its statistics are estimates; see ≈."). No mark for a non-terminal run.
- The mark is a button opening a Radix Popover panel (the panel needs no links; keep focus behaviour accessible — Escape closes and returns focus). The panel fetches `GET /v1/runs/{id}/verification` on open and shows: figures checked, verifier version, checked time, raw log kept until (or "kept indefinitely", or "deleted"), and on a mismatch a table (Table · Row · Figure · Stored · Recomputed, the first 50 with a count of the rest). Nothing else (clean-UI); the Gatling-differences table is PR 4's.
- Data integrity page (`/admin/data-integrity`): the backfill line (reuse `RecomputeProgress`'s text), four counts, the retention setting ("Raw logs are kept for 90 days" / "kept indefinitely"), and a table of problems linking each run. Poll only while something is pending or recomputing.
- Copy follows clean-UI: no description under titles; detail in ⓘ.

- [ ] Steps: failing tests (mark per status and reason; the mark absent for a running run; panel loads on open and renders mismatches; the page's counts, retention text and links; wiring from identity), implement, pass, commit ("Show each run's verification and an admin data-integrity page").

---

### Task 8: ≈ on the multi-run views

**Files:** contracts `RunListResponseSchema` item (`statsMethod` optional), `TrendRunSchema` (`statsMethod` optional), `OrgTestSummarySchema` `p95History[]` and `latestRun` (`statsMethod` optional); persistence `TRENDS_SQL` and `p95Histories`/`latestRuns` select `stats_method` (the run list already does); API mappers (`runs.controller.ts toListItem`, `metrics.controller.ts` trends, `org-tests.controller.ts`); web: `RunList.tsx` p95 card and cell, trends data tables (`transforms/trends.ts` columns — mark the run's row/label, not chart series), compare summary tiles and matrix headers (`RunCompare.tsx`, `buildCompareMatrix.ts`), `Sparkline.tsx` sr summary ("approximately" when any point is estimated) — each through `Approx`/`isExact`; tests per surface.

- [ ] Steps: failing tests (each contract field optional — absent parses; each SQL returns `stats_method`; each surface marks an estimated run and not an exact one), implement, pass, commit ("Mark estimated runs on the run list, trends, compare and home").

---

### Task 9: Gates, a real verification, CLAUDE.md, DEPLOYMENT.md, PR

- [ ] **Step 1:** predict floors from per-file deltas.
- [ ] **Step 2:** every gate on Node 22 and scratch stores (build, typecheck after deleting `.tsbuildinfo`, lint, unit, integration before e2e, e2e on port 3750), each own exit code.
- [ ] **Step 3: Real verification.** A real Gatling run through the Gradle plugin (live) and one through the on-prem runner against this branch's API and worker on the SCRATCH database (recipes: memory `verify-with-real-gatling-runs`; tokens with `stream`); both end `verified` (spec §8). Then corrupt one stored figure in each and re-verify → `mismatch` naming it; then set `RAW_LOG_RETENTION_DAYS=1` with `ingested_at` moved back 2 days on one run and run the sweeper → object gone, row says so, header reads accordingly. Then a CLI-only check on a COPY of the developer database: write a one-off script (in the SDD dir) that calls `VerifyService.verify` for every eligible run of the copy, reading the developer bucket read-only, and report verified/mismatch/unverifiable counts. Drop the copy; confirm the developer database unchanged.
- [ ] **Step 4:** DEPLOYMENT.md (retention: default 90 days DELETES raw logs older than that after upgrade — say so prominently, how to keep them (`0`), how to defer verification); CLAUDE.md entry (what the verifier checks and does not, its independence guard, the queue, retention, measured numbers, floors).
- [ ] **Step 5:** commit; the controller pushes and opens the PR after the final review.

---

## Self-review notes

- §6 verifier: separate package + lint independence (Task 2); decode with the shared decoder (Tasks 2, 5); every figure per scope × name × family × population and per bucket (Tasks 2–4); exact vs 1e-9 (Task 2 compare); verify job own queue after ingest and recompute (Task 5); mismatch status + error log + listed in Data integrity (Tasks 5, 7). The Gatling-method half of §6 is PR 4.
- §3: `run_verification` columns all present (Task 1); `gatling_differences` created empty for PR 4; retention with the sweeper and `raw_log_retained_until` (Tasks 1, 5).
- §7: mark, panel, Data integrity, API (Tasks 6, 7); ≈ on the multi-run views carried from PR 2 (Task 8).
- Deviations, each argued: `unverifiable_reason` gains `raw_log_unreadable` (a checksum/parse failure is neither deleted nor missing) and `not_exact` (an estimated run cannot be verified exactly — a mismatch flood would be false); `tool_assertions` and histogram bytes are not verified (Appendix A).
- Retention deletes data by default after upgrade: this is spec D3 (default 90 days); DEPLOYMENT.md and the PR body must say so prominently, and the user is told before merge.
