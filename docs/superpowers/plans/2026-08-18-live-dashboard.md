# Live run monitoring part 2b — the fan-out and the live dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a live delta from the Redis channel part 2a publishes to a chart in a browser, so a running run's page shows FR-LIVE-4's six items instead of a spinner.

**Architecture:** The delta widens to carry per-bucket latency and run-scope error rows (both already computed, neither serialized today). The fold owner additionally writes a whole-state snapshot key every 60 ticks, because each delta is a lookback window and the replay stream only reaches back ~17 minutes. A Nest WebSocket gateway seeds each connection from that snapshot server-side, replays the stream, then joins a per-pod pub/sub fan-out. The web client writes deltas into the React Query cache under the keys REST already uses, so the charts are unmodified.

**Tech Stack:** TypeScript, Nest (`@nestjs/websockets` + `@nestjs/platform-ws`), ioredis, React + React Query, ECharts, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-live-run-monitoring-part-2b-design.md`

## Global Constraints

- **Node 22.** `nvm use` first. On Node 20 roughly two thirds of the unit suite silently does not load — every DOM-environment file — and vitest still prints a green summary above the errors.
- **Unit floor: 99 files / 1079 tests.** A run reporting fewer did not run everything. Raise this number in `CLAUDE.md` as tasks add suites.
- **Full gate, in this order:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. Integration BEFORE e2e — a truncating integration suite under a still-draining Playwright worker produces a failure that reproduces on nothing.
- **Every task runs `pnpm typecheck && pnpm lint` before committing.** Not just tests.
- **`BUCKET_PERCENTILES` is fixed** — `[25, 50, 75, 80, 85, 90, 95, 99]`, `packages/statistics/src/engine.ts:26`. It is NOT the project's configured `percentiles`, which apply to run-scope rollups only.
- **An empty sketch's percentiles are `{}`, and its min/max/mean are `0`.** That asymmetry is deliberate (a p95 of 0 is a fabricated observation) and must be preserved exactly.
- **`type: 'value'` x-axes need PAIR-shaped series.** Scalars fail silently — ECharts plots the measure against itself, a 45° line, with no error.
- **Never put `uppercase` on anything queried by accessible name.** Playwright applies `text-transform` when computing names; jsdom does not.
- **Before adding a `<table>`, grep the e2e suite for `getByRole('table'`** and make sure the new `<caption>` shares no distinctive word with an existing one. Playwright matches names as a case-insensitive substring.
- **Do not add a decorative `<svg>` inside a chart `<figure>`.** Nine specs count SVG elements within the figure to prove a chart drew.

---

## File Structure

**Created**
- `packages/statistics/src/bucket-latency.ts` — the one derivation of a bucket's latency fields, shared by the batch writer and the live publisher.
- `apps/api/src/live/live-hub.ts` — one ioredis subscriber per pod; `Map<runId, Set<WebSocket>>`; join/leave.
- `apps/api/src/live/live.gateway.ts` — the `/v1/runs/:id/live` endpoint: explicit auth, server-side seed, replay, fan-out.
- `apps/api/src/live/live.module.ts` — wiring.
- `apps/web/src/api/live.ts` — `useLiveRun(runId)` and the socket client.
- `apps/web/src/routes/LiveNotice.tsx` — the "available when the run finishes" and "finalizing" states.

**Modified**
- `packages/persistence/src/metrics/write.ts` — calls the shared helper; loses its private copy.
- `packages/contracts/src/live-delta.ts` — the widened bucket, the errors envelope.
- `apps/worker/src/live/delta.ts` — populates them; gains `buildSnapshot`.
- `apps/worker/src/live/fold-owner.ts` — writes the snapshot key.
- `apps/web/src/routes/useRunWindow.ts` — the time domain grows on a live run.
- `apps/web/src/routes/RunDetail.tsx` — renders live instead of `Processing` when running.
- `packages/storage/src/live-chunks.ts` — the part 2a residuals.

---

## Task 1: Extract `bucketLatency`

Pure refactor. No behaviour change, and the existing batch tests prove it.

**Files:**
- Create: `packages/statistics/src/bucket-latency.ts`
- Create: `packages/statistics/test/bucket-latency.test.ts`
- Modify: `packages/statistics/src/index.ts`
- Modify: `packages/persistence/src/metrics/write.ts:75-96` and `:184-189`

**Interfaces:**
- Consumes: `Bucket` (`packages/statistics/src/buckets.ts`) — has `sketch`, `sketchOk`, `sketchKo`, each a `Sketch` with `count`, `min`, `max`, `sum`, `quantile(q)`. `BUCKET_PERCENTILES` from `./engine.js`.
- Produces: `bucketLatency(b): BucketLatency` and the `BucketLatency` interface, exported from `@perfportal/statistics`.

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/bucket-latency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BUCKET_PERCENTILES, Sketch, bucketLatency } from '../src/index.js';

/** A bucket-shaped object carrying only what bucketLatency reads. */
function bucketOf(all: number[], ok: number[], ko: number[]) {
  const fill = (xs: number[]) => {
    const s = new Sketch();
    for (const x of xs) s.add(x);
    return s;
  };
  return { sketch: fill(all), sketchOk: fill(ok), sketchKo: fill(ko) };
}

describe('bucketLatency', () => {
  it('derives min, max and mean from the all-outcomes sketch', () => {
    const out = bucketLatency(bucketOf([10, 20, 60], [10, 20], [60]));
    expect(out.minMs).toBe(10);
    expect(out.maxMs).toBe(60);
    expect(out.meanMs).toBe(30);
  });

  it('emits every fixed band, for each outcome split', () => {
    const out = bucketLatency(bucketOf([10, 20, 60], [10, 20], [60]));
    const expected = BUCKET_PERCENTILES.map((p) => `p${p}`);
    expect(Object.keys(out.percentiles)).toEqual(expected);
    expect(Object.keys(out.percentilesOk)).toEqual(expected);
    expect(Object.keys(out.percentilesKo)).toEqual(expected);
  });

  // The asymmetry is deliberate and is the thing a reimplementation gets
  // wrong: an empty sketch has no observations, so a p95 of 0 would be
  // fabricated -- but min/max/mean are 0 because the batch writer's columns
  // are NOT NULL. Both halves are asserted so neither can drift alone.
  it('returns {} for an empty sketch but 0 for its min, max and mean', () => {
    const out = bucketLatency(bucketOf([], [], []));
    expect(out.percentiles).toEqual({});
    expect(out.percentilesOk).toEqual({});
    expect(out.percentilesKo).toEqual({});
    expect(out.minMs).toBe(0);
    expect(out.maxMs).toBe(0);
    expect(out.meanMs).toBe(0);
  });

  it('gives an all-KO bucket empty OK bands and populated KO bands', () => {
    const out = bucketLatency(bucketOf([60], [], [60]));
    expect(out.percentilesOk).toEqual({});
    expect(Object.keys(out.percentilesKo)).toHaveLength(BUCKET_PERCENTILES.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/statistics/test/bucket-latency.test.ts`
Expected: FAIL — `bucketLatency` is not exported.

- [ ] **Step 3: Write the helper**

`packages/statistics/src/bucket-latency.ts`:

```ts
import type { Bucket } from './buckets.js';
import { BUCKET_PERCENTILES } from './engine.js';

/** A bucket's latency fields, as both the batch writer and the live publisher need them. */
export interface BucketLatency {
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
  percentilesOk: Record<string, number>;
  percentilesKo: Record<string, number>;
}

/**
 * An empty sketch returns {}, not a band of zeros. A p95 of 0 is a fabricated
 * observation for a bucket that made none.
 */
function percentilesOf(sketch: { count: number; quantile(q: number): number }): Record<string, number> {
  if (sketch.count === 0) return {};
  const out: Record<string, number> = {};
  for (const p of BUCKET_PERCENTILES) out[`p${p}`] = sketch.quantile(p / 100);
  return out;
}

/**
 * THE ONLY derivation of a bucket's latency fields, and that is deliberate.
 *
 * `MetricWriter` persists these for a finished run; `buildDelta` publishes them
 * for a live one. A second copy drifts, and the drift surfaces as the live
 * chart contradicting the final report -- the worst failure this product can
 * produce, and the same argument that keeps exactly one record decoder.
 *
 * The empty-sketch answers are where a reimplementation goes wrong: percentiles
 * collapse to {} while min/max/mean stay 0, because the writer's columns are
 * NOT NULL and a fabricated percentile is worse than an absent one.
 */
export function bucketLatency(b: Pick<Bucket, 'sketch' | 'sketchOk' | 'sketchKo'>): BucketLatency {
  return {
    minMs: b.sketch.count === 0 ? 0 : b.sketch.min,
    maxMs: b.sketch.count === 0 ? 0 : b.sketch.max,
    meanMs: b.sketch.count === 0 ? 0 : b.sketch.sum / b.sketch.count,
    percentiles: percentilesOf(b.sketch),
    percentilesOk: percentilesOf(b.sketchOk),
    percentilesKo: percentilesOf(b.sketchKo),
  };
}
```

- [ ] **Step 4: Export it**

Add to `packages/statistics/src/index.ts`, after the `buckets.js` line:

```ts
export * from './bucket-latency.js';
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm vitest run packages/statistics/test/bucket-latency.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Switch `MetricWriter` to it**

In `packages/persistence/src/metrics/write.ts`, change the import on line 2 — **drop `BUCKET_PERCENTILES`**, which becomes unused here and will fail lint if left:

```ts
import { HISTOGRAM_KIND, SKETCH_KIND, bucketLatency } from '@perfportal/statistics';
```

Replace the six derived values in the `bucketRows.push([...])` call. The block currently reading:

```ts
          b.sketch.count === 0 ? 0 : b.sketch.min,
          b.sketch.count === 0 ? 0 : b.sketch.max,
          b.sketch.count === 0 ? 0 : b.sketch.sum / b.sketch.count,
          // Only the configured percentiles are stored per bucket; per spec §9.1
          // bucket sketches are deliberately not persisted.
          JSON.stringify(percentilesOf(b.sketch)),
          JSON.stringify(percentilesOf(b.sketchOk)),
          JSON.stringify(percentilesOf(b.sketchKo)),
```

becomes — noting that `lat` must be computed inside the `for (const b of entry.buckets)` loop, above the `push`:

```ts
        // The one derivation, shared with the live publisher — see
        // bucketLatency's own doc comment for why it is not inlined here.
        // Bucket sketches themselves are deliberately not persisted (spec §9.1).
        const lat = bucketLatency(b);
```

```ts
          lat.minMs,
          lat.maxMs,
          lat.meanMs,
          JSON.stringify(lat.percentiles),
          JSON.stringify(lat.percentilesOk),
          JSON.stringify(lat.percentilesKo),
```

Then delete the private `percentilesOf` function and its doc comment at the bottom of the file (lines ~165-189), **keeping** the paragraph about `BUCKET_PERCENTILES` being a fixed set by moving it into `bucket-latency.ts` if it is not already covered there.

- [ ] **Step 7: Prove the refactor changed nothing**

Run: `pnpm test:unit`
Expected: PASS, and **at least 100 files / 1083 tests** (the floor plus this task's new file). The persistence and parity tests are what prove the extraction is behaviour-preserving — if any of them moved, the extraction is wrong, not the test.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/statistics/src/bucket-latency.ts packages/statistics/test/bucket-latency.test.ts packages/statistics/src/index.ts packages/persistence/src/metrics/write.ts
git commit -m "refactor(statistics,persistence): one derivation of a bucket's latency fields

percentilesOf was private to write.ts, and part 2b's live publisher needs
the same numbers. A second copy drifts, and the drift surfaces as the live
chart contradicting the final report -- the same argument that keeps
exactly one record decoder.

Extracted as bucketLatency to @perfportal/statistics, where
BUCKET_PERCENTILES already lived. No behaviour change: the batch and parity
suites are the proof."
```

- [ ] **Step 9: Raise the floor in CLAUDE.md**

Update the two numbers in the Verification section from `99 files / 1079 tests` to what Step 7 measured, adding a sentence naming `packages/statistics/test/bucket-latency.test.ts` and its case count.

---

## Task 2: The response bucket carries latency

**Files:**
- Modify: `packages/contracts/src/live-delta.ts` — `LiveSeriesBucketSchema`
- Modify: `apps/worker/src/live/delta.ts:174-180` — the bucket mapping
- Test: `packages/contracts/test/live-delta.test.ts`, `apps/worker/test/live-delta.test.ts`

**Interfaces:**
- Consumes: `bucketLatency(b): BucketLatency` from `@perfportal/statistics` (Task 1).
- Produces: `LiveDelta['responseTime']['buckets'][number]` carrying `startedOkCount`, `startedKoCount`, `minMs`, `maxMs`, `meanMs`, `percentiles`, `percentilesOk`, `percentilesKo` alongside the five count fields it already had.

- [ ] **Step 1: Write the failing parity test**

Add to `apps/worker/test/live-delta.test.ts`. This is spec §5.1 — the load-bearing case:

```ts
it('publishes the same latency fields the batch writer would persist for the same bucket', () => {
  // Build a run whose buckets are not uniform, so a wrong-bucket bug shows.
  const result = engineResultFrom([
    { startMs: 0, endMs: 120, ok: true },
    { startMs: 100, endMs: 900, ok: true },
    { startMs: 1200, endMs: 1260, ok: false },
  ]);
  const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR);

  const source = result.series.get('run  response_time')!.buckets;
  for (const published of delta.responseTime.buckets) {
    const origin = source.find((b) => b.startOffsetMs === published.startOffsetMs)!;
    const expected = bucketLatency(origin);
    expect(published.minMs).toBe(expected.minMs);
    expect(published.maxMs).toBe(expected.maxMs);
    expect(published.meanMs).toBe(expected.meanMs);
    expect(published.percentiles).toEqual(expected.percentiles);
    expect(published.percentilesOk).toEqual(expected.percentilesOk);
    expect(published.percentilesKo).toEqual(expected.percentilesKo);
    expect(published.startedOkCount).toBe(origin.startedOkCount);
    expect(published.startedKoCount).toBe(origin.startedKoCount);
  }
});
```

Derive `expected` from the payload via `bucketLatency`, never from written-down numbers — a hard-coded value breaks on the next fixture re-capture for a reason that is not a defect.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: FAIL — `published.minMs` is `undefined`.

- [ ] **Step 3: Widen the schema**

In `packages/contracts/src/live-delta.ts`, replace `LiveSeriesBucketSchema`:

```ts
/**
 * The SAME shape `SeriesBucketSchema` uses (`metrics.ts`), field for field and
 * nullability for nullability -- so a live bucket and a persisted one are
 * indistinguishable to `toPercentiles` and the chart transforms need no live
 * branch. The nullable started splits are nullable in the REST schema because
 * old persisted rows may lack them; a live bucket always sends a number.
 */
export const LiveSeriesBucketSchema = z.object({
  startOffsetMs: z.number().int(),
  startedCount: z.number().int(),
  endedCount: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  startedOkCount: z.number().int().nullable(),
  startedKoCount: z.number().int().nullable(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  percentiles: z.record(z.string(), z.number()),
  percentilesOk: z.record(z.string(), z.number()),
  percentilesKo: z.record(z.string(), z.number()),
});
```

- [ ] **Step 4: Populate it**

In `apps/worker/src/live/delta.ts`, add the import:

```ts
import { bucketLatency } from '@perfportal/statistics';
```

and replace the mapping:

```ts
  const responseTimeBuckets: LiveDelta['responseTime']['buckets'] = freshBuckets.map((b) => ({
    startOffsetMs: b.startOffsetMs,
    startedCount: b.startedCount,
    endedCount: b.endedCount,
    okCount: b.okCount,
    koCount: b.koCount,
    startedOkCount: b.startedOkCount,
    startedKoCount: b.startedKoCount,
    // Spread last: bucketLatency owns every latency field, and listing them
    // individually here would be the second copy Task 1 exists to prevent.
    ...bucketLatency(b),
  }));
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts packages/contracts/test/live-delta.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the schema case**

In `packages/contracts/test/live-delta.test.ts`:

```ts
it('rejects a response bucket missing its latency fields', () => {
  const delta = validDelta();
  delete (delta.responseTime.buckets[0] as Record<string, unknown>).percentiles;
  expect(() => LiveDeltaSchema.parse(delta)).toThrow();
});
```

- [ ] **Step 7: Typecheck, lint, full unit, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add packages/contracts/src/live-delta.ts packages/contracts/test/live-delta.test.ts apps/worker/src/live/delta.ts apps/worker/test/live-delta.test.ts
git commit -m "feat(contracts,worker): the live response bucket carries latency

PercentilesChart plots bands PER BUCKET, and a live bucket carried only
counts -- so FR-LIVE-4's 'response time percentiles' was unbuildable from
the delta, and REST cannot cover it during a run (metrics are written by
MetricWriter inside the parse pipeline, after close()).

Every Bucket already holds the sketches; only the serialization dropped
them. Fields, names and nullability match SeriesBucketSchema exactly, so
the chart transforms need no live branch."
```

---

## Task 3: The run-scope errors envelope

**Files:**
- Modify: `packages/contracts/src/live-delta.ts`
- Modify: `apps/worker/src/live/delta.ts`
- Test: `packages/contracts/test/live-delta.test.ts`, `apps/worker/test/live-delta.test.ts`

**Interfaces:**
- Consumes: `EngineResult.errors` — `{ scope: MetricScope; name: string; message: string | null; count: number }[]`, already capped at `top(200)` per key by `Engine.snapshot()`.
- Produces: `LiveDelta['errors']` — `{ rows: { message: string | null; count: number }[] }`.

- [ ] **Step 1: Write the failing test**

In `apps/worker/test/live-delta.test.ts`:

```ts
it('carries run-scope error rows, and no per-endpoint rows', () => {
  const result = engineResultWithErrors([
    { scope: 'run', name: '', message: 'connection reset', count: 7 },
    { scope: 'request', name: 'GET /cart', message: 'connection reset', count: 7 },
  ]);
  const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR);
  expect(delta.errors.rows).toEqual([{ message: 'connection reset', count: 7 }]);
});

// ErrorTally folds everything past its cap into one `message: null` row.
// Dropping it would make the rows fail to sum to summary.koCount, which is
// the one arithmetic a reader can check by eye.
it('keeps the folded remainder row rather than dropping it', () => {
  const result = engineResultWithErrors([
    { scope: 'run', name: '', message: 'timeout', count: 3 },
    { scope: 'run', name: '', message: null, count: 11 },
  ]);
  const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR);
  expect(delta.errors.rows).toContainEqual({ message: null, count: 11 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: FAIL — `delta.errors` is `undefined`.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/live-delta.ts`, before `LiveDeltaSchema`:

```ts
export const LiveErrorRowSchema = z.object({
  /** `null` is `ErrorTally`'s folded remainder, carried rather than dropped. */
  message: z.string().nullable(),
  count: z.number().int(),
});
export type LiveErrorRow = z.infer<typeof LiveErrorRowSchema>;

/**
 * RUN SCOPE ONLY. Per-endpoint error rows are excluded on part 2a §3.2's
 * argument unchanged: their count tracks the run's endpoint cardinality (2000
 * at the cap), so a live run would publish thousands of rows every tick to
 * every subscriber. The Errors tab's per-request drill-down is a REST read on
 * a finished run.
 */
export const LiveErrorsSchema = z.object({
  rows: z.array(LiveErrorRowSchema),
});
export type LiveErrors = z.infer<typeof LiveErrorsSchema>;
```

and add to `LiveDeltaSchema`, after `users`:

```ts
  errors: LiveErrorsSchema,
```

- [ ] **Step 4: Populate it**

In `buildDelta`, before assembling the returned delta:

```ts
  // Run scope only -- see LiveErrorsSchema. `top(200)` per key is already
  // applied by Engine.snapshot(), so this is bounded before it arrives.
  const errorRows = result.errors
    .filter((e) => e.scope === 'run')
    .map((e) => ({ message: e.message, count: e.count }));
```

and include `errors: { rows: errorRows }` in the delta object.

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, full unit, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add packages/contracts/src/live-delta.ts packages/contracts/test/live-delta.test.ts apps/worker/src/live/delta.ts apps/worker/test/live-delta.test.ts
git commit -m "feat(contracts,worker): the delta carries run-scope error rows

FR-LIVE-4 asks for a live error table and the delta had nothing to feed
one -- only summary.koCount. EngineResult.errors is already assembled every
tick and already capped at top(200) per key.

Run scope only. Per-endpoint rows stay excluded on part 2a §3.2's argument:
unbounded by run size. The folded `message: null` remainder is carried, or
the rows stop summing to koCount."
```

---

## Task 4: The snapshot key

**Files:**
- Modify: `apps/worker/src/live/delta.ts` — add `buildSnapshot`
- Modify: `apps/worker/src/live/fold-owner.ts` — `FoldState`, `#publish`
- Test: `apps/worker/test/live-delta.test.ts`, `apps/worker/test/fold-owner.integration.test.ts`

**Interfaces:**
- Consumes: `buildDelta(runId, result, prev)`, `INITIAL_CURSOR` (`delta.ts`).
- Produces: `buildSnapshot(runId, result, seq): LiveDelta` — a delta carrying the WHOLE response series rather than the lookback window, stamped with the given `seq`. Redis key `live:{runId}:snapshot`, JSON body, TTL `SNAPSHOT_TTL_SECONDS`.

- [ ] **Step 1: Write the failing test for `buildSnapshot`**

In `apps/worker/test/live-delta.test.ts`:

```ts
it('a snapshot carries the whole series, not the lookback window', () => {
  const result = engineResultSpanning(60_000); // many buckets
  const advanced: DeltaCursor = { seq: 12, lastPublishedOffsetMs: 50_000, lastBucketWidthMs: 1000 };

  const { delta } = buildDelta(RUN_ID, result, advanced);
  const snapshot = buildSnapshot(RUN_ID, result, advanced.seq);

  const all = result.series.get('run  response_time')!.buckets.length;
  expect(delta.responseTime.buckets.length).toBeLessThan(all);
  expect(snapshot.responseTime.buckets).toHaveLength(all);
  expect(snapshot.seq).toBe(12);
  // A seed replaces whatever a client had; it is never an upsert.
  expect(snapshot.responseTime.replaces).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: FAIL — `buildSnapshot` is not exported.

- [ ] **Step 3: Implement `buildSnapshot`**

In `apps/worker/src/live/delta.ts`:

```ts
/**
 * The whole current state, for seeding a client that was not listening.
 *
 * Built by running `buildDelta` from `INITIAL_CURSOR` -- which is exactly "no
 * lookback floor, replaces everything" -- rather than by a second traversal of
 * the series. One code path decides what a bucket looks like on the wire, so a
 * seed and a delta can never disagree about it.
 *
 * `seq` is stamped from the caller's CURRENT cursor, not from the synthetic
 * cursor used to build it: the seed's seq is the point a consumer resumes the
 * stream from, and `INITIAL_CURSOR` would claim 1 and re-deliver the run.
 */
export function buildSnapshot(runId: string, result: EngineResult, seq: number): LiveDelta {
  const { delta } = buildDelta(runId, result, INITIAL_CURSOR);
  return { ...delta, seq };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the constants**

In `apps/worker/src/live/fold-owner.ts`, beside `REPLAY_MAX_ENTRIES`:

```ts
/**
 * How many ticks between whole-state snapshots to `live:{runId}:snapshot`.
 *
 * ═══ THIS AND THE REPLAY CAP ARE ONE DECISION ═══
 * A connecting client seeds from the snapshot and then replays the stream
 * FORWARD from the snapshot's seq. If the stream's oldest surviving entry is
 * newer than that seq, the join drops every bucket in between -- silently,
 * because a consumer cannot tell a bucket that was never sent from one that
 * saw no traffic.
 *
 * `REPLAY_MAX_ENTRIES` is 200 (~17 minutes at the 5 s default), but
 * `REPLAY_BUDGET_BYTES` can lower the retained count below that at any moment
 * for a run with large deltas. So this interval is chosen well inside the
 * BYTE-derived floor rather than against the entry cap: 60 ticks is 5 minutes
 * at the default, leaving the stream more than three times the room it needs
 * even when the budget is biting hard.
 *
 * The gateway still treats "oldest entry newer than the snapshot's seq" as
 * recoverable -- re-read the snapshot, which by then has advanced -- because
 * this margin is an argument, not an invariant, and the failure it guards is
 * invisible.
 */
export const SNAPSHOT_EVERY_N_TICKS = 60;

/**
 * How long a snapshot key outlives its last write.
 *
 * `infra/docker-compose.yml` sets no `maxmemory` and no eviction policy
 * deliberately (this Redis also carries BullMQ job data, and every fitting
 * policy would start dropping jobs), so THIS TTL is the only thing that
 * reclaims the snapshot of a run whose producer died without close().
 *
 * One hour: twelve times the write interval above, and six times
 * `runningStaleAfterMs` (10 min default), so the sweeper finalizes an
 * abandoned run long before its snapshot expires. A run whose ticks stall past
 * this loses only the seed, which the gateway degrades over rather than
 * failing on.
 */
export const SNAPSHOT_TTL_SECONDS = 3600;
```

- [ ] **Step 6: Write the snapshot, AFTER the cursor advances**

Add `ticksSinceSnapshot: number` to `FoldState` (initialised to `SNAPSHOT_EVERY_N_TICKS` on claim, so the first tick seeds immediately rather than leaving a new run unseedable for five minutes).

In `#publish`, after `state.cursor = next;` and **outside** the existing try/catch:

```ts
    // AFTER the cursor advances, and in its own try -- a snapshot is a
    // convenience for future subscribers, and letting its failure reach the
    // caller would run the delta path's compensating logic
    // (`{ ...state.cursor, seq: next.seq }`) for an error that has nothing to
    // do with the delta. That would drop the coalesce replacement flag for a
    // tick whose PUBLISH and XADD both succeeded.
    state.ticksSinceSnapshot += 1;
    if (state.ticksSinceSnapshot >= SNAPSHOT_EVERY_N_TICKS) {
      try {
        await this.#redis.set(
          `live:${runId}:snapshot`,
          JSON.stringify(buildSnapshot(runId, snapshot, next.seq)),
          'EX',
          SNAPSHOT_TTL_SECONDS,
        );
        state.ticksSinceSnapshot = 0;
      } catch (err) {
        // Left un-reset, so the next tick retries rather than waiting a full
        // interval after a transient failure.
        console.error(`LiveFoldOwner: snapshot write failed for ${runId}:`, err);
      }
    }
```

- [ ] **Step 7: Write the integration case**

In `apps/worker/test/fold-owner.integration.test.ts`:

```ts
it('seeds a snapshot on the first tick, so a late joiner is never unseedable', async () => {
  await owner.tick();
  const raw = await redis.get(`live:${runId}:snapshot`);
  expect(raw).not.toBeNull();
  const seeded = LiveDeltaSchema.parse(JSON.parse(raw!));
  expect(seeded.responseTime.buckets.length).toBeGreaterThan(0);
  expect(await redis.ttl(`live:${runId}:snapshot`)).toBeGreaterThan(0);
});

it('a failed snapshot write does not disturb the delta cursor', async () => {
  const set = vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis down'));
  await expect(owner.tick()).resolves.not.toThrow();
  set.mockRestore();
  // The delta still published, and the NEXT delta must still be a plain
  // upsert -- not a spurious replacement caused by a mangled cursor.
  const next = await nextPublishedDelta(owner);
  expect(next.responseTime.replaces).toBe(false);
});
```

- [ ] **Step 8: Run the integration suite**

Bring the stack up first, and never while `scripts/capture-chart-fixture.mjs` is running — that suite truncates every table on setup.

```bash
docker compose -f infra/docker-compose.yml up -d
```

Run: `pnpm test:integration`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, full unit, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add apps/worker/src/live/delta.ts apps/worker/src/live/fold-owner.ts apps/worker/test/
git commit -m "feat(worker): write a whole-state snapshot beside the delta stream

A client connecting mid-run could not reconstruct it. Each delta's response
envelope is a lookback WINDOW, so replay rebuilds the series only while the
stream still reaches the run's start -- ~17 minutes at REPLAY_MAX_ENTRIES,
less whenever REPLAY_BUDGET_BYTES bites first. Open a soak run's page at
minute 20 and the first three minutes were gone until the run finished.

The snapshot interval and the replay cap are ONE decision: the stream must
always reach back to the last snapshot, and it drops buckets silently when
it does not. 60 ticks sits well inside the byte-derived floor.

The write is after the cursor advances and swallows its own failure: a
snapshot error running the delta path's compensating logic would drop a
coalesce replacement flag for a tick that published fine."
```

---

## Task 5: `LiveHub` — one subscriber per pod

**Files:**
- Create: `apps/api/src/live/live-hub.ts`
- Create: `apps/api/src/live/live.module.ts`
- Test: `apps/api/test/live-hub.integration.test.ts`
- Modify: `apps/api/package.json` (add `@nestjs/websockets`, `@nestjs/platform-ws`, `ws`, `@types/ws`)
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `LiveHub` with `join(runId: string, socket: WebSocket): Promise<void>`, `leave(runId: string, socket: WebSocket): Promise<void>`, and `size(runId: string): number`.

- [ ] **Step 1: Install the dependencies**

```bash
pnpm --filter @perfportal/api add @nestjs/websockets @nestjs/platform-ws ws
pnpm --filter @perfportal/api add -D @types/ws
```

`ws`, not socket.io: the browser is the only client and socket.io's fallbacks and framing buy nothing here.

- [ ] **Step 2: Write the failing test**

`apps/api/test/live-hub.integration.test.ts`:

```ts
// FR-LIVE-7's actual claim: any pod can serve any viewer. Two hubs against
// one Redis stand in for two pods.
it('delivers one publish to sockets on different pods', async () => {
  const a = new LiveHub(redisUrl);
  const b = new LiveHub(redisUrl);
  const sa = fakeSocket();
  const sb = fakeSocket();
  await a.join(runId, sa);
  await b.join(runId, sb);

  await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 1 }));
  await waitFor(() => sa.sent.length === 1 && sb.sent.length === 1);

  expect(JSON.parse(sa.sent[0]).seq).toBe(1);
  expect(JSON.parse(sb.sent[0]).seq).toBe(1);
  await a.close();
  await b.close();
});

// A subscriber connection per socket would put a Redis connection count on
// the viewer count.
it('subscribes once for a run however many sockets join, and unsubscribes on the last leave', async () => {
  const hub = new LiveHub(redisUrl);
  const s1 = fakeSocket();
  const s2 = fakeSocket();
  await hub.join(runId, s1);
  await hub.join(runId, s2);
  expect(hub.size(runId)).toBe(2);

  await hub.leave(runId, s1);
  expect(hub.size(runId)).toBe(1);
  await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 2 }));
  await waitFor(() => s2.sent.length === 1);

  await hub.leave(runId, s2);
  expect(hub.size(runId)).toBe(0);
  await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 3 }));
  await delay(100);
  expect(s2.sent).toHaveLength(1); // nothing after the last leave
  await hub.close();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm test:integration -- live-hub`
Expected: FAIL — `LiveHub` does not exist.

- [ ] **Step 4: Implement `LiveHub`**

`apps/api/src/live/live-hub.ts`:

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';

/**
 * ONE ioredis subscriber for the whole pod, and a set of sockets per run.
 *
 * This is what makes FR-LIVE-7's "no sticky routing" true rather than
 * aspirational: every pod subscribes to the runs it currently has viewers for,
 * so a viewer can land on any pod and a run needs no owning one.
 *
 * The subscriber is per POD rather than per socket because a connection per
 * socket puts a Redis connection count on the viewer count -- a number set by
 * how many people opened a page.
 *
 * A dedicated connection is required regardless: ioredis in subscriber mode
 * refuses ordinary commands, so this cannot share the client anything else uses.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  readonly #sub: Redis;
  readonly #rooms = new Map<string, Set<WebSocket>>();

  constructor(redisUrl: string) {
    this.#sub = new Redis(redisUrl);
    this.#sub.on('message', (channel, body) => {
      const runId = channel.slice('live:'.length);
      for (const socket of this.#rooms.get(runId) ?? []) socket.send(body);
    });
  }

  async join(runId: string, socket: WebSocket): Promise<void> {
    const room = this.#rooms.get(runId);
    if (room) {
      room.add(socket);
      return;
    }
    // Insert BEFORE awaiting the subscribe: a second join arriving while this
    // one is in flight must find the room and add to it, not start a second
    // SUBSCRIBE for the same channel.
    this.#rooms.set(runId, new Set([socket]));
    await this.#sub.subscribe(`live:${runId}`);
  }

  async leave(runId: string, socket: WebSocket): Promise<void> {
    const room = this.#rooms.get(runId);
    if (!room) return;
    room.delete(socket);
    if (room.size > 0) return;
    this.#rooms.delete(runId);
    await this.#sub.unsubscribe(`live:${runId}`);
  }

  size(runId: string): number {
    return this.#rooms.get(runId)?.size ?? 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.#rooms.clear();
    await this.#sub.quit();
  }
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm test:integration -- live-hub`
Expected: PASS, 2 tests.

- [ ] **Step 6: Wire the module**

`apps/api/src/live/live.module.ts` providing `LiveHub` with the config's `redisUrl`, and add `LiveModule` to `AppModule`'s `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 7: Typecheck, lint, unit, integration, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add apps/api/src/live apps/api/test/live-hub.integration.test.ts apps/api/src/app.module.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): LiveHub fans a run's deltas out across a pod's sockets

One ioredis subscriber per pod and a socket set per run, subscribing on the
first viewer and unsubscribing on the last. That is FR-LIVE-7's no-sticky-
routing claim: a viewer can land on any pod.

Per pod rather than per socket because a connection per socket puts a Redis
connection count on the viewer count. The room is inserted before the
subscribe is awaited, so a concurrent join finds it instead of opening a
second SUBSCRIBE."
```

---

## Task 6: The gateway

**Files:**
- Create: `apps/api/src/live/live.gateway.ts`
- Test: `apps/api/test/live-gateway.integration.test.ts`
- Modify: `apps/api/src/live/live.module.ts`

**Interfaces:**
- Consumes: `LiveHub` (Task 5); `buildSnapshot`'s key layout `live:{runId}:snapshot` and stream `live:{runId}:deltas` (Task 4); `OrgMemberRepository.findOrgForUser(userId)`; `auth.api.getSession({ headers })` and `fromNodeHeaders` as used by `apps/api/src/auth/auth.middleware.ts:30`.
- Produces: `GET /v1/runs/:id/live` (WebSocket upgrade). Frames: `{ type: 'snapshot', delta: LiveDelta, partial: boolean }` then `{ type: 'delta', delta: LiveDelta }`. Client's optional first frame: `{ lastSeq: number }`.

- [ ] **Step 1: Write the failing auth tests**

`apps/api/test/live-gateway.integration.test.ts`. These come first because §3.2's failure is invisible from the UI:

```ts
// Nest's HTTP guards do not run on an upgrade. A gateway that declares
// @UseGuards(AuthGuard) and stops there is unauthenticated while reading as
// guarded -- the decorator is accepted and never consulted.
it('closes an upgrade carrying no session cookie, without sending a frame', async () => {
  const socket = await connectRaw(`/v1/runs/${runId}/live`, { cookie: undefined });
  await expect(closedWith(socket)).resolves.toBeGreaterThanOrEqual(4000);
  expect(framesOf(socket)).toHaveLength(0);
});

it('closes an upgrade whose session belongs to another org', async () => {
  const socket = await connectRaw(`/v1/runs/${runId}/live`, { cookie: otherOrgCookie });
  await expect(closedWith(socket)).resolves.toBeGreaterThanOrEqual(4000);
  expect(framesOf(socket)).toHaveLength(0);
});
```

Assert **no frame was sent**, not merely that the socket closed: accepting the socket and then sending an error frame is an accepted socket an unauthorized caller can hold open.

- [ ] **Step 2: Write the failing seed test**

```ts
it('seeds from the snapshot, then replays the stream forward from its seq', async () => {
  await seedSnapshot(runId, { seq: 5, buckets: 40 });
  await appendDeltas(runId, [6, 7, 8]);

  const socket = await connect(`/v1/runs/${runId}/live`, { cookie: memberCookie });
  const frames = await collect(socket, 4);

  expect(frames[0].type).toBe('snapshot');
  expect(frames[0].delta.seq).toBe(5);
  expect(frames.slice(1).map((f) => f.delta.seq)).toEqual([6, 7, 8]);
});

// The seed is the ONE thing a browser cannot do for itself: it cannot read a
// Redis key. If this regresses to a client-side fetch the endpoint is unusable.
it('sends a partial snapshot rather than refusing when the key has expired', async () => {
  await redis.del(`live:${runId}:snapshot`);
  await appendDeltas(runId, [9]);

  const socket = await connect(`/v1/runs/${runId}/live`, { cookie: memberCookie });
  const [first] = await collect(socket, 1);
  expect(first.type).toBe('snapshot');
  expect(first.partial).toBe(true);
});
```

- [ ] **Step 3: Write the failing late-joiner test — spec §5.2**

This is the case that proves Task 4 was worth building. Without the snapshot it
fails with holes at the FRONT of the series, which is exactly the defect:

```ts
it('reconstructs a run whose stream no longer reaches its start', async () => {
  // Drive the owner past the replay window, so the earliest deltas -- and the
  // only copies of the run's first buckets -- have been trimmed.
  await foldPastReplayWindow(owner, runId);
  const oldest = await redis.xrange(`live:${runId}:deltas`, '-', '+', 'COUNT', 1);
  expect(JSON.parse(oldest[0][1][1]).seq).toBeGreaterThan(1); // genuinely trimmed

  const socket = await connect(`/v1/runs/${runId}/live`, { cookie: memberCookie });
  const [seed] = await collect(socket, 1);

  // The reconstruction must equal the owner's own view, not merely be
  // non-empty -- derived from the engine, never written down.
  const truth = buildSnapshot(runId, ownerSnapshotOf(owner, runId), seed.delta.seq);
  expect(seed.delta.responseTime.buckets).toEqual(truth.responseTime.buckets);
  expect(seed.delta.responseTime.buckets[0].startOffsetMs).toBe(0);
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm test:integration -- live-gateway`
Expected: FAIL — no route at `/v1/runs/:id/live`.

- [ ] **Step 5: Implement the gateway**

`apps/api/src/live/live.gateway.ts`. The connection handler, in order:

1. **Authenticate and authorize explicitly**, before anything else touches the
   socket. This is the code §3.2 exists for — a decorator here would be
   accepted and never consulted:

```ts
/**
 * NEST'S HTTP GUARDS DO NOT RUN ON AN UPGRADE.
 *
 * AuthGuard, SessionOnlyGuard and @Scopes are bound to the HTTP request
 * pipeline, which a WebSocket upgrade never traverses. A gateway that declares
 * `@UseGuards(AuthGuard)` compiles, reads as guarded in review, and is
 * unauthenticated. So the checks are here, in order, and the socket is closed
 * rather than accepted-then-errored: an accepted socket is one an unauthorized
 * caller can hold open.
 */
async #authorize(req: IncomingMessage, runId: string): Promise<{ orgId: string } | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return null;

  const membership = await this.members.findOrgForUser(session.user.id);
  if (!membership) return null;

  const run = await this.runs.findById(runId);
  // A run in another org and a run that does not exist answer the SAME way.
  // Distinguishing them turns this endpoint into an existence oracle for run
  // ids across the whole deployment.
  if (!run || run.orgId !== membership.orgId) return null;

  return { orgId: membership.orgId };
}
```

```ts
const authorized = await this.#authorize(req, runId);
if (!authorized) {
  socket.close(4401, 'unauthorized');
  return;
}
```
2. **Seed.** `GET live:{runId}:snapshot`. Send `{ type: 'snapshot', delta, partial: false }`. On a missing key, send the reconstruction from whatever the stream holds with `partial: true`.
3. **Replay.** `XRANGE live:{runId}:deltas ({seq} +` where `seq` is the snapshot's, or the client's `lastSeq` when it sent one and the stream still reaches it. Send each as `{ type: 'delta', delta }`.
4. **Join.** `hub.join(runId, socket)`, and `hub.leave` on `'close'`.

Add the backpressure guard on every send:

```ts
/**
 * Above this, a client is not reading and the pod is paying for it.
 *
 * It has to clear one snapshot frame with room to spare -- a full series plus
 * a 20-scenario users envelope reaches ~2 MB -- or the SEED itself would trip
 * the guard on a slow link and the connection could never establish. 8 MiB is
 * four such frames.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
```

```ts
if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
  socket.close(4408, 'too far behind');
  return;
}
```

- [ ] **Step 6: Run and watch them pass**

Run: `pnpm test:integration -- live-gateway`
Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck, lint, unit, integration, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add apps/api/src/live apps/api/test/live-gateway.integration.test.ts
git commit -m "feat(api): a WebSocket gateway that seeds, replays, then follows

GET /v1/runs/:id/live. The gateway performs the seed SERVER-SIDE -- a
browser cannot read a Redis key -- so the socket carries one snapshot frame
and then delta frames, and the client never assembles a seed itself. A
reconnecting client sends {lastSeq} and the SERVER decides whether the
stream still reaches it.

Auth is explicit and that is the point: Nest's HTTP guards do not run on an
upgrade, so a gateway declaring @UseGuards(AuthGuard) is unauthenticated
while reading as guarded. Both rejection cases assert no frame was sent,
because an accepted socket is one an unauthorized caller can hold open."
```

---

## Task 7: `useLiveRun` and the growing time domain

**Files:**
- Create: `apps/web/src/api/live.ts`
- Create: `apps/web/test/useLiveRun.test.tsx`
- Modify: `apps/web/src/routes/useRunWindow.ts:83-89`
- Modify: `apps/web/test/timeAxis.test.ts`

**Interfaces:**
- Consumes: the gateway's frame protocol (Task 6); `LiveDelta` from `@perfportal/contracts`; `seriesQueryKey`, `usersQueryKey`, `errorsQueryKey`, `statsQueryKey` from `apps/web/src/api/metrics.ts`.
- Produces: `useLiveRun(runId: string, enabled: boolean): { connected: boolean; lastDelta: LiveDelta | null }`.

- [ ] **Step 1: Write the failing hook test**

`apps/web/test/useLiveRun.test.tsx`:

```tsx
it('writes a delta into the cache under the keys the REST queries use', async () => {
  const client = new QueryClient();
  renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
  await server.send({ type: 'snapshot', delta: deltaFixture(), partial: false });

  const series = client.getQueryData(seriesQueryKey(RUN_ID, 'run', '', 'response_time'));
  expect(series).toBeDefined();
  expect(client.getQueryData(errorsQueryKey(RUN_ID))).toBeDefined();
});

// CLAUDE.md §22.6: a phone holding an open socket to draw nothing is exactly
// the "degrading badly" the compact rule exists to prevent.
it('never opens the socket when disabled', () => {
  renderHook(() => useLiveRun(RUN_ID, false), { wrapper: wrapperFor(new QueryClient()) });
  expect(server.connections).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/test/useLiveRun.test.tsx`
Expected: FAIL — `useLiveRun` does not exist.

- [ ] **Step 3: Implement the hook**

`apps/web/src/api/live.ts`. It opens a `WebSocket` when `enabled`, applies each
frame to the React Query cache under the REST keys, reconnects with exponential
backoff plus jitter, and sends `{ lastSeq }` as its first frame on a reconnect.

The merge is the subtle part, and it has exactly two rules:

```ts
/**
 * TWO RULES, AND THE SECOND ONE IS WHY `replaces` IS ON THE WIRE.
 *
 * Buckets are upserted BY `startOffsetMs`, never appended: the newest bucket is
 * still filling when it is first published, and the producer deliberately
 * re-sends a lookback window so those partial buckets get corrected. Appending
 * would draw every re-sent bucket twice.
 *
 * A `replaces: true` envelope REPLACES the series outright. `BucketSeries`
 * halves its resolution in place when it hits its cap, rewriting every offset —
 * so merging a replacement leaves the old width's buckets sitting beside the
 * new width's, at offsets that no longer mean the same thing. Nothing throws;
 * the chart just doubles its bucket count and the rates halve.
 */
function mergeResponseTime(prev: SeriesResponse | undefined, envelope: LiveDelta['responseTime']): SeriesResponse {
  const base = envelope.replaces || !prev ? [] : prev.buckets;
  const byOffset = new Map(base.map((b) => [b.startOffsetMs, b]));
  for (const b of envelope.buckets) byOffset.set(b.startOffsetMs, b);
  return {
    ...(prev ?? emptySeries()),
    bucketWidthMs: envelope.widthMs,
    buckets: [...byOffset.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
  };
}
```

`users` and `errors` are sent whole every tick — **assign, never merge**. A
merge would make a scenario that has ended keep its last bucket forever, and
would make an error row that stopped occurring immortal.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run apps/web/test/useLiveRun.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing time-domain test**

In `apps/web/test/timeAxis.test.ts`. `useTimeDomainFromShell` reads
`useOutletContext`, so it has to be rendered inside one — there is no plain
function to call, and the existing cases in this file test payload shapes
rather than the hook:

```tsx
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { useTimeDomainFromShell, type RunWindowContext } from '../src/routes/useRunWindow';

function wrapperFor(context: RunWindowContext) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={['/r']}>
      <Routes>
        <Route path="/r" element={<Outlet context={context} />}>
          <Route index element={<>{children}</>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

// One code path decides the domain for a live run and a finished one, or the
// shared crosshair means one instant on one and something else on the other.
it('takes the domain from the live duration while a run is streaming', () => {
  const { result } = renderHook(() => useTimeDomainFromShell(), {
    wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: 42_000 }),
  });
  expect(result.current).toEqual([0, 42_000]);
});

it('still prefers an explicit window over the live duration', () => {
  const { result } = renderHook(() => useTimeDomainFromShell(), {
    wrapper: wrapperFor({ window: { fromMs: 5_000, toMs: 9_000 }, durationMs: null, liveDurationMs: 42_000 }),
  });
  expect(result.current).toEqual([5_000, 9_000]);
});

it('is undefined when a run reports no duration at all', () => {
  const { result } = renderHook(() => useTimeDomainFromShell(), {
    wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: null }),
  });
  expect(result.current).toBeUndefined();
});
```

- [ ] **Step 6: Grow the domain**

Extend `RunWindowContext` with `liveDurationMs: number | null` and change `useTimeDomainFromShell`:

```ts
export function useTimeDomainFromShell(): readonly [number, number] | undefined {
  const { window, durationMs, liveDurationMs } = useOutletContext<RunWindowContext>();
  if (window !== null) return [window.fromMs, window.toMs];
  // The live duration is only consulted when the run has no settled one --
  // ONE code path, not a live-only branch. Part 1 §4.1.
  const span = durationMs ?? liveDurationMs;
  return span === null ? undefined : [0, span];
}
```

- [ ] **Step 7: Run, typecheck, lint, full unit, commit**

```bash
pnpm vitest run apps/web/test/timeAxis.test.ts
pnpm typecheck && pnpm lint && pnpm test:unit
git add apps/web/src/api/live.ts apps/web/test/useLiveRun.test.tsx apps/web/src/routes/useRunWindow.ts apps/web/test/timeAxis.test.ts
git commit -m "feat(web): useLiveRun writes deltas into the cache the charts read

The charts learn nothing about liveness -- part 1 §4's design, reachable now
that the delta carries the same fields SeriesBucketSchema does. Buckets are
upserted by startOffsetMs, and a replaces flag REPLACES the series rather
than merging, or a coalesce leaves old-width buckets beside new ones.

The time domain grows through the shared hook rather than a live branch: two
ways of deciding it are two answers to what instant the crosshair is on."
```

---

## Task 8: The live run page

**Files:**
- Create: `apps/web/src/routes/LiveNotice.tsx`
- Create: `apps/web/test/LiveNotice.test.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx:151`
- Modify: `apps/web/src/routes/RunShell.tsx`
- Test: `apps/web/e2e/run-live.spec.ts`

**Interfaces:**
- Consumes: `useLiveRun(runId, enabled)` (Task 7); `useIsCompact()` (`apps/web/src/useIsCompact.ts`); `DesktopOnly` (`apps/web/src/routes/DesktopOnly.tsx`).

- [ ] **Step 1: Write the failing notice test**

`apps/web/test/LiveNotice.test.tsx`:

```tsx
it('says what it is waiting for, not that something is loading', () => {
  render(<LiveNotice kind="withheld" subject="Statistics" />);
  expect(screen.getByText(/available when the run finishes/i)).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('says the run finished and results are being finalized', () => {
  render(<LiveNotice kind="finalizing" />);
  expect(screen.getByRole('status')).toHaveTextContent(/finalizing/i);
});
```

A spinner claims something is arriving; an empty chart claims there is nothing to draw. Neither is true of these three sections.

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `pnpm vitest run apps/web/test/LiveNotice.test.tsx`
Expected: FAIL, then PASS after `LiveNotice.tsx` exists.

Do **not** put an `<svg>` inside a chart `<figure>` — nine specs count SVG elements within the figure to prove a chart drew.

- [ ] **Step 3: Supply `liveDurationMs` from the shell**

`RunShell.tsx:101` currently provides:

```tsx
<Outlet context={{ window, durationMs: run.durationMs ?? null } satisfies RunWindowContext} />
```

Task 7 added `liveDurationMs` to `RunWindowContext`, so this object is now
missing a required field and will not typecheck until it carries it. The shell
is where the run object lives and is therefore where the live duration belongs
— a tab that read it from its own socket would be a second source for a number
every tab must agree on:

```tsx
<Outlet
  context={{
    window,
    durationMs: run.durationMs ?? null,
    liveDurationMs: live.lastDelta?.summary.durationMs ?? null,
  } satisfies RunWindowContext}
/>
```

- [ ] **Step 4: Render live instead of `Processing`**

In `apps/web/src/routes/RunDetail.tsx`, the branch at line 151 currently sends every non-complete run to `<Processing>`. Split it: `running` renders the live page; `pending` and `parsing` keep `Processing` — **except** when the page has a retained delta from a run that was live in this session, which renders frozen under a `LiveNotice kind="finalizing"` banner.

Gate the socket on `!useIsCompact()`, and pass the same flag to `DesktopOnly`'s `onShow` so the queries behind the withheld content stay `enabled: false` on a phone.

- [ ] **Step 5: Write the e2e spec**

`apps/web/e2e/run-live.spec.ts`: seed a `running` run with a snapshot key and deltas, then assert the live charts draw and the three withheld sections show their notice.

Before adding any table, grep the e2e suite for `getByRole('table'` and make sure a new `<caption>` shares no distinctive word with an existing one — the Errors table is already reached by name.

- [ ] **Step 6: Run the whole gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add apps/web/src apps/web/test apps/web/e2e/run-live.spec.ts
git commit -m "feat(web): a running run draws its dashboard instead of a spinner

FR-LIVE-4. The three sections that genuinely cannot be live -- the
statistics table, distribution and scatter -- say what they are waiting
for rather than showing a spinner, which claims something is arriving.

When the run ends the page freezes its last delta under a finalizing
banner instead of falling back to the parsing screen: taking a populated
dashboard away and replacing it with a spinner reads as something having
gone wrong at the moment nothing has.

The socket is gated on !useIsCompact() -- §22.6's rule, and a phone
holding a socket to draw nothing is what it exists to prevent."
```

- [ ] **Step 7: Measure AC-LIVE-1**

Part 2a deferred "<2 s p95 delta latency" to here, as the first point with an end-to-end path to measure. Measure publish-to-receipt across a real socket and record the number in the spec's §5.6. If it misses, report the number rather than adjusting the target.

---

## Task 9: The part 2a residuals

Three findings recorded against PR #38 as known-and-unfixed. This sub-project is already in these files.

**Files:**
- Modify: `packages/storage/src/live-chunks.ts`
- Modify: `apps/worker/src/live/fold-owner.ts`
- Test: `packages/storage/test/live-chunks.test.ts`

- [ ] **Step 1: Give `assemble()` the contiguity check**

`readFrom` asserts its chunks tile without gaps; `assemble` does not, and it is the terminal path producing the final `simulation.log`. Safe today only because `claimForClose` is a CAS so one `close()` runs at a time — which nothing in the code states. Write the failing test first: an assembly over a deliberately holed chunk set must throw `LiveChunkGapError` rather than producing a corrupt log.

- [ ] **Step 2: Make `LiveChunkGapError` report the real gap position**

It currently renders an interior gap as the caller's argument, so it reads as a caller bug rather than a `finalize` race. Assert the message names the interior offset.

- [ ] **Step 3: Make the replay byte-bound honest**

The bound is optimistic by up to one oversized delta: a re-bucketing delta carries its series from offset 0 and exceeds its neighbours. State the true bound in `REPLAY_BUDGET_BYTES`'s doc comment — budget plus one oversized entry — rather than leaving the comment claiming a tighter one than holds.

- [ ] **Step 4: Full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
cd agent && go vet ./... && go test ./... -race && cd ..
git add packages/storage apps/worker
git commit -m "fix(storage,worker): close part 2a's three recorded residuals"
```

- [ ] **Step 5: Update CLAUDE.md's floor one last time**

Set the two numbers to what the final `pnpm test:unit` reported, and name the suites this sub-project added.
