# Time-Window Re-aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** narrowing the time range recomputes every statistic over the sub-range, the way Gatling Enterprise's brush does — not a redrawn axis.

**Architecture:** Each series bucket persists an OK and a KO `Histogram`. A window is answered by merging the histograms whose `start_offset_ms` falls in the snapped range and reading every column off the merged result — exactly, at 1 ms resolution. The charts window by a `WHERE` on the same column.

**Tech Stack:** TypeScript, pnpm workspaces, Postgres + Prisma (raw `pg` for metrics), NestJS, Zod contracts, React 18.3.1 + ECharts, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-time-window-re-aggregation-design.md`

## Global Constraints

- **Node 22** (`.nvmrc`). `nvm use` first. A unit run reporting fewer than **76 files / 862 tests** did not run everything.
- Gate, integration **before** e2e: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
- Branch `feat/time-window-reaggregation`, already created from `main` at `6445d26`. One PR back to `main`, merged with `--merge`, never squashed.
- **Expectations are computed from the payload, never written down.**
- **Histogram percentiles must use the nearest-rank convention `sorted[ceil(q·n) − 1]`** — what `Sketch#quantile` re-expresses its query to hit, and what every ground-truth computation in this repo uses.
- **The window is fed on the START edge**, where the bucket sketches already are. A windowed row describes requests that *started* in the window.
- `run_started_on = $1` stays the first predicate of every bucket query. It is the partition key; without it Postgres scans every partition.
- **No `uppercase` on anything queried by accessible name**; **no decorative `<svg>` inside a chart `<figure>`**; a token not in `@theme` produces no utility, silently.
- `getByRole(role, { name })` is exact in Testing Library, a case-insensitive substring in Playwright — `exact: true` wherever a fallback could collide.

## File Structure

| File | Responsibility |
|---|---|
| `packages/statistics/src/histogram.ts` | `quantile` and `sumOfSquares` — exact walks over `entries()`. |
| `packages/statistics/src/buckets.ts` | `Bucket` gains `histogramOk`/`histogramKo`; `#coalesce` merges them. |
| `packages/statistics/src/engine.ts` | Feeds both on the start edge, beside the sketches. |
| `packages/persistence/prisma/migrations/20260816120000_bucket_histograms/` | Two nullable BYTEA columns. |
| `packages/persistence/src/metrics/write.ts` | Writes them. |
| `packages/persistence/src/metrics/read.ts` | `WINDOWED_BUCKETS_SQL` + `windowedBuckets()` + `isWindowable()`. |
| `packages/statistics/src/window.ts` *(new)* | `rollupFromHistograms()` — merged histograms → a `StatRollup`-shaped row. |
| `packages/contracts/src/metrics.ts` | `WindowSchema`; `window` on the windowable responses; `windowable` on the run. |
| `apps/api/src/metrics/metrics.controller.ts` | Range parsing, validation, snapping; windowed `/stats` and the rest. |
| `apps/api/test/window.bench.test.ts` *(new)* | The §9 budget. |
| `apps/web/src/routes/window.ts` *(new)* | `?from=&to=` parse/serialise, mirroring `compareSelection.ts`. |
| `apps/web/src/charts/TimeBrush.tsx` *(new)* | The control. |

---

### Task 1: `Histogram.quantile` and `sumOfSquares`

**Files:**
- Modify: `packages/statistics/src/histogram.ts`
- Modify: `packages/statistics/test/histogram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Histogram#quantile(q: number): number`, `Histogram#sumOfSquares(): number`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/statistics/test/histogram.test.ts`:

```ts
import { Sketch } from '../src/sketch.js';

describe('Histogram#quantile', () => {
  /** Ground truth, the nearest-rank convention this repo uses everywhere. */
  const trueQuantile = (sorted: number[], q: number): number =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;

  const sample = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 1_000; i += 1) out.push(1 + ((i * 37) % 900));
    return out;
  };

  it('is exact, unlike the sketch it will replace in a window', () => {
    const values = sample();
    const h = new Histogram();
    for (const v of values) h.accept(v);
    const sorted = [...values].sort((a, b) => a - b);

    for (const q of [0.5, 0.75, 0.95, 0.99]) {
      // EXACT, not within RELATIVE_ACCURACY. 1ms bins and integer inputs mean
      // there is no error term at all to allow for.
      expect(h.quantile(q)).toBe(trueQuantile(sorted, q));
    }
  });

  it('uses the same rank convention as Sketch#quantile', () => {
    // A histogram quantile on the linear-interpolation convention would land
    // one rank away from the full-run value on identical data — a discrepancy
    // that looks like a windowing bug and is not one.
    const values = sample();
    const h = new Histogram();
    const s = new Sketch();
    for (const v of values) { h.accept(v); s.accept(v); }

    for (const q of [0.5, 0.95, 0.99]) {
      const relative = Math.abs(h.quantile(q) - s.quantile(q)) / h.quantile(q);
      expect(relative).toBeLessThanOrEqual(0.01);   // RELATIVE_ACCURACY
    }
  });

  it('answers the boundary ranks with min and max', () => {
    const h = new Histogram();
    for (const v of [5, 10, 20, 40]) h.accept(v);
    expect(h.quantile(0)).toBe(h.min);
    expect(h.quantile(1)).toBe(h.max);
  });

  it('returns NaN for an empty histogram rather than a fabricated 0', () => {
    expect(Number.isNaN(new Histogram().quantile(0.95))).toBe(true);
  });

  it('throws rather than guess when the rank lands in the overflow bin', () => {
    // Same stance as countBelow: an unrecoverable answer is refused, never
    // approximated. At a 120s cap this is theoretical, which is exactly why
    // it must not be silent.
    const h = new Histogram({ capMs: 100 });
    for (let i = 0; i < 10; i += 1) h.accept(10);
    for (let i = 0; i < 90; i += 1) h.accept(5_000);   // all overflow
    expect(() => h.quantile(0.95)).toThrow(/overflow/i);
  });

  it('survives a serialize round trip', () => {
    const h = new Histogram();
    for (const v of sample()) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    for (const q of [0.5, 0.95, 0.99]) expect(back.quantile(q)).toBe(h.quantile(q));
  });
});

describe('Histogram#sumOfSquares', () => {
  it('gives an exact standard deviation over a merged set', () => {
    const values = [3, 5, 5, 9, 11, 20, 20, 20];
    const h = new Histogram();
    for (const v of values) h.accept(v);

    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const expected = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

    const variance = h.sumOfSquares() / h.total - (h.sum / h.total) ** 2;
    expect(Math.sqrt(variance)).toBeCloseTo(expected, 9);
  });

  it('is additive across a merge, which is what a window needs', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [1, 2, 3]) a.accept(v);
    for (const v of [4, 5, 6]) b.accept(v);
    const both = new Histogram();
    for (const v of [1, 2, 3, 4, 5, 6]) both.accept(v);

    a.merge(b);
    expect(a.sumOfSquares()).toBe(both.sumOfSquares());
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run packages/statistics/test/histogram.test.ts`
Expected: FAIL — `h.quantile is not a function`.

- [ ] **Step 3: Implement**

In `packages/statistics/src/histogram.ts`, after `countBelow`:

```ts
  /**
   * The value at quantile `q`, EXACTLY — nearest-rank, `sorted[ceil(q·n) − 1]`.
   *
   * ═══ THE CONVENTION IS NOT A DETAIL ═══
   *
   * `Sketch#quantile` goes to considerable trouble to re-express its query so
   * DDSketch's internal `q * (count - 1)` arithmetic resolves to this same
   * index, because every ground-truth computation in this repo's tests uses it.
   * A histogram quantile on the linear-interpolation convention would differ by
   * one rank position on identical data — and since the windowed path reads
   * histograms while the unwindowed path reads sketches, that difference would
   * surface as a percentile that changes when a reader brushes to the whole
   * run. It would look like a windowing bug and would not be one.
   *
   * Throws when the rank lands in the overflow bin, matching `countBelow`: the
   * answer is genuinely unrecoverable there, and a percentile that silently
   * guesses is the defect this class exists to avoid.
   */
  quantile(q: number): number {
    if (this.#total === 0) return NaN;
    const index = Math.min(this.#total - 1, Math.max(0, Math.ceil(q * this.#total) - 1));

    // Everything below the cap is counted first; if the rank falls beyond it,
    // it sits in the overflow bin and no bin value can answer it.
    const counted = this.#total - this.#overflowCount;
    if (index >= counted) {
      throw new Error(
        `Histogram: quantile(${q}) lands in the ${this.#capMs}ms overflow bin ` +
          `(${this.#overflowCount} observations); the exact value is unrecoverable.`,
      );
    }

    let seen = 0;
    for (const [value, count] of this.entries()) {
      seen += count;
      if (seen > index) return value;
    }
    return this.max;
  }

  /**
   * `Σ(value² × count)`, for an exact standard deviation over any merged set.
   *
   * Kept as a walk rather than a running total so it stays correct through
   * `merge` and `deserialize` without a third field to keep in step. The bins
   * are the state; everything else is derived from them.
   */
  sumOfSquares(): number {
    let total = 0;
    for (const [value, count] of this.entries()) total += value * value * count;
    return total;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/statistics/`
Expected: PASS — the whole package, since `distribution.ts` and `indicators.ts` both read this class.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics/src/histogram.ts packages/statistics/test/histogram.test.ts
git commit -m "feat(statistics): exact quantiles and sum of squares from the histogram"
```

---

### Task 2: Bucket histograms in the engine

**Files:**
- Modify: `packages/statistics/src/buckets.ts`
- Modify: `packages/statistics/src/engine.ts`
- Modify: `packages/statistics/test/buckets.test.ts`

**Interfaces:**
- Consumes: `Histogram` from Task 1.
- Produces: `Bucket.histogramOk: Histogram`, `Bucket.histogramKo: Histogram`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/statistics/test/buckets.test.ts`:

```ts
describe('bucket histograms', () => {
  it('records the same observations as the bucket sketches', () => {
    // Fed on the START edge, where sketchOk/sketchKo are. A windowed p95 from
    // end-edge data would disagree with the percentiles-over-time chart at the
    // same window, on the same screen.
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(100, 50, true, 'start');
    s.add(150, 50, true, 'end');
    s.add(200, 90, false, 'start');
    s.add(260, 90, false, 'end');

    const b = s.buckets()[0]!;
    expect(b.histogramOk.total).toBe(b.sketchOk.count);
    expect(b.histogramKo.total).toBe(b.sketchKo.count);
  });

  it('matches the START-edge outcome split exactly', () => {
    // The invariant the new columns are checkable against: startedOkCount and
    // sketchOk are incremented under the same condition on the same edge.
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 30; i += 1) {
      const ok = i % 4 !== 0;
      s.add(i * 100, 10 + i, ok, 'start');
      s.add(i * 100 + 50, 10 + i, ok, 'end');
    }
    for (const b of s.buckets()) {
      expect(b.histogramOk.total).toBe(b.startedOkCount);
      expect(b.histogramKo.total).toBe(b.startedKoCount);
    }
  });

  it('merges losslessly when buckets coalesce', () => {
    const fine = new BucketSeries({ startMs: 0, maxBuckets: 1_000 });
    const coarse = new BucketSeries({ startMs: 0, maxBuckets: 4 });
    for (let i = 0; i < 40; i += 1) {
      for (const s of [fine, coarse]) {
        s.add(i * 1_000, 10 + (i % 7), true, 'start');
        s.add(i * 1_000 + 10, 10 + (i % 7), true, 'end');
      }
    }
    const sum = (bs: ReturnType<BucketSeries['buckets']>) =>
      bs.reduce((n, b) => n + b.histogramOk.total, 0);
    expect(sum(coarse.buckets())).toBe(sum(fine.buckets()));
    expect(coarse.widthMs).toBeGreaterThan(fine.widthMs);
  });

  it('does not record an end-edge observation twice', () => {
    // The caller passes the same value on both edges; only 'start' feeds the
    // summarisers. Feeding both would double every count.
    const s = new BucketSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 42, true, 'start');
    s.add(10, 42, true, 'end');
    expect(s.buckets()[0]!.histogramOk.total).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/statistics/test/buckets.test.ts`
Expected: FAIL — `b.histogramOk` is undefined.

- [ ] **Step 3: Implement**

In `packages/statistics/src/buckets.ts`:

```ts
import { Histogram } from './histogram.js';
```

Add to the `Bucket` interface, beside the sketches:

```ts
  /**
   * The same observations as `sketchOk`/`sketchKo`, in a form a WINDOW can
   * merge. Sketches are ~1KB each serialized and only 1% accurate; these are
   * tens of bytes and exact — see the design's §1 measurements. Both are kept
   * because the sketch is what `run_stat` already uses for the whole run.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
```

In the bucket factory inside `add`:

```ts
        sketch: new Sketch(), sketchOk: new Sketch(), sketchKo: new Sketch(),
        histogramOk: new Histogram(), histogramKo: new Histogram(),
```

In the `edge === 'start'` branch, beside the sketch feeds:

```ts
      b.sketch.accept(value);
      if (ok) b.sketchOk.accept(value); else b.sketchKo.accept(value);
      // Same edge, same condition — which is what makes histogramOk.total
      // equal startedOkCount, the invariant the persisted column is checked
      // against at every layer.
      if (ok) b.histogramOk.accept(value); else b.histogramKo.accept(value);
```

In `#coalesce`, beside the sketch merges:

```ts
          target.sketchOk.merge(b.sketchOk);
          target.sketchKo.merge(b.sketchKo);
          target.histogramOk.merge(b.histogramOk);   // exact, like the sketches
          target.histogramKo.merge(b.histogramKo);
```

No change is needed in `engine.ts`: it drives `BucketSeries#add` and never constructs a `Bucket` itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/statistics/`
Expected: PASS.

- [ ] **Step 5: Check the memory budget did not regress**

Run: `npx vitest run packages/statistics/test/throughput.bench.test.ts`
Expected: PASS. It prints a heap delta; note the number in the commit message. Two histograms per bucket is new resident memory during ingest, and this is the suite that would notice.

- [ ] **Step 6: Commit**

```bash
git add packages/statistics/src/buckets.ts packages/statistics/test/buckets.test.ts
git commit -m "feat(statistics): every bucket carries an exact OK/KO histogram"
```

---

### Task 3: Migration and persistence

**Files:**
- Create: `packages/persistence/prisma/migrations/20260816120000_bucket_histograms/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma`
- Modify: `packages/persistence/src/metrics/write.ts`
- Modify: `packages/persistence/src/metrics/read.ts`
- Modify: `packages/persistence/test/metrics.integration.test.ts`

**Interfaces:**
- Consumes: `Bucket.histogramOk/Ko` from Task 2.
- Produces: `WINDOWED_BUCKETS_SQL`; `MetricReader.windowedBuckets(scope, runId, runStartedOn, sel, range): Promise<StoredWindowBucket[]>` where `sel = { scope: string; family: string }` and `range = { fromMs: number; toMs: number }`; `MetricReader.isWindowable(scope, runId, runStartedOn): Promise<boolean>`; `interface StoredWindowBucket { name: string; startOffsetMs: number; histogramOk: Histogram | null; histogramKo: Histogram | null }`.

- [ ] **Step 1: Write the migration**

`.../20260816120000_bucket_histograms/migration.sql`:

```sql
-- Exact 1ms histograms per bucket, so a time window can be re-aggregated from
-- what is stored rather than by re-parsing the bundle.
--
-- WHY HISTOGRAMS AND NOT THE SKETCH. Measured on this repo's own classes: a
-- DDSketch protobuf costs 1068 bytes for a SINGLE observation and 4139 for 20
-- values spread over 1-10000ms, because its store is dense and writes every bin
-- in the occupied range as a double. The same data as a Histogram costs 12 and
-- 72 bytes, because its store is a sparse map with uvarint encoding — and its
-- percentiles are exact rather than within RELATIVE_ACCURACY. Merging is map
-- addition, so a window is exact too.
--
-- NULLABLE, NO DEFAULT, so this is metadata-only on a partitioned table with
-- existing rows, and a run ingested before this migration stays distinguishable
-- from one that recorded no traffic. That distinction is what `windowable`
-- reports and what stops a brush being offered where it cannot be honoured.
--
-- histogram_kind is not repeated per bucket: run_stat.histogram_kind already
-- records the format for the run, and a second copy per bucket row could only
-- ever disagree with it.
ALTER TABLE "run_series_bucket" ADD COLUMN "histogram_ok" BYTEA;
ALTER TABLE "run_series_bucket" ADD COLUMN "histogram_ko" BYTEA;
```

- [ ] **Step 2: Update the Prisma model**

In `model RunSeriesBucket`, after `percentilesKo`:

```prisma
  /// Exact 1ms histograms of the same observations the bucket sketches hold,
  /// in a form a time window can merge. Null for runs ingested before
  /// migration 20260816120000; see `windowable`.
  histogramOk   Bytes? @map("histogram_ok")
  histogramKo   Bytes? @map("histogram_ko")
```

- [ ] **Step 3: Write the failing integration tests**

Append to `packages/persistence/test/metrics.integration.test.ts`:

```ts
describe('windowed buckets', () => {
  it('round-trips a bucket histogram and matches the start-edge split', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };

    const engine = [...result.series.values()].find((v) => v.scope === 'run')!;
    const full = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
    const rows = await reader.windowedBuckets(tenant, ctx.runId, STARTED_ON,
      { scope: 'run', family: 'response_time' }, full);

    expect(rows).toHaveLength(engine.buckets.length);
    // Derived from the engine's own buckets, never written down.
    for (const row of rows) {
      const b = engine.buckets.find((x) => x.startOffsetMs === row.startOffsetMs)!;
      expect(row.histogramOk!.total).toBe(b.startedOkCount);
      expect(row.histogramKo!.total).toBe(b.startedKoCount);
    }
  });

  it('returns only the buckets inside the range', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };
    const engine = [...result.series.values()].find((v) => v.scope === 'run')!;

    const offsets = engine.buckets.map((b) => b.startOffsetMs).sort((a, b) => a - b);
    const cut = offsets[Math.floor(offsets.length / 2)] as number;
    const rows = await reader.windowedBuckets(tenant, ctx.runId, STARTED_ON,
      { scope: 'run', family: 'response_time' }, { fromMs: 0, toMs: cut });

    expect(rows.every((r) => r.startOffsetMs < cut)).toBe(true);
    expect(rows).toHaveLength(offsets.filter((o) => o < cut).length);
    // Half-open: the boundary bucket belongs to the NEXT window, so no
    // observation is counted in two adjacent ranges.
    expect(rows.some((r) => r.startOffsetMs === cut)).toBe(false);
  });

  it('reports a freshly ingested run as windowable', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const reader = new MetricReader(pool);
    expect(await reader.isWindowable(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON)).toBe(true);
  });

  it('reports a run whose buckets predate the columns as not windowable', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    await pool.query('UPDATE run_series_bucket SET histogram_ok = NULL, histogram_ko = NULL WHERE run_id = $1', [ctx.runId]);
    const reader = new MetricReader(pool);
    expect(await reader.isWindowable(
      { orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId, STARTED_ON)).toBe(false);
  });

  it('prunes partitions on the windowed query', async () => {
    // EXPLAINs the exported constant, not a copy — a test against a copy keeps
    // passing after the real query loses its partition predicate.
    const ctx = await seedRun();
    await persist(ctx);
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${WINDOWED_BUCKETS_SQL}`,
      [STARTED_ON, ctx.runId, ctx.orgId, ctx.projectId, 'run', 'response_time', 0, 999_999_999],
    );
    expect(JSON.stringify(rows)).not.toMatch(/run_series_bucket_2026_(0[1-7]|09|1[0-2])/);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
npx vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts
```
Expected: FAIL — `reader.windowedBuckets is not a function`.

- [ ] **Step 5: Apply the migration**

```bash
cd packages/persistence && npx prisma migrate deploy
```

If a statement fails part-way, the migration is left FAILED rather than rolled back: undo the partial change, `npx prisma migrate resolve --rolled-back 20260816120000_bucket_histograms`, then re-deploy.

- [ ] **Step 6: Implement the writer**

In `write.ts`, add to the `bucketRows.push([...])` tuple and to the column list, after `percentiles_ko`:

```ts
          JSON.stringify(percentilesOf(b.sketchKo)),
          Buffer.from(b.histogramOk.serialize()),
          Buffer.from(b.histogramKo.serialize()),
```

```ts
        'min_ms', 'max_ms', 'mean_ms', 'percentiles', 'percentiles_ok', 'percentiles_ko',
        'histogram_ok', 'histogram_ko',
```

- [ ] **Step 7: Implement the reader**

In `read.ts`:

```ts
export interface StoredWindowBucket {
  name: string;
  startOffsetMs: number;
  /** Null for a run ingested before migration 20260816120000. */
  histogramOk: Histogram | null;
  histogramKo: Histogram | null;
}

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * reason as SERIES_SQL: `run_started_on = $1` is the partition-key predicate.
 *
 * `name` is deliberately NOT a parameter. A windowed statistics table needs
 * every row at once, so this returns all names for a scope and the caller
 * groups — one query rather than one per endpoint.
 *
 * The range is HALF-OPEN, `>= from AND < to`, so two adjacent windows never
 * both claim the boundary bucket.
 */
export const WINDOWED_BUCKETS_SQL = `SELECT name, start_offset_ms, histogram_ok, histogram_ko
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND family = $6
          AND start_offset_ms >= $7 AND start_offset_ms < $8
        ORDER BY name, start_offset_ms`;

export const IS_WINDOWABLE_SQL = `SELECT EXISTS (
         SELECT 1 FROM run_series_bucket
          WHERE run_started_on = $1 AND run_id = $2
            AND org_id = $3 AND project_id = $4
            AND histogram_ok IS NOT NULL
       ) AS present`;
```

And the methods on `MetricReader`:

```ts
  /** runStartedOn is REQUIRED for the same partition-pruning reason as series(). */
  async windowedBuckets(
    scope: ProjectScope,
    runId: string,
    runStartedOn: Date,
    sel: { scope: string; family: string },
    range: { fromMs: number; toMs: number },
  ): Promise<StoredWindowBucket[]> {
    const { rows } = await this.pool.query(
      WINDOWED_BUCKETS_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId, sel.scope, sel.family, range.fromMs, range.toMs],
    );
    return rows.map((r) => ({
      name: r.name,
      startOffsetMs: r.start_offset_ms,
      // Deliberately NOT an empty Histogram for null: "not recorded" and
      // "recorded nothing" are different answers, and only the caller knows
      // which one it can tolerate.
      histogramOk: r.histogram_ok ? Histogram.deserialize(new Uint8Array(r.histogram_ok)) : null,
      histogramKo: r.histogram_ko ? Histogram.deserialize(new Uint8Array(r.histogram_ko)) : null,
    }));
  }

  /** Whether this run's buckets carry histograms, i.e. whether it can be windowed. */
  async isWindowable(scope: ProjectScope, runId: string, runStartedOn: Date): Promise<boolean> {
    const { rows } = await this.pool.query(
      IS_WINDOWABLE_SQL,
      [runStartedOn, runId, scope.orgId, scope.projectId],
    );
    return rows[0]?.present === true;
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run --config vitest.integration.config.ts packages/persistence/`
Expected: PASS, including `migrations.integration.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/persistence/
git commit -m "feat(persistence): bucket histograms, and a windowed read that still prunes"
```

---

### Task 4: The windowed statistics rollup

**Files:**
- Create: `packages/statistics/src/window.ts`
- Create: `packages/statistics/test/window.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Consumes: `Histogram` from Task 1.
- Produces: `rollupFromHistograms(ok: Histogram, ko: Histogram, windowMs: number, percentiles: number[]): WindowRollup` where `WindowRollup` carries `count, okCount, koCount, errorRate, minMs, maxMs, meanMs, stddevMs, throughputRps, percentiles`.

Split from the endpoint deliberately: this is pure arithmetic over two histograms, and a reviewer can reject the arithmetic without touching HTTP.

- [ ] **Step 1: Write the failing tests**

`packages/statistics/test/window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import { rollupFromHistograms } from '../src/window.js';
import { RollupBuilder } from '../src/rollup.js';

const fill = (h: Histogram, values: readonly number[]): Histogram => {
  for (const v of values) h.accept(v);
  return h;
};

const OK = [12, 15, 15, 20, 33, 41, 58, 90];
const KO = [120, 400];

describe('rollupFromHistograms', () => {
  it('agrees with the full-run RollupBuilder on the same observations', () => {
    // The load-bearing property: a window covering everything must reproduce
    // what the unwindowed path reports. Derived from RollupBuilder itself, so
    // a change to either has to be a deliberate change to both.
    const builder = new RollupBuilder();
    for (const v of OK) builder.add(v, true);
    for (const v of KO) builder.add(v, false);
    const full = builder.finish({
      scope: 'run', name: '', family: 'response_time',
      windowMs: 10_000, percentiles: [50, 95],
    });

    const w = rollupFromHistograms(
      fill(new Histogram(), OK), fill(new Histogram(), KO), 10_000, [50, 95]);

    expect(w.count).toBe(full.count);
    expect(w.okCount).toBe(full.okCount);
    expect(w.koCount).toBe(full.koCount);
    expect(w.minMs).toBe(full.minMs);
    expect(w.maxMs).toBe(full.maxMs);
    expect(w.meanMs).toBeCloseTo(full.meanMs, 9);
    expect(w.stddevMs).toBeCloseTo(full.stddevMs, 9);
    expect(w.throughputRps).toBeCloseTo(full.throughputRps, 9);
  });

  it('takes percentiles over OK AND KO together, like the full-run row', () => {
    const w = rollupFromHistograms(
      fill(new Histogram(), OK), fill(new Histogram(), KO), 10_000, [50, 95]);
    const combined = fill(fill(new Histogram(), OK), KO);
    expect(w.percentiles['p95']).toBe(combined.quantile(0.95));
  });

  it('divides throughput by the WINDOW, not the run', () => {
    // This is what makes a brushed rate change — the whole point of the
    // feature. Halving the window doubles the rate for the same requests.
    const args = [fill(new Histogram(), OK), fill(new Histogram(), KO)] as const;
    const wide = rollupFromHistograms(args[0], args[1], 10_000, [95]);
    const narrow = rollupFromHistograms(args[0], args[1], 5_000, [95]);
    expect(narrow.throughputRps).toBeCloseTo(wide.throughputRps * 2, 9);
  });

  it('reports zeros, not NaN, for an empty window', () => {
    // A window a reader dragged over an idle stretch is a legitimate question
    // with a legitimate answer.
    const w = rollupFromHistograms(new Histogram(), new Histogram(), 1_000, [95]);
    expect(w.count).toBe(0);
    expect(w.errorRate).toBe(0);
    expect(w.meanMs).toBe(0);
    expect(w.percentiles).toEqual({});
  });

  it('never divides by a zero-length window', () => {
    const w = rollupFromHistograms(fill(new Histogram(), OK), new Histogram(), 0, [95]);
    expect(Number.isFinite(w.throughputRps)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/statistics/test/window.test.ts`
Expected: FAIL — cannot resolve `../src/window.js`.

- [ ] **Step 3: Implement**

`packages/statistics/src/window.ts`:

```ts
import { Histogram } from './histogram.js';

export interface WindowRollup {
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  percentiles: Record<string, number>;
}

/**
 * One statistics row for a time window, from the merged bucket histograms.
 *
 * ═══ EVERY COLUMN FROM ONE SOURCE ═══
 *
 * Not a mixture. The stored `ended_count`/`ok_count` columns are the END-edge
 * split and these histograms are the START-edge one, so taking counts from the
 * columns and percentiles from the histograms would describe two different sets
 * of requests inside a single row. A windowed row describes the requests that
 * STARTED in the window, all the way across.
 *
 * `windowMs` is the SNAPPED window, not the run's duration. That is what makes
 * a brushed throughput change, which is the whole point of the feature.
 */
export function rollupFromHistograms(
  ok: Histogram,
  ko: Histogram,
  windowMs: number,
  percentiles: readonly number[],
): WindowRollup {
  const okCount = ok.total;
  const koCount = ko.total;
  const count = okCount + koCount;

  if (count === 0) {
    return {
      count: 0, okCount: 0, koCount: 0, errorRate: 0,
      minMs: 0, maxMs: 0, meanMs: 0, stddevMs: 0, throughputRps: 0,
      percentiles: {},
    };
  }

  // Merged into a fresh histogram rather than mutating either input: the
  // caller may still need the OK-only set, and `merge` is destructive.
  const all = new Histogram();
  all.merge(ok);
  all.merge(ko);

  const mean = all.sum / count;
  // Σx²/n − mean². Clamped at zero because floating-point cancellation can
  // make an exactly-uniform sample come out fractionally negative.
  const variance = Math.max(0, all.sumOfSquares() / count - mean * mean);

  return {
    count,
    okCount,
    koCount,
    errorRate: koCount / count,
    minMs: all.min,
    maxMs: all.max,
    meanMs: mean,
    stddevMs: Math.sqrt(variance),
    // A zero-length window cannot happen through the API — `from >= to` is a
    // 400 — but a rate of Infinity leaking into a response is worse than a
    // guard nobody trips.
    throughputRps: windowMs > 0 ? count / (windowMs / 1000) : 0,
    percentiles: Object.fromEntries(
      percentiles.map((p) => [`p${p}`, all.quantile(p / 100)]),
    ),
  };
}
```

- [ ] **Step 4: Export and run**

Add `export * from './window.js';` to `packages/statistics/src/index.ts`.

Run: `npx vitest run packages/statistics/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics/src/window.ts packages/statistics/test/window.test.ts packages/statistics/src/index.ts
git commit -m "feat(statistics): one statistics row from a window's merged histograms"
```

---

### Task 5: The range parameter on `/stats`

**Files:**
- Modify: `packages/contracts/src/metrics.ts`
- Modify: `apps/api/src/metrics/metrics.controller.ts`
- Modify: `apps/api/src/common/validation.ts`
- Create: `apps/api/test/window.integration.test.ts`

**Interfaces:**
- Consumes: `rollupFromHistograms`, `windowedBuckets`, `isWindowable`.
- Produces: `WindowSchema` / `Window`; `StatsResponse.window: Window | null`; `parseRange(from, to)` in validation; `GET /v1/runs/:id/stats?from&to`.

- [ ] **Step 1: Write the contract**

In `packages/contracts/src/metrics.ts`:

```ts
export const WindowSchema = z.object({
  /** Elapsed ms from run start, inclusive. */
  fromMs: z.number().int().nonnegative(),
  /** Elapsed ms from run start, EXCLUSIVE — adjacent windows never overlap. */
  toMs: z.number().int().positive(),
  /**
   * The bucket width the window was snapped to. A brush that cuts a bucket in
   * half cannot be answered exactly at any storage cost, so the range is
   * widened outward to bucket boundaries and reported here. The page header
   * must state THIS range, not the one the reader dragged.
   */
  bucketWidthMs: z.number().int().positive(),
});
export type Window = z.infer<typeof WindowSchema>;
```

And on `StatsResponseSchema`:

```ts
  /**
   * The window these statistics were computed over, or `null` when the whole
   * run was used. Non-null values are SNAPPED — see WindowSchema.
   */
  window: WindowSchema.nullable(),
```

- [ ] **Step 2: Write the failing integration tests**

`apps/api/test/window.integration.test.ts`. Copy the bundle/`beforeAll`/`ingested()`/`auth()` preamble from `error-series.integration.test.ts` verbatim.

```ts
const stats = (id: string, query = '') =>
  request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats${query}`).set(auth());

const runRowOf = (body: StatsResponse) =>
  body.stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

describe('GET /v1/runs/:id/stats — windowed', () => {
  it('reports no window when none was asked for', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    expect(StatsResponseSchema.parse((await stats(id)).body).window).toBeNull();
  });

  it('a full-extent window reproduces the unwindowed row', async () => {
    // Within RELATIVE_ACCURACY, not exactly: the windowed path merges exact
    // histograms and the unwindowed path reads the 1%-relative sketch. That
    // divergence is designed and documented (§8); this pins its size.
    ctx = await createTestApp();
    const id = await ingested();

    const whole = runRowOf(StatsResponseSchema.parse((await stats(id)).body));
    const windowed = runRowOf(
      StatsResponseSchema.parse((await stats(id, '?from=0&to=99999999')).body));

    expect(windowed.count).toBe(whole.count);
    expect(windowed.okCount).toBe(whole.okCount);
    expect(windowed.koCount).toBe(whole.koCount);
    expect(windowed.maxMs).toBe(whole.maxMs);
    for (const key of Object.keys(whole.percentiles)) {
      const a = whole.percentiles[key]!;
      const b = windowed.percentiles[key]!;
      expect(Math.abs(a - b) / a).toBeLessThanOrEqual(0.01);
    }
  });

  it('a half window reports strictly fewer requests and no larger a max', async () => {
    // The assertion that separates a real re-aggregation from a redrawn axis.
    ctx = await createTestApp();
    const id = await ingested();

    const whole = runRowOf(StatsResponseSchema.parse((await stats(id)).body));
    const series = SeriesResponseSchema.parse((await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=run&name=&family=response_time`).set(auth())).body);
    const offsets = series.buckets.map((b) => b.startOffsetMs);
    const half = offsets[Math.floor(offsets.length / 2)]!;

    const body = StatsResponseSchema.parse((await stats(id, `?from=0&to=${half}`)).body);
    const part = runRowOf(body);

    expect(part.count).toBeGreaterThan(0);
    expect(part.count).toBeLessThan(whole.count);
    expect(part.maxMs).toBeLessThanOrEqual(whole.maxMs);
    expect(body.window).not.toBeNull();
    expect(body.window!.bucketWidthMs).toBe(series.bucketWidthMs);
  });

  it('reports the SNAPPED window, not the one asked for', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const series = SeriesResponseSchema.parse((await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=run&name=&family=response_time`).set(auth())).body);
    const width = series.bucketWidthMs;

    // Deliberately off a boundary, by construction.
    const body = StatsResponseSchema.parse(
      (await stats(id, `?from=${width + 1}&to=${width * 3 + 1}`)).body);
    expect(body.window!.fromMs % width).toBe(0);
    expect(body.window!.toMs % width).toBe(0);
    // Outward, so nothing the reader selected falls outside what was computed.
    expect(body.window!.fromMs).toBeLessThanOrEqual(width + 1);
    expect(body.window!.toMs).toBeGreaterThanOrEqual(width * 3 + 1);
  });

  it('rejects an inverted or malformed range instead of guessing', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    expect((await stats(id, '?from=500&to=500')).status).toBe(400);
    expect((await stats(id, '?from=900&to=100')).status).toBe(400);
    expect((await stats(id, '?from=-1&to=100')).status).toBe(400);
    expect((await stats(id, '?from=abc&to=100')).status).toBe(400);
  });

  it('honours from alone and to alone, never silently ignoring one', async () => {
    // The `?name=` without `scope` trap, not repeated. Each bound is
    // meaningful on its own.
    ctx = await createTestApp();
    const id = await ingested();
    const whole = runRowOf(StatsResponseSchema.parse((await stats(id)).body));

    const tail = runRowOf(StatsResponseSchema.parse((await stats(id, '?from=1000')).body));
    const head = runRowOf(StatsResponseSchema.parse((await stats(id, '?to=1000')).body));
    expect(tail.count).toBeLessThan(whole.count);
    expect(head.count).toBeLessThan(whole.count);
    expect(head.count + tail.count).toBe(whole.count);
  });

  it('refuses a window on a run that predates the columns', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    await ctx.pool.query(
      'UPDATE run_series_bucket SET histogram_ok = NULL, histogram_ko = NULL WHERE run_id = $1', [id]);

    const res = await stats(id, '?from=0&to=1000');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WINDOW_UNAVAILABLE');
    // And the unwindowed call still works — the run is readable, just not brushable.
    expect((await stats(id)).status).toBe(200);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --config vitest.integration.config.ts apps/api/test/window.integration.test.ts`
Expected: FAIL — `window` is not in the response.

- [ ] **Step 4: Implement range parsing**

In `apps/api/src/common/validation.ts`:

```ts
/**
 * `?from=&to=` as elapsed ms from run start.
 *
 * Each bound is INDEPENDENTLY OPTIONAL and meaningful alone — `from` with no
 * `to` means "to the end", `to` with no `from` means "from the start". Neither
 * is ever silently ignored, which is the trap the metrics endpoints already
 * carry for `?name=` without `scope`.
 *
 * Returns null when neither is present, which means the whole run.
 */
export function parseRange(
  from: string | undefined,
  to: string | undefined,
): { fromMs: number; toMs: number } | null {
  if (from === undefined && to === undefined) return null;

  const bound = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw badRequest(
        'RANGE_INVALID',
        `"${label}" must be a non-negative integer number of milliseconds, not "${raw}".`,
        'Pass elapsed milliseconds from the run start, for example ?from=0&to=60000.',
      );
    }
    return n;
  };

  const fromMs = bound(from, 0, 'from');
  const toMs = bound(to, Number.MAX_SAFE_INTEGER, 'to');
  if (fromMs >= toMs) {
    throw badRequest(
      'RANGE_INVALID',
      `"from" (${fromMs}) must be strictly before "to" (${toMs}).`,
      'An empty window has no statistics to report; widen the range.',
    );
  }
  return { fromMs, toMs };
}
```

- [ ] **Step 5: Implement the windowed branch**

In `metrics.controller.ts`, add `@Query('from') from?: string, @Query('to') to?: string` to `stats`, and after the settings block:

```ts
    const range = parseRange(from, to);
    const tenant = { orgId: run.orgId, projectId: run.projectId };

    if (range !== null) {
      if (!(await this.reader.isWindowable(tenant, run.id, run.startedOn))) {
        throw badRequest(
          'WINDOW_UNAVAILABLE',
          'This run was ingested before per-bucket histograms were recorded, so it cannot be re-aggregated over a time window.',
          'Re-ingest the run to enable time-window analysis, or view the whole run.',
        );
      }
      return this.#windowedStats(run, tenant, range, settings, scope, name, family);
    }
```

`#windowedStats` reads every scope's buckets once, snaps, groups by name, merges and rolls up:

```ts
  async #windowedStats(
    run: { id: string; orgId: string; projectId: string; startedOn: Date },
    tenant: { orgId: string; projectId: string },
    range: { fromMs: number; toMs: number },
    settings: { percentiles: number[]; indicators: { lowerMs: number; higherMs: number } },
    scope: string | undefined,
    name: string | undefined,
    family: string | undefined,
  ): Promise<StatsResponse> {
    const wanted = scope ?? 'run';
    const rows = await this.reader.windowedBuckets(
      tenant, run.id, run.startedOn,
      { scope: wanted, family: family ?? 'response_time' }, range);

    // The width comes from the OFFSETS THEMSELVES, not from a constant: the
    // engine halves resolution on a long run, and dividing by 1000 would scale
    // every rate by a power of two with nothing looking wrong.
    const bucketWidthMs = inferBucketWidthMs([...new Set(rows.map((r) => r.startOffsetMs))].sort((a, b) => a - b));
    // Snapped OUTWARD, so nothing the reader selected falls outside the answer.
    const fromMs = Math.floor(range.fromMs / bucketWidthMs) * bucketWidthMs;
    const last = rows.length === 0 ? fromMs : Math.max(...rows.map((r) => r.startOffsetMs));
    const toMs = Math.min(
      Math.ceil(range.toMs / bucketWidthMs) * bucketWidthMs,
      last + bucketWidthMs,
    );

    const byName = new Map<string, { ok: Histogram; ko: Histogram }>();
    for (const row of rows) {
      let entry = byName.get(row.name);
      if (!entry) { entry = { ok: new Histogram(), ko: new Histogram() }; byName.set(row.name, entry); }
      if (row.histogramOk) entry.ok.merge(row.histogramOk);
      if (row.histogramKo) entry.ko.merge(row.histogramKo);
    }

    const stats = [...byName.entries()]
      .filter(([rowName]) => (name !== undefined ? rowName === name : true))
      .map(([rowName, h]) => {
        const w = rollupFromHistograms(h.ok, h.ko, toMs - fromMs, settings.percentiles);
        return {
          scope: wanted as StatsResponse['stats'][number]['scope'],
          name: rowName,
          family: (family ?? 'response_time') as StatsResponse['stats'][number]['family'],
          ...w,
          // From the WINDOW's own OK histogram, so the bands describe the same
          // requests as every other column in the row.
          indicators: bandsFrom(h.ok, w.koCount, settings.indicators),
        };
      });

    const runRow = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    return {
      runId: run.id,
      stats,
      indicators: runRow?.indicators ?? { under: 0, between: 0, over: 0, failed: 0 },
      // Histograms are what a window is computed from, so a windowed response
      // is configurable by construction.
      configurable: true,
      bounds: settings.indicators,
      window: { fromMs, toMs, bucketWidthMs },
    };
  }
```

Add `window: null` to the existing unwindowed return.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --config vitest.integration.config.ts apps/api/test/window.integration.test.ts apps/api/test/openapi.integration.test.ts apps/api/test/read.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api
git commit -m "feat(api): /stats re-aggregates over a snapped time window"
```

---

### Task 6: The benchmark, and the budget it gates

**Files:**
- Create: `apps/api/test/window.bench.test.ts`

**Interfaces:**
- Consumes: everything above. Produces: nothing — this is a gate.

Nothing in Layer 3 should be built on a number nobody has measured.

- [ ] **Step 1: Write the benchmark**

`apps/api/test/window.bench.test.ts`, modelled on `packages/statistics/test/throughput.bench.test.ts`:

```ts
/**
 * The §9 budget. A windowed request-scope table merges up to 300 histograms
 * PER ENDPOINT, and 15,000 deserialise-and-merge operations on one request is
 * not obviously cheap. This is the part of the design most likely to fail on
 * contact with a real run, so it gets a measurement rather than an assumption.
 */
const BUDGET_MS = 500;

it('re-aggregates a 50-endpoint run within the budget', async () => {
  ctx = await createTestApp();
  const id = await seededWideRun(ctx, { endpoints: 50, buckets: 300 });

  const started = process.hrtime.bigint();
  const res = await request(ctx.app.getHttpServer())
    .get(`/v1/runs/${id}/stats?scope=request&from=0&to=99999999`)
    .set(auth());
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  expect(res.status).toBe(200);
  // eslint-disable-next-line no-console
  console.log(`  windowed /stats: ${elapsedMs.toFixed(0)}ms (budget ${BUDGET_MS}ms)`);
  expect(elapsedMs).toBeLessThan(BUDGET_MS);
});
```

`seededWideRun` inserts bucket rows directly rather than ingesting: the subject is the read path, and 15 000 buckets through the real pipeline would put minutes on the suite for no extra coverage.

```ts
/**
 * A run with `endpoints × buckets` series rows, written straight to the table.
 *
 * Each histogram gets a realistic per-bucket population — ~20 observations in a
 * narrow latency band — because size tracks value SPREAD, and seeding one
 * value per bucket would measure a payload the real path never produces.
 */
async function seededWideRun(
  ctx: TestContext,
  opts: { endpoints: number; buckets: number },
): Promise<string> {
  const id = randomUUID();
  const startedOn = new Date('2026-08-16T00:00:00Z');
  await ctx.prisma.run.create({
    data: {
      id, orgId: ctx.orgId, projectId: ctx.projectId,
      status: 'complete', verdict: 'passed', tool: 'gatling',
      startedAt: startedOn, startedOn, durationMs: opts.buckets * 1000,
      bundleKey: `k/${id}`, bundleSha256: 'z'.repeat(64), bundleBytes: BigInt(1),
      engineOptions: {},
    },
  });

  const rows: unknown[][] = [];
  for (let e = 0; e < opts.endpoints; e += 1) {
    for (let b = 0; b < opts.buckets; b += 1) {
      const ok = new Histogram();
      const ko = new Histogram();
      for (let i = 0; i < 20; i += 1) ok.accept(40 + ((e + b + i) % 25));
      ko.accept(300 + (b % 40));
      rows.push([
        startedOn, id, ctx.orgId, ctx.projectId,
        'request', `GET /r${e}`, 'response_time', b * 1000,
        21, 21, 20, 1, 20, 1, 40, 340, 55,
        '{}', '{}', '{}',
        Buffer.from(ok.serialize()), Buffer.from(ko.serialize()),
      ]);
    }
  }
  // Reuse MetricWriter's batching rather than one statement: Postgres caps a
  // statement at 65535 parameters and this is 300 000 rows.
  await insertSeriesRows(ctx.pool, rows);
  return id;
}
```

`insertSeriesRows` is a thin local helper over the same `INSERT … VALUES` batching `MetricWriter` uses; copy its 500-row chunking rather than inventing a second one.

- [ ] **Step 2: Run it and record the number**

Run: `npx vitest run --config vitest.integration.config.ts apps/api/test/window.bench.test.ts`

**If it misses the budget, STOP and report** rather than continuing to Layer 3. The mitigations, in preference order, are in the spec's §9: narrow the query to rendered scopes; cache the merged result per (run, window), which is immutable; or precompute at a coarser granularity. Which one is right depends on where the time actually goes, so profile before choosing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/window.bench.test.ts
git commit -m "test(api): a measured budget for windowed re-aggregation"
```

---

### Task 7: The range on the remaining endpoints

**Files:**
- Modify: `apps/api/src/metrics/metrics.controller.ts`
- Modify: `apps/api/src/parity/parity.controller.ts`
- Modify: `packages/contracts/src/metrics.ts`
- Modify: `apps/api/test/window.integration.test.ts`

**Interfaces:** Consumes `parseRange`. Produces `window` on `SeriesResponse`, `UsersResponse`, `DistributionResponse`, `ErrorSeriesResponse`, `ScatterResponse`.

- [ ] **Step 1: Write the failing tests**

Append to `window.integration.test.ts`:

```ts
describe('the range applies to every time-axis endpoint', () => {
  const paths = (id: string) => [
    `/v1/runs/${id}/series?scope=run&name=&family=response_time`,
    `/v1/runs/${id}/users`,
    `/v1/runs/${id}/distribution?scope=run&name=`,
    `/v1/runs/${id}/errors/series`,
  ];

  it('narrows every one of them, and reports the snapped window', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    for (const path of paths(id)) {
      const join = path.includes('?') ? '&' : '?';
      const whole = await request(ctx.app.getHttpServer()).get(path).set(auth());
      const part = await request(ctx.app.getHttpServer())
        .get(`${path}${join}from=0&to=5000`).set(auth());

      expect(part.status, path).toBe(200);
      expect(part.body.window, path).not.toBeNull();
      expect(JSON.stringify(part.body).length, path).toBeLessThan(JSON.stringify(whole.body).length);
    }
  });

  it('leaves the flat errors table whole-run, deliberately', async () => {
    // run_error_bucket is run scope only and holds five messages plus a
    // remainder, against this table's two hundred. A brushed errors table
    // would be a poorer table wearing the same heading — see the spec's §6.
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/errors?scope=run&name=&from=0&to=5000`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.window).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts apps/api/test/window.integration.test.ts`
Expected: FAIL — `part.body.window` is undefined on every path.

- [ ] **Step 3: Implement — one shared guard, then two shapes**

Every windowed endpoint repeats the same three lines, so they move into a private helper rather than being retyped five times:

```ts
  /**
   * Parses, guards and returns the range, or null for the whole run.
   *
   * Shared so the `WINDOW_UNAVAILABLE` check cannot be forgotten on one
   * endpoint and present on the other four — which would let a brushed page
   * show four windowed figures beside one whole-run figure, with nothing
   * saying which was which.
   */
  async #range(
    run: { id: string; orgId: string; projectId: string; startedOn: Date },
    from: string | undefined,
    to: string | undefined,
  ): Promise<{ fromMs: number; toMs: number } | null> {
    const range = parseRange(from, to);
    if (range === null) return null;
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    if (!(await this.reader.isWindowable(tenant, run.id, run.startedOn))) {
      throw badRequest(
        'WINDOW_UNAVAILABLE',
        'This run was ingested before per-bucket histograms were recorded, so it cannot be re-aggregated over a time window.',
        'Re-ingest the run to enable time-window analysis, or view the whole run.',
      );
    }
    return range;
  }
```

**Shape A — filter the buckets already being returned.** `/series`, `/users`, `/errors/series` and `/scatter`. `/series` is the template:

```ts
    const range = await this.#range(run, from, to);
    const buckets = (await this.reader.series(tenant, run.id, run.startedOn, { scope, name, family }))
      // Half-open, matching WINDOWED_BUCKETS_SQL, so two adjacent windows
      // never both claim the boundary bucket.
      .filter((b) => range === null || (b.startOffsetMs >= range.fromMs && b.startOffsetMs < range.toMs));
```

and the response gains `window: range === null ? null : snapped(buckets, range)`, where `snapped` is the same outward-snapping helper `#windowedStats` uses — extract it in Task 5 rather than writing it twice.

`/users` filters `run_user_bucket` rows the same way; `/errors/series` filters its own rows before grouping by message; `/scatter` filters before building points.

**Shape B — merge the windowed histograms.** `/distribution` only. It reads `run_stat.histogram_ok`/`histogram_ko` today; windowed, it merges the bucket histograms exactly as `#windowedStats` does and folds bins from the merged result. Same code path, different consumer.

**`/errors` gains no parameters at all** — not an ignored one. Its docstring should say why, pointing at the spec's §6: `run_error_bucket` is run scope only and holds five messages plus a remainder, so a brushed errors table would be a poorer table wearing the same heading.

- [ ] **Step 4: Run the API suite and commit**

```bash
npx vitest run --config vitest.integration.config.ts apps/api/
git add apps/api packages/contracts
git commit -m "feat(api): every time-axis endpoint honours the window"
```

---

### Task 8: The brush

**Files:**
- Create: `apps/web/src/routes/window.ts`
- Create: `apps/web/test/window.test.ts`
- Create: `apps/web/src/charts/TimeBrush.tsx`
- Modify: `apps/web/src/api/metrics.ts`
- Modify: `apps/web/src/routes/RunDetail.tsx`, `RunShell.tsx`

**Interfaces:** Produces `parseWindow(from: string | null, to: string | null, runDurationMs: number): Window | null`, `serialiseWindow(w: Window | null): { from?: string; to?: string }`, `TimeBrush`. Six query factories in `api/metrics.ts` gain a trailing `window: Window | null`, and exactly six:

| gains a window | stays whole-run |
|---|---|
| `statsQuery(id, window)` | `errorsQuery(id, scope, name)` — §6 |
| `seriesQuery(id, scope, name, family, window)` | `trendsQuery(id, limit)` — its axis is runs |
| `usersQuery(id, window)` | |
| `distributionQuery(id, scope, name, family, window)` | |
| `errorSeriesQuery(id, window)` | |
| `scatterQuery(id, name, window)` | |

- [ ] **Step 1: Write the failing tests**

`apps/web/test/window.test.ts`:

```ts
describe('parseWindow', () => {
  it('is the whole run when the URL names no window', () => {
    expect(parseWindow(null, null, 60_000)).toBeNull();
  });

  it('honours one bound alone', () => {
    expect(parseWindow('1000', null, 60_000)).toEqual({ fromMs: 1000, toMs: 60_000 });
    expect(parseWindow(null, '1000', 60_000)).toEqual({ fromMs: 0, toMs: 1000 });
  });

  it('falls back rather than throwing on a malformed value', () => {
    // safeNext's stance: the reader asked to see a run, and a mangled query
    // string is no reason to refuse them.
    expect(parseWindow('abc', 'def', 60_000)).toBeNull();
    expect(parseWindow('900', '100', 60_000)).toBeNull();
  });

  it('clamps to the run rather than asking for time that does not exist', () => {
    expect(parseWindow('0', '999999', 60_000)).toEqual({ fromMs: 0, toMs: 60_000 });
  });
});

describe('query keys', () => {
  it('carries the window, so staleTime: Infinity stays correct', () => {
    // The concern the earlier spec raised about this feature. It dissolves
    // once the window is part of the key: a completed run's metrics FOR A
    // GIVEN WINDOW still never change.
    //
    // `statsQuery` takes only an id today and is deliberately UNFILTERED —
    // every consumer needs the whole row set. The window is the one thing that
    // must join it, because it changes the numbers rather than selecting among
    // them.
    const whole = statsQuery('run-1', null).queryKey;
    const part = statsQuery('run-1', { fromMs: 0, toMs: 1000 }).queryKey;
    const other = statsQuery('run-1', { fromMs: 1000, toMs: 2000 }).queryKey;
    expect(whole).not.toEqual(part);
    expect(part).not.toEqual(other);
  });

  it('puts the window on the URL of every windowed endpoint', () => {
    const url = statsQuery('run-1', { fromMs: 0, toMs: 1000 }).queryFn.toString();
    expect(url).toContain('from=0');
    expect(url).toContain('to=1000');
  });
});
```

- [ ] **Step 2: Implement the parser**

`apps/web/src/routes/window.ts`:

```ts
import type { Window } from '@perfportal/contracts';

/**
 * `?from=&to=` — the run's time window, in the URL rather than component state.
 *
 * Same argument `?runs=` makes on the Compare page: a window someone selected
 * is a thing they paste into a review comment, and state that lives only in a
 * component cannot be pasted.
 *
 * ═══ VALIDATED, NEVER TRUSTED, AND NEVER THROWS ═══
 *
 * `safeNext`'s stance applied to another parameter. The reader asked to see a
 * run; a malformed query string is no reason to refuse them one. Anything that
 * does not parse falls back to the whole run, which is the honest default
 * rather than an error page.
 */
export function parseWindow(
  from: string | null,
  to: string | null,
  runDurationMs: number,
): Window | null {
  if (from === null && to === null) return null;

  const bound = (raw: string | null, fallback: number): number | null => {
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const fromMs = bound(from, 0);
  const toMs = bound(to, runDurationMs);
  if (fromMs === null || toMs === null) return null;

  // Clamped to the run, so the page never asks the API for time that does not
  // exist — and an inverted range falls back rather than 400ing the whole page.
  const clampedTo = Math.min(toMs, runDurationMs);
  if (fromMs >= clampedTo) return null;
  return { fromMs, toMs: clampedTo, bucketWidthMs: 0 };
}

/** The inverse, for writing a selection back to the URL. */
export const serialiseWindow = (w: Window | null): { from?: string; to?: string } =>
  w === null ? {} : { from: String(w.fromMs), to: String(w.toMs) };
```

`bucketWidthMs: 0` is a placeholder the client never reads — the server reports
the snapped width in its response, and the header renders THAT.

- [ ] **Step 3: Thread it through the query factories**

Each factory gains a trailing `window` parameter, puts it in the key, and appends the bounds. `statsQuery` is the template; the rest follow it exactly:

```ts
export const statsQueryKey = (id: string, window: Window | null) =>
  ['run', id, 'stats', window?.fromMs ?? null, window?.toMs ?? null] as const;

/** The window is part of the KEY, which is what keeps `staleTime: Infinity`
 *  unconditionally correct: a completed run's metrics for a GIVEN window still
 *  never change. */
export const statsQuery = (id: string, window: Window | null) => ({
  queryKey: statsQueryKey(id, window),
  queryFn: () => apiFetch(StatsResponseSchema, `${runPath(id)}/stats${rangeSuffix(window)}`),
  staleTime: Infinity,
});
```

with one shared helper, so no factory can spell the parameter differently:

```ts
/** `''` for the whole run, `?from=&to=` otherwise. Always both bounds — each
 *  is meaningful alone on the wire, but sending one and omitting the other
 *  from a client that knows both is just a chance to send the wrong one. */
export const rangeSuffix = (w: Window | null, join = '?'): string =>
  w === null ? '' : `${join}from=${w.fromMs}&to=${w.toMs}`;
```

Factories whose URL already carries a query string pass `'&'`.

- [ ] **Step 4: The brush**

`apps/web/src/charts/TimeBrush.tsx` renders an ECharts `dataZoom` slider over the run-scope series and writes `?from=&to=` on change, debounced so a drag is one navigation rather than forty.

**It is its own element above the charts, never inside a chart's `<figure>`** — nine specs count SVG elements within a figure to prove a chart drew, and a brush rendered inside one breaks both the counts and the invariant they rest on.

`RunShell` reads the window once from the URL and passes it down, so every tab and every figure on the page agree about what is being shown.

- [ ] **Step 5: e2e — the assertion that separates this from an axis clip**

Append to `apps/web/e2e/run-charts.spec.ts`:

```ts
test('brushing recomputes the statistics, not just the axis', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto(runPath(runId));
  const whole = await payload<StatsJson>(page, `/v1/runs/${runId}/stats?scope=run&name=`);
  const wholeCount = whole.stats.find((s) => s.scope === 'run')!.count;

  // Half the run, via the URL — the brush writes exactly this.
  await page.goto(`${runPath(runId)}?from=0&to=30000`);
  const part = await payload<StatsJson>(
    page, `/v1/runs/${runId}/stats?scope=run&name=&from=0&to=30000`);
  const partCount = part.stats.find((s) => s.scope === 'run')!.count;

  // DERIVED, never written down: the brushed count is strictly smaller.
  expect(partCount).toBeGreaterThan(0);
  expect(partCount).toBeLessThan(wholeCount);

  // And the page shows the brushed number, not the whole-run one.
  await expect(page.getByTestId('kpi-total-requests')).toHaveText(String(partCount));
});
```

- [ ] **Step 6: Full gate, in its documented order**

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

Integration **before** e2e. Update the `CLAUDE.md` floor to the new numbers.

- [ ] **Step 7: Commit and open the PR**

```bash
git add -A
git commit -m "feat(web): brush the run, and every number follows"
git push -u origin feat/time-window-reaggregation
gh pr create --base main --title "feat: time-window re-aggregation" --body "..."
```

Then use `superpowers:finishing-a-development-branch`.
