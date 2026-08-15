# Errors Over Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run's failures on a time axis, one series per error message, so a reader can see *when* a run broke and *what* broke.

**Architecture:** A new `ErrorSeries` in `@perfportal/statistics` buckets failures at their `endMs` and is coalesced up to the run-scope response-time series' final bucket width, so both charts share one resolution. Rows land in a new `run_error_bucket` table partitioned on `run_started_on` like its two neighbours. A new run-scope-only endpoint serves at most six series — the top five messages by run-wide total plus one folded remainder — which is exactly what the categorical palette can draw.

**Tech Stack:** TypeScript, pnpm workspaces, Postgres + Prisma (raw `pg` for metrics), NestJS, Zod contracts, React 18.3.1 + ECharts, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-15-errors-over-time-design.md`

## Global Constraints

- **Node 22** (`.nvmrc`). `nvm use` first. A unit run reporting fewer than **74 files / 830 tests** did not run everything.
- Gate, in this order — integration **before** e2e: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
- Branch is `feat/errors-over-time`, already created from `main` at `b6bd0dc`. One PR back to `main`, merged with `--merge`, never squashed.
- **Expectations are computed from the payload, never written down.** The reference bundle yields 24 failures over 2 distinct messages; a test asserting `24` breaks on the next re-capture for a reason that is not a defect.
- **`ERROR_SERIES_KEEP = 5`**, exported from `@perfportal/statistics`. Five named messages plus one `other` = six, and `MAX_CATEGORICAL_SERIES` is six with no seventh.
- **No `uppercase` on anything queried by accessible name** — Playwright applies `text-transform` when computing a name; jsdom does not.
- **No decorative `<svg>` inside a chart `<figure>`** — nine existing specs prove a chart drew by counting SVG elements within the figure.
- **A token not in `@theme` produces no utility, silently.** Chart marks come from `--chart-*` via `assignPalette`; `--color-status-*` is a text palette and `text-status-failed` does not exist.
- `getByRole(role, { name })` is **exact** in Testing Library and a case-insensitive **substring** in Playwright. Use `exact: true` wherever a fallback could be a substring — every authenticated page also carries N `ProjectRail` links.

## File Structure

| File | Responsibility |
|---|---|
| `packages/statistics/src/errors-series.ts` *(new)* | `ErrorSeries` — bucket, coalesce, fold. Pure; no I/O. |
| `packages/statistics/src/engine.ts` | Owns the lifecycle: constructs `ErrorSeries` lazily, feeds it, finishes it at the run series' width. |
| `packages/persistence/prisma/migrations/20260815180000_run_error_bucket/migration.sql` *(new)* | The partitioned table and twelve 2026 partitions. |
| `packages/persistence/prisma/schema.prisma` | `RunErrorBucket` model, mirroring `RunUserBucket`. |
| `packages/persistence/src/metrics/write.ts` | A fourth `insertBatched` call. |
| `packages/persistence/src/metrics/read.ts` | `ERROR_SERIES_SQL` + `MetricReader.errorSeries()`. |
| `packages/contracts/src/metrics.ts` | `ErrorSeriesResponseSchema`. |
| `apps/api/src/metrics/metrics.controller.ts` | `GET /v1/runs/:id/errors/series`. |
| `apps/web/src/api/metrics.ts` | `errorSeriesQuery`. |
| `apps/web/src/charts/transforms/errorSeries.ts` *(new)* | Response → `ChartData`, counts → per-second rates. |
| `apps/web/src/charts/ErrorsChart.tsx` *(new)* | The figure. |
| `apps/web/src/routes/RunDetail.tsx` | `RunErrorsTab` renders the chart above the existing table. |

---

### Task 1: `ErrorSeries`

**Files:**
- Create: `packages/statistics/src/errors-series.ts`
- Create: `packages/statistics/test/errors-series.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ERROR_SERIES_KEEP: 5`; `class ErrorSeries` with `constructor(opts: { startMs: number; maxBuckets: number })`, `get widthMs(): number`, `add(tsMs: number, message: string): void`, `finish(widthMs: number, keep?: number): ErrorSeriesResult`; `interface ErrorSeriesRow { startOffsetMs: number; message: string | null; count: number }`; `interface ErrorSeriesResult { bucketWidthMs: number; rows: ErrorSeriesRow[] }`.

- [ ] **Step 1: Write the failing tests**

`packages/statistics/test/errors-series.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ERROR_SERIES_KEEP, ErrorSeries } from '../src/errors-series.js';

/** Counts keyed by message for one offset, for readable assertions. */
function at(result: { rows: { startOffsetMs: number; message: string | null; count: number }[] }, offset: number) {
  return Object.fromEntries(
    result.rows.filter((r) => r.startOffsetMs === offset).map((r) => [r.message ?? '@other', r.count]),
  );
}

describe('ErrorSeries', () => {
  it('files a failure in the bucket its timestamp falls in', () => {
    const s = new ErrorSeries({ startMs: 1000, maxBuckets: 100 });
    s.add(1200, 'boom');
    s.add(2300, 'boom');
    s.add(2900, 'bang');

    const out = s.finish(1000);
    expect(out.bucketWidthMs).toBe(1000);
    expect(at(out, 0)).toEqual({ boom: 1 });
    expect(at(out, 1000)).toEqual({ boom: 1, bang: 1 });
  });

  it('leaves an unoccupied bucket absent rather than emitting a zero row', () => {
    // A gap in time is a gap. A zero row would draw a measured "no errors
    // here" over an interval nothing was recorded in.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 'boom');
    s.add(5000, 'boom');
    expect(s.finish(1000).rows.map((r) => r.startOffsetMs)).toEqual([0, 5000]);
  });

  it('halves its own resolution once it exceeds maxBuckets', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 4 });
    for (let i = 0; i < 10; i += 1) s.add(i * 1000, 'boom');
    expect(s.widthMs).toBeGreaterThan(1000);
  });

  it('coalesces UP to a requested wider width, summing exactly', () => {
    // The property the whole design rests on: merging counts is lossless, so
    // an error series bucketed finer than the run series can always be lifted
    // to match it.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(500, 'boom');
    s.add(1500, 'boom');
    s.add(2500, 'bang');

    const out = s.finish(2000);
    expect(out.bucketWidthMs).toBe(2000);
    expect(at(out, 0)).toEqual({ boom: 2 });
    expect(at(out, 2000)).toEqual({ bang: 1 });
  });

  it('preserves the total count across any coalesce', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 50; i += 1) s.add(i * 300, `m${i % 3}`);
    const total = (r: { rows: { count: number }[] }) => r.rows.reduce((n, x) => n + x.count, 0);
    expect(total(s.finish(8000))).toBe(50);
  });

  it('reports the width it actually has when asked for a NARROWER one', () => {
    // Cannot happen by the spec's subset argument (§2) — the run series always
    // halves at least as often. Clamping rather than throwing keeps a broken
    // invariant from failing a whole ingest for one chart, and the response
    // still carries the real width so the chart stays self-consistent.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 2 });
    for (let i = 0; i < 20; i += 1) s.add(i * 1000, 'boom');
    const wide = s.widthMs;
    expect(s.finish(1000).bucketWidthMs).toBe(wide);
  });

  it('keeps the top five by RUN-WIDE total and folds the rest', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    // Seven distinct messages, descending frequency.
    for (let rank = 0; rank < 7; rank += 1) {
      for (let n = 0; n < 10 - rank; n += 1) s.add(0, `m${rank}`);
    }
    const out = s.finish(1000);
    const named = out.rows.filter((r) => r.message !== null).map((r) => r.message);
    expect(named).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(named).toHaveLength(ERROR_SERIES_KEEP);
    // m5 (5) + m6 (4) — derived, not written down.
    expect(at(out, 0)['@other']).toBe(5 + 4);
  });

  it('selects the top five globally, NOT per bucket', () => {
    // A message that leads one bucket but is rare overall must not appear as a
    // series that exists only there — a line that starts and stops mid-chart
    // reads as a metric that was measured and then was not.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let rank = 0; rank < 5; rank += 1) {
      for (let n = 0; n < 20; n += 1) s.add(0, `common${rank}`);
    }
    s.add(1000, 'local-leader');

    const out = s.finish(1000);
    expect(out.rows.some((r) => r.message === 'local-leader')).toBe(false);
    expect(at(out, 1000)).toEqual({ '@other': 1 });
  });

  it('emits no other row when nothing was folded', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 'boom');
    expect(s.finish(1000).rows.every((r) => r.message !== null)).toBe(true);
  });

  it('folds beyond 200 distinct messages instead of growing without bound', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 250; i += 1) s.add(0, `m${i}`);
    const out = s.finish(1000);
    // 250 seen, 200 admitted, 50 rejected on arrival; of the 200 admitted, 5
    // are kept and 195 fold. Derived from the two caps, not written down.
    expect(at(out, 0)['@other']).toBe(250 - 200 + (200 - ERROR_SERIES_KEEP));
  });

  it('is empty, not broken, when nothing was ever added', () => {
    expect(new ErrorSeries({ startMs: 0, maxBuckets: 100 }).finish(1000)).toEqual({
      bucketWidthMs: 1000,
      rows: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && pnpm vitest run packages/statistics/test/errors-series.test.ts`
Expected: FAIL — cannot resolve `../src/errors-series.js`.

- [ ] **Step 3: Implement**

`packages/statistics/src/errors-series.ts`:

```ts
/**
 * A run's failures on a time axis, one count per (bucket, message).
 *
 * ═══ WHY THIS IS NOT PART OF `ErrorRollup` ═══
 *
 * `ErrorRollup` is the flat total behind the errors table, and it is correct as
 * it stands. Giving it a second, differently-scoped responsibility — one that
 * includes warm-up where the flat one excludes it, and folds at five where the
 * flat one folds at two hundred — would make both harder to read than two
 * small classes are.
 *
 * ═══ WHY THE WIDTH IS AN ARGUMENT TO `finish` ═══
 *
 * Errors are sparse. `BucketSeries` halves resolution on its count of OCCUPIED
 * buckets, so a structure bucketing only failures halves far less often than
 * the run's response-time series does — leaving two charts on one page at two
 * resolutions, and leaving `inferBucketWidthMs` (which reads the smallest gap
 * between offsets) to conclude that three errors 35 s apart were bucketed at
 * 35 000 ms.
 *
 * So the caller passes the run series' final width and this coalesces up to it.
 * That is always possible, and always exact: an error is recorded at the same
 * `endMs` the run series receives on its 'end' edge, so error buckets are a
 * SUBSET of run buckets at every width; given the same `maxBuckets` cap the run
 * series therefore never halves later, and the coalesce is a merge of counts
 * rather than an impossible split. `engine.ts` passes `maxBucketsRun` for
 * exactly this reason — a different cap breaks the argument.
 */

/**
 * Five named messages, so five plus the folded remainder fills the categorical
 * palette exactly.
 *
 * `apps/web`'s `MAX_CATEGORICAL_SERIES` is six and there is no seventh —
 * `assignPalette` leaves an excess series UNDRAWN. A sixth named message would
 * therefore push `other` off the chart silently.
 *
 * The two numbers cannot share a constant: this package depends only on
 * `@perfportal/core` and `apps/web` only on `@perfportal/contracts`, and adding
 * a dependency to carry one integer is not worth it. `apps/web/test` asserts
 * the relationship from its side instead.
 */
export const ERROR_SERIES_KEEP = 5;

/**
 * How many DISTINCT messages are tracked in the time dimension before further
 * new ones fold on arrival.
 *
 * Matches `ErrorRollup.top()`'s limit, so the two surfaces agree except on runs
 * with more than this many distinct messages — where both are already
 * collapsing. Without a cap the structure is `distinct messages × occupied
 * buckets`; the flat rollup carries the same unbounded map today, but
 * multiplying it by bucket count is what makes it worth bounding here.
 */
const MAX_TRACKED_MESSAGES = 200;

export interface ErrorSeriesRow {
  startOffsetMs: number;
  /** `null` is the folded remainder, NOT a message that happens to be absent. */
  message: string | null;
  count: number;
}

export interface ErrorSeriesResult {
  bucketWidthMs: number;
  rows: ErrorSeriesRow[];
}

interface ErrorBucket {
  counts: Map<string, number>;
  /** Failures the tracking cap turned away. Folded into `other` at finish. */
  overflow: number;
}

export class ErrorSeries {
  readonly #startMs: number;
  readonly #maxBuckets: number;
  #widthMs = 1000;
  #buckets = new Map<number, ErrorBucket>();
  #tracked = new Set<string>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  get widthMs(): number {
    return this.#widthMs;
  }

  add(tsMs: number, message: string): void {
    const idx = Math.floor((tsMs - this.#startMs) / this.#widthMs);
    let bucket = this.#buckets.get(idx);
    if (!bucket) {
      bucket = { counts: new Map(), overflow: 0 };
      this.#buckets.set(idx, bucket);
    }

    if (this.#tracked.has(message) || this.#tracked.size < MAX_TRACKED_MESSAGES) {
      this.#tracked.add(message);
      bucket.counts.set(message, (bucket.counts.get(message) ?? 0) + 1);
    } else {
      bucket.overflow += 1;
    }

    while (this.#buckets.size > this.#maxBuckets) this.#halve();
  }

  /** Merges adjacent bucket pairs and doubles the width. Lossless: counts sum. */
  #halve(): void {
    const next = new Map<number, ErrorBucket>();
    for (const [idx, b] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
      const ni = Math.floor(idx / 2);
      const target = next.get(ni);
      if (!target) {
        next.set(ni, b);
        continue;
      }
      for (const [message, count] of b.counts) {
        target.counts.set(message, (target.counts.get(message) ?? 0) + count);
      }
      target.overflow += b.overflow;
    }
    this.#buckets = next;
    this.#widthMs *= 2;
  }

  finish(widthMs: number, keep: number = ERROR_SERIES_KEEP): ErrorSeriesResult {
    // Up only. A request for a NARROWER width cannot happen (see the file
    // docstring), and clamping rather than throwing keeps a broken invariant
    // from failing a whole ingest for one chart — the returned width is the
    // real one, so the chart stays self-consistent either way.
    while (this.#widthMs < widthMs) this.#halve();

    // Run-wide totals, computed AFTER coalescing so the ranking is over final
    // buckets. Per-bucket ranking would make a series appear and vanish
    // depending on which message happened to lead in each bucket.
    const totals = new Map<string, number>();
    for (const bucket of this.#buckets.values()) {
      for (const [message, count] of bucket.counts) {
        totals.set(message, (totals.get(message) ?? 0) + count);
      }
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, keep)
      .map(([message]) => message);
    const kept = new Set(top);

    const rows: ErrorSeriesRow[] = [];
    for (const [idx, bucket] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
      const startOffsetMs = idx * this.#widthMs;
      // In global rank order, so a bucket's rows read the same way everywhere.
      for (const message of top) {
        const count = bucket.counts.get(message);
        if (count !== undefined) rows.push({ startOffsetMs, message, count });
      }
      let other = bucket.overflow;
      for (const [message, count] of bucket.counts) if (!kept.has(message)) other += count;
      // No zero row: a fold that folded nothing is not a measurement.
      if (other > 0) rows.push({ startOffsetMs, message: null, count: other });
    }

    return { bucketWidthMs: this.#widthMs, rows };
  }
}
```

- [ ] **Step 4: Export it**

Add to `packages/statistics/src/index.ts`, after the `errors-rollup.js` line:

```ts
export * from './errors-series.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/errors-series.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/statistics/src/errors-series.ts packages/statistics/test/errors-series.test.ts packages/statistics/src/index.ts
git commit -m "feat(statistics): failures on a time axis, coalesced to the run series' width"
```

---

### Task 2: Engine wiring

**Files:**
- Modify: `packages/statistics/src/engine.ts`
- Modify: `packages/statistics/test/engine.test.ts`

**Interfaces:**
- Consumes: `ErrorSeries`, `ERROR_SERIES_KEEP` from Task 1.
- Produces: `EngineResult.errorSeries: ErrorSeriesResult`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/statistics/test/engine.test.ts`. That file builds `CanonicalEvent` object literals directly — there is no `meta()`/`request()` builder — so this block declares its own local helpers in the same style rather than inventing a shared one.

Add `inferBucketWidthMs` to the existing `../src/engine.js` import line's neighbour: `import { inferBucketWidthMs } from '../src/buckets.js';`

```ts
describe('errors over time', () => {
  const BASE = 1_000;
  const meta: CanonicalEvent = {
    type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: BASE,
  };
  const failed = (startMs: number, endMs: number, message?: string): CanonicalEvent => ({
    type: 'request', name: 'r', groups: [], userId: 'u', startMs, endMs, ok: false, message,
  });
  const passed = (startMs: number, endMs: number): CanonicalEvent => ({
    type: 'request', name: 'r', groups: [], userId: 'u', startMs, endMs, ok: true,
  });

  it('buckets a failure at its END, where koCount is counted', () => {
    // Starts in bucket 0 (offset 900) and fails in bucket 1 (offset 1200), so
    // the two edges disagree and the assertion can tell them apart. It belongs
    // with its own KO, which the run series records on the 'end' edge.
    const r = runEngine([meta, failed(BASE + 900, BASE + 1_200, 'boom')]);
    expect(r.errorSeries.rows).toEqual([{ startOffsetMs: 1_000, message: 'boom', count: 1 }]);
  });

  it('reports the same bucket width as the run-scope response-time series', () => {
    // The alignment the whole design exists for: two charts on one page at one
    // resolution. Derived from the run series, never written down.
    //
    // 4000 one-second requests against a 100-bucket cap forces the run series
    // to halve repeatedly, while the 80 failures never exceed the cap on their
    // own — so this exercises the coalesce rather than a no-op.
    const events: CanonicalEvent[] = [meta];
    for (let i = 0; i < 4_000; i += 1) {
      const startMs = BASE + i * 1_000;
      events.push(i % 50 === 0 ? failed(startMs, startMs + 10, 'boom') : passed(startMs, startMs + 10));
    }
    const r = runEngine(events, { maxBucketsRun: 100 });
    const runSeries = [...r.series.values()].find((s) => s.scope === 'run')!;
    expect(r.errorSeries.bucketWidthMs).toBe(
      inferBucketWidthMs(runSeries.buckets.map((b) => b.startOffsetMs)),
    );
  });

  it('INCLUDES warm-up, unlike the flat errors rollup', () => {
    // Series include warm-up (PRD 7.4). If this one did not, a bucket inside
    // the warm-up window would show koCount > 0 on the responses chart and
    // nothing at all here, on the same axis at the same instant.
    const r = runEngine([meta, failed(BASE + 100, BASE + 200, 'boom')], { warmupMs: 5_000 });
    expect(r.errors).toHaveLength(0);
    expect(r.errorSeries.rows).toHaveLength(1);
  });

  it('labels a message-less failure exactly as the flat rollup does', () => {
    const r = runEngine([meta, failed(BASE, BASE + 10)]);
    const flat = r.errors.find((e) => e.scope === 'run')!.message;
    expect(r.errorSeries.rows[0]!.message).toBe(flat);
  });

  it('sums to the run series koCount in every bucket', () => {
    // The invariant that makes the two charts reconcile, and the reason the
    // feed is on the end edge. Four distinct messages, so nothing folds and
    // the sum is over named series alone.
    const events: CanonicalEvent[] = [meta];
    for (let i = 0; i < 40; i += 1) {
      const startMs = BASE + i * 100;
      events.push(
        i % 3 === 0 ? failed(startMs, startMs + 50, `m${i % 4}`) : passed(startMs, startMs + 50),
      );
    }
    const r = runEngine(events);
    const runSeries = [...r.series.values()].find((s) => s.scope === 'run')!;

    const drawn = new Map<number, number>();
    for (const row of r.errorSeries.rows) {
      drawn.set(row.startOffsetMs, (drawn.get(row.startOffsetMs) ?? 0) + row.count);
    }
    for (const bucket of runSeries.buckets) {
      expect(drawn.get(bucket.startOffsetMs) ?? 0).toBe(bucket.koCount);
    }
  });

  it('is empty for a run with no failures', () => {
    expect(runEngine([meta, passed(BASE, BASE + 10)]).errorSeries.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/statistics/test/engine.test.ts`
Expected: FAIL — `result.errorSeries` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/statistics/src/engine.ts`:

**3a.** Add the import beside the existing `ErrorRollup` one:

```ts
import { ErrorSeries, type ErrorSeriesResult } from './errors-series.js';
```

**3b.** Add the shared label helper at module scope, next to `BUCKET_PERCENTILES`:

```ts
/**
 * The label a failure is filed under.
 *
 * SHARED by the flat rollup and the time series deliberately. The two are read
 * side by side on the errors tab, and a failure that appeared as `(no message)`
 * in one and as an empty string in the other would look like two different
 * failures.
 */
const errorMessageOf = (message: string | undefined): string =>
  message !== undefined && message.length > 0 ? message : '(no message)';
```

**3c.** Add to `EngineResult`:

```ts
  /**
   * Failures over time, run scope. Coalesced to the run-scope response-time
   * series' width so both charts share one resolution — see `errors-series.ts`.
   */
  errorSeries: ErrorSeriesResult;
```

**3d.** Declare the lazy holders beside `errorsByKey`:

```ts
  // LAZY, exactly like `seriesFor`'s BucketSeries instances and for the same
  // reason `userEvents` is buffered: `runStartMs` is 0 until the meta event is
  // handled below, and a series constructed against 0 files every failure at an
  // absolute epoch offset while every request bucket is run-relative.
  let errorSeries: ErrorSeries | null = null;
  const errorSeriesFor = (): ErrorSeries => {
    errorSeries ??= new ErrorSeries({ startMs: runStartMs, maxBuckets: maxBucketsRun });
    return errorSeries;
  };
  // Captured rather than looked up by key after the loop: the `series` map's key
  // is `${scope} ${name} ${family}`, so the run-scope entry's key contains a
  // double space, and a lookup that got the spacing wrong would silently fall
  // back to 1000 ms.
  let runResponseSeries: BucketSeries | null = null;
```

**3e.** In the request branch, assign the captured reference:

```ts
    const runSeries = seriesFor('run', '', 'response_time', maxBucketsRun);
    runResponseSeries = runSeries;
```

**3f.** Feed the series **before** the warm-up guard, immediately after the `epSeries.add(...)` lines:

```ts
    // BEFORE the warm-up guard below, unlike the flat `errorsFor` calls after
    // it. Series include warm-up (PRD 7.4) and this is a series.
    if (!e.ok) errorSeriesFor().add(e.endMs, errorMessageOf(e.message));
```

**3g.** Replace the inline normalisation in the existing flat-rollup block so both paths share one helper:

```ts
    if (!e.ok) {
      const message = errorMessageOf(e.message);
      errorsFor('run', '').add(message);
      errorsFor('request', name).add(message);
    }
```

**3h.** After the event loop, beside the `errors` assembly:

```ts
  const runWidthMs = runResponseSeries?.widthMs ?? 1000;
  const errorSeriesResult: ErrorSeriesResult =
    errorSeries === null ? { bucketWidthMs: runWidthMs, rows: [] } : errorSeries.finish(runWidthMs);
```

**3i.** Add `errorSeries: errorSeriesResult,` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/statistics/`
Expected: PASS. The whole package, not just the two files — `engine.test.ts`, `parity.test.ts` and `scopes.test.ts` all assert on `EngineResult`.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics/src/engine.ts packages/statistics/test/engine.test.ts
git commit -m "feat(statistics): the engine fills the error series, warm-up included"
```

---

### Task 3: Migration and persistence

**Files:**
- Create: `packages/persistence/prisma/migrations/20260815180000_run_error_bucket/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma`
- Modify: `packages/persistence/src/metrics/write.ts`
- Modify: `packages/persistence/src/metrics/read.ts`
- Modify: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Consumes: `EngineResult.errorSeries` from Task 2.
- Produces: `ERROR_SERIES_SQL`; `MetricReader.errorSeries(scope: ProjectScope, runId: string, runStartedOn: Date): Promise<StoredErrorBucket[]>`; `interface StoredErrorBucket { startOffsetMs: number; message: string | null; count: number; bucketWidthMs: number }`.

- [ ] **Step 1: Write the migration**

`packages/persistence/prisma/migrations/20260815180000_run_error_bucket/migration.sql`:

```sql
-- Failures on a time axis, run scope. Partitioned on run_started_on exactly
-- like run_series_bucket and run_user_bucket, for retention (NFR-SC-7):
-- dropping a partition beats a delete storm.
--
-- No scope/name/family columns. This table is run scope only; a column that
-- only ever holds one value invites a future reader to filter on it and find
-- the filter silently ignored.
--
-- is_other is a REAL COLUMN rather than the magic message 'other' that
-- ErrorRollup.top() uses. That literal collides with a genuine error message
-- of the same text, which in the flat table's unique key is a latent unique
-- violation that would fail an ingest. Folded rows carry message = '' and
-- is_other = true; a real message is never empty, because the engine maps a
-- missing one to '(no message)'.
--
-- bucket_width_ms is constant per run and denormalised deliberately. The
-- alternative is inferBucketWidthMs, which reads the smallest gap between
-- offsets — right for a dense series and systematically wrong for a sparse
-- one: three errors at 5s, 40s and 90s infer a width of 35000ms.
CREATE TABLE "run_error_bucket" (
    "run_started_on"  DATE    NOT NULL,
    "run_id"          UUID    NOT NULL,
    "org_id"          UUID    NOT NULL,
    "project_id"      UUID    NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "message"         TEXT    NOT NULL,
    "is_other"        BOOLEAN NOT NULL,
    "count"           INTEGER NOT NULL,
    "bucket_width_ms" INTEGER NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_error_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "start_offset_ms", "message", "is_other")
) PARTITION BY RANGE ("run_started_on");

-- Twelve months from 2026-01, matching its two neighbours. Automatic rollover
-- is a later milestone; until then a write past the last partition fails
-- loudly rather than silently landing somewhere wrong.
CREATE TABLE "run_error_bucket_2026_01" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_error_bucket_2026_02" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_error_bucket_2026_03" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_error_bucket_2026_04" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_error_bucket_2026_05" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_error_bucket_2026_06" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_error_bucket_2026_07" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_error_bucket_2026_08" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_error_bucket_2026_09" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_error_bucket_2026_10" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_error_bucket_2026_11" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_error_bucket_2026_12" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
```

- [ ] **Step 2: Add the Prisma model**

In `packages/persistence/prisma/schema.prisma`, after `RunUserBucket`:

```prisma
/// Partitioned by range on run_started_on — see migration
/// 20260815180000_run_error_bucket, hand-edited. Prisma cannot express
/// partitioning.
model RunErrorBucket {
  runStartedOn  DateTime @map("run_started_on") @db.Date
  runId         String   @map("run_id") @db.Uuid
  orgId         String   @map("org_id") @db.Uuid
  projectId     String   @map("project_id") @db.Uuid
  startOffsetMs Int      @map("start_offset_ms")
  /// '' when isOther. A real message is never empty — the engine maps a
  /// missing one to '(no message)'.
  message       String
  /// The folded remainder, as a column rather than a magic message value.
  isOther       Boolean  @map("is_other")
  count         Int
  /// Constant per run, denormalised deliberately: inferring a width from
  /// sparse offsets is systematically wrong. See the migration.
  bucketWidthMs Int      @map("bucket_width_ms")

  @@id([runStartedOn, runId, startOffsetMs, message, isOther])
  @@map("run_error_bucket")
}
```

- [ ] **Step 3: Let `persist` take custom events**

The file's `persist(ctx)` helper always runs its fixed `events()`, which produce a single distinct message — enough for a round trip, not for a fold. Add a defaulted second parameter, which leaves all existing callers unchanged:

```ts
async function persist(
  ctx: { orgId: string; projectId: string; runId: string },
  evts: CanonicalEvent[] = events(),
) {
  const result = runEngine(evts, { percentiles: [50, 95, 99] });
  // ...rest unchanged
}
```

- [ ] **Step 4: Write the failing integration tests**

Append to `packages/persistence/test/metrics.integration.test.ts`. Add `ERROR_SERIES_SQL` to the existing `../src/index.js` import.

```ts
describe('error series', () => {
  const BASE = STARTED_AT.getTime();
  const start: CanonicalEvent = {
    type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: BASE,
  };
  const fail = (i: number, message: string): CanonicalEvent => ({
    type: 'request', name: 'GET /a', groups: [], userId: String(i),
    startMs: BASE + i * 100, endMs: BASE + i * 100 + 20, ok: false, message,
  });

  it('round-trips rows, mapping the folded remainder to null', async () => {
    const ctx = await seedRun();
    // Seven distinct messages at descending frequency: five are kept by name
    // and two fold, so both row kinds are exercised.
    const evts: CanonicalEvent[] = [start];
    for (let rank = 0; rank < 7; rank += 1) {
      for (let n = 0; n < 10 - rank; n += 1) evts.push(fail(rank * 10 + n, `m${rank}`));
    }
    const result = await persist(ctx, evts);

    const rows = await new MetricReader(pool).errorSeries(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON,
    );

    // Derived from what the engine produced, never written down.
    expect(rows).toHaveLength(result.errorSeries.rows.length);
    expect(rows.some((r) => r.message === null)).toBe(true);
    expect(rows.every((r) => r.bucketWidthMs === result.errorSeries.bucketWidthMs)).toBe(true);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(
      result.errorSeries.rows.reduce((n, r) => n + r.count, 0),
    );
  });

  it('does not collide when a real message is literally "other"', async () => {
    // The failure `is_other` exists to prevent. With a magic message value the
    // folded row and this real one share a primary key, and the INSERT fails
    // the whole ingest rather than merely drawing something wrong.
    const ctx = await seedRun();
    const evts: CanonicalEvent[] = [start];
    // 'other' frequent enough to be kept BY NAME (20), plus six rarer messages
    // so that something really does fold as well.
    for (let n = 0; n < 20; n += 1) evts.push(fail(n, 'other'));
    for (let rank = 0; rank < 6; rank += 1) {
      for (let n = 0; n < 6 - rank; n += 1) evts.push(fail(100 + rank * 10 + n, `m${rank}`));
    }
    await persist(ctx, evts);

    const rows = await new MetricReader(pool).errorSeries(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON,
    );
    expect(rows.some((r) => r.message === 'other')).toBe(true);
    expect(rows.some((r) => r.message === null)).toBe(true);
  });

  it('prunes partitions when reading error buckets', async () => {
    // Mirrors the run_user_bucket pruning test exactly, and EXPLAINs the
    // exported constant rather than a copy of it — a test against a copy keeps
    // passing after the real query loses its partition predicate.
    const ctx = await seedRun();
    await persist(ctx);
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${ERROR_SERIES_SQL}`,
      [STARTED_ON, ctx.runId, ctx.orgId, ctx.projectId],
    );
    expect(JSON.stringify(rows)).not.toMatch(/run_error_bucket_2026_(0[1-7]|09|1[0-2])/);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
pnpm vitest run packages/persistence/test/metrics.integration.test.ts
```
Expected: FAIL — `reader.errorSeries is not a function`.

- [ ] **Step 6: Implement the writer**

In `packages/persistence/src/metrics/write.ts`, after the `run_error` insert:

```ts
    await insertBatched(
      client,
      'run_error_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'start_offset_ms', 'message', 'is_other', 'count', 'bucket_width_ms',
      ],
      result.errorSeries.rows.map((r) => [
        ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
        r.startOffsetMs,
        // null is the folded remainder; the column pair carries it explicitly
        // rather than through a message value a real error could also have.
        r.message ?? '', r.message === null,
        r.count,
        result.errorSeries.bucketWidthMs,
      ]),
    );
```

- [ ] **Step 7: Implement the reader**

In `packages/persistence/src/metrics/read.ts`, beside `USER_SERIES_SQL`:

```ts
/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL and USER_SERIES_SQL: `run_started_on = $1`
 * is the partition-key predicate, and a test that asserted the plan of a COPY
 * of this string would keep passing after the real one lost it.
 */
export const ERROR_SERIES_SQL = `SELECT start_offset_ms, message, is_other, count, bucket_width_ms
         FROM run_error_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
        ORDER BY start_offset_ms ASC, count DESC, message ASC`;
```

The `StoredErrorBucket` interface beside `StoredUserBucket`:

```ts
export interface StoredErrorBucket {
  startOffsetMs: number;
  /** `null` is the folded remainder, reconstructed from `is_other`. */
  message: string | null;
  count: number;
  bucketWidthMs: number;
}
```

And the method on `MetricReader`, after `users()`:

```ts
  /** runStartedOn is REQUIRED for the same partition-pruning reason as series(). */
  async errorSeries(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
  ): Promise<StoredErrorBucket[]> {
    const { rows } = await this.pool.query(
      ERROR_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      message: r.is_other ? null : r.message,
      count: r.count,
      bucketWidthMs: r.bucket_width_ms,
    }));
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run packages/persistence/test/metrics.integration.test.ts`
Expected: PASS. Also run `pnpm vitest run packages/persistence/test/migrations.integration.test.ts` — it checks the migration set applies cleanly.

- [ ] **Step 9: Commit**

```bash
git add packages/persistence/
git commit -m "feat(persistence): run_error_bucket, partitioned like its two neighbours"
```

---

### Task 4: Contract and endpoint

**Files:**
- Modify: `packages/contracts/src/metrics.ts`
- Modify: `apps/api/src/metrics/metrics.controller.ts`
- Create: `apps/api/test/error-series.integration.test.ts`

**Interfaces:**
- Consumes: `MetricReader.errorSeries` from Task 3.
- Produces: `ErrorSeriesResponseSchema` / `ErrorSeriesResponse`; `GET /v1/runs/:id/errors/series`.

- [ ] **Step 1: Write the contract**

In `packages/contracts/src/metrics.ts`, after `ErrorsResponseSchema`:

```ts
export const ErrorSeriesResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The width of every bucket, STORED rather than inferred. Errors are sparse,
   * and `inferBucketWidthMs` reads the smallest gap between offsets — three
   * errors 35s apart would infer a 35000ms width. Equal to `/series`'
   * `bucketWidthMs` for the same run, by construction.
   */
  bucketWidthMs: z.number().int().positive(),
  /**
   * False ONLY for a run ingested before errors were recorded over time. A run
   * that genuinely had no failures is `true` with an empty `series` — the two
   * are otherwise indistinguishable, and drawing empty axes for the first would
   * claim the run succeeded.
   */
  available: z.boolean(),
  series: z.array(
    z.object({
      /** `null` is the folded remainder, NOT a message that failed to load. */
      message: z.string().nullable(),
      total: z.number().int(),
      points: z.array(
        z.object({ startOffsetMs: z.number().int(), count: z.number().int() }),
      ),
    }),
  ),
});
export type ErrorSeriesResponse = z.infer<typeof ErrorSeriesResponseSchema>;
```

- [ ] **Step 2: Write the failing integration test**

`apps/api/test/error-series.integration.test.ts`. Copy the bundle/`beforeAll`/`afterEach`/`ingested()`/`auth()` preamble from `trends.integration.test.ts` verbatim — same `createTestApp`, same `runPipelineFor`, same `Queue` obliterate.

```ts
import { ErrorSeriesResponseSchema, SeriesResponseSchema } from '@perfportal/contracts';

// ...the preamble from trends.integration.test.ts: bundle, ctx, ingested(), auth()

const errorSeries = (id: string) =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/errors/series`).set(auth());

const runSeries = (id: string) =>
  request(ctx.app.getHttpServer())
    .get(`/v1/runs/${id}/series?scope=run&name=&family=response_time`)
    .set(auth());

describe('GET /v1/runs/:id/errors/series', () => {
  it('serves at most five named series plus the folded remainder', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.series.filter((s) => s.message !== null).length).toBeLessThanOrEqual(5);
    expect(body.series.length).toBeLessThanOrEqual(6);
    expect(body.available).toBe(true);
  });

  it('reports the same bucket width as /series for the same run', async () => {
    // Derived from the other endpoint, never written down. This alignment is
    // what the whole design exists for — see the spec's §2.
    ctx = await createTestApp();
    const id = await ingested();

    const series = SeriesResponseSchema.parse((await runSeries(id)).body);
    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.bucketWidthMs).toBe(series.bucketWidthMs);
  });

  it('reconciles with the run series koCount, bucket by bucket', async () => {
    // The invariant the end-edge feed buys. The reference bundle has fewer
    // than five distinct messages, so nothing folds and this is a sum over
    // named series — but the assertion holds either way.
    ctx = await createTestApp();
    const id = await ingested();

    const series = SeriesResponseSchema.parse((await runSeries(id)).body);
    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);

    const drawn = new Map<number, number>();
    for (const s of body.series) {
      for (const p of s.points) {
        drawn.set(p.startOffsetMs, (drawn.get(p.startOffsetMs) ?? 0) + p.count);
      }
    }
    for (const bucket of series.buckets) {
      expect(drawn.get(bucket.startOffsetMs) ?? 0).toBe(bucket.koCount);
    }
  });

  it('reports NOT available when flat errors exist and bucket rows do not', async () => {
    // Exactly the state a run ingested before this migration is in: the flat
    // errors table has its rows, this table has none.
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query('DELETE FROM run_error_bucket WHERE run_id = $1', [id]);

    const body = ErrorSeriesResponseSchema.parse((await errorSeries(id)).body);
    expect(body.available).toBe(false);
    expect(body.series).toEqual([]);
  });

  it('404s for a run in another org', async () => {
    // 404, never 403: the status must not distinguish "no such run" from "not
    // yours", exactly as the sibling routes already reason about.
    ctx = await createTestApp();
    const theirRun = randomUUID();
    const other = await ctx.prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'p', name: 'P', settings: {} },
    });
    await ctx.prisma.run.create({
      data: {
        id: theirRun,
        orgId: other.id,
        projectId: otherProject.id,
        status: 'complete',
        tool: 'gatling',
        startedAt: new Date('2026-08-02T10:00:00Z'),
        startedOn: new Date('2026-08-02T10:00:00Z'),
        bundleKey: `k/${theirRun}`,
        bundleSha256: 'y'.repeat(64),
        bundleBytes: BigInt(1),
        engineOptions: {},
      },
    });

    expect((await errorSeries(theirRun)).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run apps/api/test/error-series.integration.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 4: Implement the endpoint**

In `apps/api/src/metrics/metrics.controller.ts`, after the existing `errors` handler:

```ts
  /**
   * Failures over time, RUN SCOPE ONLY — and it takes no `scope` or `name`
   * query parameters at all.
   *
   * That absence is deliberate. The other metrics endpoints force `name` to ''
   * when `scope` is absent, so a scoped call that forgets `scope` silently
   * returns the whole run with a 200. The surest way not to reproduce that trap
   * is to have no such parameters: this table holds one scope and the route
   * says so.
   */
  @Get('errors/series')
  @Scopes('read')
  async errorSeries(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<ErrorSeriesResponse> {
    const run = await this.#run(req, id);
    const scope = { orgId: run.orgId, projectId: run.projectId };

    const [rows, flat] = await Promise.all([
      this.reader.errorSeries(scope, run.id, run.startedOn),
      this.reader.errors(scope, run.id),
    ]);

    // One expression over BOTH counts, not a lookup on the flat table alone.
    // A project with warmupMs > 0 whose only failures fell in the ramp has
    // bucket rows and no flat rows — the series includes warm-up, the table
    // does not — and that run's data is present, not missing.
    const available = rows.length > 0 || flat.length === 0;

    // Grouped in first-seen order, which the reader's ORDER BY makes the
    // global rank order the engine emitted.
    const byMessage = new Map<string | null, { total: number; points: { startOffsetMs: number; count: number }[] }>();
    for (const row of rows) {
      let entry = byMessage.get(row.message);
      if (!entry) { entry = { total: 0, points: [] }; byMessage.set(row.message, entry); }
      entry.total += row.count;
      entry.points.push({ startOffsetMs: row.startOffsetMs, count: row.count });
    }

    return {
      runId: run.id,
      // The stored width, which is constant per run. `?? 1000` only for a run
      // with no rows at all, where nothing is drawn anyway.
      bucketWidthMs: rows[0]?.bucketWidthMs ?? 1000,
      available,
      series: [...byMessage.entries()].map(([message, entry]) => ({ message, ...entry })),
    };
  }
```

Add `ErrorSeriesResponse` to the contracts import at the top of the file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/test/error-series.integration.test.ts apps/api/test/openapi.integration.test.ts`
Expected: PASS. The OpenAPI suite iterates every path generically, so the new route must satisfy its `responses` and `security` assertions without a bespoke case.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics.ts apps/api/
git commit -m "feat(api): GET /v1/runs/:id/errors/series, run scope and no scope parameter"
```

---

### Task 5: The chart

**Files:**
- Modify: `apps/web/src/api/metrics.ts`
- Create: `apps/web/src/charts/transforms/errorSeries.ts`
- Create: `apps/web/src/charts/ErrorsChart.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx`
- Create: `apps/web/test/transforms.errorSeries.test.ts`

**Interfaces:**
- Consumes: `ErrorSeriesResponse` from Task 4.
- Produces: `errorSeriesQuery(id: string)`; `toErrorSeries(response: ErrorSeriesResponse): ChartData`; `ErrorsChart({ data }: { data: ErrorSeriesResponse })`.

- [ ] **Step 1: Write the failing transform tests**

`apps/web/test/transforms.errorSeries.test.ts`:

```ts
import type { ErrorSeriesResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { OTHER_LABEL, toErrorSeries } from '../src/charts/transforms/errorSeries';
import { MAX_CATEGORICAL_SERIES } from '../src/charts/theme';
import { ERROR_SERIES_KEEP } from './support/errorSeriesKeep';

const response = (over: Partial<ErrorSeriesResponse> = {}): ErrorSeriesResponse => ({
  runId: '00000000-0000-4000-8000-000000000000',
  bucketWidthMs: 1000,
  available: true,
  series: [],
  ...over,
});

describe('toErrorSeries', () => {
  it('plots [elapsedMs, rate] pairs on a value axis', () => {
    // Not one value per shared category: errors are SPARSE, and a category
    // axis indexes by position, so failures at 5s, 40s and 90s would draw
    // three evenly-spaced points and misplace all of them in time.
    const d = toErrorSeries(response({
      series: [{ message: 'boom', total: 2, points: [{ startOffsetMs: 5000, count: 2 }] }],
    }));
    expect(d.series[0]!.data).toEqual([[5000, 2]]);
  });

  it('divides by the response’s OWN bucket width', () => {
    // A 2000ms bucket holding the same count is HALF the rate — the same
    // argument transforms/rates.ts makes.
    const points = [{ startOffsetMs: 0, count: 4 }];
    const fine = toErrorSeries(response({ bucketWidthMs: 1000, series: [{ message: 'b', total: 4, points }] }));
    const coarse = toErrorSeries(response({ bucketWidthMs: 2000, series: [{ message: 'b', total: 4, points }] }));
    const at0 = (d: typeof fine) => (d.series[0]!.data as [number, number][])[0]![1];
    expect(at0(coarse)).toBeCloseTo(at0(fine) / 2, 9);
  });

  it('names the folded remainder rather than drawing an unlabelled series', () => {
    const d = toErrorSeries(response({
      series: [{ message: null, total: 3, points: [{ startOffsetMs: 0, count: 3 }] }],
    }));
    expect(d.series[0]!.name).toBe(OTHER_LABEL);
  });

  it('says a run predates the recording instead of drawing empty axes', () => {
    const d = toErrorSeries(response({ available: false }));
    expect(d.empty).toBeTruthy();
    expect(d.series).toHaveLength(0);
  });

  it('says a run simply had no failures, in different words', () => {
    // The distinction `available` exists for. Both are empty; only one of them
    // is good news, and a reader must be able to tell which.
    const missing = toErrorSeries(response({ available: false })).empty;
    const clean = toErrorSeries(response({ available: true })).empty;
    expect(clean).toBeTruthy();
    expect(clean).not.toBe(missing);
  });

  it('carries one table row per offset across every series', () => {
    // The parity surface: a sparse series must not lose the offsets only its
    // neighbours occupy.
    const d = toErrorSeries(response({
      series: [
        { message: 'a', total: 1, points: [{ startOffsetMs: 0, count: 1 }] },
        { message: 'b', total: 1, points: [{ startOffsetMs: 2000, count: 1 }] },
      ],
    }));
    expect(d.rows).toHaveLength(2);
  });
});

describe('the palette has room for what the engine keeps', () => {
  it('draws every kept message AND the folded remainder', () => {
    // The engine's ERROR_SERIES_KEEP and this palette cannot share a constant —
    // @perfportal/statistics depends only on @perfportal/core, and apps/web
    // only on @perfportal/contracts. Shrinking the palette would otherwise push
    // `other` off the chart silently, because assignPalette leaves an excess
    // series UNDRAWN.
    expect(MAX_CATEGORICAL_SERIES).toBeGreaterThanOrEqual(ERROR_SERIES_KEEP + 1);
  });
});
```

Create `apps/web/test/support/errorSeriesKeep.ts` holding the mirrored constant with a comment naming `packages/statistics/src/errors-series.ts` as its source, so the duplication is visible rather than buried in an assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/test/transforms.errorSeries.test.ts`
Expected: FAIL — cannot resolve `../src/charts/transforms/errorSeries`.

- [ ] **Step 3: Implement the transform**

`apps/web/src/charts/transforms/errorSeries.ts`:

```ts
import type { ErrorSeriesResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/** What the folded remainder is called wherever a reader can see it. */
export const OTHER_LABEL = 'Other errors';

/**
 * Failures per second, one series per message.
 *
 * A VALUE X-AXIS, like the compare overlay and unlike every other run chart.
 * Errors are sparse — the reference run has failures in 21 of its 62 buckets —
 * and a category axis indexes points by position, so the gaps would close and
 * every point after the first gap would sit at the wrong time.
 */
export function toErrorSeries(response: ErrorSeriesResponse): ChartData {
  const perSecond = response.bucketWidthMs / 1000;
  const label = (message: string | null): string => message ?? OTHER_LABEL;

  if (response.series.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns: ['Elapsed (s)'],
      rows: [],
      // TWO DIFFERENT SENTENCES, deliberately. Both states draw nothing, and
      // only one of them is good news; a reader who cannot tell "this run
      // passed" from "we did not record this" has been told nothing.
      empty: response.available
        ? 'No requests failed in this run.'
        : 'This run was ingested before failures were recorded over time.',
    };
  }

  const series: ChartSeries[] = response.series.map((s) => ({
    name: label(s.message),
    data: s.points.map((p) => [p.startOffsetMs, p.count / perSecond] as [number, number]),
  }));

  // The union of every series' offsets, so a message that only failed once
  // still has its row — the table is the parity surface and the screen-reader
  // route to the same data.
  const offsets = [
    ...new Set(response.series.flatMap((s) => s.points.map((p) => p.startOffsetMs))),
  ].sort((a, b) => a - b);

  const lookups = response.series.map(
    (s) => new Map(s.points.map((p) => [p.startOffsetMs, p.count / perSecond])),
  );

  const rows: ChartTableRow[] = offsets.map((offset) => ({
    label: String(offset / 1000),
    // `—` rather than 0: this message did not fail in this bucket, which is
    // not the same claim as a measured rate of zero.
    values: lookups.map((lookup) => lookup.get(offset) ?? '—'),
  }));

  return {
    series,
    // EMPTY ON PURPOSE: x is a measured quantity, so each point carries its own.
    axisLabels: [],
    columns: ['Elapsed (s)', ...response.series.map((s) => label(s.message))],
    rows,
  };
}
```

- [ ] **Step 4: Implement the query factory**

In `apps/web/src/api/metrics.ts`, following the `usersQuery` shape:

```ts
export const errorSeriesQueryKey = (id: string) => ['run', id, 'errors', 'series'] as const;

/** Takes no parameters: the endpoint is run scope only, by design. */
export const errorSeriesQuery = (id: string) => ({
  queryKey: errorSeriesQueryKey(id),
  queryFn: () => apiFetch(ErrorSeriesResponseSchema, `${runPath(id)}/errors/series`),
  staleTime: Infinity,
});
```

- [ ] **Step 5: Implement the chart**

`apps/web/src/charts/ErrorsChart.tsx`:

```tsx
import type { ErrorSeriesResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { toErrorSeries } from './transforms/errorSeries';

/**
 * Failures per second, above the errors table on the same tab.
 *
 * NO ICON, NO DECORATIVE SVG. `Chart` renders its data table inside the
 * `<figure>`, and nine specs across `run-charts.spec.ts` and
 * `request-detail.spec.ts` prove a chart really drew by counting SVG elements
 * within the figure. An icon makes those counts wrong and destroys the
 * invariant they rest on.
 *
 * The categorical palette, never `--color-status-failed`: chart marks come from
 * `--chart-*` through `assignPalette`, and `--color-status-*` is a TEXT palette
 * deliberately kept out of `@theme` — `text-status-failed` emits no CSS at all.
 */
export default function ErrorsChart({ data }: { readonly data: ErrorSeriesResponse }) {
  const chart = useMemo(() => toErrorSeries(data), [data]);

  return (
    <Chart
      id="errors-over-time"
      title="Errors per second"
      data={chart}
      kind="line"
      // The same crosshair group as every other chart measuring this run's
      // clock, because that is what this measures too.
      group="run-time"
      xAxis={{ type: 'value', name: 'Elapsed (ms)' }}
      yAxis={{ name: 'Errors/s' }}
      unit="/s"
    />
  );
}
```

- [ ] **Step 6: Put it on the Errors tab**

In `apps/web/src/routes/RunDetail.tsx`, `RunErrorsTab` — the chart above the table, both from their own queries:

```tsx
export function RunErrorsTab() {
  const { runId } = useParams<{ runId: string }>();
  const errors = useQuery({ ...errorsQuery(runId ?? ''), enabled: runId !== undefined });
  const series = useQuery({ ...errorSeriesQuery(runId ?? ''), enabled: runId !== undefined });

  return (
    <div className="flex flex-col gap-6">
      {/* WHEN, then WHAT. The chart answers "did this run degrade or was it
          broken throughout", which is the question a reader arrives with; the
          table below answers "what exactly failed" and holds every message,
          not only the five the palette can draw. */}
      <Payload query={series} slots={[{ id: 'errors-over-time', title: 'Errors per second' }]}>
        {(data) => <ErrorsChart data={data} />}
      </Payload>

      <TableSection title="Errors" query={errors}>
        {(data) => <ErrorsTable errors={data} />}
      </TableSection>
    </div>
  );
}
```

Add the two imports (`ErrorsChart`, `errorSeriesQuery`) and confirm `Payload` is already imported in this file — it is, from `./payload`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run apps/web/`
Expected: PASS. The whole app's unit suite — `RunDetail` has existing tests that assert the errors tab's contents.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): errors per second, above the table that lists them all"
```

---

### Task 6: Browser coverage and the full gate

**Files:**
- Modify: `apps/web/e2e/run-tables.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-15-errors-over-time.md` (tick the boxes)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

The chart's browser coverage belongs in `run-tables.spec.ts`, which already owns the errors tab and has a `runErrorsPath` helper — not a new spec file.

- [ ] **Step 1: Write the failing e2e cases**

Append to `apps/web/e2e/run-tables.spec.ts`:

```ts
test('the errors tab draws failures over time above the table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  const figure = page.getByTestId('chart-errors-over-time');
  // EXACTLY ONE svg in the figure — the invariant nine other specs rest on,
  // and the reason no icon may be rendered inside it.
  await expect(figure.locator('svg')).toHaveCount(1);

  // One series per distinct message the payload really carries. Derived from
  // the API, never written down: the reference bundle's message set changes on
  // re-capture and that is not a defect.
  const body = await errors(page, runId);
  const expected = Math.min(body.errors.length, 5);
  await expect(figure.locator('svg text[text-anchor="start"]')).toHaveCount(expected);

  // And the table is still below it, holding every message rather than five.
  await expect(errorsTable(page)).toHaveCount(1);
});

test('the errors chart carries its data table, like every other chart', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  await expect(page.getByTestId('chart-data-errors-over-time')).toHaveCount(1);
});
```

Reuse the file's existing `errors(page, runId)` payload helper and `errorsTable(page)` locator; do not add new ones.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test:e2e -- run-tables`
Expected: FAIL — `chart-errors-over-time` has no matches.

- [ ] **Step 3: Make them pass**

They should already pass from Task 5. If the series count is wrong, the likely cause is the legend: `Chart` draws no legend below two series, so a run with one distinct message has zero `text-anchor="start"` labels. Adjust the assertion to match `Chart`'s documented behaviour rather than changing `Chart`.

- [ ] **Step 4: Run the full gate, in its documented order**

```bash
source ~/.nvm/nvm.sh && nvm use
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. Integration **before** e2e — Playwright's `webServer` and its worker do not stop the instant the last spec passes, and `test:integration` truncating every table underneath a still-draining queue produces a failure that reproduces on nothing.

Unit must report **more** than 74 files / 830 tests, since this plan adds suites. Update the floor in `CLAUDE.md` to the new numbers.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "test(web): errors over time in a real browser, and the gate"
git push -u origin feat/errors-over-time
gh pr create --base main --title "feat: errors over time" --body "..."
```

Then use `superpowers:finishing-a-development-branch`.
