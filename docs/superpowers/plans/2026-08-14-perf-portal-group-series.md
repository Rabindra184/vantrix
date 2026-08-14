# Group-scoped time series Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine emit per-group time buckets so GR-04 and GR-06 draw on
the group detail page, narrowing deviation D-14.

**Architecture:** `run_series_bucket` has no `family` column and a group carries
two measures under one name, so Task 1 migrates the table before any series is
worth emitting. Task 2 emits them. Tasks 3–4 carry `family` through the API and
re-capture the fixture. Tasks 5–7 draw them, giving `PercentilesChart` its
identity from the caller — the fourth component in this codebase to need that.

**Tech Stack:** TypeScript, PostgreSQL (partitioned tables), Prisma migrations,
NestJS, React 19, TanStack Query, ECharts, Vitest, Playwright, pnpm workspaces.

## Global Constraints

- Node >= 22. Run `. "$HOME/.nvm/nvm.sh" && nvm use` before any pnpm command.
- **GR-04 and GR-06 are OK-only** (§A.9 F-11). Read `percentilesOk`, never the
  combined `percentiles`. A combined implementation silently includes KO
  responses Gatling excludes.
- **`family` goes after `name` and before `start_offset_ms` in the primary key.**
  `(run_started_on, run_id, scope, name)` must stay a strict prefix — the schema
  deliberately has no secondary index because the PK's btree serves those
  lookups.
- **No backfill of group series.** Runs ingested before this keep their stated
  gap; buckets cannot be reconstructed without re-parsing the bundle.
- **The stated-gap wording must become about the run, not the platform.** After
  this ships, "this platform has not recorded per-group time series" is false.
- **Expectations are computed from the payload, never written down.**
- **Charts never fetch.** Only route components call query factories.
- `Catalog/Recommendations` cannot discriminate the two families — they agree to
  within 1 ms. Use `Cart` (141 vs 225 ms) or `Catalog` (488 vs 592 ms).
- Verify with `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration`;
  e2e with `pnpm test:e2e`. `test:unit` excludes the integration and e2e suites.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/persistence/prisma/migrations/20260814120000_series_family/migration.sql` | **Create.** Add `family`, backfill, NOT NULL, recreate the PK. |
| `packages/persistence/prisma/schema.prisma` | **Modify.** `family` field and the new `@@id`. |
| `packages/persistence/src/metrics/read.ts` | **Modify.** `SERIES_SQL` gains `family`; `series()` selector; new `hasGroupSeries()`. |
| `packages/persistence/src/metrics/write.ts` | **Modify.** `family` in the series column list and row tuples. |
| `packages/statistics/src/engine.ts` | **Modify.** `seriesFor` keyed by family; two group calls; `maxBucketsGroup`. |
| `packages/contracts/src/metrics.ts` | **Modify.** `SeriesResponse.groupSeriesAvailable`. |
| `apps/api/src/metrics/metrics.controller.ts` | **Modify.** `family` query param; set the new flag. |
| `scripts/capture-chart-fixture.mjs` | **Modify.** Capture a group series. |
| `apps/web/test/fixtures/reference-run.json` | **Regenerate.** |
| `apps/web/src/api/metrics.ts` | **Modify.** `seriesQuery` takes `family`. |
| `apps/web/src/charts/PercentilesChart.tsx` | **Modify.** id, title and every testid from the caller. |
| `apps/web/src/routes/GroupDetail.tsx` | **Modify.** Draw both, or state a run-specific gap. |
| `apps/web/e2e/group-detail.spec.ts` | **Modify.** Both charts draw; their controls are independent. |

---

## Task 1: The `family` column, end to end at the persistence layer

**Files:**
- Create: `packages/persistence/prisma/migrations/20260814120000_series_family/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (the `RunSeriesBucket` model)
- Modify: `packages/persistence/src/metrics/read.ts:79-86`, `:140-149`
- Modify: `packages/persistence/src/metrics/write.ts:96-102`
- Modify: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Produces: `SERIES_SQL` filtering on `family`; `reader.series(scope, runId, runStartedOn, sel: { scope: string; name: string; family: string })`; the writer persisting `family`.

**Why the migration and the code land together:** the moment the PK includes
`family`, a writer that does not supply it fails. These cannot be separate
commits without a broken tree between them.

**The risky part is the PK, not the column.** `run_series_bucket` is
range-partitioned monthly (`run_series_bucket_2026_01` … `_2026_12`, declared in
`0001_init`). Dropping and recreating the primary key cascades across all twelve.

**Read `packages/persistence/test/metrics.integration.test.ts` first.** Its tests
run the real engine and write its result, then read back — e.g.
`result.series.get('run ')` compared against
`reader.series(tenant, ctx.runId, STARTED_ON, { scope: 'run', name: '' })`. Do
not hand-build a series map; follow that pattern.

**This task does not emit group series** — the engine gains them in Task 2. What
it proves is that the column, the key and both code paths carry a family at all,
using the `response_time` series that already exist.

- [ ] **Step 1: Write the failing integration test**

Append to `packages/persistence/test/metrics.integration.test.ts`, mirroring the
`round-trips series buckets` test above it for setup:

```ts
  it('round-trips a series through its family', async () => {
    // Everything the engine emits today is response_time; groups add a second
    // family in the next task. What this pins is that family survives the write
    // and is required on the read — a reader ignoring it would return every
    // family's rows interleaved once groups exist.
    const stored = await reader.series(tenant, ctx.runId, STARTED_ON, {
      scope: 'run', name: '', family: 'response_time',
    });
    const engineBuckets = result.series.get('run ')?.buckets ?? [];

    expect(stored).toHaveLength(engineBuckets.length);
    expect(stored.length).toBeGreaterThan(0);

    // A family that was never written returns nothing rather than everything.
    const wrong = await reader.series(tenant, ctx.runId, STARTED_ON, {
      scope: 'run', name: '', family: 'group_cumulated',
    });
    expect(wrong).toEqual([]);
  });
```

That second assertion is the one that matters: a `SERIES_SQL` which accepted the
parameter but did not filter on it would pass the first and fail this.

- [ ] **Step 2: Run it and watch it fail**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts -t 'two families'
```

Expected: FAIL — a type error on the unknown `family` property, or a unique-key
violation, depending on how far it gets.

- [ ] **Step 3: Write the migration**

Create `packages/persistence/prisma/migrations/20260814120000_series_family/migration.sql`:

```sql
-- Appendix A GR-04 and GR-06 need percentiles over time for a GROUP, and a
-- group carries two measures under one name — cumulated response time and
-- wall-clock duration, which diverge whenever its requests overlap. The old
-- primary key (run_started_on, run_id, scope, name, start_offset_ms) has no
-- room for that distinction, so the two collided and one replaced the other.
--
-- NOT NULL with a backfill rather than nullable: every row that exists is a
-- response_time series, and a nullable family would make every later read
-- carry a "which is it" branch for a state that cannot occur.
ALTER TABLE "run_series_bucket" ADD COLUMN "family" TEXT;
UPDATE "run_series_bucket" SET "family" = 'response_time' WHERE "family" IS NULL;
ALTER TABLE "run_series_bucket" ALTER COLUMN "family" SET NOT NULL;

-- FAMILY SITS AFTER name AND BEFORE start_offset_ms, and the position is
-- load-bearing. 0001_init records that there is deliberately no secondary index
-- on (run_started_on, run_id, scope, name) because those columns are a strict
-- prefix of this key and the PK's own btree already serves them. Putting family
-- any earlier breaks that prefix and silently costs every existing series
-- lookup its index, once per partition, with nothing failing to announce it.
--
-- DROP then ADD on the partitioned parent cascades to all twelve partitions.
-- The partition key (run_started_on) stays in the key, which Postgres requires.
ALTER TABLE "run_series_bucket" DROP CONSTRAINT "run_series_bucket_pkey";
ALTER TABLE "run_series_bucket" ADD CONSTRAINT "run_series_bucket_pkey"
  PRIMARY KEY ("run_started_on", "run_id", "scope", "name", "family", "start_offset_ms");
```

- [ ] **Step 4: Update the Prisma model**

In `packages/persistence/prisma/schema.prisma`, add the field after `name` and
change the id:

```prisma
  name          String
  /// Which measure this series is of. 'response_time' for run and request
  /// scope; a group carries 'group_cumulated' AND 'group_duration' under one
  /// name, which is why this is in the primary key.
  family        String
```

```prisma
  @@id([runStartedOn, runId, scope, name, family, startOffsetMs])
```

- [ ] **Step 5: Thread `family` through the reader**

In `packages/persistence/src/metrics/read.ts`, `SERIES_SQL` becomes:

```ts
export const SERIES_SQL = `SELECT start_offset_ms, started_count, ended_count, ok_count, ko_count,
              started_ok_count, started_ko_count,
              min_ms, max_ms, mean_ms, percentiles, percentiles_ok, percentiles_ko
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND name = $6 AND family = $7
        ORDER BY start_offset_ms`;
```

and `series()`'s selector and parameters:

```ts
    sel: { scope: string; name: string; family: string },
  ): Promise<StoredBucket[]> {
    const { rows } = await this.pool.query(
      SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId, sel.scope, sel.name, sel.family],
    );
```

- [ ] **Step 6: Thread `family` through the writer**

In `packages/persistence/src/metrics/write.ts`, add `'family'` to the column
list after `'name'`, and supply the value in each series row tuple:

```ts
        // A LITERAL, and only until the next task. Every series the engine
        // emits today is a response_time series — run scope and request scope
        // — so this is correct rather than a placeholder. Task 2 adds groups,
        // whose entries carry their own family, and replaces this with
        // `entry.family`. Written as a literal here so the tree is never in a
        // state where the PK demands a column the writer cannot supply.
        'response_time',
```

placed to match `'family'`'s position in the column list.

- [ ] **Step 7: Run the test**

```bash
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts
```

Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 8: Prove the partition pruning survived**

This is the check that catches a migration which works and quietly costs every
lookup its index. Find the existing pruning test — it shares `SERIES_SQL`
verbatim for exactly this reason — and confirm it still passes:

```bash
pnpm vitest run --config vitest.integration.config.ts -t 'prune'
```

Expected: PASS. If it fails, the `family` column landed in the wrong position in
the key. Do not adjust the test; fix the migration.

- [ ] **Step 9: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
```

```bash
git add packages/persistence
git commit -m "feat(persistence): a series row carries its metric family"
```

---

## Task 2: The engine emits two series per group

**Files:**
- Modify: `packages/statistics/src/engine.ts:40`, `:99-104`, `:128-139`, `:172-175`
- Modify: `packages/statistics/test/scopes.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at compile time; the writer's new column is fed by this task's output.
- Produces: `EngineResult.series` entries gain `family: MetricFamily`. `seriesFor(scope, name, family, max)`.

**Why this shape:** the group branch already calls `rollupFor` twice, once per
family, eleven lines from `seriesFor`. The two helpers should stop differing.

`BucketSeries` does **not** change — it takes one value per event, so cumulated
and duration are two series rather than one series carrying two sketches. A
`Bucket` widened to hold both would make every run- and request-scope bucket
carry an unused one.

- [ ] **Step 1: Write the failing test**

Append to `packages/statistics/test/scopes.test.ts`, inside the group describe:

```ts
  it('emits a series per family for one group name', () => {
    const r = runEngine(events);
    const catalog = [...r.series.values()].filter(
      (v) => v.scope === 'group' && v.name === 'Catalog',
    );

    expect(catalog.map((v) => v.family).sort()).toEqual([
      'group_cumulated',
      'group_duration',
    ]);

    // The file's `grp(['Catalog'], 0, 500, 300)` is annotated "duration 500,
    // cumulated 300 — deliberately different", so a single series reused for
    // both families would make these sketches equal.
    const cumulated = catalog.find((v) => v.family === 'group_cumulated')!;
    const duration = catalog.find((v) => v.family === 'group_duration')!;
    const maxOf = (v: typeof cumulated) => Math.max(...v.buckets.map((b) => b.maxMs));
    expect(maxOf(cumulated)).not.toBe(maxOf(duration));
  });
```

The group `describe` in this file already builds divergent events — `Catalog` at
cumulated 300 against duration 500 — so no new fixture is needed. Use `Catalog`,
not a name you invent: the assertion depends on that annotated divergence.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/scopes.test.ts -t 'series per family'
```

Expected: FAIL — `expected [] to deeply equal [ 'group_cumulated', 'group_duration' ]`;
no group series exist.

- [ ] **Step 3: Key `seriesFor` by family**

In `packages/statistics/src/engine.ts`, widen the result type at `:40`:

```ts
  series: Map<string, { scope: MetricScope; name: string; family: MetricFamily; buckets: Bucket[] }>;
```

the series map's own entry type, and `seriesFor` at `:99`:

```ts
  // Keyed by (scope, name, family) the same way `rollups` is: the key is an
  // opaque lookup token only, never parsed back — scope, name and family are
  // always read from the stored entry fields, so a name containing a space can
  // never truncate or collide.
  const seriesFor = (
    scope: MetricScope, name: string, family: MetricFamily, max: number,
  ): BucketSeries => {
    const key = `${scope} ${name} ${family}`;
    let entry = series.get(key);
    if (!entry) {
      entry = { scope, name, family, series: new BucketSeries({ startMs: runStartMs, maxBuckets: max }) };
      series.set(key, entry);
    }
    return entry.series;
  };
```

and the final map construction at the bottom of `runEngine`, which must carry
`family` through alongside `scope` and `name`.

- [ ] **Step 4: Give groups a bucket cap and two series**

Add the option beside the others:

```ts
  maxBucketsGroup?: number;
```

```ts
  const maxBucketsGroup = opts.maxBucketsGroup ?? 300;
```

In the group branch, after the two `rollupFor` calls:

```ts
      // GR-04 and GR-06. Two series, not one: cumulated response time and
      // wall-clock duration diverge whenever requests inside the group overlap,
      // which is the same reason `rollupFor` is called twice above.
      //
      // Both edges, matching the request path — the percentiles chart reads the
      // END edge, but a series that only recorded one edge could not later feed
      // a rate chart without a re-ingest.
      const cumulated = seriesFor('group', name, 'group_cumulated', maxBucketsGroup);
      cumulated.add(e.startMs, e.cumulatedResponseTimeMs, e.ok, 'start');
      cumulated.add(e.endMs, e.cumulatedResponseTimeMs, e.ok, 'end');
      const duration = seriesFor('group', name, 'group_duration', maxBucketsGroup);
      duration.add(e.startMs, e.endMs - e.startMs, e.ok, 'start');
      duration.add(e.endMs, e.endMs - e.startMs, e.ok, 'end');
```

**Place these before the warm-up `continue`, not after.** Series include warm-up
(PRD 7.4) while summary stats exclude it — the request branch already splits
this way at `:160` and `:169`, and the group branch's `continue` currently sits
above the rollups.

- [ ] **Step 5: Update the run and request `seriesFor` calls**

Both gain the family argument:

```ts
    const runSeries = seriesFor('run', '', 'response_time', maxBucketsRun);
```

```ts
    const epSeries = seriesFor('request', name, 'response_time', maxBucketsEndpoint);
```

- [ ] **Step 6: Run the statistics suite**

```bash
pnpm vitest run packages/statistics
```

Expected: PASS.

- [ ] **Step 7: Fix the callers of the series map key, which just changed**

`seriesFor`'s key was `` `${scope} ${name}` ``; it is now
`` `${scope} ${name} ${family}` ``. Anything doing a literal `get` on that map
breaks — silently, returning `undefined` and then an empty bucket array, which
several assertions treat as "nothing to compare".

`packages/persistence/test/metrics.integration.test.ts` does exactly this at two
places, both `result.series.get('run ')`. The run-scope key is now
`'run  response_time'` — **two spaces**, because the run's name is the empty
string.

```bash
grep -rn "series.get(" packages apps --include=*.ts | grep -v node_modules | grep -v /dist/
```

Fix every hit. Prefer finding the entry by its fields over rebuilding the key
string — `[...result.series.values()].find(v => v.scope === 'run')` cannot drift
when the key format changes again.

- [ ] **Step 8: Feed `family` to the writer**

In `packages/persistence/src/metrics/write.ts`, replace the `'response_time'`
literal Task 1 left in the series row tuples with `entry.family`. That literal
exists precisely so this task is where it stops being true.

- [ ] **Step 8: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
```

```bash
git add packages/statistics packages/persistence/src/metrics/write.ts
git commit -m "feat(statistics): a group emits a series per metric family"
```

---

## Task 3: The API carries `family` and reports availability

**Files:**
- Modify: `packages/contracts/src/metrics.ts:99`
- Modify: `apps/api/src/metrics/metrics.controller.ts:138-170`
- Modify: `packages/persistence/src/metrics/read.ts`
- Modify: `apps/api/test/read.integration.test.ts`

**Interfaces:**
- Consumes: `reader.series(…, sel: { scope, name, family })` from Task 1.
- Produces: `GET /series?scope=&name=&family=`; `SeriesResponse.groupSeriesAvailable: boolean`; `reader.hasGroupSeries(scope, runId, runStartedOn): Promise<boolean>`.

**The flag's shape differs from `startedSplitAvailable` deliberately.** That one
is derived from the rows themselves, because its columns are nullable and the
rows exist. Here the rows are *absent* for a pre-migration run, and an absent
group series is indistinguishable from a group with no traffic. So this flag is
a separate question about the run: does it have any group series at all?

The seemingly ambiguous case — a run with no groups whatsoever — is unreachable,
because a reader arrives at a group page only from a group row.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/read.integration.test.ts`:

```ts
  it('reports group series as unavailable for a run that has none', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=group&name=Cart&family=group_cumulated`)
      .set(auth());

    expect(res.status).toBe(200);
    // Not "no data" — the run predates group series. An empty bucket array is
    // also what a quiet group returns, which is why this flag exists.
    expect(res.body.groupSeriesAvailable).toBe(false);
    expect(res.body.buckets).toEqual([]);
  });
```

Use the file's existing seeded run, which has no group series until Task 4
re-ingests.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts -t 'unavailable'
```

Expected: FAIL — `expected undefined to be false`; the field does not exist.

- [ ] **Step 3: Add the contract field**

In `packages/contracts/src/metrics.ts`, after `startedSplitAvailable`:

```ts
  /**
   * False when this run has no group-scope series at all — it was ingested
   * before the platform recorded them. An empty `buckets` array is ALSO what a
   * group with no traffic returns, so the two are indistinguishable without
   * this; drawing empty axes would claim the group was measured and found idle.
   *
   * A run-level question, unlike `startedSplitAvailable`, which reads the rows:
   * there the columns are nullable and the rows exist; here the rows are absent.
   */
  groupSeriesAvailable: z.boolean(),
```

- [ ] **Step 4: Add the reader query**

In `packages/persistence/src/metrics/read.ts`:

```ts
/** Existence only — the caller needs a yes/no, and a partition-pruned EXISTS is
 *  cheaper than counting rows it will not read. */
export const HAS_GROUP_SERIES_SQL = `SELECT EXISTS (
         SELECT 1 FROM run_series_bucket
          WHERE run_started_on = $1 AND run_id = $2
            AND org_id = $3 AND project_id = $4
            AND scope = 'group'
        ) AS present`;
```

```ts
  async hasGroupSeries(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      HAS_GROUP_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows[0]?.present === true;
  }
```

- [ ] **Step 5: Wire the endpoint**

In `apps/api/src/metrics/metrics.controller.ts`, the series handler takes the
new parameter and sets the flag:

```ts
    @Query('name') name = '',
    @Query('family') family = 'response_time',
  ): Promise<SeriesResponse> {
    const run = await this.#run(req, id);
    const buckets = await this.reader.series(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      run.startedOn,
      { scope, name, family },
    );
```

```ts
      // Only asked when it can matter. A run-scope or request-scope caller does
      // not need it, and the extra query is not worth issuing for them.
      groupSeriesAvailable:
        scope === 'group'
          ? await this.reader.hasGroupSeries(
              { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
            )
          : false,
```

- [ ] **Step 6: Update the web query factory**

In `apps/web/src/api/metrics.ts`, `seriesQuery` and `seriesQueryKey` take
`family`, defaulting to `'response_time'` so the run and request pages are
unchanged:

```ts
export const seriesQueryKey = (id: string, scope = 'run', name = '', family = 'response_time') =>
  ['run', id, 'series', scope, name, family] as const;
```

```ts
export const seriesQuery = (id: string, scope = 'run', name = '', family = 'response_time') => ({
  queryKey: seriesQueryKey(id, scope, name, family),
  queryFn: () =>
    apiFetch(
      SeriesResponseSchema,
      `${runPath(id)}/series?scope=${encodeURIComponent(scope)}` +
        `&name=${encodeURIComponent(name)}&family=${encodeURIComponent(family)}`,
    ),
});
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
```

```bash
git add packages/contracts packages/persistence apps/api apps/web/src/api/metrics.ts
git commit -m "feat(api): the series endpoint takes a family and reports group availability"
```

---

## Task 4: Re-capture the fixture against a run that has group series

**Files:**
- Modify: `scripts/capture-chart-fixture.mjs`
- Regenerate: `apps/web/test/fixtures/reference-run.json`
- Modify: `apps/web/test/reference-run.fixture.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: a fixture with a `groupSeries` key holding a `SeriesResponse` for `Cart` / `group_cumulated`.

**Why this task is not optional.** Every web test written in Tasks 5–7 reads
this fixture. A stale capture has no group series, so `groupSeriesAvailable`
would be `false` and every new test would exercise the **stated-gap** branch —
the exact state this piece exists to leave behind, passing green.

- [ ] **Step 1: Add the capture**

In `scripts/capture-chart-fixture.mjs`, append to `ENDPOINTS`:

```js
  {
    key: 'groupSeries',
    // `Cart` because its two families diverge (141 ms cumulated against 225 ms
    // duration); `Catalog/Recommendations` agrees to within 1 ms and would let
    // a one-family implementation pass.
    path: (id) =>
      `/v1/runs/${id}/series?scope=group&name=${encodeURIComponent('Cart')}&family=group_cumulated`,
  },
```

and to the `nonEmpty` guard:

```js
    // Empty here means the run was ingested without group series — the whole
    // point of this capture — so it must fail loudly rather than be written.
    'groupSeries.buckets': captured.groupSeries.buckets.length,
```

- [ ] **Step 2: Bring up the stack, rebuild, re-ingest and capture**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
. "$HOME/.nvm/nvm.sh" && nvm use && pnpm build
```

Start the API in a second shell and leave it running, then:

```bash
node --experimental-strip-types scripts/capture-chart-fixture.mjs
```

The script seeds and ingests a fresh run, so the captured run has group series
provided Tasks 1–2 are built into the running server. **Never run
`pnpm test:integration` while the capture is in flight** — it truncates every
table on setup.

- [ ] **Step 3: Verify the capture before using it**

```bash
node -e "
const f=require('./apps/web/test/fixtures/reference-run.json');
console.log('groupSeries buckets:', f.groupSeries.buckets.length);
console.log('groupSeriesAvailable:', f.groupSeries.groupSeriesAvailable);
console.log('family:', f._capture.endpoints.groupSeries);
"
```

Expected: a non-zero bucket count and `groupSeriesAvailable: true`. If the flag
is `false`, the API you captured from predates Task 3 — rebuild and restart it.

- [ ] **Step 4: Assert the fixture is fit for purpose**

Append to `apps/web/test/reference-run.fixture.test.ts`:

```ts
  it('carries a group series with buckets to draw', () => {
    const s = SeriesResponseSchema.parse(fixture.groupSeries);
    expect(s.scope).toBe('group');
    expect(s.name).toBe('Cart');
    expect(s.groupSeriesAvailable).toBe(true);
    expect(s.buckets.length).toBeGreaterThan(0);
    // OK-only percentiles are what GR-04 reads (§A.9 F-11); a bucket without
    // them would make every percentile assertion vacuous.
    expect(s.buckets.some((b) => b.percentilesOk !== null)).toBe(true);
  });
```

- [ ] **Step 5: Run the unit suite and commit**

```bash
pnpm test:unit
```

Expected: PASS. Existing series tests read `fixture.series`, which is unchanged
in shape.

```bash
git add scripts/capture-chart-fixture.mjs apps/web/test/fixtures/reference-run.json apps/web/test/reference-run.fixture.test.ts
git commit -m "test(web): capture a group series, so the drawn branch is testable"
```

---

## Task 5: `PercentilesChart` takes its whole identity from the caller

**Files:**
- Modify: `apps/web/src/charts/PercentilesChart.tsx:30`, `:54`, `:70`, `:80-81`
- Create: `apps/web/test/PercentilesChart.identity.test.tsx`

**Interfaces:**
- Produces: `PercentilesChart` gains `id?: string` and `title?: string`, defaulting to `'percentiles'` and `'Response time percentiles over time'`.

**This is the fourth component in this codebase to need this**, after
`DistributionChart`, `ScopedStatistics` and `IndicatorsChart`. The rule: a
component that names itself cannot appear twice on a page.

**Here it is sharper than a duplicated heading.** `PercentilesChart` owns
interactive state — a scale toggle at `data-testid="scale-toggle"` and a band
selector at `data-testid={\`band-${band}\`}`. Two instances give the page two
toggles answering to one testid and two band selectors a test cannot tell apart.
**Every testid the component emits must derive from `id`**, not just the figure.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PercentilesChart.identity.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SeriesResponseSchema } from '@perfportal/contracts';
import PercentilesChart from '../src/charts/PercentilesChart';
import fixture from './fixtures/reference-run.json';

afterEach(cleanup);

const series = SeriesResponseSchema.parse(fixture.series);

describe('PercentilesChart identity', () => {
  it('derives every testid from the caller’s id', () => {
    render(
      <>
        <PercentilesChart series={series} id="percentiles-a" title="A" />
        <PercentilesChart series={series} id="percentiles-b" title="B" />
      </>,
    );

    // Two charts, two independent control sets. A hardcoded testid gives one
    // ambiguous match per control and `getByTestId` throws.
    expect(screen.getByTestId('scale-toggle-percentiles-a')).toBeInTheDocument();
    expect(screen.getByTestId('scale-toggle-percentiles-b')).toBeInTheDocument();
    expect(screen.queryByTestId('scale-toggle')).not.toBeInTheDocument();
  });

  it('keeps the default identity when the caller names nothing', () => {
    render(<PercentilesChart series={series} />);
    expect(screen.getByTestId('scale-toggle-percentiles')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/PercentilesChart.identity.test.tsx
```

Expected: FAIL — `Unable to find an element by: [data-testid="scale-toggle-percentiles-a"]`.

- [ ] **Step 3: Take id and title from the caller**

In `apps/web/src/charts/PercentilesChart.tsx`:

```tsx
/**
 * `id` and `title` are props because the GROUP detail page renders TWO of these
 * — one per metric family — and a component that names itself cannot appear
 * twice. That is true of the figure, and doubly so here: this chart owns a
 * scale toggle and a band selector, so a hardcoded testid gives a page two
 * controls a test cannot tell apart. Every testid below derives from `id`.
 *
 * Defaults keep the run and request pages, which render exactly one, unchanged.
 */
export default function PercentilesChart({
  series,
  id = 'percentiles',
  title = 'Response time percentiles over time',
}: {
  readonly series: SeriesResponse;
  readonly id?: string;
  readonly title?: string;
}) {
```

Then `data-testid={\`band-${band}-${id}\`}` at `:54`,
`data-testid={\`scale-toggle-${id}\`}` at `:70`, and `id={id} title={title}` on
the `Chart` at `:80-81`.

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run apps/web/test/PercentilesChart.identity.test.tsx apps/web/test/RunDetail.polling.test.tsx
```

Expected: PASS. Any existing test or e2e selecting `scale-toggle` or `band-*`
by the bare name now needs the `-percentiles` suffix — update those selectors
rather than reverting the change, and name them in your report.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/PercentilesChart.tsx apps/web/test apps/web/e2e
git commit -m "fix(web): a percentiles chart takes its whole identity from the caller"
```

---

## Task 6: The group page draws both, or states a run-specific gap

**Files:**
- Modify: `apps/web/src/routes/GroupDetail.tsx`
- Modify: `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `seriesQuery(id, scope, name, family)` (Task 3), `PercentilesChart` with `id`/`title` (Task 5), `groupSeriesAvailable` on the payload.

**The stated-gap wording must change.** `NO_GROUP_SERIES` currently says "This
platform has not recorded per-group time series". After this piece that is
false — the platform does. It must become about the run.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/GroupDetail.test.tsx`:

```tsx
it('draws both percentile charts when the run has group series', async () => {
  const series = fixture.groupSeries;
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/series')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(JSON.stringify({ ...series, family }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('/runs/r1/groups/Cart');

  await waitFor(() => {
    expect(screen.getByTestId('chart-percentiles-group_cumulated')).toBeInTheDocument();
    expect(screen.getByTestId('chart-percentiles-group_duration')).toBeInTheDocument();
  });
  // DRAWN, not stated: the gap sentence must be gone.
  expect(screen.queryByText(/not recorded/i)).not.toBeInTheDocument();
});

it('states a RUN-specific gap when the run has no group series', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/series')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ...fixture.groupSeries, groupSeriesAvailable: false, buckets: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('/runs/r1/groups/Cart');

  await waitFor(() => {
    const figure = screen.getByTestId('chart-percentiles-group_cumulated');
    // About THIS RUN, not about the platform — the platform records these now.
    expect(figure.textContent).toMatch(/this run/i);
    expect(figure.textContent).not.toMatch(/platform/i);
  });
});
```

Use the `renderGroupDetail` helper the file already has.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx -t 'group series'
```

Expected: FAIL — the charts are `Undrawn` placeholders and the wording still
says "platform".

- [ ] **Step 3: Fetch both families and draw or state**

In `GroupDetail.tsx`, add a series query per family beside the distributions:

```tsx
  const cumulatedSeries = useQuery({
    ...seriesQuery(runId ?? '', 'group', name ?? '', 'group_cumulated'),
    enabled: runId !== undefined && name !== undefined,
  });
  const durationSeries = useQuery({
    ...seriesQuery(runId ?? '', 'group', name ?? '', 'group_duration'),
    enabled: runId !== undefined && name !== undefined,
  });
  const seriesFor = { group_cumulated: cumulatedSeries, group_duration: durationSeries };
```

Replace the wording:

```tsx
/**
 * D-14, narrowed. The platform records per-group series as of piece 5, so this
 * is a fact about THIS RUN, not about the product — a page that still blamed
 * the platform would be making a false claim about it.
 */
const NO_GROUP_SERIES =
  'This run was ingested before the platform recorded per-group time series, so percentiles ' +
  'over time cannot be drawn for it. The statistics and distribution above are computed from ' +
  'measurements this run does carry.';
```

and replace the unconditional `Undrawn` inside the `FAMILIES.map` with the
drawn-or-stated branch:

```tsx
          <Payload query={seriesFor[family]} slots={[percentiles]}>
            {(data) =>
              data.groupSeriesAvailable ? (
                <PercentilesChart series={data} id={percentiles.id} title={percentiles.title} />
              ) : (
                <Undrawn slot={percentiles} reason={NO_GROUP_SERIES} />
              )
            }
          </Payload>
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run apps/web/test/GroupDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/GroupDetail.tsx apps/web/test/GroupDetail.test.tsx
git commit -m "feat(web): GR-04 and GR-06 draw, narrowing D-14 to pre-migration runs"
```

---

## Task 7: e2e — both charts draw, and their controls are independent

**Files:**
- Modify: `apps/web/e2e/group-detail.spec.ts`

**Interfaces:** none.

The stack must be up; the e2e seeds and ingests its own run, so it has group
series once Tasks 1–2 are built.

**The assertion that matters:** two charts whose controls happen to move
together satisfy any test that only drives one. Operate one chart's scale toggle
and assert the *other* is unchanged.

- [ ] **Step 1: Replace the stated-gap test**

The existing test asserting both percentile figures say "not recorded" is now
wrong — a freshly seeded run has group series. Replace it:

```ts
test('both percentile charts draw, with independent controls', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/groups/Cart`);

  const cumulated = page.getByTestId('chart-percentiles-group_cumulated');
  const duration = page.getByTestId('chart-percentiles-group_duration');
  await expect(cumulated).toBeVisible();
  await expect(duration).toBeVisible();

  // Each carries its own data table — the parity surface.
  await expect(page.getByTestId('chart-data-percentiles-group_cumulated')).toHaveCount(1);
  await expect(page.getByTestId('chart-data-percentiles-group_duration')).toHaveCount(1);

  // INDEPENDENT, not one control rendered twice: drive one and assert the other
  // did not move. A shared testid would also make these locators ambiguous.
  // The toggle carries aria-pressed={scale === 'log'} and starts on log, so
  // clicking one flips it to "false" while the other stays "true". Asserted on
  // aria-pressed rather than the label ("Log scale"/"Linear scale") because it
  // is the accessible state a screen reader reads, and it cannot drift with
  // copy.
  const cumulatedToggle = page.getByTestId('scale-toggle-percentiles-group_cumulated');
  const durationToggle = page.getByTestId('scale-toggle-percentiles-group_duration');
  await expect(cumulatedToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(durationToggle).toHaveAttribute('aria-pressed', 'true');

  await cumulatedToggle.click();

  await expect(cumulatedToggle).toHaveAttribute('aria-pressed', 'false');
  // THE ASSERTION THIS TEST EXISTS FOR: one control moved, the other did not.
  await expect(durationToggle).toHaveAttribute('aria-pressed', 'true');

  // GR-07 still does not exist (§A.9 F-4).
  await expect(page.getByTestId('chart-requests-per-second')).toHaveCount(0);
  await expect(page.getByTestId('chart-responses-per-second')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it**

```bash
pnpm build && pnpm test:e2e apps/web/e2e/group-detail.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run every suite and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

```bash
git add apps/web/e2e/group-detail.spec.ts
git commit -m "test(web): both group percentile charts draw with independent controls"
```

---

## Falsification checkpoints

Run each after Task 7. Break the code as named, confirm the named test behaves
as stated, revert.

| # | Break this | This must fail |
|---|---|---|
| 1 | move `family` after `scope` in the PK, re-migrate | the partition-pruning test still prunes |
| 2 | read `percentiles` instead of `percentilesOk` | the chart is OK-only (§A.9 F-11) |
| 3 | emit one group series instead of two | cumulated and duration are distinct series |
| 4 | return `groupSeriesAvailable: true` unconditionally | an old run states its gap rather than drawing empty axes |
| 5 | restore the old "this platform" wording | the sentence is about this run |
| 6 | give both percentile charts the same `id` | each family's figure, toggle and band selector is its own |
| 7 | drive one toggle and assert the other moved too | the controls are independent |
| 8 | assert families differ using `Catalog/Recommendations` | **it must still pass** — that group cannot discriminate, which is why 3 uses `Cart` |

Checkpoints 1 and 5 are the non-numeric ones. Checkpoint 1 is the only one that
catches a migration which works and silently costs every series lookup its
index; it is the likeliest to be waved through as an optimisation detail.

---

## Done when

A person opens a group on a newly ingested run and sees five drawn containers,
matching Gatling's own group page. The same page on a run ingested before this
piece draws three and states two gaps, naming the run rather than the platform.
`pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration` and
`pnpm test:e2e` are green, and every checkpoint above has been run and shown to
behave as named.

D-14 is narrowed in the ledger, not deleted.
