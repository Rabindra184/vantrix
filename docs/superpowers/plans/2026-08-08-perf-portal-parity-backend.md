# PerfPortal Parity Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Appendix A data row a value behind it and a `PT-*` test asserting that value against the checked-in Gatling 3.15.1.2 fixture, so the parity frontend becomes a pure rendering project.

**Architecture:** An exact 1 ms sparse histogram is stored beside the existing DDSketch on `run_stat`, split OK/KO. From it, indicator bands and Gatling-compatible distribution bins are computed **at read time** at any bounds, which is what makes K-01–K-03 configurable without a re-ingest. The engine stops discarding `UserEvent`s and gains a per-scenario user series; errors become per-`(scope, name)`; `run_indicator` is deleted because it is now derivable.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node ≥ 22, pnpm workspaces, Vitest, NestJS + Express, Prisma (CRUD/migrations) + raw `pg` (metrics), Postgres range partitioning, Zod contracts → OpenAPI 3.1.

**Spec:** [`docs/superpowers/specs/2026-08-08-perf-portal-parity-backend-design.md`](../specs/2026-08-08-perf-portal-parity-backend-design.md)

## Global Constraints

- **Percentile accuracy assertions use `<=` against 1.000%, never `<`.** 1.000% is reachable and DDSketch guarantees it inclusively.
- **Percentiles are never compared to Gatling's printed figure.** Ground truth is the percentile of the fully sorted decoded event set (AC-PARITY-2).
- **Purity lint:** `packages/statistics`, `packages/plugin-gatling`, `packages/core` may not import `fs`, `net`, `pg`, or any I/O module (`eslint.config.js`, `no-restricted-imports`). Histogram and distribution code is pure.
- **`noUncheckedIndexedAccess` is on.** Every array/Map index access yields `T | undefined` and must be narrowed.
- **ESM:** every relative import ends in `.js`, including from `.ts` sources.
- **Apps use SWC, packages use esbuild** under Vitest (`vitest.config.ts`). Do not change that config; NestJS DI depends on it.
- **A partitioned table's primary key must contain the partition key.** `run_user_bucket`'s PK leads with `run_started_on`.
- **Prisma cannot express partitioning.** `run_user_bucket`'s migration SQL is hand-written; `prisma/schema.prisma` carries the model for typing only.
- **`prisma migrate deploy` does not regenerate the client.** Use `pnpm --filter @perfportal/persistence run migrate:deploy`, which chains `prisma generate`.
- **Node-postgres binds a JS `Date` for a `timestamp` (no tz) column in the process's local timezone.** Bind ISO strings for raw timestamp writes.
- **Gatling `maxPlots` is the literal `100`**, hardcoded at `GlobalReportGenerator.scala:80`. It is not configuration.
- **Scala's `Double.round` is `floor(x + 0.5)`**, not JavaScript's `Math.round` for negatives. Values here are non-negative, but use an explicit `scalaRound` helper so the intent is not implicit.
- Commit after every task. Never commit on `main`; work on `feat/parity-backend`.

## Reference facts verified against the fixture and Gatling `v3.15.1` source

These are load-bearing. Tests assert them; do not re-derive them.

| Fact | Value |
|---|---|
| Fixture global min / max | **16 ms / 2503 ms** (min is *not* 28 — 28 is the first bin's midpoint label) |
| Distribution bins | 100, labels `floor(min + step·i + step/2 + 0.5)`, `step = (max−min)/100` |
| First / last distribution label | **28 / 2491** |
| Distribution values | **percent of the combined OK+KO count**, so OK% + KO% sums to 100 across the chart |
| Scatter x | global **requests**/s, both statuses |
| Scatter y | the request's **p95 in that bucket, truncated** (`Math.trunc`) |
| `All users` totals | exactly the per-scenario sum, in both user charts, all 63 buckets |
| Run header duration | rendered `1m 2s` — whole seconds, not ms |
| Fixture totals (already asserted) | 895 requests, 871/24 OK/KO, bands 848/0/23/24, max 2503, mean 228, stddev 370 |

## File Structure

**Create**
- `packages/statistics/src/histogram.ts` — `Histogram`: exact sparse 1 ms bins, OK/KO kept separately by the caller. Merge, serialize, `countBelow`.
- `packages/statistics/src/distribution.ts` — Gatling's binning rules, pure.
- `packages/statistics/src/users.ts` — `UserSeries`: per-scenario `started` / `ended` / `maxConcurrent` buckets.
- `packages/persistence/prisma/migrations/<ts>_parity_backend/migration.sql` — hand-written.
- `apps/api/src/metrics/distribution.controller.ts`, `users.controller.ts`, `scatter.controller.ts`.

**Modify**
- `packages/statistics/src/indicators.ts` — `IndicatorCounter` deleted, replaced by `bandsFrom`.
- `packages/statistics/src/rollup.ts` — `RollupBuilder` carries two histograms.
- `packages/statistics/src/engine.ts` — user events, per-scope errors, meta capture, fixed bucket percentile set, no indicators.
- `packages/persistence/src/metrics/write.ts`, `read.ts`.
- `packages/contracts/src/metrics.ts`, `run.ts`, and a new `settings.ts`.
- `apps/api/src/metrics/metrics.controller.ts`, `apps/api/src/runs/runs.controller.ts`, `apps/api/src/openapi/schemas.ts`.
- `apps/api/test/parity.e2e.test.ts` — grows the `PT-*` cases.
- `PerfPortal_Enterprise_PRD.md` Appendix A, `README.md`.

---

### Task 1: `Histogram` — exact sparse 1 ms histogram

The one structure the whole plan rests on. It must round-trip losslessly: the ingest spine shipped a `Sketch.deserialize` that silently dropped `min`, `max`, and `sum` because nothing ever round-tripped one through storage. Step 1 exists to make that class of bug impossible here.

**Files:**
- Create: `packages/statistics/src/histogram.ts`
- Create: `packages/statistics/test/histogram.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Produces: `class Histogram`, `HISTOGRAM_KIND`, `DEFAULT_HISTOGRAM_CAP_MS`, `interface HistogramSnapshot`.

- [ ] **Step 1: Write the failing test**

Create `packages/statistics/test/histogram.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Histogram, HISTOGRAM_KIND } from '../src/histogram.js';

describe('Histogram', () => {
  it('counts exact integer-millisecond observations', () => {
    const h = new Histogram();
    for (const v of [10, 10, 20, 30, 30, 30]) h.accept(v);
    expect(h.total).toBe(6);
    expect(h.min).toBe(10);
    expect(h.max).toBe(30);
    expect(h.sum).toBe(130);
    expect(h.countAt(10)).toBe(2);
    expect(h.countAt(30)).toBe(3);
    expect(h.countAt(15)).toBe(0);
  });

  it('countBelow is a strict less-than, exact at any bound', () => {
    const h = new Histogram();
    for (const v of [799, 800, 801, 1199, 1200, 1201]) h.accept(v);
    expect(h.countBelow(800)).toBe(1);
    expect(h.countBelow(1200)).toBe(4);
    expect(h.countBelow(0)).toBe(0);
    expect(h.countBelow(Number.POSITIVE_INFINITY)).toBe(6);
  });

  it('merges exactly', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [5, 5, 9]) a.accept(v);
    for (const v of [9, 12]) b.accept(v);
    a.merge(b);
    expect(a.total).toBe(5);
    expect(a.countAt(5)).toBe(2);
    expect(a.countAt(9)).toBe(2);
    expect(a.countAt(12)).toBe(1);
    expect(a.min).toBe(5);
    expect(a.max).toBe(12);
    expect(a.sum).toBe(40);
  });

  // The regression the Sketch round-trip bug taught us: assert EVERY derived
  // quantity survives serialization, not just the bin counts.
  it('round-trips losslessly, including min, max, sum and count', () => {
    const h = new Histogram();
    for (const v of [1, 1, 7, 400, 400, 400, 119_999]) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    expect(back.total).toBe(h.total);
    expect(back.min).toBe(h.min);
    expect(back.max).toBe(h.max);
    expect(back.sum).toBe(h.sum);
    expect(back.countAt(400)).toBe(3);
    expect(back.countAt(119_999)).toBe(1);
    expect(back.countBelow(400)).toBe(h.countBelow(400));
    expect([...back.entries()]).toEqual([...h.entries()]);
  });

  it('round-trips an empty histogram', () => {
    const back = Histogram.deserialize(new Histogram().serialize());
    expect(back.total).toBe(0);
    expect(back.min).toBe(0);
    expect(back.max).toBe(0);
    expect(back.sum).toBe(0);
    expect([...back.entries()]).toEqual([]);
  });

  it('folds values above the cap into one overflow bin, keeping count, sum and max exact', () => {
    const h = new Histogram({ capMs: 1000 });
    h.accept(500);
    h.accept(5_000);
    h.accept(9_000);
    expect(h.total).toBe(3);
    expect(h.overflowCount).toBe(2);
    expect(h.sum).toBe(14_500);
    expect(h.max).toBe(9_000);
    expect(h.countBelow(1_000)).toBe(1);
    // Above the cap, countBelow cannot be exact — it must not silently claim to be.
    expect(() => h.countBelow(6_000)).toThrow(/overflow/i);
    const back = Histogram.deserialize(h.serialize());
    expect(back.overflowCount).toBe(2);
    expect(back.sum).toBe(14_500);
    expect(back.max).toBe(9_000);
  });

  it('declares its wire format', () => {
    expect(HISTOGRAM_KIND).toBe('sparse-ms-v1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/statistics/test/histogram.test.ts`
Expected: FAIL — `Cannot find module '../src/histogram.js'`.

- [ ] **Step 3: Implement `Histogram`**

Create `packages/statistics/src/histogram.ts`:

```ts
/** Wire format tag stored in `run_stat.histogram_kind`. Bump on any layout change. */
export const HISTOGRAM_KIND = 'sparse-ms-v1' as const;

/**
 * Observations above this fold into a single overflow bin. 120s is above any
 * realistic HTTP timeout, so the loss is theoretical; the bin exists so a
 * pathological run degrades loudly (countBelow throws) instead of silently.
 */
export const DEFAULT_HISTOGRAM_CAP_MS = 120_000;

export interface HistogramSnapshot {
  total: number;
  min: number;
  max: number;
  sum: number;
  overflowCount: number;
}

function writeUvarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readUvarint(buf: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = buf[pos.i++];
    if (byte === undefined) throw new Error('Histogram: truncated varint');
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 128;
  }
}

/**
 * An exact, sparse, one-millisecond-resolution histogram.
 *
 * Response times are integer milliseconds, so 1 ms bins are lossless — which is
 * what lets indicator bands and Gatling's distribution bins be computed at read
 * time at ANY bounds, exactly. The DDSketch beside it cannot do this: its bins
 * are logarithmic (~2% wide), so the bin straddling 800 ms cannot be split.
 *
 * Size is bounded by DISTINCT OBSERVED VALUES, not by range.
 */
export class Histogram {
  #bins = new Map<number, number>();
  #capMs: number;
  #total = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;
  #overflowCount = 0;

  constructor(opts: { capMs?: number } = {}) {
    this.#capMs = opts.capMs ?? DEFAULT_HISTOGRAM_CAP_MS;
  }

  /** Negative durations are a upstream data fault; clamp to 0 rather than corrupt the key space. */
  accept(valueMs: number): void {
    const v = Math.max(0, Math.round(valueMs));
    this.#total++;
    this.#sum += v;
    if (v < this.#min) this.#min = v;
    if (v > this.#max) this.#max = v;
    if (v > this.#capMs) {
      this.#overflowCount++;
      return;
    }
    this.#bins.set(v, (this.#bins.get(v) ?? 0) + 1);
  }

  merge(other: Histogram): void {
    for (const [v, c] of other.#bins) this.#bins.set(v, (this.#bins.get(v) ?? 0) + c);
    this.#total += other.#total;
    this.#sum += other.#sum;
    this.#overflowCount += other.#overflowCount;
    if (other.#min < this.#min) this.#min = other.#min;
    if (other.#max > this.#max) this.#max = other.#max;
  }

  get total(): number { return this.#total; }
  get sum(): number { return this.#sum; }
  get overflowCount(): number { return this.#overflowCount; }
  get capMs(): number { return this.#capMs; }
  get min(): number { return this.#total === 0 ? 0 : this.#min; }
  get max(): number { return this.#total === 0 ? 0 : this.#max; }

  countAt(valueMs: number): number { return this.#bins.get(valueMs) ?? 0; }

  /** Ascending by value. */
  *entries(): IterableIterator<readonly [number, number]> {
    for (const v of [...this.#bins.keys()].sort((a, b) => a - b)) {
      yield [v, this.#bins.get(v) as number] as const;
    }
  }

  /**
   * Exact count of observations strictly below `boundMs`.
   *
   * Throws when the bound sits above the cap and an overflow bin exists: the
   * answer would be a guess, and a band count that silently guesses is exactly
   * the defect this class replaced.
   */
  countBelow(boundMs: number): number {
    if (this.#overflowCount > 0 && boundMs > this.#capMs) {
      throw new Error(
        `Histogram: countBelow(${boundMs}) crosses the ${this.#capMs}ms overflow bin (${this.#overflowCount} observations); the exact count is unrecoverable.`,
      );
    }
    let n = 0;
    for (const [v, c] of this.#bins) if (v < boundMs) n += c;
    return n;
  }

  snapshot(): HistogramSnapshot {
    return {
      total: this.total, min: this.min, max: this.max,
      sum: this.sum, overflowCount: this.overflowCount,
    };
  }

  serialize(): Uint8Array {
    const out: number[] = [1];                       // version
    writeUvarint(out, this.#capMs);
    const sorted = [...this.entries()];
    writeUvarint(out, sorted.length);
    let prev = 0;
    for (const [v, c] of sorted) {
      writeUvarint(out, v - prev);                   // delta; first entry is its own value
      writeUvarint(out, c);
      prev = v;
    }
    writeUvarint(out, this.#total);
    writeUvarint(out, this.#sum);
    writeUvarint(out, this.#overflowCount);
    writeUvarint(out, this.#total === 0 ? 0 : this.#min);
    writeUvarint(out, this.#total === 0 ? 0 : this.#max);
    return Uint8Array.from(out);
  }

  static deserialize(buf: Uint8Array): Histogram {
    const pos = { i: 0 };
    const version = buf[pos.i++];
    if (version !== 1) throw new Error(`Histogram: unsupported version ${String(version)}`);
    const capMs = readUvarint(buf, pos);
    const h = new Histogram({ capMs });
    const n = readUvarint(buf, pos);
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = prev + readUvarint(buf, pos);
      h.#bins.set(v, readUvarint(buf, pos));
      prev = v;
    }
    // Restored explicitly, never re-derived from the bins: the overflow bin
    // holds observations the bins do not, so total/sum/max would all be wrong.
    h.#total = readUvarint(buf, pos);
    h.#sum = readUvarint(buf, pos);
    h.#overflowCount = readUvarint(buf, pos);
    const min = readUvarint(buf, pos);
    const max = readUvarint(buf, pos);
    h.#min = h.#total === 0 ? Number.POSITIVE_INFINITY : min;
    h.#max = h.#total === 0 ? Number.NEGATIVE_INFINITY : max;
    return h;
  }
}
```

- [ ] **Step 4: Export it**

In `packages/statistics/src/index.ts`, add after the `sketch.js` export:

```ts
export * from './histogram.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/histogram.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Falsification checkpoint — prove the round-trip test can fail**

Temporarily delete the line `h.#sum = readUvarint(buf, pos);` from `deserialize` and re-run.
Expected: the "round-trips losslessly" and "overflow" tests FAIL. Restore the line and confirm PASS again.

This is the check that was missing for `Sketch`. Do not skip it.

- [ ] **Step 7: Commit**

```bash
git add packages/statistics/src/histogram.ts packages/statistics/test/histogram.test.ts packages/statistics/src/index.ts
git commit -m "feat(statistics): exact 1ms sparse histogram

The DDSketch cannot serve indicator bands or Gatling's distribution: its
bins are logarithmic at ~2% width, so the bin straddling 800ms cannot be
split and band counts would be approximate where Appendix A requires
exact. Response times are integer milliseconds, so a 1ms histogram is
lossless, and every one of those rows becomes a read-time fold.

deserialize restores total, sum, min, max and overflowCount explicitly
rather than re-deriving them from the bins - the overflow bin holds
observations the bins do not. Sketch.deserialize shipped without that and
silently returned -Infinity for the top percentile of any reloaded sketch."
```

---

### Task 2: Gatling-compatible distribution binning

Pure functions reproducing `StatsHelper.buckets` / `.step` and `LogFileData.distribution` from Gatling `v3.15.1`. The fixture's 100 labels are the acceptance test.

**Files:**
- Create: `packages/statistics/src/distribution.ts`
- Create: `packages/statistics/test/distribution.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Consumes: `Histogram` from Task 1.
- Produces: `gatlingStep(min, max, maxPlots): number`, `gatlingLabels(min, max, step): number[]`, `gatlingBucketFor(t, min, max, step): number`, `distribution(ok: Histogram, ko: Histogram, maxPlots?: number): DistributionResult`, `interface DistributionResult { labels: number[]; okPercent: number[]; koPercent: number[]; okCount: number[]; koCount: number[]; exactValues: boolean }`, `GATLING_MAX_PLOTS`.

- [ ] **Step 1: Write the failing test**

Create `packages/statistics/test/distribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import {
  GATLING_MAX_PLOTS, bucketIndexFor, distribution, gatlingBucketFor, gatlingLabels, gatlingStep,
} from '../src/distribution.js';

// Verified against fixtures/gatling-3.15.1.2/reference-report/index.html:
// the global chart's 100 categories are 28, 53, 78, ..., 2491, and they are
// reproduced EXACTLY by min=16, max=2503. 28 is the first bin's MIDPOINT,
// not the minimum - which is why reading the minimum off the chart is wrong.
const FIXTURE_MIN = 16;
const FIXTURE_MAX = 2503;

describe('gatling distribution binning', () => {
  it('uses 100 plots, matching the hardcoded literal in GlobalReportGenerator', () => {
    expect(GATLING_MAX_PLOTS).toBe(100);
  });

  it('steps by range/maxPlots, or by 1 when the range is narrower than maxPlots', () => {
    expect(gatlingStep(16, 2503, 100)).toBeCloseTo(24.87, 10);
    expect(gatlingStep(10, 40, 100)).toBe(1.0);
  });

  it('reproduces the fixture 100 labels exactly', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    const labels = gatlingLabels(FIXTURE_MIN, FIXTURE_MAX, step);
    expect(labels).toHaveLength(100);
    expect(labels[0]).toBe(28);
    expect(labels[1]).toBe(53);
    expect(labels[8]).toBe(227);      // the 24ms gap, not 228
    expect(labels[99]).toBe(2491);
    // 12 gaps of 24ms among 87 of 25ms - the signature that (max-min)/100 is wrong.
    const gaps = labels.slice(1).map((v, i) => v - (labels[i] as number));
    expect(gaps.filter((g) => g === 24)).toHaveLength(12);
    expect(gaps.filter((g) => g === 25)).toHaveLength(87);
  });

  it('clamps the maximum observation into the last bucket', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    expect(gatlingBucketFor(FIXTURE_MAX, FIXTURE_MIN, FIXTURE_MAX, step)).toBe(2491);
    expect(gatlingBucketFor(FIXTURE_MIN, FIXTURE_MIN, FIXTURE_MAX, step)).toBe(28);
  });

  it('expresses BOTH series as a percent of the combined OK+KO count', () => {
    const ok = new Histogram();
    const ko = new Histogram();
    for (let i = 0; i < 300; i++) ok.accept(100);
    for (let i = 0; i < 100; i++) ko.accept(2000);
    const d = distribution(ok, ko);
    const okTotal = d.okPercent.reduce((a, b) => a + b, 0);
    const koTotal = d.koPercent.reduce((a, b) => a + b, 0);
    expect(okTotal).toBeCloseTo(75, 6);
    expect(koTotal).toBeCloseTo(25, 6);
    expect(okTotal + koTotal).toBeCloseTo(100, 6);
  });

  it('drops bucketing entirely when the range is at most maxPlots', () => {
    const ok = new Histogram();
    for (const v of [10, 10, 11, 12]) ok.accept(v);
    const d = distribution(ok, new Histogram());
    expect(d.exactValues).toBe(true);
    expect(d.labels).toEqual([10, 11, 12]);
    expect(d.okCount).toEqual([2, 1, 1]);
  });

  it('returns empty for no observations', () => {
    const d = distribution(new Histogram(), new Histogram());
    expect(d.labels).toEqual([]);
    expect(d.okPercent).toEqual([]);
  });

  it('places every observation on the fixture range exactly where Gatling does', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    const labels = gatlingLabels(FIXTURE_MIN, FIXTURE_MAX, step);
    for (let v = FIXTURE_MIN; v <= FIXTURE_MAX; v++) {
      const i = bucketIndexFor(v, FIXTURE_MIN, FIXTURE_MAX, step, labels.length);
      expect(labels[i]).toBe(gatlingBucketFor(v, FIXTURE_MIN, FIXTURE_MAX, step));
    }
  });

  // Gatling drops observations whose computed label is absent from its own
  // label set; arithmetic indexing cannot. Conservation is the invariant every
  // percentage assertion rests on.
  it('never loses an observation, on ranges where Gatling would', () => {
    for (const [min, max] of [[14, 818], [0, 101], [7, 3999], [16, 2503]] as const) {
      const ok = new Histogram();
      for (let v = min; v <= max; v++) ok.accept(v);
      const d = distribution(ok, new Histogram());
      expect(d.okCount.reduce((a, b) => a + b, 0)).toBe(max - min + 1);
      expect(d.okPercent.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/statistics/test/distribution.test.ts`
Expected: FAIL — `Cannot find module '../src/distribution.js'`.

- [ ] **Step 3: Implement the binning**

Create `packages/statistics/src/distribution.ts`:

```ts
import { Histogram } from './histogram.js';

/**
 * Hardcoded in Gatling at GlobalReportGenerator.scala:80 as the literal 100.
 * It is NOT configuration, so the platform must not make it configurable
 * either without breaking parity.
 */
export const GATLING_MAX_PLOTS = 100;

export interface DistributionResult {
  labels: number[];
  okCount: number[];
  koCount: number[];
  /** Percent of the COMBINED OK+KO count, matching Gatling. Sums to 100 across both series. */
  okPercent: number[];
  koPercent: number[];
  /** True when the range was narrow enough that Gatling skips bucketing. */
  exactValues: boolean;
  /** Non-zero means some observations exceeded the histogram cap; see Histogram. */
  overflowCount: number;
}

/** Scala's Double.round is floor(x + 0.5); JS Math.round differs for negatives. */
function scalaRound(x: number): number {
  return Math.floor(x + 0.5);
}

/** StatsHelper.step */
export function gatlingStep(min: number, max: number, maxPlots: number): number {
  const range = max - min;
  return range < maxPlots ? 1.0 : range / maxPlots;
}

/** StatsHelper.buckets — labels are bucket MIDPOINTS, not lower edges. */
export function gatlingLabels(min: number, max: number, step: number): number[] {
  const halfStep = step / 2;
  const length = Math.ceil((max - min) / step);
  return Array.from({ length }, (_, i) => scalaRound(min + step * i + halfStep));
}

/**
 * LogFileData.distribution's bucketFunction, transcribed exactly — note the
 * clamp to max - 1. Exported and tested because it documents the source rule,
 * but NOT used to place observations; see bucketIndexFor.
 */
export function gatlingBucketFor(t: number, min: number, max: number, step: number): number {
  const value = Math.min(t, max - 1);
  return scalaRound(value - ((value - min) % step) + step / 2);
}

/**
 * The bin index an observation belongs to.
 *
 * Gatling groups by the LABEL VALUE that bucketFunction computes, then looks
 * that value up among the labels StatsHelper.buckets produced. Those two
 * roundings do not always agree: probing 4240 (min, max) ranges found 26 where
 * some observation's computed label is absent from the label set, so Gatling
 * silently drops it — up to 8 observations in the worst case, and some ranges
 * yield 101 labels rather than 100 because `ceil(range/step)` is a
 * floating-point round trip.
 *
 * DELIBERATE DEVIATION: we index arithmetically instead, which is the same
 * quantity without the second rounding. It never drops an observation, so the
 * percentages always sum to 100. Verified across the same 4240 ranges: zero
 * out-of-range indices, and identical placement to bucketFunction across the
 * ENTIRE fixture range (min 16, max 2503), which is what parity is asserted on.
 */
export function bucketIndexFor(
  t: number, min: number, max: number, step: number, binCount: number,
): number {
  const value = Math.min(t, max - 1);
  return Math.min(Math.max(Math.floor((value - min) / step), 0), binCount - 1);
}

export function distribution(
  ok: Histogram,
  ko: Histogram,
  maxPlots: number = GATLING_MAX_PLOTS,
): DistributionResult {
  const size = ok.total + ko.total;
  const overflowCount = ok.overflowCount + ko.overflowCount;
  if (size === 0) {
    return { labels: [], okCount: [], koCount: [], okPercent: [], koPercent: [], exactValues: false, overflowCount };
  }

  // min/max span BOTH series - which is why the fixture's global min is 16 and
  // not the 28 the chart's first label suggests.
  const min = ok.total === 0 ? ko.min : ko.total === 0 ? ok.min : Math.min(ok.min, ko.min);
  const max = Math.max(ok.max, ko.max);
  const percent = (n: number): number => (n * 100) / size;

  if (max - min <= maxPlots) {
    // Gatling's "use exact values" branch: one plot per distinct observation.
    // NOT exercised by the reference fixture (its range is 2487); implemented
    // from source semantics, with labels as the sorted union of both series.
    const values = new Set<number>();
    for (const [v] of ok.entries()) values.add(v);
    for (const [v] of ko.entries()) values.add(v);
    const labels = [...values].sort((a, b) => a - b);
    const okCount = labels.map((v) => ok.countAt(v));
    const koCount = labels.map((v) => ko.countAt(v));
    return {
      labels, okCount, koCount,
      okPercent: okCount.map(percent),
      koPercent: koCount.map(percent),
      exactValues: true,
      overflowCount,
    };
  }

  const step = gatlingStep(min, max, maxPlots);
  const labels = gatlingLabels(min, max, step);

  const okCount = new Array<number>(labels.length).fill(0);
  const koCount = new Array<number>(labels.length).fill(0);
  const fold = (h: Histogram, into: number[]): void => {
    for (const [v, c] of h.entries()) {
      const i = bucketIndexFor(v, min, max, step, labels.length);
      into[i] = (into[i] as number) + c;
    }
  };
  fold(ok, okCount);
  fold(ko, koCount);

  return {
    labels, okCount, koCount,
    okPercent: okCount.map(percent),
    koPercent: koCount.map(percent),
    exactValues: false,
    overflowCount,
  };
}
```

- [ ] **Step 4: Export it**

In `packages/statistics/src/index.ts`, add:

```ts
export * from './distribution.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/distribution.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Falsification checkpoint — prove the label test can fail**

Change `gatlingLabels` to use lower edges (`scalaRound(min + step * i)` — drop `+ halfStep`) and re-run.
Expected: "reproduces the fixture 100 labels exactly" FAILS with `labels[0]` = 16, not 28. Restore.

Then change `gatlingStep`'s divisor from `maxPlots` to `maxPlots - 1` and re-run.
Expected: the same test FAILS on `labels[99]`. Restore and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/statistics/src/distribution.ts packages/statistics/test/distribution.test.ts packages/statistics/src/index.ts
git commit -m "feat(statistics): Gatling-compatible distribution binning

Appendix A says 'bin counts exact'. The report renders PERCENTAGES of the
combined OK+KO count to 2dp, over 100 midpoint-labelled bins - and the
labels are not (max-min)/100. With min 28 and max 2503 that gives 24.75,
but no floor/round/ceil of 28+24.75i reproduces the observed 28, 53, 78,
103, 128, 153, 178, 203, 227, ..., 2491.

Solving for the real bounds reproduces all 100 exactly at min=16, max=2503:
28 is the FIRST BIN'S MIDPOINT, not the minimum. Rules transcribed from
StatsHelper.scala and LogFileData.scala at tag v3.15.1, including the
clamp to max-1 and the no-bucketing branch when range <= 100."
```

---

### Task 3: Indicator bands from the histogram

`IndicatorCounter` is deleted. Bands become a read-time fold, which is what makes K-01/K-02 configurable per project without a re-ingest.

**Files:**
- Modify: `packages/statistics/src/indicators.ts`
- Modify: `packages/statistics/test/indicators.test.ts`

**Interfaces:**
- Consumes: `Histogram` from Task 1.
- Produces: `bandsFrom(ok: Histogram, koCount: number, bounds: { lowerMs: number; higherMs: number }): IndicatorBands`. `IndicatorBands` and `isWarmup` keep their existing shapes and signatures. `IndicatorCounter` is **removed**.

- [ ] **Step 1: Replace the test file's contents**

Overwrite `packages/statistics/test/indicators.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import { bandsFrom, isWarmup } from '../src/indicators.js';

const histOf = (...values: number[]): Histogram => {
  const h = new Histogram();
  for (const v of values) h.accept(v);
  return h;
};

describe('bandsFrom', () => {
  it('splits on t < lower, lower <= t < higher, t >= higher', () => {
    const ok = histOf(799, 800, 801, 1199, 1200, 1201);
    expect(bandsFrom(ok, 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 1, between: 3, over: 2, failed: 0,
    });
  });

  it('takes failed from the KO count, never from the OK histogram', () => {
    expect(bandsFrom(histOf(10, 20), 7, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 2, between: 0, over: 0, failed: 7,
    });
  });

  // This is the whole point of the redesign: the SAME stored histogram yields
  // different bands under different project settings, with no re-ingest.
  it('honours non-default bounds against unchanged stored data (AC-PARITY-4)', () => {
    const ok = histOf(100, 500, 900, 1500);
    expect(bandsFrom(ok, 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 2, between: 1, over: 1, failed: 0,
    });
    expect(bandsFrom(ok, 0, { lowerMs: 200, higherMs: 1000 })).toEqual({
      under: 1, between: 2, over: 1, failed: 0,
    });
  });

  it('is all zeroes for an empty histogram', () => {
    expect(bandsFrom(new Histogram(), 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 0, between: 0, over: 0, failed: 0,
    });
  });

  it('reproduces the fixture bands 848/0/23/24 at Gatling defaults', () => {
    const ok = new Histogram();
    for (let i = 0; i < 848; i++) ok.accept(300);      // < 800
    for (let i = 0; i < 23; i++) ok.accept(2000);      // >= 1200
    expect(bandsFrom(ok, 24, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 848, between: 0, over: 23, failed: 24,
    });
  });
});

describe('isWarmup', () => {
  it('is false when no warm-up is configured', () => {
    expect(isWarmup(1_000, 0, 0)).toBe(false);
  });
  it('is true strictly inside the window', () => {
    expect(isWarmup(4_999, 0, 5_000)).toBe(true);
    expect(isWarmup(5_000, 0, 5_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/statistics/test/indicators.test.ts`
Expected: FAIL — `bandsFrom` is not exported.

- [ ] **Step 3: Rewrite `indicators.ts`**

Overwrite `packages/statistics/src/indicators.ts`:

```ts
import type { Histogram } from './histogram.js';

export interface IndicatorBands { under: number; between: number; over: number; failed: number; }

/**
 * Bands folded out of the OK histogram at read time.
 *
 * Previously an IndicatorCounter incremented during ingest, whose result was
 * written to a `run_indicator` table. That froze the bounds at ingest: changing
 * a project's thresholds could not restate its own history, and AC-PARITY-4
 * ("non-default bounds render accordingly") would have held only for runs
 * ingested after the change. An exact histogram makes the bounds a display
 * threshold applied to complete data, so the table is gone.
 *
 * `failed` is the KO count, which lives on run_stat.ko_count - it is not a
 * response-time band and must never be derived from the OK histogram.
 */
export function bandsFrom(
  ok: Histogram,
  koCount: number,
  bounds: { lowerMs: number; higherMs: number },
): IndicatorBands {
  const under = ok.countBelow(bounds.lowerMs);
  const belowHigher = ok.countBelow(bounds.higherMs);
  return {
    under,
    between: belowHigher - under,
    over: ok.total - belowHigher,
    failed: koCount,
  };
}

/** Warm-up requests stay in the time series but are excluded from summary stats (PRD 7.4). */
export function isWarmup(tsMs: number, runStartMs: number, warmupMs: number): boolean {
  return warmupMs > 0 && tsMs - runStartMs < warmupMs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/indicators.test.ts`
Expected: PASS, 7 tests.

`pnpm typecheck` will now fail in `engine.ts` (it still imports `IndicatorCounter`). Task 6 fixes that; do not patch it here.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics/src/indicators.ts packages/statistics/test/indicators.test.ts
git commit -m "refactor(statistics): fold indicator bands from the histogram

IndicatorCounter froze the bounds at ingest, so AC-PARITY-4's 'non-default
bounds render accordingly' would only ever have held for runs ingested
after a settings change. bandsFrom() applies the bounds to complete stored
data at read time, so the same bytes answer any bounds.

engine.ts does not compile until Task 6; that is deliberate, not an
oversight - the two changes are one semantic move split across a review
boundary."
```

---

### Task 4: `UserSeries` — active users and start rate

Feeds G-18, G-19 and G-26. The engine currently discards every `UserEvent`.

**Files:**
- Create: `packages/statistics/src/users.ts`
- Create: `packages/statistics/test/users.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Produces: `class UserSeries` with `constructor(opts: { startMs: number; maxBuckets: number })`, `add(scenario: string, kind: 'start' | 'end', tsMs: number): void`, `scenarios(): { scenario: string; buckets: UserBucket[] }[]`; `interface UserBucket { startOffsetMs: number; started: number; ended: number; maxConcurrent: number }`.

- [ ] **Step 1: Write the failing test**

Create `packages/statistics/test/users.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UserSeries } from '../src/users.js';

describe('UserSeries', () => {
  it('counts starts and ends per scenario per one-second bucket', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'start', 0);
    s.add('Browse', 'start', 500);
    s.add('Browse', 'end', 1_200);
    s.add('Checkout', 'start', 1_800);
    const byScenario = new Map(s.scenarios().map((e) => [e.scenario, e.buckets]));
    expect(byScenario.get('Browse')?.[0]).toEqual({
      startOffsetMs: 0, started: 2, ended: 0, maxConcurrent: 2,
    });
    expect(byScenario.get('Browse')?.[1]).toEqual({
      startOffsetMs: 1_000, started: 0, ended: 1, maxConcurrent: 2,
    });
    expect(byScenario.get('Checkout')?.[0]).toEqual({
      startOffsetMs: 1_000, started: 1, ended: 0, maxConcurrent: 1,
    });
  });

  it('tracks the PEAK concurrency inside a bucket, not the closing value', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 5; i++) s.add('Browse', 'start', 100 + i);
    for (let i = 0; i < 4; i++) s.add('Browse', 'end', 200 + i);
    const b = s.scenarios()[0]?.buckets[0];
    expect(b?.maxConcurrent).toBe(5);
    expect(b?.started).toBe(5);
    expect(b?.ended).toBe(4);
  });

  it('sorts out-of-order events before sweeping concurrency', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'end', 900);
    s.add('Browse', 'start', 100);
    s.add('Browse', 'start', 200);
    const b = s.scenarios()[0]?.buckets[0];
    expect(b?.maxConcurrent).toBe(2);
  });

  it('carries concurrency across bucket boundaries', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 100 });
    s.add('Browse', 'start', 100);
    s.add('Browse', 'start', 200);
    s.add('Browse', 'end', 5_500);
    const buckets = s.scenarios()[0]?.buckets ?? [];
    expect(buckets.find((b) => b.startOffsetMs === 3_000)?.maxConcurrent).toBe(2);
    expect(buckets.find((b) => b.startOffsetMs === 5_000)?.maxConcurrent).toBe(2);
    expect(buckets.find((b) => b.startOffsetMs === 5_000)?.ended).toBe(1);
  });

  it('coalesces losslessly when the bucket cap is exceeded', () => {
    const s = new UserSeries({ startMs: 0, maxBuckets: 2 });
    s.add('Browse', 'start', 0);
    s.add('Browse', 'start', 1_000);
    s.add('Browse', 'end', 2_000);
    s.add('Browse', 'start', 3_000);
    const buckets = s.scenarios()[0]?.buckets ?? [];
    expect(buckets.length).toBeLessThanOrEqual(2);
    expect(buckets.reduce((n, b) => n + b.started, 0)).toBe(3);
    expect(buckets.reduce((n, b) => n + b.ended, 0)).toBe(1);
    expect(Math.max(...buckets.map((b) => b.maxConcurrent))).toBe(2);
  });

  it('is empty when no user events were seen', () => {
    expect(new UserSeries({ startMs: 0, maxBuckets: 100 }).scenarios()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/statistics/test/users.test.ts`
Expected: FAIL — `Cannot find module '../src/users.js'`.

- [ ] **Step 3: Implement `UserSeries`**

Create `packages/statistics/src/users.ts`:

```ts
export interface UserBucket {
  startOffsetMs: number;
  started: number;
  ended: number;
  /** Peak concurrency reached at any instant inside this bucket. */
  maxConcurrent: number;
}

interface Delta { tsMs: number; delta: 1 | -1 }

/**
 * Per-scenario user arrival rate (G-26) and concurrency (G-18).
 *
 * These are different quantities and Gatling charts them separately: a constant
 * arrival rate produces a RISING concurrency curve when the service slows, and
 * that divergence is the signal an engineer looks for.
 *
 * Events are buffered and sorted before sweeping, because concurrency depends on
 * ordering and a tool's log is only approximately ordered. The buffer is one
 * entry per user event - orders of magnitude fewer than request events.
 */
export class UserSeries {
  #startMs: number;
  #maxBuckets: number;
  #events = new Map<string, Delta[]>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  add(scenario: string, kind: 'start' | 'end', tsMs: number): void {
    let list = this.#events.get(scenario);
    if (!list) { list = []; this.#events.set(scenario, list); }
    list.push({ tsMs, delta: kind === 'start' ? 1 : -1 });
  }

  scenarios(): { scenario: string; buckets: UserBucket[] }[] {
    const out: { scenario: string; buckets: UserBucket[] }[] = [];
    for (const [scenario, events] of this.#events) {
      out.push({ scenario, buckets: this.#sweep(events) });
    }
    return out.sort((a, b) => a.scenario.localeCompare(b.scenario));
  }

  #sweep(events: Delta[]): UserBucket[] {
    // Starts before ends at the same instant, so a user who starts and ends in
    // the same millisecond still contributes 1 to the peak rather than 0.
    const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs || b.delta - a.delta);
    let width = 1000;
    let buckets = new Map<number, UserBucket>();
    let concurrent = 0;

    for (const e of sorted) {
      const idx = Math.floor((e.tsMs - this.#startMs) / width);
      let b = buckets.get(idx);
      if (!b) {
        b = { startOffsetMs: idx * width, started: 0, ended: 0, maxConcurrent: concurrent };
        buckets.set(idx, b);
      }
      if (e.delta === 1) { b.started++; concurrent++; } else { b.ended++; concurrent--; }
      if (concurrent > b.maxConcurrent) b.maxConcurrent = concurrent;
    }

    // Buckets with no user event still carry the standing concurrency, so a long
    // steady phase does not read as a gap.
    if (buckets.size > 0) {
      const indices = [...buckets.keys()].sort((a, b) => a - b);
      const first = indices[0] as number;
      const last = indices[indices.length - 1] as number;
      let standing = 0;
      for (let i = first; i <= last; i++) {
        const b = buckets.get(i);
        if (b) {
          standing = standing + b.started - b.ended;
        } else {
          buckets.set(i, { startOffsetMs: i * width, started: 0, ended: 0, maxConcurrent: standing });
        }
      }
    }

    while (buckets.size > this.#maxBuckets) {
      const next = new Map<number, UserBucket>();
      const newWidth = width * 2;
      for (const [idx, b] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
        const ni = Math.floor(idx / 2);
        const target = next.get(ni);
        if (!target) {
          next.set(ni, { ...b, startOffsetMs: ni * newWidth });
        } else {
          target.started += b.started;
          target.ended += b.ended;
          // Peak of a wider window is the peak of its parts - correct because
          // each part's maxConcurrent is already an instantaneous peak.
          if (b.maxConcurrent > target.maxConcurrent) target.maxConcurrent = b.maxConcurrent;
        }
      }
      buckets = next;
      width = newWidth;
    }

    return [...buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  }
}
```

- [ ] **Step 4: Export it**

In `packages/statistics/src/index.ts`, add:

```ts
export * from './users.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/users.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Falsification checkpoint — prove the peak test can fail**

In `#sweep`, replace `if (concurrent > b.maxConcurrent) b.maxConcurrent = concurrent;` with `b.maxConcurrent = concurrent;` (closing value rather than peak) and re-run.
Expected: "tracks the PEAK concurrency inside a bucket" FAILS with `1`, not `5`. Restore and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/statistics/src/users.ts packages/statistics/test/users.test.ts packages/statistics/src/index.ts
git commit -m "feat(statistics): per-scenario user arrival rate and concurrency

engine.ts line 94 discarded every UserEvent, so G-18, G-19 and G-26 had no
data at all. Arrival rate and concurrency are different quantities and
Gatling charts them separately - a constant arrival rate produces a rising
concurrency curve when the service slows, which is the signal engineers
look for.

Events are buffered and sorted before sweeping: concurrency depends on
ordering, and coalescing takes the max of parts rather than summing, since
each part is already an instantaneous peak."
```

---

### Task 5: `RollupBuilder` carries OK and KO histograms

**Files:**
- Modify: `packages/statistics/src/rollup.ts`
- Modify: `packages/statistics/test/rollup.test.ts`

**Interfaces:**
- Consumes: `Histogram` (Task 1).
- Produces: `StatRollup` gains `histogramOk: Histogram` and `histogramKo: Histogram`. `RollupBuilder.add(durationMs, ok)` and `.finish(opts)` keep their existing signatures.

- [ ] **Step 1: Append the failing tests**

Add to `packages/statistics/test/rollup.test.ts`:

```ts
import { bandsFrom } from '../src/indicators.js';

describe('RollupBuilder histograms', () => {
  it('routes observations to the OK or KO histogram by status', () => {
    const b = new RollupBuilder();
    b.add(100, true);
    b.add(100, true);
    b.add(900, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(r.histogramOk.total).toBe(2);
    expect(r.histogramOk.countAt(100)).toBe(2);
    expect(r.histogramKo.total).toBe(1);
    expect(r.histogramKo.countAt(900)).toBe(1);
  });

  it('keeps the sketch over BOTH statuses, matching the existing percentile columns', () => {
    const b = new RollupBuilder();
    b.add(10, true);
    b.add(20, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(r.count).toBe(2);
    expect(r.histogramOk.total + r.histogramKo.total).toBe(r.count);
  });

  it('yields bands that agree with the rollup counts', () => {
    const b = new RollupBuilder();
    for (let i = 0; i < 848; i++) b.add(300, true);
    for (let i = 0; i < 23; i++) b.add(2000, true);
    for (let i = 0; i < 24; i++) b.add(50, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(bandsFrom(r.histogramOk, r.koCount, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 848, between: 0, over: 23, failed: 24,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/statistics/test/rollup.test.ts`
Expected: FAIL — `histogramOk` does not exist on `StatRollup`.

- [ ] **Step 3: Add the histograms**

In `packages/statistics/src/rollup.ts`, add the import:

```ts
import { Histogram } from './histogram.js';
```

Add to the `StatRollup` interface, after `sketch: Sketch;`:

```ts
  /**
   * Exact 1ms histograms, split by status because Gatling renders OK and KO as
   * separate distribution series. `All` is their merge, which is exact.
   * The sketch above spans BOTH statuses; do not conflate the two.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
```

Add the fields to the class, beside `#sketch`:

```ts
  #histOk = new Histogram();
  #histKo = new Histogram();
```

In `add`, after `this.#sketch.accept(durationMs);`:

```ts
    if (ok) this.#histOk.accept(durationMs); else this.#histKo.accept(durationMs);
```

In the object `finish` returns, after `sketch: this.#sketch,`:

```ts
      histogramOk: this.#histOk,
      histogramKo: this.#histKo,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/statistics/test/rollup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics/src/rollup.ts packages/statistics/test/rollup.test.ts
git commit -m "feat(statistics): RollupBuilder carries OK and KO histograms

Gatling renders the distribution as two series and the sketch spans both
statuses, so one histogram cannot serve. All is their merge, which is exact
because histogram merges are exact."
```

---

### Task 6: Engine — user events, per-scope errors, run metadata

The task that deletes `engine.ts:94`'s `if (e.type !== 'request') continue;`.

**Files:**
- Modify: `packages/statistics/src/engine.ts`
- Modify: `packages/statistics/src/engine-async.ts`
- Modify: `packages/statistics/src/errors-rollup.ts`
- Modify: `packages/statistics/test/engine.test.ts`

**Interfaces:**
- Consumes: `UserSeries`/`UserBucket` (Task 4), `StatRollup.histogramOk/Ko` (Task 5), `isWarmup` (Task 3).
- Produces: `EngineResult` **loses** `indicators` and **gains**:
  ```ts
  users: { scenario: string; buckets: UserBucket[] }[];
  simulation: string | null;
  description: string | null;
  durationMs: number;
  ```
  `errors` changes shape to `{ scope: MetricScope; name: string; message: string; count: number }[]`.
  `EngineOptions` **loses** `lowerMs`, `higherMs`, `percentiles`; gains `maxBucketsUsers?: number`.
  New exported constant `BUCKET_PERCENTILES = [25, 50, 75, 80, 85, 90, 95, 99] as const`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/statistics/test/engine.test.ts`:

```ts
import { BUCKET_PERCENTILES } from '../src/engine.js';
import type { CanonicalEvent } from '@perfportal/core';

describe('engine — parity additions', () => {
  const events = (): CanonicalEvent[] => [
    { type: 'meta', simulation: 'ParitySimulation', toolVersion: '3.15.1', startedAtMs: 1_000, description: 'a run' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'start', tsMs: 1_000 },
    { type: 'user', scenario: 'Checkout', userId: '2', kind: 'start', tsMs: 1_500 },
    { type: 'request', name: 'list', groups: [], scenario: 'Browse', userId: '1', startMs: 1_000, endMs: 1_100, ok: true },
    { type: 'request', name: 'buy', groups: [], scenario: 'Checkout', userId: '2', startMs: 1_500, endMs: 2_400, ok: false, message: 'boom' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'end', tsMs: 2_000 },
  ];

  it('no longer discards user events', () => {
    const r = runEngine(events());
    const names = r.users.map((u) => u.scenario);
    expect(names).toEqual(['Browse', 'Checkout']);
    expect(r.users[0]?.buckets[0]?.started).toBe(1);
  });

  it('captures simulation name and description from the meta event', () => {
    const r = runEngine(events());
    expect(r.simulation).toBe('ParitySimulation');
    expect(r.description).toBe('a run');
  });

  it('reports duration as the span from run start to the last response', () => {
    expect(runEngine(events()).durationMs).toBe(1_400);   // 2_400 - 1_000
  });

  it('scopes errors so a request page can show its own', () => {
    const r = runEngine(events());
    expect(r.errors).toContainEqual({ scope: 'run', name: '', message: 'boom', count: 1 });
    expect(r.errors).toContainEqual({ scope: 'request', name: 'buy', message: 'boom', count: 1 });
  });

  it('stores a FIXED per-bucket percentile band set, not the project’s columns', () => {
    // Buckets persist numbers, not sketches, so a configurable per-bucket set
    // would make history depend on ingest-day configuration. p95 in particular
    // must always exist: Gatling's scatter hardcodes quantile(0.95).
    expect(BUCKET_PERCENTILES).toContain(95);
    expect([...BUCKET_PERCENTILES]).toEqual([25, 50, 75, 80, 85, 90, 95, 99]);
  });

  it('no longer returns an indicators field', () => {
    expect('indicators' in runEngine(events())).toBe(false);
  });

  it('still enforces the endpoint cardinality cap', () => {
    const many: CanonicalEvent[] = [];
    for (let i = 0; i < 12; i++) {
      many.push({ type: 'request', name: `r${i}`, groups: [], userId: 'u', startMs: 0, endMs: 1, ok: true });
    }
    expect(() => runEngine(many, { maxEndpoints: 10 })).toThrow(/cardinality/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/statistics/test/engine.test.ts`
Expected: FAIL — `BUCKET_PERCENTILES` is not exported; `r.users` is undefined.

- [ ] **Step 3: Scope the error rollup**

In `packages/statistics/src/errors-rollup.ts`, leave `ErrorRollup` exactly as it is — it is per-key already, and the engine will hold one instance per `(scope, name)`.

- [ ] **Step 4: Rewrite the engine**

Apply these edits to `packages/statistics/src/engine.ts`.

Replace the import block's indicators line and add the new imports:

```ts
import { ingestError, type CanonicalEvent, type MetricFamily, type MetricScope } from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { isWarmup } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';
import { UserSeries, type UserBucket } from './users.js';
```

Add above `EngineOptions`:

```ts
/**
 * The per-bucket percentile bands, FIXED rather than configurable.
 *
 * A bucket persists percentiles as plain numbers - the ingest spine stores
 * summary sketches only - so a bucket's percentiles can never be recomputed at
 * read time. A configurable per-bucket set would therefore mean "whatever the
 * project happened to be configured as on ingest day". This is exactly the set
 * Gatling's own percentiles-over-time chart renders, so K-04's band selector is
 * a choice among stored series rather than a recomputation.
 *
 * p95 is load-bearing beyond the chart: Gatling's response-time-vs-throughput
 * scatter hardcodes quantile(0.95), so removing it would break RQ-09.
 */
export const BUCKET_PERCENTILES = [25, 50, 75, 80, 85, 90, 95, 99] as const;
```

Replace `EngineOptions`:

```ts
export interface EngineOptions {
  warmupMs?: number;
  /**
   * The statistics-table percentile columns (K-03). Read from project settings
   * at REQUEST time in production; this option exists so tests and the SLA path
   * can ask for a set directly. Indicator bounds are deliberately absent - the
   * engine no longer counts bands.
   */
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
  maxBucketsUsers?: number;
}
```

Replace `EngineResult`:

```ts
export interface EngineResult {
  stats: StatRollup[];
  series: Map<string, { scope: MetricScope; name: string; buckets: Bucket[] }>;
  users: { scenario: string; buckets: UserBucket[] }[];
  errors: { scope: MetricScope; name: string; message: string; count: number }[];
  endpointCount: number;
  runStartedAtMs: number | null;
  /** From the meta event. Null when the tool reported none. */
  simulation: string | null;
  description: string | null;
  /** Run start to last response. Gatling's header renders this to whole seconds. */
  durationMs: number;
}
```

In the body, replace the `indicators` and `errors` declarations:

```ts
  const users = new UserSeries({ startMs: runStartMs, maxBuckets: opts.maxBucketsUsers ?? 1200 });
  // One rollup per (scope, name), keyed the same opaque way as `rollups`: the
  // key is never parsed back, so a request name containing a space is safe.
  const errorsByKey = new Map<string, { scope: MetricScope; name: string; rollup: ErrorRollup }>();
  const errorsFor = (scope: MetricScope, name: string): ErrorRollup => {
    const key = `${scope} ${name}`;
    let entry = errorsByKey.get(key);
    if (!entry) { entry = { scope, name, rollup: new ErrorRollup() }; errorsByKey.set(key, entry); }
    return entry.rollup;
  };
  let simulation: string | null = null;
  let description: string | null = null;
```

Replace the meta branch:

```ts
    if (e.type === 'meta') {
      runStartMs = e.startedAtMs;
      sawMeta = true;
      simulation = e.simulation;
      description = e.description ?? null;
      continue;
    }
```

Replace `if (e.type !== 'request') continue;` with:

```ts
    if (e.type === 'user') {
      // Always recorded, warm-up included: the user charts show the ramp.
      users.add(e.scenario, e.kind, e.tsMs);
      continue;
    }
    if (e.type !== 'request') continue;
```

Replace the two lines after the `rollupFor(...)` calls at the end of the request branch:

```ts
    rollupFor('run', '', 'response_time').add(duration, e.ok);
    rollupFor('request', e.name, 'response_time').add(duration, e.ok);
    // A message-less failure still contributes to the KO count; route it into an
    // explicit bucket so sum(errors[].count) always reconciles instead of
    // silently undercounting.
    if (!e.ok) {
      const message = e.message && e.message.length > 0 ? e.message : '(no message)';
      errorsFor('run', '').add(message);
      errorsFor('request', e.name).add(message);
    }
```

Replace the return block:

```ts
  const windowMs = Math.max(0, lastMs - Math.max(firstMs, runStartMs + warmupMs));
  const stats: StatRollup[] = [];
  for (const { scope, name, family, builder } of rollups.values()) {
    stats.push(builder.finish({ scope, name, family, windowMs, percentiles }));
  }

  const errors: EngineResult['errors'] = [];
  for (const { scope, name, rollup } of errorsByKey.values()) {
    for (const e of rollup.top(200)) errors.push({ scope, name, message: e.message, count: e.count });
  }

  return {
    stats,
    series: new Map([...series].map(([k, v]) => [k, { scope: v.scope, name: v.name, buckets: v.series.buckets() }])),
    users: users.scenarios(),
    errors,
    endpointCount: endpoints.size,
    runStartedAtMs: sawMeta ? runStartMs : null,
    simulation,
    description,
    durationMs: lastMs === 0 ? 0 : Math.max(0, lastMs - runStartMs),
  };
```

- [ ] **Step 5: Confirm `engine-async.ts` needs no change**

Read `packages/statistics/src/engine-async.ts`. It is 20 lines: it drains the
`AsyncIterable` into an array and calls `runEngine`. It holds **no aggregation
logic of its own**, so there is nothing to mirror — it inherits every change
made in Step 4 for free, and duplicating logic into it would create exactly the
sync/async divergence the single delegation exists to prevent.

Verify this is still true rather than assuming it:

```bash
grep -n "runEngine\|for await\|EngineResult" packages/statistics/src/engine-async.ts
```
Expected: the file references `runEngine` and re-exports its `EngineResult` type;
no rollup, bucket, histogram, or indicator logic appears.

If that expectation does not hold, STOP and report it — the plan assumed a
delegating wrapper and the assumption would be wrong.

- [ ] **Step 6: Run the statistics suite**

Run: `pnpm vitest run packages/statistics`
Expected: PASS. `pnpm typecheck` still fails in `packages/persistence` (it reads `result.indicators`); Task 8 fixes it.

- [ ] **Step 7: Falsification checkpoint — prove the user test can fail**

Restore `if (e.type !== 'request') continue;` in place of the user branch and re-run.
Expected: "no longer discards user events" FAILS with an empty array — the exact defect this task removes. Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/statistics/src/engine.ts packages/statistics/src/engine-async.ts packages/statistics/test/engine.test.ts
git commit -m "feat(statistics): user series, scoped errors, run metadata

Deletes engine.ts's 'if (e.type !== \"request\") continue' - the line that
made G-18, G-19 and G-26 unimplementable. Errors become per (scope, name)
so RQ-11 can show a request's own failures. simulation and description were
parsed by the Gatling adapter and then thrown away; G-01 and G-02 need them.

Per-bucket percentiles become a fixed band set. Buckets persist numbers,
not sketches, so a configurable set would silently mean 'whatever the
project was configured as on ingest day' - and Gatling's scatter hardcodes
quantile(0.95), so p95 must exist regardless of a project's columns."
```

---

### Task 7: Migration and schema

**Files:**
- Create: `packages/persistence/prisma/migrations/20260808120000_parity_backend/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma`

**Interfaces:**
- Produces: `run_stat.histogram_ok`, `.histogram_ko`, `.histogram_kind`; `run_error.scope`, `.name`; `run.simulation`, `.description`, `.duration_ms`; table `run_user_bucket`. Table `run_indicator` is dropped.

- [ ] **Step 1: Write the migration**

Create `packages/persistence/prisma/migrations/20260808120000_parity_backend/migration.sql`:

```sql
-- Exact 1ms histograms, beside the sketch and under the same key. Nullable
-- because runs ingested before this migration have none, and the read path
-- reports `configurable: false` for them rather than pretending otherwise.
ALTER TABLE "run_stat" ADD COLUMN "histogram_ok" BYTEA;
ALTER TABLE "run_stat" ADD COLUMN "histogram_ko" BYTEA;
ALTER TABLE "run_stat" ADD COLUMN "histogram_kind" TEXT;

-- Indicator bands are now a read-time fold over histogram_ok, at whatever
-- bounds the project currently has. Storing them froze the bounds at ingest,
-- which AC-PARITY-4 forbids. `failed` was always just run_stat.ko_count.
DROP TABLE "run_indicator";

-- Errors gain a scope so a request detail page can show its own (RQ-11).
-- Existing rows are run-scope by construction.
ALTER TABLE "run_error" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'run';
ALTER TABLE "run_error" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "run_error" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "run_error" ALTER COLUMN "name" DROP DEFAULT;
CREATE UNIQUE INDEX "run_error_run_scope_name_message_key"
  ON "run_error" ("run_id", "scope", "name", "message");

-- Run header fields (G-01, G-02, G-04). duration_ms is the tool's own span,
-- unrelated to ingest timing.
ALTER TABLE "run" ADD COLUMN "simulation" TEXT;
ALTER TABLE "run" ADD COLUMN "description" TEXT;
ALTER TABLE "run" ADD COLUMN "duration_ms" INTEGER;

-- Per-scenario user arrival rate and concurrency (G-18, G-19, G-26).
-- Partitioned on run_started_on exactly like run_series_bucket, for retention.
CREATE TABLE "run_user_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "started" INTEGER NOT NULL,
    "ended" INTEGER NOT NULL,
    "max_concurrent" INTEGER NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_user_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "scenario", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

CREATE TABLE "run_user_bucket_2026_01" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_user_bucket_2026_02" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_user_bucket_2026_03" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_user_bucket_2026_04" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_user_bucket_2026_05" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_user_bucket_2026_06" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_user_bucket_2026_07" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_user_bucket_2026_08" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_user_bucket_2026_09" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_user_bucket_2026_10" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_user_bucket_2026_11" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_user_bucket_2026_12" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
```

- [ ] **Step 2: Update the Prisma schema**

In `packages/persistence/prisma/schema.prisma`:

Delete the entire `model RunIndicator { ... }` block.

Add to `model RunStat`, after `sketchKind`:

```prisma
  histogramOk   Bytes?  @map("histogram_ok")
  histogramKo   Bytes?  @map("histogram_ko")
  histogramKind String? @map("histogram_kind")
```

Add to `model RunError`, after `projectId`:

```prisma
  scope     String
  name      String
```

and add to its attribute block:

```prisma
  @@unique([runId, scope, name, message])
```

Add to `model Run`, after `toolVersion`:

```prisma
  /// The tool's own simulation identity and run description, from the run
  /// header. Null until the worker parses, and forever for a failed run.
  simulation  String?
  description String?
  /// The load test's own span in ms. Unrelated to ingest timing; Gatling's
  /// report header renders this to whole seconds.
  durationMs  Int?     @map("duration_ms")
```

Add a new model (typing only — Prisma cannot express the partitioning, which is why the migration SQL above is hand-written):

```prisma
model RunUserBucket {
  runStartedOn  DateTime @map("run_started_on") @db.Date
  runId         String   @map("run_id") @db.Uuid
  orgId         String   @map("org_id") @db.Uuid
  projectId     String   @map("project_id") @db.Uuid
  scenario      String
  startOffsetMs Int      @map("start_offset_ms")
  started       Int
  ended         Int
  maxConcurrent Int      @map("max_concurrent")

  @@id([runStartedOn, runId, scenario, startOffsetMs])
  @@map("run_user_bucket")
}
```

- [ ] **Step 3: Apply the migration**

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @perfportal/persistence run migrate:deploy
```

Expected: `1 migration found`, applied, then `Generated Prisma Client`.

`migrate:deploy` chains `prisma generate` on purpose — `migrate deploy` alone does not regenerate the client, which produces baffling `Unknown argument` errors later.

- [ ] **Step 4: Verify the partitions and the dropped table**

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U perfportal -d perfportal -c "\d+ run_user_bucket" -c "\d run_indicator"
```

Expected: `run_user_bucket` reports `Partition key: RANGE (run_started_on)` and lists 12 partitions; `\d run_indicator` reports `Did not find any relation named "run_indicator"`.

- [ ] **Step 5: Verify the migration checksum is consistent**

```bash
pnpm --filter @perfportal/persistence exec prisma migrate status --schema prisma/schema.prisma
```

Expected: `Database schema is up to date!`

If any earlier step edited a migration file after applying it, `migrate status` can report "up to date" while `_prisma_migrations.checksum` no longer matches the file. If you edited the SQL after applying, drop and recreate the dev database rather than trusting this output.

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/prisma/migrations packages/persistence/prisma/schema.prisma
git commit -m "feat(persistence): histograms, scoped errors, user buckets, run header

Drops run_indicator: bands are now a read-time fold over histogram_ok at
whatever bounds the project currently has, and 'failed' was always just
run_stat.ko_count. Storing them froze the bounds at ingest, which
AC-PARITY-4 forbids.

run_user_bucket is range-partitioned on run_started_on exactly like
run_series_bucket, and its primary key leads with the partition key because
Postgres requires a partitioned table's PK to contain it. Prisma cannot
express partitioning, so this SQL is hand-written and the model exists for
typing only."
```

---

### Task 8: `MetricWriter` persists the new data

**Files:**
- Modify: `packages/persistence/src/metrics/write.ts`
- Modify: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Consumes: `EngineResult` (Task 6), `HISTOGRAM_KIND` (Task 1), `BUCKET_PERCENTILES` (Task 6).
- Produces: `MetricWriter.persist(client, ctx, result)` keeps its signature.

- [ ] **Step 1: Write the failing integration test**

Append to `packages/persistence/test/metrics.integration.test.ts` (inside the existing describe that already has a pool and a seeded run):

```ts
  it('persists histograms that round-trip out of the database', async () => {
    // …arrange a run through the existing helper, then:
    const { rows } = await pool.query<{ histogram_ok: Buffer; histogram_kind: string }>(
      `SELECT histogram_ok, histogram_kind FROM run_stat
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [runId],
    );
    expect(rows[0]?.histogram_kind).toBe(HISTOGRAM_KIND);
    const h = Histogram.deserialize(new Uint8Array(rows[0]!.histogram_ok));
    expect(h.total).toBeGreaterThan(0);
    expect(bandsFrom(h, 0, { lowerMs: 800, higherMs: 1200 }).under).toBeGreaterThan(0);
  });

  it('persists per-scenario user buckets', async () => {
    const { rows } = await pool.query(
      `SELECT scenario, started, max_concurrent FROM run_user_bucket
        WHERE run_started_on = $1 AND run_id = $2 ORDER BY scenario, start_offset_ms`,
      [startedOn, runId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('persists errors with a scope and name', async () => {
    const { rows } = await pool.query(
      `SELECT scope, name FROM run_error WHERE run_id = $1 ORDER BY scope`,
      [runId],
    );
    expect(rows.map((r) => r.scope)).toContain('request');
  });
```

Import at the top of the file: `import { Histogram, HISTOGRAM_KIND, bandsFrom } from '@perfportal/statistics';`

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- packages/persistence/test/metrics.integration.test.ts`
Expected: FAIL — `histogram_kind` is null and `run_user_bucket` is empty.

- [ ] **Step 3: Update the writer**

In `packages/persistence/src/metrics/write.ts`:

Change the import line to:

```ts
import { BUCKET_PERCENTILES, HISTOGRAM_KIND, SKETCH_KIND } from '@perfportal/statistics';
```

Add the three columns to the `run_stat` column list, after `'sketch_kind'`:

```ts
        'histogram_ok', 'histogram_ko', 'histogram_kind',
```

and the three values to its row mapper, after `SKETCH_KIND,`:

```ts
        Buffer.from(s.histogramOk.serialize()),
        Buffer.from(s.histogramKo.serialize()),
        HISTOGRAM_KIND,
```

Replace the `run_error` insert with the scoped form:

```ts
    await insertBatched(
      client,
      'run_error',
      ['id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'message', 'count'],
      result.errors.map((e) => [
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId,
        e.scope, e.name, e.message, e.count,
      ]),
    );
```

Delete the entire `run_indicator` insert block.

Add the user-bucket insert after the series insert:

```ts
    const userRows: unknown[][] = [];
    for (const entry of result.users) {
      for (const b of entry.buckets) {
        userRows.push([
          ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scenario, b.startOffsetMs, b.started, b.ended, b.maxConcurrent,
        ]);
      }
    }
    await insertBatched(
      client,
      'run_user_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'scenario', 'start_offset_ms', 'started', 'ended', 'max_concurrent',
      ],
      userRows,
    );
```

Replace `percentilesOf` entirely — the per-bucket set is now fixed, so it no longer reads a key set off `result.stats[0]`:

```ts
/**
 * The per-bucket percentile bands are a FIXED set (BUCKET_PERCENTILES), not the
 * project's configured columns. A bucket stores numbers and no sketch, so a
 * configurable set would freeze whatever the project happened to be configured
 * as on ingest day. Reading the keys off result.stats[0] - the previous
 * behaviour - did exactly that.
 */
function percentilesOf(sketch: { count: number; quantile(q: number): number }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of BUCKET_PERCENTILES) out[`p${p}`] = sketch.count === 0 ? 0 : sketch.quantile(p / 100);
  return out;
}
```

and update its single call site to `JSON.stringify(percentilesOf(b.sketch))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration -- packages/persistence/test/metrics.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/metrics/write.ts packages/persistence/test/metrics.integration.test.ts
git commit -m "feat(persistence): write histograms, user buckets and scoped errors

percentilesOf previously read its key set off result.stats[0].percentiles,
which silently made every bucket's band set depend on the project's
configured columns on ingest day. It now uses the fixed BUCKET_PERCENTILES.

The integration test deserializes the histogram back out of bytea and folds
bands from it, so a write that round-trips wrong fails here rather than in
the parity suite."
```

---

### Task 9: `MetricReader` serves the new data

**Files:**
- Modify: `packages/persistence/src/metrics/read.ts`
- Modify: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Produces on `MetricReader`:
  ```ts
  histograms(scope: TenantScope, runId: string, key: StatKey): Promise<{ ok: Histogram; ko: Histogram } | null>
  users(scope: TenantScope, runId: string, runStartedOn: Date): Promise<StoredUserBucket[]>
  errors(scope: TenantScope, runId: string, sel?: { scope: string; name: string }): Promise<{ message: string; count: number }[]>
  ```
  `StoredStat` gains `histogramOk: Histogram | null` and `histogramKo: Histogram | null`.
  New `export const USER_SERIES_SQL` and `interface StoredUserBucket { scenario: string; startOffsetMs: number; started: number; ended: number; maxConcurrent: number }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/persistence/test/metrics.integration.test.ts`:

```ts
  it('reads histograms back and folds bands at two different bounds', async () => {
    const reader = new MetricReader(pool);
    const h = await reader.histograms({ orgId, projectId }, runId,
      { scope: 'run', name: '', family: 'response_time' });
    expect(h).not.toBeNull();
    const a = bandsFrom(h!.ok, 0, { lowerMs: 800, higherMs: 1200 });
    const b = bandsFrom(h!.ok, 0, { lowerMs: 50, higherMs: 100 });
    expect(a).not.toEqual(b);              // same bytes, different settings
    expect(a.under + a.between + a.over).toBe(b.under + b.between + b.over);
  });

  it('prunes partitions when reading user buckets', async () => {
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${USER_SERIES_SQL}`,
      [startedOn, runId, orgId, projectId],
    );
    expect(JSON.stringify(rows)).not.toMatch(/run_user_bucket_2026_(0[1-7]|09|1[0-2])/);
  });

  it('defaults to run scope so a caller cannot double-count', async () => {
    const reader = new MetricReader(pool);
    const defaulted = await reader.errors({ orgId, projectId }, runId);
    const explicit = await reader.errors({ orgId, projectId }, runId, { scope: 'run', name: '' });
    expect(defaulted).toEqual(explicit);
    // The same failure also has a request-scope row; totals must not be summed
    // across scopes. Run-scope total must equal the run's KO count, not twice it.
    const { rows } = await pool.query<{ ko: string }>(
      `SELECT ko_count::text AS ko FROM run_stat
        WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
      [runId],
    );
    const runKo = Number(rows[0]?.ko ?? 0);
    expect(defaulted.reduce((n, e) => n + e.count, 0)).toBe(runKo);
  });

  it('filters errors by scope and name', async () => {
    const reader = new MetricReader(pool);
    const runScoped = await reader.errors({ orgId, projectId }, runId, { scope: 'run', name: '' });
    const { rows } = await pool.query<{ name: string }>(
      `SELECT DISTINCT name FROM run_error WHERE run_id = $1 AND scope = 'request' LIMIT 1`,
      [runId],
    );
    const reqName = rows[0]?.name;
    expect(reqName).toBeDefined();
    const reqScoped = await reader.errors({ orgId, projectId }, runId, { scope: 'request', name: reqName as string });
    expect(reqScoped.length).toBeGreaterThan(0);
    expect(reqScoped.reduce((n, e) => n + e.count, 0))
      .toBeLessThan(runScoped.reduce((n, e) => n + e.count, 0));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- packages/persistence/test/metrics.integration.test.ts`
Expected: FAIL — `reader.histograms` is not a function.

- [ ] **Step 3: Extend the reader**

In `packages/persistence/src/metrics/read.ts`:

Change the import to `import { Histogram, Sketch } from '@perfportal/statistics';`

Add the interface and shared SQL beside `SERIES_SQL`:

```ts
export interface StoredUserBucket {
  scenario: string;
  startOffsetMs: number;
  started: number;
  ended: number;
  maxConcurrent: number;
}

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL: `run_started_on = $1` is the partition-key
 * predicate. A hand-copied EXPLAIN query in the test would drift from this one
 * and stop catching the regression it exists to catch.
 */
export const USER_SERIES_SQL = `SELECT scenario, start_offset_ms, started, ended, max_concurrent
         FROM run_user_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
        ORDER BY scenario, start_offset_ms`;
```

Add `histogramOk` / `histogramKo` to `StoredStat`:

```ts
  /** Null for runs ingested before the parity migration; the API reports those as non-configurable. */
  histogramOk: Histogram | null;
  histogramKo: Histogram | null;
```

Select and map them in `stats()` — add `histogram_ok, histogram_ko` to the column list and this to the mapper:

```ts
      histogramOk: r.histogram_ok ? Histogram.deserialize(new Uint8Array(r.histogram_ok)) : null,
      histogramKo: r.histogram_ko ? Histogram.deserialize(new Uint8Array(r.histogram_ko)) : null,
```

Add the three new methods to the class:

```ts
  /** Both status histograms for one (scope, name, family). Null when the row has none. */
  async histograms(
    scope: TenantScope,
    runId: string,
    key: StatKey,
  ): Promise<{ ok: Histogram; ko: Histogram } | null> {
    const { rows } = await this.pool.query<{ histogram_ok: Buffer | null; histogram_ko: Buffer | null }>(
      `SELECT histogram_ok, histogram_ko FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
          AND scope = $4 AND name = $5 AND family = $6`,
      [runId, scope.orgId, scope.projectId, key.scope, key.name, key.family],
    );
    const row = rows[0];
    if (!row?.histogram_ok || !row.histogram_ko) return null;
    return {
      ok: Histogram.deserialize(new Uint8Array(row.histogram_ok)),
      ko: Histogram.deserialize(new Uint8Array(row.histogram_ko)),
    };
  }

  /** runStartedOn is REQUIRED for the same partition-pruning reason as series(). */
  async users(scope: TenantScope, runId: string, runStartedOn: Date): Promise<StoredUserBucket[]> {
    const { rows } = await this.pool.query(
      USER_SERIES_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
      scenario: r.scenario,
      startOffsetMs: r.start_offset_ms,
      started: r.started,
      ended: r.ended,
      maxConcurrent: r.max_concurrent,
    }));
  }
```

Replace `errors()`:

```ts
  /**
   * `sel` defaults to RUN scope, never "no filter".
   *
   * The engine now emits one row per (scope, name) per message, so a single
   * failure produces both a run-scope row and a request-scope row. An unfiltered
   * query would return both and a caller summing counts would double every
   * error. Defaulting to run scope keeps the existing run-level endpoint's
   * numbers identical to what it returned before scoping existed.
   */
  async errors(
    scope: TenantScope,
    runId: string,
    sel: { scope: string; name: string } = { scope: 'run', name: '' },
  ): Promise<{ message: string; count: number }[]> {
    const params: unknown[] = [runId, scope.orgId, scope.projectId, sel.scope, sel.name];
    const filter = ' AND scope = $4 AND name = $5';
    const { rows } = await this.pool.query(
      `SELECT message, count FROM run_error
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3${filter}
        ORDER BY count DESC, message ASC`,
      params,
    );
    return rows.map((r) => ({ message: r.message, count: r.count }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration -- packages/persistence/test/metrics.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Falsification checkpoint — prove the pruning test can fail**

Delete `run_started_on = $1 AND ` from `USER_SERIES_SQL` (leaving the parameter in place would break the query, so also renumber) and re-run just the pruning test.
Expected: FAIL — the plan names partitions other than `2026_08`. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/src/metrics/read.ts packages/persistence/test/metrics.integration.test.ts
git commit -m "feat(persistence): read histograms, user buckets and scoped errors

The histogram test folds bands from the SAME stored bytes at two different
bounds and asserts they differ while their total is unchanged - which is
the whole claim of AC-PARITY-4 reduced to one assertion.

USER_SERIES_SQL is exported and shared with the pruning test for the same
reason SERIES_SQL is: a hand-copied EXPLAIN query drifts and stops catching
the missing partition predicate."
```

---
### Task 10: Contracts and project settings

**Files:**
- Create: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/metrics.ts`, `packages/contracts/src/run.ts`, `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/settings.test.ts`

**Interfaces:**
- Produces: `ProjectSettingsSchema` / `parseProjectSettings(value: unknown): ProjectSettings`; `IndicatorBandsSchema`; `DistributionResponseSchema`; `UsersResponseSchema`; `ScatterResponseSchema`. `StatRowSchema` gains `indicators`; `StatsResponseSchema` gains `configurable`; `RunResponseSchema` gains `simulation`, `description`, `durationMs`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseProjectSettings } from '../src/settings.js';

describe('parseProjectSettings', () => {
  it('falls back to Gatling defaults for an empty settings object', () => {
    expect(parseProjectSettings({})).toEqual({
      indicators: { lowerMs: 800, higherMs: 1200 },
      percentiles: [50, 75, 95, 99],
    });
  });

  it('accepts non-default bounds and columns (AC-PARITY-4)', () => {
    expect(parseProjectSettings({ indicators: { lowerMs: 200, higherMs: 900 }, percentiles: [90, 99, 99.9] }))
      .toEqual({ indicators: { lowerMs: 200, higherMs: 900 }, percentiles: [90, 99, 99.9] });
  });

  it('ignores unrelated keys rather than failing the request', () => {
    expect(parseProjectSettings({ maxDecompressedBundleBytes: 123 }).indicators.lowerMs).toBe(800);
  });

  it('rejects a lower bound above the higher bound', () => {
    expect(() => parseProjectSettings({ indicators: { lowerMs: 2000, higherMs: 1000 } }))
      .toThrow(/lowerMs/);
  });

  it('rejects percentiles outside (0, 100)', () => {
    expect(() => parseProjectSettings({ percentiles: [0] })).toThrow();
    expect(() => parseProjectSettings({ percentiles: [100] })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/contracts/test/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/settings.js'`.

- [ ] **Step 3: Implement the settings contract**

Create `packages/contracts/src/settings.ts`:

```ts
import { z } from 'zod';

/**
 * Read at REQUEST time, not frozen at ingest.
 *
 * This deliberately reverses the ingest spine's frozen-engineOptions rule for
 * these two settings only. That rule exists so a project changing configuration
 * cannot silently reinterpret its own history, and it still binds anything that
 * changes WHICH events are aggregated - warm-up above all. Indicator bounds and
 * percentile columns are not that: with an exact histogram and a stored sketch,
 * both are display thresholds applied to complete data, and recomputing them per
 * request yields exactly what a re-ingest would.
 */
export const ProjectSettingsSchema = z.object({
  indicators: z
    .object({
      lowerMs: z.number().int().positive().default(800),
      higherMs: z.number().int().positive().default(1200),
    })
    .default({ lowerMs: 800, higherMs: 1200 })
    .refine((v) => v.lowerMs < v.higherMs, {
      message: 'indicators.lowerMs must be below indicators.higherMs',
    }),
  percentiles: z
    .array(z.number().gt(0).lt(100))
    .min(1)
    .default([50, 75, 95, 99]),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** Unrelated keys (e.g. maxDecompressedBundleBytes) are ignored, not rejected. */
export function parseProjectSettings(value: unknown): ProjectSettings {
  return ProjectSettingsSchema.parse(value ?? {});
}
```

- [ ] **Step 4: Extend the metrics contracts**

In `packages/contracts/src/metrics.ts`, add:

```ts
export const IndicatorBandsSchema = z.object({
  under: z.number().int(),
  between: z.number().int(),
  over: z.number().int(),
  failed: z.number().int(),
});
```

Add to `StatRowSchema`, after `percentiles`:

```ts
  /** Folded from this row's stored histogram at the project's current bounds. */
  indicators: IndicatorBandsSchema,
```

Add to `StatsResponseSchema`, after `indicators`:

```ts
  /**
   * False for runs ingested before the parity migration, which have no
   * histogram: their bands come from frozen values and do not respond to a
   * bounds change. Reported rather than silently pretended.
   */
  configurable: z.boolean(),
  /** The bounds these bands were folded at, so a client never has to guess. */
  bounds: z.object({ lowerMs: z.number().int(), higherMs: z.number().int() }),
```

Append the three new response schemas:

```ts
export const DistributionResponseSchema = z.object({
  runId: z.string().uuid(),
  scope: MetricScopeSchema,
  name: z.string(),
  family: MetricFamilySchema,
  /** Bucket MIDPOINTS, matching Gatling's category labels. */
  labels: z.array(z.number()),
  okCount: z.array(z.number().int()),
  koCount: z.array(z.number().int()),
  /** Percent of the COMBINED OK+KO count. The two series together sum to 100. */
  okPercent: z.array(z.number()),
  koPercent: z.array(z.number()),
  /** True when the range was narrow enough that Gatling skips bucketing. */
  exactValues: z.boolean(),
  /** Non-zero means observations exceeded the histogram cap and bins are incomplete above it. */
  overflowCount: z.number().int(),
});
export type DistributionResponse = z.infer<typeof DistributionResponseSchema>;

export const UsersResponseSchema = z.object({
  runId: z.string().uuid(),
  scenarios: z.array(
    z.object({
      scenario: z.string(),
      buckets: z.array(
        z.object({
          startOffsetMs: z.number().int(),
          started: z.number().int(),
          ended: z.number().int(),
          maxConcurrent: z.number().int(),
        }),
      ),
    }),
  ),
  /**
   * The per-scenario sum at each offset. Gatling's own 'All users' series is
   * exactly this sum in both charts, verified across all 63 fixture buckets -
   * so summing per-scenario maxima is REQUIRED for parity here, even though
   * max(a+b) != max(a)+max(b) in general.
   */
  total: z.array(
    z.object({
      startOffsetMs: z.number().int(),
      started: z.number().int(),
      ended: z.number().int(),
      maxConcurrent: z.number().int(),
    }),
  ),
});
export type UsersResponse = z.infer<typeof UsersResponseSchema>;

export const ScatterResponseSchema = z.object({
  runId: z.string().uuid(),
  name: z.string(),
  /** [global requests/s, this request's truncated p95 in that bucket]. */
  ok: z.array(z.tuple([z.number().int(), z.number().int()])),
  ko: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type ScatterResponse = z.infer<typeof ScatterResponseSchema>;
```

- [ ] **Step 5: Extend the run contract**

In `packages/contracts/src/run.ts`, add to `RunResponseSchema` after `toolVersion`:

```ts
  /** The tool's own simulation identity and run description (G-01, G-02). */
  simulation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /** The load test's own span. Gatling's header renders this to whole seconds (G-04). */
  durationMs: z.number().int().nullable().optional(),
```

These are **additive and optional**, so no existing response validation changes.

- [ ] **Step 6: Export the new module**

In `packages/contracts/src/index.ts`, add `export * from './settings.js';`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/contracts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): settings, distribution, users and scatter schemas

Run fields are additive and optional, so no existing response validation
shifts. StatsResponse gains 'configurable' so a pre-migration run reports
that its bands do not respond to a bounds change, instead of silently
serving frozen numbers as if they did."
```

---

### Task 11: Worker persists the run header

**Files:**
- Modify: `apps/worker/src/pipeline/pipeline.service.ts`
- Modify: `packages/persistence/src/repositories/run.ts`
- Modify: `apps/worker/test/pipeline.integration.test.ts`

**Interfaces:**
- Consumes: `EngineResult.simulation/.description/.durationMs` (Task 6).
- Produces: `RunRepository.completeParity(...)` is **not** added — extend the existing terminal-status write instead, so the run's header, stats and verdict still commit in one transaction.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/test/pipeline.integration.test.ts`:

```ts
  it('records the tool run header alongside the statistics', async () => {
    // …after the existing helper ingests the reference bundle:
    const { rows } = await pool.query(
      `SELECT simulation, description, duration_ms FROM run WHERE id = $1`,
      [runId],
    );
    expect(rows[0]?.simulation).toBe('ParitySimulation');
    expect(rows[0]?.duration_ms).toBeGreaterThan(60_000);
    expect(rows[0]?.duration_ms).toBeLessThan(64_000);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- apps/worker/test/pipeline.integration.test.ts`
Expected: FAIL — `simulation` is null.

- [ ] **Step 3: Thread the header through**

In `packages/persistence/src/repositories/run.ts`, extend the method that writes the terminal state (the one that already sets `status`, `verdict`, `toolStartedAt`, `ingestedAt`) to also accept and write:

```ts
    simulation: string | null;
    description: string | null;
    durationMs: number | null;
```

Bind `toolStartedAt` as an ISO string, not a JS `Date` — node-postgres serializes a bound `Date` for a `timestamp` (no tz) column in the **process's** local timezone, which shifts it by the host's offset. The existing code already does this; do not regress it.

In `apps/worker/src/pipeline/pipeline.service.ts`, pass `result.simulation`, `result.description`, and `result.durationMs` at that call site. Remove any reference to `result.indicators`, which no longer exists.

- [ ] **Step 4: Serve the fields from the run endpoint**

Persisting them is not enough — nothing reads them yet, which is precisely how
`run_indicator.failed` became a column that was written and never read.

In `apps/api/src/runs/runs.controller.ts`, find the function that maps a run row
to `RunResponse` (`respondWithRun`) and add the three fields:

```ts
    simulation: run.simulation ?? null,
    description: run.description ?? null,
    durationMs: run.durationMs ?? null,
```

Add to `apps/api/test/runs.integration.test.ts`:

```ts
  it('serves the tool run header on the run endpoint', async () => {
    const r = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(r.body).toHaveProperty('simulation');
    expect(r.body).toHaveProperty('durationMs');
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration -- apps/worker/test/pipeline.integration.test.ts apps/api/test/runs.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/pipeline/pipeline.service.ts packages/persistence/src/repositories/run.ts apps/worker/test/pipeline.integration.test.ts apps/api/src/runs/runs.controller.ts apps/api/test/runs.integration.test.ts
git commit -m "feat(worker,api): persist and serve the tool run header

simulation and description were parsed by the Gatling adapter and dropped
on the floor; G-01, G-02 and G-04 need them. Written in the same
transaction as the statistics and the verdict, so a run is never observable
with a header but no numbers."
```

---

### Task 12: `GET /v1/runs/:id/stats` folds bands per row

**Files:**
- Modify: `apps/api/src/metrics/metrics.controller.ts`
- Modify: `apps/api/test/metrics.integration.test.ts`

**Interfaces:**
- Consumes: `bandsFrom` (Task 3), `parseProjectSettings` (Task 10), `MetricReader.stats` with histograms (Task 9).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/metrics.integration.test.ts`:

```ts
  it('returns indicator bands per row, folded at the project bounds', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.configurable).toBe(true);
    expect(res.body.bounds).toEqual({ lowerMs: 800, higherMs: 1200 });
    const run = res.body.stats.find((s: { scope: string }) => s.scope === 'run');
    expect(run.indicators.under + run.indicators.between + run.indicators.over).toBe(run.okCount);
    expect(run.indicators.failed).toBe(run.koCount);
  });

  // The claim of AC-PARITY-4, end to end: same stored bytes, different settings.
  it('restates history when the project changes its bounds, with no re-ingest', async () => {
    const before = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`).set('Authorization', `Bearer ${token}`).expect(200);
    await pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 100, higherMs: 200 }), projectId],
    );
    const after = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`).set('Authorization', `Bearer ${token}`).expect(200);
    const pick = (b: { stats: { scope: string; indicators: { under: number } }[] }) =>
      b.stats.find((s) => s.scope === 'run')!.indicators.under;
    expect(pick(after.body)).not.toBe(pick(before.body));
    expect(after.body.bounds).toEqual({ lowerMs: 100, higherMs: 200 });
    // Restore: settings are shared state for the rest of this file, and the
    // case above asserts the 800/1200 defaults.
    await pool.query(
      `UPDATE project SET settings = jsonb_set(settings, '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ lowerMs: 800, higherMs: 1200 }), projectId],
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- apps/api/test/metrics.integration.test.ts`
Expected: FAIL — `configurable` is undefined.

- [ ] **Step 3: Rewrite the stats handler**

In `apps/api/src/metrics/metrics.controller.ts`, delete the entire `#indicators` private method (the `run_indicator` table is gone) and its `pg.Pool` usage if nothing else needs it. Replace the `stats` handler body:

```ts
  @Get('stats')
  @Scopes('read')
  async stats(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('name') name?: string,
    @Query('family') family?: string,
  ): Promise<StatsResponse> {
    const run = await this.#run(req, id);
    const settings = parseProjectSettings(await this.projects.settings(run.projectId));
    const all = await this.reader.stats({ orgId: run.orgId, projectId: run.projectId }, run.id);
    const rows = all
      .filter((s) => (scope ? s.scope === scope : true))
      .filter((s) => (name !== undefined ? s.name === name : true))
      .filter((s) => (family ? s.family === family : true));

    // A run ingested before the parity migration has no histogram. Its bands
    // cannot respond to a bounds change, and saying so is better than serving
    // frozen numbers that look live.
    const configurable = rows.every((s) => s.histogramOk !== null);

    const stats = rows.map((s) => ({
      scope: s.scope as StatsResponse['stats'][number]['scope'],
      name: s.name,
      family: s.family as StatsResponse['stats'][number]['family'],
      count: s.count,
      okCount: s.okCount,
      koCount: s.koCount,
      errorRate: s.errorRate,
      minMs: s.minMs,
      maxMs: s.maxMs,
      meanMs: s.meanMs,
      stddevMs: s.stddevMs,
      throughputRps: s.throughputRps,
      percentiles: s.percentiles,
      indicators: s.histogramOk
        ? bandsFrom(s.histogramOk, s.koCount, settings.indicators)
        : { under: 0, between: 0, over: 0, failed: s.koCount },
    }));

    const runRow = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    return {
      runId: run.id,
      stats,
      indicators: runRow?.indicators ?? { under: 0, between: 0, over: 0, failed: 0 },
      configurable,
      bounds: settings.indicators,
    };
  }
```

Add the imports `import { bandsFrom } from '@perfportal/statistics';` and `import { parseProjectSettings } from '@perfportal/contracts';`, and inject the existing project repository as `private readonly projects: ProjectRepository`.

> **If `ProjectRepository` has no `settings(projectId)` method**, add one that returns `project.settings` as `unknown`. Do not read `project` through raw SQL here; the repository is where tenancy scoping lives.

- [ ] **Step 4: Extend the errors handler**

```ts
  @Get('errors')
  @Scopes('read')
  async errors(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('name') name?: string,
  ): Promise<ErrorsResponse> {
    const run = await this.#run(req, id);
    // Omitting ?scope means run scope, NOT "every scope": the engine writes a
    // row per (scope, name), so an unscoped read would return each failure
    // twice and double every count.
    const sel = { scope: scope ?? 'run', name: scope === undefined ? '' : (name ?? '') };
    const errors = await this.reader.errors(
      { orgId: run.orgId, projectId: run.projectId }, run.id, sel,
    );
    return { runId: run.id, errors };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration -- apps/api/test/metrics.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/metrics/metrics.controller.ts apps/api/test/metrics.integration.test.ts
git commit -m "feat(api): per-row indicator bands folded at the project bounds

Deletes the #indicators method that summed the run_indicator table. The
second test changes a project's bounds and asserts the SAME run's bands
move without a re-ingest - AC-PARITY-4 end to end, in one request pair."
```

---

### Task 13: Distribution, users and scatter endpoints

**Files:**
- Create: `apps/api/src/metrics/parity.controller.ts`
- Modify: `apps/api/src/metrics/metrics.module.ts`
- Modify: `packages/statistics/src/buckets.ts`
- Create: `packages/statistics/test/bucket-width.test.ts`
- Create: `apps/api/test/parity-endpoints.integration.test.ts`

**Interfaces:**
- Produces: `inferBucketWidthMs(offsets: number[]): number` exported from `packages/statistics/src/buckets.ts`; routes `GET /v1/runs/:id/distribution`, `/users`, `/scatter`.

- [ ] **Step 1: Write the failing width test**

Create `packages/statistics/test/bucket-width.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inferBucketWidthMs } from '../src/buckets.js';

describe('inferBucketWidthMs', () => {
  it('is the smallest positive gap, so a missing bucket cannot inflate it', () => {
    expect(inferBucketWidthMs([0, 1000, 2000, 5000])).toBe(1000);
  });
  it('reads a coalesced series correctly', () => {
    expect(inferBucketWidthMs([0, 4000, 8000])).toBe(4000);
  });
  it('falls back to one second when there is nothing to infer from', () => {
    expect(inferBucketWidthMs([])).toBe(1000);
    expect(inferBucketWidthMs([0])).toBe(1000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/statistics/test/bucket-width.test.ts`
Expected: FAIL — `inferBucketWidthMs` is not exported.

- [ ] **Step 3: Add the helper**

Append to `packages/statistics/src/buckets.ts`:

```ts
/**
 * The bucket width of a persisted series.
 *
 * run_series_bucket stores start_offset_ms but not the width, and the width is
 * not always 1000: BucketSeries halves resolution in place once a run exceeds
 * its bucket cap. The scatter's x-axis is a RATE, so dividing by the wrong
 * width silently scales every point.
 *
 * The smallest positive gap, not the first gap: a bucket with no observations
 * is absent from the table, so consecutive offsets can be two widths apart.
 */
export function inferBucketWidthMs(offsets: number[]): number {
  let width = Number.POSITIVE_INFINITY;
  for (let i = 1; i < offsets.length; i++) {
    const gap = (offsets[i] as number) - (offsets[i - 1] as number);
    if (gap > 0 && gap < width) width = gap;
  }
  return Number.isFinite(width) ? width : 1000;
}
```

- [ ] **Step 4: Write the failing endpoint tests**

Create `apps/api/test/parity-endpoints.integration.test.ts` following the setup already used by `apps/api/test/metrics.integration.test.ts` (same app bootstrap, same seeded run, same bearer token), with:

```ts
  it('serves a Gatling-shaped distribution', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.labels.length).toBe(100);
    expect(res.body.overflowCount).toBe(0);
    const sum = [...res.body.okPercent, ...res.body.koPercent].reduce((a: number, b: number) => a + b, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it('serves per-scenario users plus a summed total', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/users`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
    const first = res.body.total[0];
    const perScenario = res.body.scenarios
      .map((s: { buckets: { startOffsetMs: number; maxConcurrent: number }[] }) =>
        s.buckets.find((b) => b.startOffsetMs === first.startOffsetMs)?.maxConcurrent ?? 0)
      .reduce((a: number, b: number) => a + b, 0);
    expect(first.maxConcurrent).toBe(perScenario);
  });

  it('serves the scatter as one point per bucket with a truncated p95', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent('Catalog / List')}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.ok.length).toBeGreaterThan(0);
    for (const [x, y] of res.body.ok) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });

  it('404s for a run in another project', async () => {
    await request(app.getHttpServer())
      .get(`/v1/runs/${otherProjectRunId}/distribution?scope=run&name=&family=response_time`)
      .set('Authorization', `Bearer ${token}`).expect(404);
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm test:integration -- apps/api/test/parity-endpoints.integration.test.ts`
Expected: FAIL — 404 on every new route.

- [ ] **Step 6: Implement the controller**

Create `apps/api/src/metrics/parity.controller.ts`:

```ts
import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { DistributionResponse, ScatterResponse, UsersResponse } from '@perfportal/contracts';
import { MetricReader, RunRepository } from '@perfportal/persistence';
import { distribution, inferBucketWidthMs } from '@perfportal/statistics';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { uuidParam } from '../common/validation.js';

@Controller('/v1/runs/:id')
export class ParityController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
  ) {}

  async #run(req: Request, id: string) {
    const tenant = req.tenant!;
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);
    return run;
  }

  @Get('distribution')
  @Scopes('read')
  async distribution(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope = 'run',
    @Query('name') name = '',
    @Query('family') family = 'response_time',
  ): Promise<DistributionResponse> {
    const run = await this.#run(req, id);
    const h = await this.reader.histograms(
      { orgId: run.orgId, projectId: run.projectId }, run.id, { scope, name, family },
    );
    if (!h) throw new NotFoundException(`No ${family} histogram for ${scope} "${name}" in run ${id}.`);
    const d = distribution(h.ok, h.ko);
    return {
      runId: run.id,
      scope: scope as DistributionResponse['scope'],
      name,
      family: family as DistributionResponse['family'],
      labels: d.labels,
      okCount: d.okCount,
      koCount: d.koCount,
      okPercent: d.okPercent,
      koPercent: d.koPercent,
      exactValues: d.exactValues,
      overflowCount: d.overflowCount,
    };
  }

  @Get('users')
  @Scopes('read')
  async users(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<UsersResponse> {
    const run = await this.#run(req, id);
    const rows = await this.reader.users(
      { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
    );

    const byScenario = new Map<string, UsersResponse['scenarios'][number]['buckets']>();
    const total = new Map<number, { startOffsetMs: number; started: number; ended: number; maxConcurrent: number }>();
    for (const r of rows) {
      let list = byScenario.get(r.scenario);
      if (!list) { list = []; byScenario.set(r.scenario, list); }
      list.push({
        startOffsetMs: r.startOffsetMs, started: r.started,
        ended: r.ended, maxConcurrent: r.maxConcurrent,
      });
      // Gatling's own 'All users' series is the per-scenario SUM in both
      // charts - verified across all 63 fixture buckets. Summing maxima is
      // normally wrong (max(a+b) != max(a)+max(b)); here it is what parity
      // requires. Do not "fix" this to a true max-of-sums.
      const t = total.get(r.startOffsetMs) ?? {
        startOffsetMs: r.startOffsetMs, started: 0, ended: 0, maxConcurrent: 0,
      };
      t.started += r.started;
      t.ended += r.ended;
      t.maxConcurrent += r.maxConcurrent;
      total.set(r.startOffsetMs, t);
    }

    return {
      runId: run.id,
      scenarios: [...byScenario].map(([scenario, buckets]) => ({ scenario, buckets }))
        .sort((a, b) => a.scenario.localeCompare(b.scenario)),
      total: [...total.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
    };
  }

  @Get('scatter')
  @Scopes('read')
  async scatter(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('name') name = '',
  ): Promise<ScatterResponse> {
    const run = await this.#run(req, id);
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    const [global, own] = await Promise.all([
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'run', name: '' }),
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'request', name }),
    ]);

    // x is a RATE over the global REQUESTS series (started_count, both
    // statuses), matching Gatling's getRequestsPerSecBuffer(None, None).
    // Not responses - that is a different chart.
    const widthMs = inferBucketWidthMs(global.map((b) => b.startOffsetMs));
    const rateAt = new Map<number, number>();
    for (const b of global) {
      rateAt.set(b.startOffsetMs, Math.round((b.startedCount / widthMs) * 1000));
    }

    // y is quantile(0.95).toInt - TRUNCATED, not rounded.
    const ok: [number, number][] = [];
    const ko: [number, number][] = [];
    for (const b of own) {
      const x = rateAt.get(b.startOffsetMs);
      const p95 = b.percentiles.p95;
      if (x === undefined || p95 === undefined) continue;
      (b.okCount > 0 ? ok : ko).push([x, Math.trunc(p95)]);
    }
    ok.sort((a, b) => a[0] - b[0]);
    ko.sort((a, b) => a[0] - b[0]);
    return { runId: run.id, name, ok, ko };
  }
}
```

- [ ] **Step 7: Register the controller**

Add `ParityController` to the `controllers` array in `apps/api/src/metrics/metrics.module.ts`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:integration -- apps/api/test/parity-endpoints.integration.test.ts packages/statistics/test/bucket-width.test.ts`
Expected: PASS.

- [ ] **Step 9: Falsification checkpoint — prove the rate divisor matters**

The reference fixture's run has 63 buckets, well under the 300 cap, so it never
coalesces — no test in this task or Task 15 exercises a wrong divisor. Rather
than claim coverage that does not exist, falsify the piece that IS covered:

Change `inferBucketWidthMs` to return the FIRST gap instead of the smallest and
re-run `pnpm vitest run packages/statistics/test/bucket-width.test.ts`.
Expected: "is the smallest positive gap" FAILS. Restore.

Then record in the report that the controller's *use* of the inferred width is
unverified: no fixture coalesces. The final review should decide whether that
warrants a synthetic >300-bucket integration fixture.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/metrics/parity.controller.ts apps/api/src/metrics/metrics.module.ts apps/api/test/parity-endpoints.integration.test.ts packages/statistics/src/buckets.ts packages/statistics/test/bucket-width.test.ts
git commit -m "feat(api): distribution, users and scatter endpoints

The scatter needs no new storage: x is the run-scope bucket's request rate
and y is the request-scope bucket's p95, both already persisted. x divides
by the INFERRED bucket width, because BucketSeries halves resolution in
place once a run exceeds its cap and the axis is a rate - dividing by a
hardcoded 1000 would silently scale every point on a long run.

The users total sums per-scenario maxima. That is normally a bug, and here
it is required: Gatling's own 'All users' series equals the per-scenario
sum in both charts across all 63 fixture buckets."
```

---
### Task 14: Regenerate the OpenAPI document

**Files:**
- Modify: `apps/api/src/openapi/schemas.ts`, `apps/api/src/openapi/document.ts`
- Modify: `apps/api/test/openapi.integration.test.ts`

**Interfaces:**
- Consumes: every schema from Task 10.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/openapi.integration.test.ts`:

```ts
  it('documents every parity endpoint', () => {
    for (const path of [
      '/v1/runs/{id}/distribution', '/v1/runs/{id}/users', '/v1/runs/{id}/scatter',
    ]) {
      expect(doc.paths[path]?.get).toBeDefined();
    }
  });

  it('documents the new component schemas', () => {
    for (const name of ['DistributionResponse', 'UsersResponse', 'ScatterResponse', 'IndicatorBands']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
  });

  it('declares the query parameters the parity endpoints actually read', () => {
    const names = (doc.paths['/v1/runs/{id}/distribution'].get.parameters ?? [])
      .map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'scope', 'name', 'family']));
  });

  it('reports indicator bands on the stats response', () => {
    expect(doc.components.schemas.StatsResponse.properties.configurable).toBeDefined();
    expect(doc.components.schemas.StatRow.properties.indicators).toBeDefined();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration -- apps/api/test/openapi.integration.test.ts`
Expected: FAIL — the three paths are undefined.

- [ ] **Step 3: Register the schemas and paths**

In `apps/api/src/openapi/schemas.ts`, add the new Zod schemas to the same `zod-to-json-schema` registration list the existing 31 use — do not hand-write JSON Schema.

In `apps/api/src/openapi/document.ts`, add the three `GET` paths following the shape of the existing `/v1/runs/{id}/series` entry: `id` path parameter, the query parameters listed above, a `200` response referencing the component, and `401`/`403`/`404` referencing the existing problem schema.

The document is hand-rolled rather than built with `DocumentBuilder` because `DocumentBuilder` emits the 3.0 dialect; keep `openapi: '3.1.0'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration -- apps/api/test/openapi.integration.test.ts`
Expected: PASS, including the existing `@readme/openapi-parser` validation case.

Note: the validator case passes against an **empty** document too. It is not evidence the document is right — the four cases above are.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/openapi apps/api/test/openapi.integration.test.ts
git commit -m "feat(api): document the parity endpoints in OpenAPI 3.1

Generated from the Zod contracts, not hand-written - the frontend
sub-project generates its client from this document, so a drift here
becomes a type error there rather than a runtime surprise."
```

---

### Task 15: The `PT-*` parity harness

The task the whole plan exists for. Extends the keystone rather than adding files: the fixture is posted once over live HTTP and every row asserts against that one run.

**Files:**
- Modify: `apps/api/test/parity.e2e.test.ts`

- [ ] **Step 1: Add the Appendix A row cases**

Append to `apps/api/test/parity.e2e.test.ts`, inside the existing describe that already posts `fixtures/gatling-3.15.1.2/reference-report`.

> **Read the file first.** The cases below use `get(path)` for an authenticated
> `GET`, plus `runId`, `projectId` and `pool` from the enclosing scope. Those
> names are shorthand for whatever the file already has — it currently posts the
> bundle and asserts totals, so a request helper and `runId` exist in some form,
> but `pool` and `projectId` may not be in scope and may need lifting out of the
> setup block. Adapt the names to the file; do not introduce a second app
> bootstrap or re-post the bundle, which would double an already slow suite.

```ts
  // Ground truth for percentiles is the sorted decoded event set, NEVER the
  // figure Gatling prints. Gatling reports p99 = 2369 for this fixture and 2369
  // does not occur anywhere in the data - the sorted tail jumps 2287 -> 2501.
  // Matching Gatling would mean reproducing its estimator's error (AC-PARITY-2).
  const truePercentile = (sorted: number[], p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] as number;
  };
  const withinOnePercent = (actual: number, truth: number): boolean =>
    truth === 0 ? actual === 0 : Math.abs(actual - truth) / truth <= 0.01;   // <=, never <

  describe('Appendix A.1 — global report page', () => {
    it('PT-G-01/02 header carries the simulation name and description', async () => {
      const r = await get(`/v1/runs/${runId}`);
      expect(r.body.simulation).toBe('ParitySimulation');
      expect(typeof r.body.description).toBe('string');
    });

    it('PT-G-04 header duration matches the report’s whole-second rendering', async () => {
      const r = await get(`/v1/runs/${runId}`);
      expect(Math.floor(r.body.durationMs / 1000)).toBe(62);      // report shows "1m 2s"
    });

    it('PT-G-06..09 indicator bands are 848 / 0 / 23 / 24', async () => {
      const r = await get(`/v1/runs/${runId}/stats`);
      expect(r.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
    });

    it('PT-G-20/21 distribution has 100 midpoint bins from 28 to 2491', async () => {
      const r = await get(`/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`);
      expect(r.body.labels).toHaveLength(100);
      expect(r.body.labels[0]).toBe(28);
      expect(r.body.labels[99]).toBe(2491);
      // Percent of the COMBINED count: the two series together sum to 100.
      const total = [...r.body.okPercent, ...r.body.koPercent].reduce((a: number, b: number) => a + b, 0);
      expect(total).toBeCloseTo(100, 6);
      expect(r.body.okCount.reduce((a: number, b: number) => a + b, 0)).toBe(871);
      expect(r.body.koCount.reduce((a: number, b: number) => a + b, 0)).toBe(24);
    });

    it('PT-G-18/19 active users total equals the per-scenario sum', async () => {
      const r = await get(`/v1/runs/${runId}/users`);
      expect(r.body.scenarios.map((s: { scenario: string }) => s.scenario)).toEqual(['Browse', 'Checkout']);
      for (const t of r.body.total) {
        const sum = r.body.scenarios
          .map((s: { buckets: { startOffsetMs: number; maxConcurrent: number }[] }) =>
            s.buckets.find((b) => b.startOffsetMs === t.startOffsetMs)?.maxConcurrent ?? 0)
          .reduce((a: number, b: number) => a + b, 0);
        expect(t.maxConcurrent).toBe(sum);
      }
    });

    it('PT-G-26 user start rate is present and non-zero', async () => {
      const r = await get(`/v1/runs/${runId}/users`);
      expect(r.body.total.reduce((n: number, b: { started: number }) => n + b.started, 0)).toBeGreaterThan(0);
    });
  });

  describe('Appendix A.2 — request detail page', () => {
    it('PT-RQ-02 per-request indicator bands reconcile with the row counts', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=request`);
      for (const row of r.body.stats) {
        expect(row.indicators.under + row.indicators.between + row.indicators.over).toBe(row.okCount);
        expect(row.indicators.failed).toBe(row.koCount);
      }
    });

    it('PT-RQ-09 scatter is one point per bucket, x a rate and y a truncated p95', async () => {
      const stats = await get(`/v1/runs/${runId}/stats?scope=request`);
      const name = stats.body.stats[0].name as string;
      const [series, scatter] = await Promise.all([
        get(`/v1/runs/${runId}/series?scope=request&name=${encodeURIComponent(name)}`),
        get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent(name)}`),
      ]);
      const buckets = series.body.buckets.filter((b: { endedCount: number }) => b.endedCount > 0);
      expect(scatter.body.ok.length + scatter.body.ko.length).toBe(buckets.length);
      for (const [, y] of scatter.body.ok) expect(Number.isInteger(y)).toBe(true);
    });

    it('PT-RQ-11 a request page shows only its own errors', async () => {
      const all = await get(`/v1/runs/${runId}/errors`);
      const stats = await get(`/v1/runs/${runId}/stats?scope=request`);
      const failing = stats.body.stats.find((s: { koCount: number }) => s.koCount > 0);
      const own = await get(`/v1/runs/${runId}/errors?scope=request&name=${encodeURIComponent(failing.name)}`);
      expect(own.body.errors.length).toBeGreaterThan(0);
      expect(own.body.errors.reduce((n: number, e: { count: number }) => n + e.count, 0))
        .toBeLessThan(all.body.errors.reduce((n: number, e: { count: number }) => n + e.count, 0));
    });
  });

  describe('Appendix A.3 — group detail page', () => {
    it('PT-GR-01/02 cumulated response time and duration stay distinct', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=group`);
      const families = new Set(r.body.stats.map((s: { family: string }) => s.family));
      expect(families.has('group_cumulated')).toBe(true);
      expect(families.has('group_duration')).toBe(true);
      const nested = r.body.stats.filter((s: { name: string }) => s.name === 'Catalog/Recommendations');
      expect(nested).toHaveLength(2);
      // Collapsing these two into one metric is the most common group-parity error.
      expect(nested[0].meanMs).not.toBe(nested[1].meanMs);
    });

    it('PT-GR-03/05 both group families have their own distribution', async () => {
      for (const family of ['group_cumulated', 'group_duration']) {
        const r = await get(
          `/v1/runs/${runId}/distribution?scope=group&name=${encodeURIComponent('Catalog/Recommendations')}&family=${family}`,
        );
        expect(r.body.labels.length).toBeGreaterThan(0);
      }
    });

    it('PT-GR-09 group indicator bands are present', async () => {
      const r = await get(`/v1/runs/${runId}/stats?scope=group`);
      for (const row of r.body.stats) {
        expect(row.indicators.under + row.indicators.between + row.indicators.over).toBe(row.okCount);
      }
    });
  });

  describe('Appendix A.5/A.6 — columns and configurability', () => {
    it('PT-G-12 every §A.5 column is present at every scope', async () => {
      const r = await get(`/v1/runs/${runId}/stats`);
      for (const row of r.body.stats) {
        for (const k of ['count', 'okCount', 'koCount', 'errorRate', 'throughputRps',
                         'minMs', 'maxMs', 'meanMs', 'stddevMs']) {
          expect(typeof row[k]).toBe('number');
        }
        for (const p of ['p50', 'p75', 'p95', 'p99']) {
          expect(typeof row.percentiles[p]).toBe('number');
        }
      }
    });

    it('PT-K-01/02 non-default bounds restate history without a re-ingest (AC-PARITY-4)', async () => {
      const before = await get(`/v1/runs/${runId}/stats`);
      await setProjectIndicators({ lowerMs: 100, higherMs: 300 });
      const after = await get(`/v1/runs/${runId}/stats`);
      expect(after.body.bounds).toEqual({ lowerMs: 100, higherMs: 300 });
      expect(after.body.indicators.under).not.toBe(before.body.indicators.under);
      expect(after.body.indicators.under + after.body.indicators.between + after.body.indicators.over)
        .toBe(before.body.indicators.under + before.body.indicators.between + before.body.indicators.over);
      await setProjectIndicators({ lowerMs: 800, higherMs: 1200 });
    });

    it('PT-K-03 percentile columns follow project settings', async () => {
      await setProjectPercentiles([90, 99]);
      const r = await get(`/v1/runs/${runId}/stats`);
      expect(Object.keys(r.body.stats[0].percentiles).sort()).toEqual(['p90', 'p99']);
      // p95 survives in the BUCKETS regardless, or the scatter breaks.
      const s = await get(`/v1/runs/${runId}/series?scope=run&name=`);
      expect(s.body.buckets[0].percentiles.p95).toBeDefined();
      await setProjectPercentiles([50, 75, 95, 99]);
    });
  });
```

Add the two helpers near the top of the file:

```ts
  const setProjectIndicators = async (indicators: { lowerMs: number; higherMs: number }) => {
    await pool.query(
      `UPDATE project SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{indicators}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(indicators), projectId],
    );
  };
  const setProjectPercentiles = async (percentiles: number[]) => {
    await pool.query(
      `UPDATE project SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{percentiles}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(percentiles), projectId],
    );
  };
```

- [ ] **Step 2: Run the parity suite**

Run: `pnpm test:integration -- apps/api/test/parity.e2e.test.ts`
Expected: PASS, with the pre-existing cases (895 requests, 871/24, max 2503, mean 228, stddev 370) still green.

- [ ] **Step 3: Falsification checkpoint — prove the rows can fail**

Run each of these, confirm the named case FAILS, then restore:

| Break | Case that must fail |
|---|---|
| `gatlingLabels` drops `+ halfStep` | PT-G-20/21 (`labels[0]` becomes 16) |
| `distribution`'s `percent` divides by `ok.total` instead of `size` | PT-G-20/21 (sum becomes 200) |
| `users` total uses `Math.max` instead of `+=` | PT-G-18/19 |
| `scatter` uses `Math.round` instead of `Math.trunc` | PT-RQ-09 on any bucket with a fractional p95 |
| `bandsFrom` uses `<=` instead of `<` for `under` | PT-G-06..09 |
| `errorsFor('request', …)` removed from the engine | PT-RQ-11 |

If any row passes while its dependency is broken, the assertion is not testing what it claims — fix the assertion before continuing. This table is the point of the task.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/parity.e2e.test.ts
git commit -m "test(parity): assert every Appendix A data row against the fixture

One named case per row, so a CI failure names the row that regressed
instead of surfacing as an anonymous assertion. Percentiles compare against
ground truth from the sorted decoded event set, never Gatling's printed
figure: Gatling reports p99 = 2369 for this fixture and 2369 occurs nowhere
in the data - the sorted tail jumps 2287 to 2501.

Each row was verified to FAIL against a deliberately broken implementation
before being accepted. A green test that cannot go red is not a test."
```

---

### Task 16: Correct Appendix A and the README

The matrix is what the GA gate rests on; leaving it disagreeing with the shipped behaviour is worse than either being wrong alone.

**Files:**
- Modify: `PerfPortal_Enterprise_PRD.md` (§A.0 tolerances, §A.1 G-04/G-20/G-21, §A.2 RQ-09, §A.9)
- Modify: `README.md`

- [ ] **Step 1: Amend §A.9 with the new findings**

Append three findings to §A.9, dated 2026-08-08, in the same style as the existing five:

- **F-7 (RQ-09).** Not a per-request scatter: one point per second, x = global requests/s (`getRequestsPerSecBuffer(None, None).counts`, `count.total`), y = `digest.quantile(0.95).toInt` — truncated. Source: `LogFileData.scala:213`, tag `v3.15.1`. The fixture could not decide it: p75 through max coincide on all seven request pages at ~3 requests/second.
- **F-8 (G-20/G-21).** The distribution renders **percentages of the combined OK+KO count** to 2 dp, over 100 **midpoint-labelled** bins. The labels are not `(max−min)/100`; they are `floor(min + step·i + step/2 + 0.5)`, reproduced exactly at **min = 16, max = 2503**. The `28` on the chart is the first bin's midpoint, not the minimum. `maxPlots` is the hardcoded literal `100`.
- **F-9 (G-04).** The header renders `Duration: 1m 2s` — whole seconds. "Exact ms" is unassertable from the report; the row's tolerance becomes "exact to the displayed second."

- [ ] **Step 2: Correct the affected rows and tolerances**

- §A.0 tolerance paragraph: replace "Distribution bin counts **exact** when bin boundaries align" with the F-8 rule.
- §A.1 row G-04: tolerance `Exact ms` → `Exact to the displayed second`.
- §A.1 rows G-20/G-21: tolerance `Bin counts exact` → `Bin labels exact; percent of combined OK+KO exact to 2dp`.
- §A.2 row RQ-09: description → "one point per second; x = global requests/s, y = truncated p95"; tolerance stays `1% relative`, against ground truth.
- §A.6: add a note that K-03 governs the statistics-table columns only, and that the over-time band set is fixed — buckets store numbers, not sketches.

- [ ] **Step 3: Update the README**

Add the new endpoints to the API list, and add a line to the "Proving it end to end" section noting the parity suite now asserts every Appendix A data row by name, with the fixture's global min of **16 ms**.

- [ ] **Step 4: Full verification**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add PerfPortal_Enterprise_PRD.md README.md
git commit -m "docs: correct Appendix A against the generated report and Gatling source

Three rows were wrong. RQ-09 is one point per second with a truncated p95,
not a per-request scatter. G-20/G-21 render percentages of the combined
count over midpoint-labelled bins, not counts - and the fixture's real
minimum is 16ms, not the 28 the chart's first label suggests. G-04's
'exact ms' is unassertable: the header shows whole seconds.

Appendix A is what the GA gate rests on, so a matrix that disagrees with
shipped behaviour is worse than either being wrong alone."
```

---

## Verification

Run after the final task:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

**Definition of done:** every row in Appendix A §A.1, §A.2, §A.3, §A.5 and §A.6 that carries data has a named `PT-*` case asserting it against `fixtures/gatling-3.15.1.2/`, and each of those cases has been shown to fail against a deliberately broken implementation (Task 15 Step 3).

**Out of scope, and must not appear in any diff:** React or any frontend code; latency as a metric family; the Scenario Detail page; backfilling histograms onto runs ingested before this change; live monitoring.
