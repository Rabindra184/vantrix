# Exact statistics — PR 1: exact engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every NEW run's statistics — tiles, tables, buckets, trends, compare, SLA verdicts, Gatling-assertion verdicts and the live view — are exact (nearest-rank over 1 ms histograms), while runs ingested before this PR read exactly as they do today.

**Architecture:** The existing exact `Histogram` (`packages/statistics/src/histogram.ts`) becomes uncapped (format `sparse-ms-v2`) and gains integer rank arithmetic. `RollupBuilder` and `BucketSeries` drop their DDSketches and derive every figure from histograms. Readers choose per stored row: a `sparse-ms-v2` histogram is exact and used; anything older keeps today's legacy sketch path. `run.stats_method` (`estimated` for existing rows, `exact-v1` for new ones) reaches the browser so the "estimate within 1%" caveats show only on estimated runs.

**Tech Stack:** TypeScript (Node 22, pnpm workspace), Vitest 4, Prisma 6 + raw `pg`, NestJS API, React web app, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-exact-statistics-design.md` (§2 rules, §3 data model, §4 engine, §9 PR 1). Research: `docs/superpowers/research/2026-10-15-gatling-enterprise-parity-matrix.md`.

## Global Constraints

- Node 22 (`source ~/.nvm/nvm.sh && nvm use`) before every command — on Node 20 the jsdom suite silently skips.
- Percentile rule (spec §2): nearest rank, 1-based position ⌈p/100 × n⌉; p = 0 → min, p = 100 → max; n = 0 → no value (key absent, never 0 or NaN).
- Rank arithmetic must be exact for decimal percentiles (`99.9`, `99.99`): never `Math.ceil(p / 100 * n)` in floating point.
- Standard deviation is the population form √(Σx²/n − mean²), clamped at 0 before the square root.
- New histograms are uncapped; `sparse-ms-v1` bytes stay readable.
- Rows written before this PR must read exactly as before (legacy sketch path untouched for them).
- New contract fields are `.optional()` (rolling-deploy rule in `packages/contracts/src/run.ts`).
- Every new number on the wire goes through BOTH run identity builders (`RunsService.toResponse` and the 202 in `respondWithRun`) — use `lifecycleOf`.
- Branch from `main` (`git checkout main && git pull --ff-only && git checkout -b feat/exact-statistics-engine`), check `git log --oneline origin/main..HEAD`; merge commit, never squash.
- Commit messages via `git commit -F - <<'MSG'` (backticks in `-m` strings are executed by the shell).
- Never `git add -A`; name paths.
- Integration and e2e suites run against a scratch database and Redis index, never the developer database `perfportal`.

## Review Focus

1. **Decimal percentiles at round sample sizes** — p99.9 over n = 1000 must be the 999th value, p7 over n = 100 the 7th. Today's float formula returns the 1000th / 8th (measured). Pinned in Task 1.
2. **Runs ingested before this PR** — a row with a DDSketch and a `sparse-ms-v1` histogram (possibly with overflow) must produce byte-identical `/stats`, trends and SLA answers to today. Pinned in Task 4 and Task 5.
3. **Empty populations** — a bucket with only KO responses, a KO-only `percentilesOk`, a request with zero KO: percentiles are `{}` / absent, min/max/mean 0, never NaN on the wire. Pinned in Task 2.
4. **Very large values** — group durations of minutes and a 30-minute request: exact percentile, exact serialize/deserialize round trip, no overflow. Pinned in Task 1 and Task 2.
5. **An older API pod** — a response without `statsMethod` must keep the estimate caveat in the browser (absent means "not known to be exact"). Pinned in Task 6.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/statistics/src/rank.ts` (new) | `nearestRankIndex(p, n)` — the one rank formula | 1 |
| `packages/statistics/src/histogram.ts` | Uncapped v2 format, `percentile(p)`, `exact` flag, v1 compatibility | 1 |
| `packages/statistics/src/rollup.ts` | `StatRollup` without `sketch`; every figure from histograms | 2 |
| `packages/statistics/src/buckets.ts` | `Bucket` without sketches | 2 |
| `packages/statistics/src/bucket-latency.ts` | Bucket latency from histograms | 2 |
| `packages/statistics/src/tool-assertions.ts` | G-05 percentiles from histograms | 2 |
| `packages/statistics/src/window.ts` | Window percentiles via `percentile` | 2 |
| `packages/statistics/src/stored-percentiles.ts` (new) | Exact-or-legacy percentile recomputation for stored rows | 4 |
| `packages/sla/src/metrics.ts`, `packages/sla/src/stats.ts` | Evaluator reads histograms | 3 |
| `packages/persistence/prisma/migrations/20261015120000_exact_statistics/migration.sql` (new) | Nullable sketch, `run.stats_method` | 4 |
| `packages/persistence/prisma/schema.prisma` | Same, in the schema | 4 |
| `packages/persistence/src/metrics/write.ts` | Writes v2 histograms, no sketch | 4 |
| `packages/persistence/src/metrics/read.ts`, `trends.ts` | Load histograms for recomputation | 4 |
| `apps/api/src/metrics/metrics.controller.ts` | `/stats` and trends use the shared helper | 5 |
| `packages/contracts/src/run.ts`, `apps/api/src/runs/runs.service.ts` | `statsMethod` on run identity | 5 |
| `apps/web/src/routes/RunStats.tsx`, `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/src/routes/RunGlossary.tsx` | Caveats only on estimated runs | 6 |
| `CLAUDE.md` | Entry, floors | 7 |

---

### Task 1: Exact rank arithmetic and the uncapped histogram

**Files:**
- Create: `packages/statistics/src/rank.ts`
- Modify: `packages/statistics/src/histogram.ts`, `packages/statistics/src/index.ts`
- Test: `packages/statistics/test/rank.test.ts` (new), `packages/statistics/test/histogram.test.ts`

**Interfaces:**
- Produces: `nearestRankIndex(p: number, n: number): number` (0-based index, `-1` when `n === 0`); `HISTOGRAM_KIND = 'sparse-ms-v2'`; `Histogram#percentile(p: number): number | undefined` (p in [0, 100]; `undefined` when empty or when a legacy overflow bin hides the rank); `Histogram#exact: boolean` (true for histograms created by `new Histogram()` and deserialized from v2; false for v1 bytes); `Histogram.deserialize` accepts v1 and v2; `serialize()` always writes v2 and throws if `overflowCount > 0`.

- [ ] **Step 1: Write the failing rank tests**

`packages/statistics/test/rank.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nearestRankIndex } from '../src/rank.js';

describe('nearestRankIndex', () => {
  it('is the 1-based position ceil(p/100*n), as a 0-based index', () => {
    expect(nearestRankIndex(50, 4)).toBe(1);   // 2nd of 4
    expect(nearestRankIndex(95, 20)).toBe(18); // 19th of 20
    expect(nearestRankIndex(99, 1718)).toBe(1700); // ceil(1700.82) = 1701st
  });

  it('answers min for p=0 and max for p=100', () => {
    expect(nearestRankIndex(0, 10)).toBe(0);
    expect(nearestRankIndex(100, 10)).toBe(9);
  });

  it('is -1 for an empty sample', () => {
    expect(nearestRankIndex(50, 0)).toBe(-1);
  });

  // The floating-point formula Math.ceil(p / 100 * n) gets both of these wrong
  // (measured 2026-10-15): 0.07 * 100 is 7.000000000000001 and 0.999 * 1000 is
  // 999.0000000000001, so it returns the 8th and the 1000th value.
  it('is exact for decimal and round-sample percentiles', () => {
    expect(nearestRankIndex(7, 100)).toBe(6);       // 7th
    expect(nearestRankIndex(99.9, 1000)).toBe(998); // 999th
    expect(nearestRankIndex(99.99, 10000)).toBe(9998);
  });

  it('agrees with an exact rational computation for every p and n swept', () => {
    const ps = [1, 5, 7, 25, 50, 75, 80, 85, 90, 95, 99, 99.5, 99.9, 99.99];
    for (const p of ps) {
      const scale = 10 ** ((String(p).split('.')[1] ?? '').length);
      const num = BigInt(Math.round(p * scale));
      for (let n = 1; n <= 5000; n++) {
        const den = 100n * BigInt(scale);
        const prod = num * BigInt(n);
        const rank = Number((prod + den - 1n) / den); // exact ceil
        expect(nearestRankIndex(p, n), `p=${p} n=${n}`).toBe(Math.max(1, rank) - 1);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/statistics/test/rank.test.ts`
Expected: FAIL — `Cannot find module '../src/rank.js'`.

- [ ] **Step 3: Implement `rank.ts`**

```ts
/**
 * THE ONE NEAREST-RANK FORMULA (spec §2): the value at 1-based position
 * ⌈p/100 × n⌉, returned as a 0-based index.
 *
 * Computed on integers because the floating-point form is wrong at round
 * sample sizes: Math.ceil(0.999 * 1000) is 1000 and Math.ceil(0.07 * 100) is
 * 8 (measured), so p99.9 over 1,000 values would return the maximum. `p` is
 * scaled by 10^decimals to an integer, so `num * n` is an exact integer and
 * the division below is the only rounding, applied once and upward.
 */
export function nearestRankIndex(p: number, n: number): number {
  if (n <= 0) return -1;
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile ${p} is outside [0, 100]`);
  const decimals = (String(p).split('.')[1] ?? '').length;
  const scale = 10 ** decimals;
  const num = Math.round(p * scale);
  const den = 100 * scale;
  const rank = Math.ceil((num * n) / den);
  return Math.min(n, Math.max(1, rank)) - 1;
}
```

Add to `packages/statistics/src/index.ts`: `export * from './rank.js';`

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/statistics/test/rank.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing histogram tests**

Append to `packages/statistics/test/histogram.test.ts` (keep every existing case — they cover v1 behaviour that must survive):

```ts
import { HISTOGRAM_KIND, Histogram } from '../src/histogram.js';

describe('Histogram v2 (exact, uncapped)', () => {
  const sorted = (h: Histogram) => [...h.entries()].flatMap(([v, c]) => Array(c).fill(v) as number[]);

  it('names its format sparse-ms-v2', () => {
    expect(HISTOGRAM_KIND).toBe('sparse-ms-v2');
  });

  it('keeps values far above 120 s exactly', () => {
    const h = new Histogram();
    for (const v of [400, 300_700, 1_800_000]) h.accept(v);
    expect(h.overflowCount).toBe(0);
    expect(h.percentile(50)).toBe(300_700);
    expect(h.percentile(100)).toBe(1_800_000);
    expect(h.exact).toBe(true);
  });

  it('answers percentile(p) as the nearest-rank value of the sorted data', () => {
    const h = new Histogram();
    const values = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
    for (const v of values) h.accept(v);
    expect(h.percentile(99.9)).toBe(999);   // not 1000
    expect(h.percentile(0)).toBe(1);
    expect(h.percentile(100)).toBe(1000);
  });

  it('answers undefined for an empty histogram', () => {
    expect(new Histogram().percentile(50)).toBeUndefined();
  });

  it('round-trips v2 bytes exactly, including huge values', () => {
    const h = new Histogram();
    for (const v of [0, 1, 1, 2_147_483_647, 1_800_000]) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    expect(sorted(back)).toEqual(sorted(h));
    expect([back.total, back.sum, back.min, back.max]).toEqual([h.total, h.sum, h.min, h.max]);
    expect(back.exact).toBe(true);
    expect(h.serialize()[0]).toBe(2);
  });

  it('still reads v1 bytes, and marks them not exact', () => {
    // A v1 histogram as written before this PR: version 1, cap 120000, one
    // value 500 and one overflowed 300000.
    const legacy = Histogram.legacyV1ForTests([500, 300_000]);
    const back = Histogram.deserialize(legacy);
    expect(back.exact).toBe(false);
    expect(back.overflowCount).toBe(1);
    expect(back.percentile(50)).toBe(500);
    expect(back.percentile(100)).toBeUndefined(); // hidden in the overflow bin
  });

  it('refuses to serialize a legacy histogram that overflowed', () => {
    const back = Histogram.deserialize(Histogram.legacyV1ForTests([300_000]));
    expect(() => back.serialize()).toThrow(/overflow/);
  });

  it('merges exactly: any split merged equals the whole', () => {
    const values = Array.from({ length: 5000 }, (_, i) => Math.floor(((i * 7919) % 4096) ** 1.3));
    const whole = new Histogram();
    for (const v of values) whole.accept(v);
    for (const parts of [2, 3, 7]) {
      const merged = new Histogram();
      for (let k = 0; k < parts; k++) {
        const part = new Histogram();
        values.filter((_, i) => i % parts === k).forEach((v) => part.accept(v));
        merged.merge(part);
      }
      for (const p of [0, 25, 50, 90, 95, 99, 99.9, 100]) {
        expect(merged.percentile(p), `parts=${parts} p=${p}`).toBe(whole.percentile(p));
      }
      expect(merged.sum).toBe(whole.sum);
    }
  });

  it('matches a sorting oracle on heavy-tailed, bimodal and tied data', () => {
    const shapes: Record<string, number[]> = {
      ties: Array(500).fill(42) as number[],
      single: [7],
      bimodal: [...Array(300).fill(20), ...Array(30).fill(4000)] as number[],
      heavy: Array.from({ length: 2000 }, (_, i) => Math.floor(10 / (1 - i / 2001) ** 2)),
    };
    for (const [name, values] of Object.entries(shapes)) {
      const h = new Histogram();
      values.forEach((v) => h.accept(v));
      const s = [...values].sort((a, b) => a - b);
      for (const p of [0, 1, 7, 50, 75, 90, 95, 99, 99.9, 100]) {
        const idx = Math.min(s.length, Math.max(1, Math.ceil(Math.round(p * 10) * s.length / 1000))) - 1;
        expect(h.percentile(p), `${name} p${p}`).toBe(s[idx]);
      }
    }
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run packages/statistics/test/histogram.test.ts`
Expected: FAIL — `HISTOGRAM_KIND` is `'sparse-ms-v1'`, `percentile` / `exact` / `legacyV1ForTests` do not exist.

- [ ] **Step 7: Implement the v2 histogram**

In `packages/statistics/src/histogram.ts`:

1. `export const HISTOGRAM_KIND = 'sparse-ms-v2' as const;`
2. Replace `DEFAULT_HISTOGRAM_CAP_MS` and its comment with:

```ts
/**
 * Histograms written before 2026-10-15 (`sparse-ms-v1`) folded observations
 * above this into one overflow bin. New histograms are uncapped: a sparse
 * 1 ms structure costs one entry per DISTINCT observed value, so a 300 s
 * group duration costs the same as a 3 ms response. Kept only to read v1.
 */
export const LEGACY_V1_CAP_MS = 120_000;
```

3. Change the fields and constructor so a new histogram has no cap:

```ts
  #capMs: number = Number.POSITIVE_INFINITY;
  #exact = true;
  // ...existing #bins, #total, #sum, #min, #max, #overflowCount unchanged

  constructor() {}

  /** True unless this histogram was read from `sparse-ms-v1` bytes. */
  get exact(): boolean { return this.#exact; }
```

`accept`, `merge`, `countAt`, `entries`, `countBelow`, `sumOfSquares`, `snapshot` stay as they are (the cap comparison is never true for a new histogram). In `merge`, add `if (!other.#exact) this.#exact = false;` and take `this.#capMs = Math.min(this.#capMs, other.#capMs)`.

4. Replace `quantile(q)` with:

```ts
  /**
   * The nearest-rank value at percentile `p` (0–100), exactly — see
   * `nearestRankIndex`. `undefined` when empty, or when a LEGACY v1 overflow
   * bin hides the rank (that value is unrecoverable, and an absent key is
   * the honest answer; `StatisticsTable` already renders it as a dash).
   */
  percentile(p: number): number | undefined {
    const index = nearestRankIndex(p, this.#total);
    if (index < 0) return undefined;
    if (index >= this.#total - this.#overflowCount) return undefined;
    let seen = 0;
    for (const [value, count] of this.entries()) {
      seen += count;
      if (seen > index) return value;
    }
    return this.max;
  }
```

Import `nearestRankIndex` from `./rank.js`.

5. Replace `serialize` and `deserialize`:

```ts
  /** Always `sparse-ms-v2`: version 2, entries, total, sum, min, max. */
  serialize(): Uint8Array {
    if (this.#overflowCount > 0) {
      throw new Error('Histogram: a legacy v1 histogram with an overflow bin cannot be re-serialized');
    }
    const out: number[] = [2];
    const sorted = [...this.entries()];
    writeUvarint(out, sorted.length);
    let prev = 0;
    for (const [v, c] of sorted) {
      writeUvarint(out, v - prev);
      writeUvarint(out, c);
      prev = v;
    }
    writeUvarint(out, this.#total);
    writeUvarint(out, this.#sum);
    writeUvarint(out, this.#total === 0 ? 0 : this.#min);
    writeUvarint(out, this.#total === 0 ? 0 : this.#max);
    return Uint8Array.from(out);
  }

  static deserialize(buf: Uint8Array): Histogram {
    const pos = { i: 0 };
    const version = buf[pos.i++];
    if (version !== 1 && version !== 2) throw new Error(`Histogram: unsupported version ${String(version)}`);
    const h = new Histogram();
    if (version === 1) {
      h.#capMs = readUvarint(buf, pos);
      h.#exact = false;
    }
    const n = readUvarint(buf, pos);
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = prev + readUvarint(buf, pos);
      h.#bins.set(v, readUvarint(buf, pos));
      prev = v;
    }
    h.#total = readUvarint(buf, pos);
    h.#sum = readUvarint(buf, pos);
    h.#overflowCount = version === 1 ? readUvarint(buf, pos) : 0;
    const min = readUvarint(buf, pos);
    const max = readUvarint(buf, pos);
    h.#min = h.#total === 0 ? Number.POSITIVE_INFINITY : min;
    h.#max = h.#total === 0 ? Number.NEGATIVE_INFINITY : max;
    return h;
  }

  /** Test-only: the exact v1 bytes the pre-2026-10-15 writer produced. */
  static legacyV1ForTests(values: readonly number[]): Uint8Array {
    const bins = new Map<number, number>();
    let overflow = 0, sum = 0, min = Infinity, max = -Infinity;
    for (const raw of values) {
      const v = Math.max(0, Math.round(raw));
      sum += v; min = Math.min(min, v); max = Math.max(max, v);
      if (v > LEGACY_V1_CAP_MS) overflow++; else bins.set(v, (bins.get(v) ?? 0) + 1);
    }
    const out: number[] = [1];
    writeUvarint(out, LEGACY_V1_CAP_MS);
    const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
    writeUvarint(out, sorted.length);
    let prev = 0;
    for (const [v, c] of sorted) { writeUvarint(out, v - prev); writeUvarint(out, c); prev = v; }
    writeUvarint(out, values.length);
    writeUvarint(out, sum);
    writeUvarint(out, overflow);
    writeUvarint(out, values.length === 0 ? 0 : min);
    writeUvarint(out, values.length === 0 ? 0 : max);
    return Uint8Array.from(out);
  }
```

6. Update `countBelow`'s error message to name the legacy cap: `` `Histogram: countBelow(${boundMs}) crosses the legacy ${this.#capMs}ms overflow bin …` `` (behaviour unchanged).

- [ ] **Step 8: Fix every `quantile(` caller of `Histogram`**

Run: `grep -rn "\.quantile(" packages apps --include=*.ts | grep -v /dist/ | grep -v Sketch`
For each `Histogram` caller replace `h.quantile(p / 100)` with `h.percentile(p)`, and handle `undefined` as "absent". `window.ts`'s `recoverablePercentiles` becomes:

```ts
function recoverablePercentiles(all: Histogram, percentiles: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of percentiles) {
    const value = all.percentile(p);
    if (value !== undefined) out[`p${p}`] = value; // absent, never 0, for a legacy overflowed rank
  }
  return out;
}
```

Keep its docstring's first paragraph and replace the rest with two lines: new histograms never overflow; legacy v1 rows can, and their hidden ranks stay absent.

Callers of `DEFAULT_HISTOGRAM_CAP_MS` (`grep -rn DEFAULT_HISTOGRAM_CAP_MS packages apps --include=*.ts`) switch to `LEGACY_V1_CAP_MS`; in `apps/api/src/metrics/metrics.controller.ts`'s `bandsOrRefuse` message say "the legacy 120000ms histogram cap of runs ingested before 2026-10-15".

- [ ] **Step 9: Run the statistics suite**

Run: `pnpm vitest run packages/statistics`
Expected: PASS. Existing histogram cases written against `quantile(q)` are rewritten to `percentile(p)` with the same expectations; cases asserting a throw on overflow now assert `undefined` from `percentile` (overflow only exists on v1 bytes — build them with `legacyV1ForTests`).

- [ ] **Step 10: Commit**

```bash
git add packages/statistics/src/rank.ts packages/statistics/src/histogram.ts packages/statistics/src/window.ts packages/statistics/src/index.ts packages/statistics/test/rank.test.ts packages/statistics/test/histogram.test.ts apps/api/src/metrics/metrics.controller.ts
git commit -F - <<'MSG'
Make the histogram uncapped and its percentiles exact

nearestRankIndex computes the rank on integers: the floating-point
Math.ceil(p / 100 * n) returned the 1000th value for p99.9 over 1,000
and the 8th for p7 over 100 (measured). New histograms are
sparse-ms-v2 with no overflow bin; v1 bytes stay readable and are
marked not exact.
MSG
```

---

### Task 2: Rollups, buckets and Gatling assertions on histograms

**Files:**
- Modify: `packages/statistics/src/rollup.ts`, `packages/statistics/src/buckets.ts`, `packages/statistics/src/bucket-latency.ts`, `packages/statistics/src/tool-assertions.ts`, `packages/statistics/src/engine.ts` (comments only), `apps/worker/src/live/fold-owner.ts` (comment only)
- Test: `packages/statistics/test/rollup.test.ts`, `packages/statistics/test/bucket-latency.test.ts`, `packages/statistics/test/parity.test.ts`, `packages/statistics/test/tool-assertions.test.ts`, `packages/statistics/test/chunk-invariance.test.ts`

**Interfaces:**
- Consumes: `Histogram#percentile`, `Histogram#merge`, `Histogram#sumOfSquares` (Task 1).
- Produces: `StatRollup` WITHOUT `sketch` (fields: scope, name, family, count, okCount, koCount, errorRate, minMs, maxMs, meanMs, stddevMs, percentiles, throughputRps, histogramOk, histogramKo); `Bucket` WITHOUT `sketch`, `sketchOk`, `sketchKo`; `bucketLatency(b: Pick<Bucket, 'histogramOk' | 'histogramKo'>): BucketLatency` (same `BucketLatency` shape); exported helper `mergedHistogram(ok: Histogram, ko: Histogram): Histogram` in `rollup.ts`.

- [ ] **Step 1: Write the failing tests**

In `packages/statistics/test/parity.test.ts` (which already has `events` and `result` at the top, and a PT-G-12 block with a float-formula `truth`):

1. In the PT-G-12 block, replace `truth` with `const truth = (p: number) => durations[nearestRankIndex(p, durations.length)]!;` (import `nearestRankIndex` from `../src/rank.js`), call it with `p` rather than `p / 100`, and change "within 1% relative" to `toBe(truth(p))` — exact equality, case renamed "equals the true nearest-rank percentile".
2. Add a case over every request row. The engine keys a request row by `[...e.groups, e.name].join('/')` (`engine.ts:321`):

```ts
it('reports every run and request percentile as the exact nearest-rank value', () => {
  const requests = events.filter((e): e is Extract<typeof e, { type: 'request' }> => e.type === 'request');
  const durationsFor = (row: (typeof result.stats)[number]): number[] =>
    requests
      .filter((e) => row.scope === 'run' || [...e.groups, e.name].join('/') === row.name)
      .map((e) => e.endMs - e.startMs)
      .sort((a, b) => a - b);
  const rows = result.stats.filter((s) => s.family === 'response_time' && (s.scope === 'run' || s.scope === 'request'));
  expect(rows.length).toBeGreaterThan(1); // the run row plus at least one request
  for (const row of rows) {
    const values = durationsFor(row);
    expect(values.length, `${row.scope}/${row.name}`).toBe(row.count);
    for (const [key, value] of Object.entries(row.percentiles)) {
      expect(value, `${row.scope}/${row.name} ${key}`).toBe(values[nearestRankIndex(Number(key.slice(1)), values.length)]);
    }
  }
});
```

In `packages/statistics/test/rollup.test.ts`:

```ts
it('has no sketch and derives mean and population stddev from the histograms', () => {
  const b = new RollupBuilder();
  for (const v of [10, 20, 30, 40]) b.add(v, true);
  b.add(1000, false);
  const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 99.9] });
  expect('sketch' in r).toBe(false);
  expect(r.meanMs).toBe(220);
  expect(r.stddevMs).toBeCloseTo(Math.sqrt((100 + 400 + 900 + 1600 + 1_000_000) / 5 - 220 ** 2), 9);
  expect(r.percentiles).toEqual({ p50: 30, 'p99.9': 1000 });
});

it('keeps a five-minute group duration exact', () => {
  const b = new RollupBuilder();
  b.add(300_700, true);
  const r = b.finish({ scope: 'group', name: 'Browse', family: 'group_duration', windowMs: 1000, percentiles: [50] });
  expect(r.percentiles.p50).toBe(300_700);
});
```

In `packages/statistics/test/bucket-latency.test.ts`:

```ts
it('answers {} for an empty population and exact values otherwise', () => {
  const okOnlyKo = { histogramOk: new Histogram(), histogramKo: new Histogram() };
  okOnlyKo.histogramKo.accept(401);
  okOnlyKo.histogramKo.accept(403);
  const lat = bucketLatency(okOnlyKo);
  expect(lat.percentilesOk).toEqual({});
  expect(lat.percentilesKo.p50).toBe(401);
  expect(lat.minMs).toBe(401);
  expect(lat.maxMs).toBe(403);
  expect(lat.meanMs).toBe(402);
  expect(Object.values(lat.percentiles).every(Number.isFinite)).toBe(true);
});

it('answers zeros and {} for a bucket that saw nothing', () => {
  const lat = bucketLatency({ histogramOk: new Histogram(), histogramKo: new Histogram() });
  expect(lat).toEqual({ minMs: 0, maxMs: 0, meanMs: 0, percentiles: {}, percentilesOk: {}, percentilesKo: {} });
});
```

In `packages/statistics/test/tool-assertions.test.ts`, change the reference-run p99 assertion that expected the clamped value `2503` to the exact nearest-rank value computed from the sorted durations (PT-G-12's true p99, `2501`).

In `packages/statistics/test/chunk-invariance.test.ts`, extend the existing live-vs-batch comparison to require `toEqual` on every rollup's `percentiles` and every bucket's `bucketLatency(...)` (exact equality, not tolerance).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/statistics`
Expected: FAIL — rollups still carry `sketch`, percentiles are sketch estimates (`2503` not `2501`, p50 not exact), `bucketLatency` reads sketches.

- [ ] **Step 3: Implement**

`packages/statistics/src/rollup.ts`:

```ts
import type { MetricFamily, MetricScope } from '@perfportal/core';
import { Histogram } from './histogram.js';

export interface StatRollup {
  scope: MetricScope;
  name: string;
  family: MetricFamily;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  /** Exact nearest-rank values over both statuses, at the configured set. */
  percentiles: Record<string, number>;
  throughputRps: number;
  /** Exact 1 ms histograms by status; their merge is the all-responses population. */
  histogramOk: Histogram;
  histogramKo: Histogram;
}

/** A fresh merge of both statuses — never mutates either input. */
export function mergedHistogram(ok: Histogram, ko: Histogram): Histogram {
  const all = new Histogram();
  all.merge(ok);
  all.merge(ko);
  return all;
}

/** Percentiles of a histogram at a set, omitting ranks it cannot answer. */
export function percentilesOf(h: Histogram, set: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of set) {
    const v = h.percentile(p);
    if (v !== undefined) out[`p${p}`] = v;
  }
  return out;
}

export class RollupBuilder {
  #histOk = new Histogram();
  #histKo = new Histogram();

  add(durationMs: number, ok: boolean): void {
    if (ok) this.#histOk.accept(durationMs); else this.#histKo.accept(durationMs);
  }

  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
    /** Copy the histograms for a live fold that keeps accumulating after the snapshot. */
    clone?: boolean;
  }): StatRollup {
    const all = mergedHistogram(this.#histOk, this.#histKo);
    const count = all.total;
    const okCount = this.#histOk.total;
    const mean = count === 0 ? 0 : all.sum / count;
    const variance = count === 0 ? 0 : Math.max(0, all.sumOfSquares() / count - mean * mean);
    const copy = (h: Histogram): Histogram => {
      const c = new Histogram();
      c.merge(h);
      return c;
    };
    return {
      scope: opts.scope,
      name: opts.name,
      family: opts.family,
      count,
      okCount,
      koCount: count - okCount,
      errorRate: count === 0 ? 0 : (count - okCount) / count,
      minMs: all.min,
      maxMs: all.max,
      meanMs: mean,
      stddevMs: Math.sqrt(variance),
      percentiles: percentilesOf(all, opts.percentiles),
      throughputRps: opts.windowMs === 0 ? 0 : (count / opts.windowMs) * 1000,
      histogramOk: opts.clone ? copy(this.#histOk) : this.#histOk,
      histogramKo: opts.clone ? copy(this.#histKo) : this.#histKo,
    };
  }
}
```

Note: `Histogram#accept` rounds to whole ms. Gatling durations are already whole ms (`endMs - startMs` of integer timestamps), so mean and min/max are unchanged for real data; the old Welford over raw values is gone on purpose — one source for every figure.

`packages/statistics/src/buckets.ts`: delete the `sketch`, `sketchOk`, `sketchKo` fields from `Bucket`, their creation in `add`, the three `accept` lines and the three `merge` lines in `#coalesce`, and the `Sketch` import. Keep the START-edge comment, re-pointed at the histograms ("Histograms are fed on the START edge, not the end, to match Gatling …").

`packages/statistics/src/bucket-latency.ts`:

```ts
import type { Bucket } from './buckets.js';
import { BUCKET_PERCENTILES } from './engine.js';
import { mergedHistogram, percentilesOf } from './rollup.js';

export interface BucketLatency {
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
  percentilesOk: Record<string, number>;
  percentilesKo: Record<string, number>;
}

/**
 * THE ONLY derivation of a bucket's latency fields — `MetricWriter` persists
 * these and `buildDelta` publishes them, so the live chart and the final
 * report cannot disagree. An empty population answers {} (a p95 of 0 would be
 * a fabricated observation); min/max/mean answer 0 because the columns are
 * NOT NULL.
 */
export function bucketLatency(b: Pick<Bucket, 'histogramOk' | 'histogramKo'>): BucketLatency {
  const all = mergedHistogram(b.histogramOk, b.histogramKo);
  return {
    minMs: all.min,
    maxMs: all.max,
    meanMs: all.total === 0 ? 0 : all.sum / all.total,
    percentiles: percentilesOf(all, BUCKET_PERCENTILES),
    percentilesOk: percentilesOf(b.histogramOk, BUCKET_PERCENTILES),
    percentilesKo: percentilesOf(b.histogramKo, BUCKET_PERCENTILES),
  };
}
```

`packages/statistics/src/tool-assertions.ts`, the `percentile` case:

```ts
        // Exact, from both statuses' histograms — Gatling's assertion reads the
        // all-responses population. Arbitrary ranks (99.9) are answerable
        // because the histograms are kept, not only the configured columns.
        case 'percentile':
          return mergedHistogram(row.histogramOk, row.histogramKo).percentile(target.rank ?? 0) ?? null;
```

Remove the `clampPercentile` import there. Replace the long clamp comment above the case with the three lines shown.

`engine.ts` and `fold-owner.ts`: update comments that say "sketches" to "histograms" (no behaviour change). `grep -n -i sketch packages/statistics/src/engine.ts apps/worker/src/live/fold-owner.ts` must return no match when done.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run packages/statistics`
Expected: PASS. `clamped-quantiles.test.ts` will fail on the removed `clampPercentile` call sites — fix it in Task 4 Step 6; if it fails here only because a call site no longer exists, mark that file's assertion list in the same way now (remove the deleted sites from its expectations).

- [ ] **Step 5: Typecheck the dependents**

Run: `pnpm typecheck`
Expected: errors only in `packages/sla`, `packages/persistence/src/metrics/write.ts` and readers (fixed in Tasks 3 and 4). No error may remain in `packages/statistics` or `apps/worker`.

- [ ] **Step 6: Commit**

```bash
git add packages/statistics/src packages/statistics/test apps/worker/src/live/fold-owner.ts
git commit -F - <<'MSG'
Derive every rollup and bucket figure from exact histograms

RollupBuilder and BucketSeries drop their DDSketches. Percentiles are
nearest-rank over the merged status histograms; mean and population
standard deviation come from the same histogram, so a row describes one
set of values. G-05 assertions read the same histograms.
MSG
```

---

### Task 3: SLA evaluation on histograms

**Files:**
- Modify: `packages/sla/src/metrics.ts`, `packages/sla/src/stats.ts`
- Test: `packages/sla/test/evaluate.test.ts` (or the file that tests `resolveMetric`; `grep -rln resolveMetric packages/sla/test`)

**Interfaces:**
- Consumes: `StatRollup.histogramOk/histogramKo`, `mergedHistogram` (Task 2).
- Produces: `EvaluableStat.histogram?: Histogram` (all-responses) replacing `sketch?: Sketch`.

- [ ] **Step 1: Write the failing test**

```ts
import { Histogram } from '@perfportal/statistics';
import { resolveMetric, type EvaluableStat } from '../src/metrics.js';

it('answers a percentile outside the stored set exactly from the histogram', () => {
  const h = new Histogram();
  for (let v = 1; v <= 1000; v++) h.accept(v);
  const stat: EvaluableStat = {
    scope: 'run', name: '', family: 'response_time', count: 1000, okCount: 1000, koCount: 0,
    errorRate: 0, minMs: 1, maxMs: 1000, meanMs: 500.5, stddevMs: 0, throughputRps: 0,
    percentiles: { p50: 500 }, histogram: h,
  };
  expect(resolveMetric(stat, 'p99.9')).toBe(999);
  expect(resolveMetric(stat, 'p50')).toBe(500);
});

it('answers null for a percentile when no histogram and no stored value exist', () => {
  const stat = { scope: 'run', name: '', family: 'response_time', count: 0, okCount: 0, koCount: 0,
    errorRate: 0, minMs: 0, maxMs: 0, meanMs: 0, stddevMs: 0, throughputRps: 0, percentiles: {} } satisfies EvaluableStat;
  expect(resolveMetric(stat, 'p95')).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/sla`
Expected: FAIL — `histogram` is not a property of `EvaluableStat` (typecheck in the test file) or `p99.9` resolves via the sketch path to `null`.

- [ ] **Step 3: Implement**

`packages/sla/src/metrics.ts`: import `type Histogram` instead of `clampPercentile, type Sketch`; replace the `sketch?: Sketch` field with

```ts
  /** All-responses exact histogram, for percentiles outside the stored set. */
  histogram?: Histogram;
```

and the tail of `resolveMetric` with

```ts
  const stored = stat.percentiles[metric];
  if (stored !== undefined) return stored;
  const p = Number(m[1]);
  return stat.histogram?.percentile(p) ?? null;
```

Rewrite the docstring paragraph above `resolveMetric` to say the fallback is the exact histogram.

`packages/sla/src/stats.ts`: replace `sketch: s.sketch,` with `histogram: mergedHistogram(s.histogramOk, s.histogramKo),` and import `mergedHistogram` from `@perfportal/statistics`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/sla`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sla/src packages/sla/test
git commit -F - <<'MSG'
Judge SLA rules on exact histogram percentiles

resolveMetric answers a percentile outside the stored set from the
all-responses histogram instead of a clamped sketch estimate.
MSG
```

---

### Task 4: Persistence — migration, writer, readers, shared recomputation

**Files:**
- Create: `packages/persistence/prisma/migrations/20261015120000_exact_statistics/migration.sql`, `packages/statistics/src/stored-percentiles.ts`
- Modify: `packages/persistence/prisma/schema.prisma`, `packages/persistence/src/metrics/write.ts`, `packages/persistence/src/metrics/read.ts`, `packages/persistence/src/metrics/trends.ts`, `packages/persistence/src/repositories/run.ts` (RunRecord), `packages/statistics/src/index.ts`, `packages/statistics/test/clamped-quantiles.test.ts`
- Test: `packages/statistics/test/stored-percentiles.test.ts` (new), `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Consumes: `Histogram` v2/v1, `mergedHistogram`, `percentilesOf` (Tasks 1–2).
- Produces: `storedPercentiles(row: StoredPercentileSource, set: readonly number[]): Record<string, number>` where

```ts
export interface StoredPercentileSource {
  count: number;
  minMs: number;
  maxMs: number;
  /** The frozen column written at ingest. */
  percentiles: Record<string, number>;
  histogramOk: Histogram | null;
  histogramKo: Histogram | null;
  /** Legacy rows only (written before 2026-10-15). */
  sketch: { count: number; quantile(q: number): number } | null;
}
```

  and `RunRecord.statsMethod: 'estimated' | 'exact-v1'`; read rows (`StatRow` in `read.ts`, the trend row in `trends.ts`) carry `histogramOk`, `histogramKo` and a nullable `sketch`.

- [ ] **Step 1: Write the failing unit test for the shared rule**

`packages/statistics/test/stored-percentiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Histogram, Sketch, storedPercentiles } from '../src/index.js';

const exactRow = () => {
  const ok = new Histogram();
  for (let v = 1; v <= 1000; v++) ok.accept(v);
  return { count: 1000, minMs: 1, maxMs: 1000, percentiles: { p50: 500 }, histogramOk: ok, histogramKo: new Histogram(), sketch: null };
};

describe('storedPercentiles', () => {
  it('recomputes an exact (v2) row at any set from its histograms', () => {
    expect(storedPercentiles(exactRow(), [50, 99.9])).toEqual({ p50: 500, 'p99.9': 999 });
  });

  it('keeps the legacy sketch path, clamped, for a pre-2026-10-15 row', () => {
    const s = new Sketch();
    for (let v = 1; v <= 1000; v++) s.accept(v);
    const legacy = {
      count: 1000, minMs: 1, maxMs: 1000, percentiles: { p50: 500 },
      histogramOk: Histogram.deserialize(Histogram.legacyV1ForTests([1, 2, 3])), histogramKo: null,
      sketch: Sketch.deserialize(s.serialize()),
    };
    const out = storedPercentiles(legacy, [99]);
    expect(out.p99).toBeGreaterThanOrEqual(1);
    expect(out.p99).toBeLessThanOrEqual(1000); // clamped, as before
  });

  it('falls back to the frozen column for an empty row or a row with neither source', () => {
    expect(storedPercentiles({ ...exactRow(), count: 0 }, [50])).toEqual({ p50: 500 });
    expect(storedPercentiles({ count: 5, minMs: 1, maxMs: 9, percentiles: { p50: 4 }, histogramOk: null, histogramKo: null, sketch: null }, [50])).toEqual({ p50: 4 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/statistics/test/stored-percentiles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stored-percentiles.ts`**

```ts
import type { Histogram } from './histogram.js';
import { clampPercentile } from './percentile.js';
import { mergedHistogram, percentilesOf } from './rollup.js';

export interface StoredPercentileSource {
  count: number;
  minMs: number;
  maxMs: number;
  percentiles: Record<string, number>;
  histogramOk: Histogram | null;
  histogramKo: Histogram | null;
  sketch: { count: number; quantile(q: number): number } | null;
}

/**
 * Percentiles for a STORED row at the project's current set (spec §4).
 *
 * An exact row (both histograms present and `sparse-ms-v2`) is recomputed
 * from its histograms — exact at any percentile. A row written before
 * 2026-10-15 keeps the legacy path it has always had: its sketch, clamped
 * against its exact extremes, so its numbers do not move until the backfill
 * (PR 2) rewrites it. With neither, or with no observations, the frozen
 * column is the only answer.
 */
export function storedPercentiles(row: StoredPercentileSource, set: readonly number[]): Record<string, number> {
  if (row.count === 0) return row.percentiles;
  const { histogramOk: ok, histogramKo: ko } = row;
  if (ok && ko && ok.exact && ko.exact) return percentilesOf(mergedHistogram(ok, ko), set);
  if (row.sketch && row.sketch.count > 0) {
    const sketch = row.sketch;
    return Object.fromEntries(set.map((p) => [`p${p}`, clampPercentile(sketch.quantile(p / 100), row)]));
  }
  return row.percentiles;
}
```

Export from `packages/statistics/src/index.ts`: `export * from './stored-percentiles.js';`

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/statistics/test/stored-percentiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Migration and schema**

`packages/persistence/prisma/migrations/20261015120000_exact_statistics/migration.sql`:

```sql
-- Exact statistics (docs/superpowers/specs/2026-10-15-exact-statistics-design.md).
-- New rows carry no DDSketch; rows written before keep theirs until the
-- backfill (PR 2) and the clean-up (PR 5).
ALTER TABLE run_stat ALTER COLUMN sketch DROP NOT NULL;
ALTER TABLE run_stat ALTER COLUMN sketch_kind DROP NOT NULL;

-- Existing runs are 'estimated'; the default then flips so every run created
-- from now on is 'exact-v1' without touching any insert statement.
ALTER TABLE run ADD COLUMN stats_method text NOT NULL DEFAULT 'estimated';
ALTER TABLE run ALTER COLUMN stats_method SET DEFAULT 'exact-v1';
ALTER TABLE run ADD CONSTRAINT run_stats_method_check CHECK (stats_method IN ('estimated', 'exact-v1'));
```

No backticks anywhere in SQL comments (they end template literals in this repo's raw SQL; keep the habit in migrations too).

`schema.prisma`: in `RunStat`, `sketch Bytes?` and `sketchKind String? @map("sketch_kind")`; in `Run`, add `statsMethod String @default("exact-v1") @map("stats_method")` beside the other run columns. Do NOT run `prisma format` over the file (it realigns unrelated models).

Run: `pnpm --filter @perfportal/persistence run migrate:deploy` against the scratch database, then `infra/test/schema-matches-migrations.sh` (or the command CI's `test-residue` job runs) — Expected: agree.

- [ ] **Step 6: Writer, readers, RunRecord, guard test**

`write.ts`: in the `run_stat` row, write `null` for `sketch` and `null` for `sketch_kind`; keep `HISTOGRAM_KIND` (now `'sparse-ms-v2'`). Remove the `SKETCH_KIND` import if unused.

`read.ts`: both places that build `sketch:` keep `r.sketch ? Sketch.deserialize(...) : null` (legacy rows). Make sure the rows that feed `/stats` (around line 245–267) and the per-run list (around 320–333) also carry `histogramOk`/`histogramKo` — the first already does; add them to the second's SELECT and mapping if missing.

`trends.ts`: add `t.histogram_ok, t.histogram_ko` / `s.histogram_ok, s.histogram_ko` beside `t.sketch` / `s.sketch` in both SELECT arms, and to the trend row type:

```ts
  readonly histogramOk: Histogram | null;
  readonly histogramKo: Histogram | null;
```

mapped with `Histogram.deserialize(new Uint8Array(row.histogram_ok))` when not null.

`repositories/run.ts`: add `statsMethod: 'estimated' | 'exact-v1'` to `RunRecord` and map it from the Prisma row (`run.statsMethod as RunRecord['statsMethod']`). The list query's p95 clamp (around line 434) stays: it is correct for both kinds.

`packages/statistics/test/clamped-quantiles.test.ts`: the production `.quantile(` call sites are now only the legacy sketch path inside `stored-percentiles.ts` (wrapped in `clampPercentile`). Update the file's `EXEMPT` list and expectations so the guard still requires every `Sketch#quantile` call to be clamped, and add an assertion that no production file calls `Histogram#quantile` (it no longer exists).

- [ ] **Step 7: Integration test — exact rows are written and read back exact**

In `packages/persistence/test/metrics.integration.test.ts` add:

The file already has `seedRun()` (returns `{ orgId, projectId, runId }`, creating the run through Prisma — which now takes the new `exact-v1` default) and `persist(ctx)` (runs the engine and `MetricWriter`). Add:

```ts
it('writes new rows with v2 histograms, no sketch, and an exact-v1 run', async () => {
  const ctx = await seedRun();
  await persist(ctx);
  const { rows } = await pool.query(
    `SELECT sketch, sketch_kind, histogram_kind, get_byte(histogram_ok, 0) AS v FROM run_stat WHERE run_id = $1`, [ctx.runId]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.sketch === null && r.sketch_kind === null && r.histogram_kind === 'sparse-ms-v2' && r.v === 2)).toBe(true);
  const run = await pool.query(`SELECT stats_method FROM run WHERE id = $1`, [ctx.runId]);
  expect(run.rows[0].stats_method).toBe('exact-v1');
});

it('still reads a legacy row (sketch + v1 histogram) through the legacy path', async () => {
  const ctx = await seedRun();
  await pool.query(`UPDATE run SET stats_method = 'estimated' WHERE id = $1`, [ctx.runId]);
  const sketch = new Sketch();
  for (const v of [100, 200, 300]) sketch.accept(v);
  await pool.query(
    `INSERT INTO run_stat (id, run_id, org_id, project_id, scope, name, family, count, ok_count, ko_count,
       error_rate, min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles,
       sketch, sketch_kind, histogram_ok, histogram_ko, histogram_kind)
     VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time', 3, 3, 0,
       0, 100, 300, 200, 81.6, 1, '{"p50":200}', $4, 'ddsketch', $5, $6, 'sparse-ms-v1')`,
    [ctx.runId, ctx.orgId, ctx.projectId, Buffer.from(sketch.serialize()),
     Buffer.from(Histogram.legacyV1ForTests([100, 200, 300])), Buffer.from(Histogram.legacyV1ForTests([]))],
  );
  const { rows } = await pool.query(`SELECT sketch, histogram_ok FROM run_stat WHERE run_id = $1`, [ctx.runId]);
  expect(rows[0].sketch).not.toBeNull();
  expect(Histogram.deserialize(new Uint8Array(rows[0].histogram_ok)).exact).toBe(false);
});
```

Import `Sketch` beside the file's existing `@perfportal/statistics` import.

Run (scratch stores exported): `pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/persistence/prisma packages/persistence/src packages/persistence/test packages/statistics/src/stored-percentiles.ts packages/statistics/src/index.ts packages/statistics/test/stored-percentiles.test.ts packages/statistics/test/clamped-quantiles.test.ts
git commit -F - <<'MSG'
Store exact rows and mark new runs exact-v1

run_stat.sketch becomes nullable and new rows write none; run gains
stats_method ('estimated' for existing rows, 'exact-v1' for new ones).
storedPercentiles is the one rule for recomputing a stored row: exact
from v2 histograms, the unchanged clamped-sketch path for legacy rows.
MSG
```

---

### Task 5: API — `/stats`, trends and run identity

**Files:**
- Modify: `apps/api/src/metrics/metrics.controller.ts`, `apps/api/src/runs/runs.service.ts`, `apps/api/src/runs/runs.controller.ts` (only if the 202 builder does not already spread `lifecycleOf`), `packages/contracts/src/run.ts`, `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/read.integration.test.ts`, `apps/api/test/trends.integration.test.ts`, `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: `storedPercentiles` (Task 4), `RunRecord.statsMethod` (Task 4).
- Produces: `RunIdentity.statsMethod?: 'estimated' | 'exact-v1'` on both identity builders.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/test/contracts.test.ts`:

The file builds a `const base = {…}` object inside each describe (lines ~120, ~162, ~238). Put this case in the describe whose `base` is parsed with `RunIdentitySchema` (or `RunResponseSchema`, which extends it), reusing that `base`:

```ts
it('accepts a run identity with and without statsMethod (rolling deploy)', () => {
  expect(RunIdentitySchema.safeParse({ ...base, statsMethod: 'exact-v1' }).success).toBe(true);
  expect(RunIdentitySchema.safeParse(base).success).toBe(true);
  expect(RunIdentitySchema.safeParse({ ...base, statsMethod: 'sketch' }).success).toBe(false);
});
```

`apps/api/test/read.integration.test.ts`:

The file has `FIXTURE_LOG` (the reference `simulation.log`) and `ingested(extra?)`, which posts the bundle and processes it, returning the run id. Follow the file's existing request helper and auth header for reads (copy the pattern from the case at line ~70). Add:

```ts
import { readFileSync } from 'node:fs';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { nearestRankIndex } from '@perfportal/statistics';

it('serves a new run exactly: /stats percentiles equal nearest-rank values of the raw log', async () => {
  const id = await ingested();
  const values = [...parseSimulationLog(readFileSync(FIXTURE_LOG))]
    .filter((e): e is Extract<typeof e, { type: 'request' }> => e.type === 'request')
    .map((e) => e.endMs - e.startMs)
    .sort((a, b) => a - b);
  const res = await readAs(`/v1/runs/${id}/stats`); // the file's authenticated GET helper; write it from line ~70's pattern if absent
  const runRow = res.body.stats.find((s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time');
  expect(Object.keys(runRow.percentiles).length).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(runRow.percentiles)) {
    expect(value, key).toBe(values[nearestRankIndex(Number(key.slice(1)), values.length)]);
  }
});

it('sends statsMethod on the run in both the 202 and the finished response', async () => {
  const id = await ingested();
  const done = await readAs(`/v1/runs/${id}`);
  expect(done.body.statsMethod).toBe('exact-v1');
  // A run that has not been processed answers through the 202 builder.
  const pendingId = await postWithoutProcessing(); // POST the same bundle with metadata waitMs: 0 and do not drain the queue
  const pending = await readAs(`/v1/runs/${pendingId}`);
  expect(pending.status).toBe(202);
  expect(pending.body.statsMethod).toBe('exact-v1');
});
```

`postWithoutProcessing` is `ingested`'s POST half without the queue drain — split `ingested` into the two halves rather than copying the request.

`apps/api/test/trends.integration.test.ts`: add a case that a legacy row (inserted as in Task 4's `persistLegacyRow`) returns the same percentiles it returned before this PR (compute the expected value with `clampPercentile(sketch.quantile(p / 100), row)` in the test), and an exact row returns nearest-rank values.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts` and `pnpm vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts apps/api/test/trends.integration.test.ts`
Expected: FAIL — unknown key `statsMethod` is stripped / schema lacks it; controller still uses the sketch block.

- [ ] **Step 3: Implement**

`packages/contracts/src/run.ts`, inside `RunIdentitySchema` after `runnerJobId`:

```ts
  /** Whether this run's statistics are exact ('exact-v1') or were estimated
   *  by the pre-2026-10-15 sketch engine ('estimated'). OPTIONAL for the
   *  rolling-deploy reason the stamps above give; a reader treats absent as
   *  "not known to be exact". */
  statsMethod: z.enum(['estimated', 'exact-v1']).optional(),
```

`apps/api/src/runs/runs.service.ts`: add `statsMethod: RunRecord['statsMethod']` to `lifecycleOf`'s return type and `statsMethod: run.statsMethod,` to its returned object. Confirm both builders spread `lifecycleOf`'s result (`grep -n lifecycleOf apps/api/src/runs/*.ts`); if the 202 builder lists fields by hand, add `statsMethod` there too.

`apps/api/src/metrics/metrics.controller.ts`: replace BOTH percentile blocks (trends rows near line 185 and `/stats` near line 275) with

```ts
        percentiles: storedPercentiles(r, settings.percentiles),
```

(use `s` in the second block), import `storedPercentiles` from `@perfportal/statistics`, remove the `clampPercentile` import if now unused, and replace the two long comments with one line each: `// Exact for rows written since 2026-10-15; legacy rows keep the clamped sketch — see storedPercentiles.`

`apps/api/src/openapi/document.ts`: where the `/stats` description says percentiles are recomputed "from the run's stored sketch", say "from the run's stored histograms (exact) or, for runs ingested before 2026-10-15, its stored sketch". Do not add any new response status.

- [ ] **Step 4: Run them to verify they pass**

Run: the same commands as Step 2, plus `pnpm vitest run --config vitest.integration.config.ts apps/api/test/openapi.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/run.ts packages/contracts/test/contracts.test.ts apps/api/src apps/api/test
git commit -F - <<'MSG'
Serve exact percentiles and say which runs are exact

/stats and trends recompute through storedPercentiles; run identity
carries statsMethod on both builders, optional for the rolling deploy.
MSG
```

---

### Task 6: Web — caveats only where figures are estimated

**Files:**
- Modify: `apps/web/src/routes/RunStats.tsx`, `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/src/routes/RunGlossary.tsx`, and the component that renders `StatisticsTable` on the run page (`grep -rn "<StatisticsTable" apps/web/src`)
- Test: `apps/web/test/RunStats.test.tsx`, `apps/web/test/StatisticsTable.test.tsx`, `apps/web/test/RunGlossary.test.tsx`

**Interfaces:**
- Consumes: `RunIdentity.statsMethod` (Task 5).
- Produces: `isExact(statsMethod: RunIdentity['statsMethod']): boolean` in `apps/web/src/routes/statsMethod.ts` (new) — `true` only for `'exact-v1'`; components take a required `exact: boolean` prop where they print a caveat.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/RunStats.test.tsx`:

```ts
it('drops the p95 estimate caveat on an exact run and keeps it on an estimated one', async () => {
  renderStats({ exact: true });
  expect(screen.getByRole('button', { name: /about p95/i })).not.toHaveAccessibleDescription(/estimat|1%/i);
  cleanup();
  renderStats({ exact: false });
  expect(screen.getByRole('button', { name: /about p95/i })).toHaveAccessibleDescription(/within 1%/i);
});
```

If the exact run's p95 tile has no other caveat, the ⓘ is absent entirely — then assert `queryByRole('button', { name: /about p95/i })` is null for the exact case instead.

`apps/web/test/StatisticsTable.test.tsx`: the same pair for the table's percentile caveat (`within 1%` present for `exact={false}`, absent for `exact={true}`).

`apps/web/test/statsMethod.test.ts` (new):

```ts
import { describe, expect, it } from 'vitest';
import { isExact } from '../src/routes/statsMethod.js';

describe('isExact', () => {
  it('is true only for exact-v1; absent (an older API) is not exact', () => {
    expect(isExact('exact-v1')).toBe(true);
    expect(isExact('estimated')).toBe(false);
    expect(isExact(undefined)).toBe(false);
  });
});
```

`apps/web/test/RunGlossary.test.tsx`: the percentile entry's meaning must contain "nearest rank" and must not contain "within 1%".

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/web/test/RunStats.test.tsx apps/web/test/StatisticsTable.test.tsx apps/web/test/statsMethod.test.ts apps/web/test/RunGlossary.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/routes/statsMethod.ts`:

```ts
import type { RunIdentity } from '@perfportal/contracts';

/** Exact only when the API says so; an API that predates the field is not known to be exact. */
export function isExact(statsMethod: RunIdentity['statsMethod']): boolean {
  return statsMethod === 'exact-v1';
}
```

`RunStats.tsx`: the p95 caveat constant (around line 285) is used only when `exact` is false. Thread `exact` from the run identity (the component that renders `RunStats` already has the identity — pass `exact={isExact(identity.statsMethod)}`), required prop, no default (this repo's rule for a prop whose wrong value is silent).

`StatisticsTable.tsx`: the caption text around line 1157 (`'estimates, accurate to within 1%, …'`) is included only when `exact` is false; for an exact run the sentence reads "Percentiles are exact: the value at that rank in the run's own data." Same required-prop rule; update every caller `tsc` names.

`RunGlossary.tsx`: rewrite the percentile/estimate entry: "p95 and the other percentiles are the actual response time at that rank — nearest rank: of n responses, the one at position ⌈p/100 × n⌉. Gatling's own report estimates them with t-digest, so its tail values can differ. Runs processed before exact statistics show an estimate within 1%." Keep the entry's headword(s) that the glossary guard requires to exist in source.

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command, then `pnpm typecheck && pnpm lint`
Expected: PASS, exit 0 each.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -F - <<'MSG'
Show the estimate caveat only on estimated runs

Exact runs lose "within 1%" from the p95 tile and the statistics
table; estimated runs and responses from an older API keep it. The
glossary states the nearest-rank definition.
MSG
```

---

### Task 7: Full gates, real runs, CLAUDE.md, PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Predict the floors**

Count new and removed cases per file (`git diff origin/main --stat` and `grep -c "it(" `on each touched test file before/after) and write the predicted unit, integration and e2e totals down before running anything (this repo's rule: a total is a prediction first).

- [ ] **Step 2: Run every gate on Node 22, scratch stores**

```bash
source ~/.nvm/nvm.sh && nvm use
pnpm build > /tmp/ex-build.txt 2>&1; echo "build=$?"
pnpm typecheck > /tmp/ex-tc.txt 2>&1; echo "typecheck=$?"
pnpm lint > /tmp/ex-lint.txt 2>&1; echo "lint=$?"
pnpm test:unit > /tmp/ex-unit.txt 2>&1; echo "unit=$?"; tail -6 /tmp/ex-unit.txt
pnpm test:integration > /tmp/ex-int.txt 2>&1; echo "integration=$?"; tail -6 /tmp/ex-int.txt
pnpm test:e2e --workers=2 > /tmp/ex-e2e.txt 2>&1; echo "e2e=$?"; tail -6 /tmp/ex-e2e.txt
```

Expected: every exit 0, totals equal the predictions, zero `Errors` lines in the unit output. Read each exit code, never a pipeline's.

- [ ] **Step 3: Real runs**

With the API and worker from this branch on their own Redis index:
1. Ingest the 2026-10-15 `BasicSimulation` log (`~/Downloads/gatling-gradle-plugin-demo-kotlin-main/build/reports/gatling/basicsimulation-20261015162147567/simulation.log`) through `POST /v1/runs`.
2. Run the three-way comparison script from the research session (raw log vs `/stats` vs Gatling's HTML report). Expected: every count, min, max equal; every PerfPortal percentile EQUAL to the raw nearest-rank value (previously 206.46 vs 205, 671.94 vs 671); mean equal to two decimals.
3. One live run through the Gradle plugin (token with the `stream` scope) and one on-prem runner run: `GET /v1/runs/{id}` reports `statsMethod: 'exact-v1'`, and the live tiles' final values equal the finished page's.

- [ ] **Step 4: CLAUDE.md entry**

Add an entry at the top of the Verification section in this repository's style: what changed (exact engine, v2 histograms, `stats_method`), the measured float-rank defect (p99.9 over 1,000, p7 over 100), the legacy path, what was run (each gate's total and exit code), the real-run comparison numbers, and the new floors.

- [ ] **Step 5: Commit, push, PR**

```bash
git add CLAUDE.md
git commit -F - <<'MSG'
Record the exact-statistics engine in CLAUDE.md
MSG
git push -u origin feat/exact-statistics-engine
gh pr create --base main --title "Exact statistics, PR 1: exact engine" --body-file /tmp/pr1-body.md
```

The PR body lists the spec, the five-PR delivery, what this PR changes for new and legacy runs, the gates with totals, and the real-run comparison. Merge only on a SHA-pinned green read (CLAUDE.md's `before`/`after` `headRefOid` check), with `--merge`.

---

## Self-review notes

- Spec §2 rules → Tasks 1–3 (rank, mean, population stddev, empty populations, SLA full precision). Display rounding is unchanged (`roundForReading`) and needs no task.
- Spec §3 data model → Task 4 (nullable sketch, `stats_method`, v2 kind). `run_verification`, `run_verdict_change` and retention belong to PRs 2–3 by the spec's own §9.
- Spec §4 engine → Tasks 1–3 and 5. `clampPercentile` stays for the legacy read path only, until PR 5 drops sketches; the browser clamp in `apps/web/src/percentile.ts` stays for the same legacy rows and is removed with the backfill (PR 2). This is the one refinement of the spec: removing them now would change estimated runs' numbers before the backfill rewrites them.
- Spec §7 copy removal → Task 6, conditional on `statsMethod` so estimated runs keep their caveat until PR 2 adds the ≈ labels.
