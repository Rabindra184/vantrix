/**
 * Where a percentile estimate is projected back onto what it can possibly be.
 *
 * Four surfaces render one — the statistics table, the run totals tiles, the
 * trend line and the compare overlay — and a decision owned by any one of
 * them is a decision the other three can silently disagree with.
 */

/**
 * A percentile of a sample cannot lie outside that sample's own range, so an
 * estimate that does is known to be wrong — and min/max are tracked exactly
 * while percentiles carry DDSketch's 1% relative error. Clamping projects the
 * estimate onto the interval it was always constrained to; it is a better
 * estimate, not a prettier one.
 *
 * Measured on the reference run: `Catalog/Recommendations` reports p99 2515.4
 * against max 2503, and `Cart` reports p99 179.49 against max 179 — and so does
 * the run-scope totals row, at 2515.4 against 2503. The table puts p99 and Max
 * in adjacent columns, so unclamped a reader sees a 99th percentile larger than
 * the maximum and reasonably concludes the product is broken.
 *
 * NOT the pipeline's bug being hidden: task 1 confirmed we are exact on all
 * four exactly-tracked quantities and out by up to 14 ms in the sparse tail,
 * which is exactly the estimator's advertised error. The caption says the
 * percentiles are estimates, because that is true clamped or not.
 *
 * The right long-term home is STILL `packages/statistics`, where the exact
 * extremes and the estimated percentiles are produced together and every
 * consumer — the API, the charts, any future export — would benefit. That is
 * recorded as follow-up in the ruling and is unchanged by this module.
 *
 * ═══ WHY THIS LIVES HERE AND NOT IN `StatisticsTable` ═══
 *
 * It used to, and the note above used to end "doing it in the browser fixes
 * one surface, which is this one". It reached TWO — the table and the run
 * totals tiles — and stopped, so `trends.ts` plotted a p99 ABOVE the max the
 * same run's page had clamped, and `compare.ts` did the same per bucket.
 * Measured across nine real runs: 30 of 384 percentile values (7.8%) sit
 * above their own maximum, worst +0.59%, which is DDSketch's 1% bound
 * behaving exactly as advertised.
 *
 * `PercentileRange`'s own docstring below already NAMED `TrendRun` as a
 * caller it was narrowed for — and that caller never called it. The barrier
 * was layering rather than intent: `charts/transforms/*.ts` are pure, and
 * importing a React component into one to reach a `Math.min` is not
 * something to do. So the decision moved to a module every surface can
 * reach, which is what `isChangeGood` did when the matrix needed the
 * direction rule `compareSummary` owned.
 */
export function clampPercentile(value: number, row: PercentileRange): number {
  return Math.min(Math.max(value, row.minMs), row.maxMs);
}

/**
 * The two exactly-tracked extremes an estimate is clamped against — narrower
 * than `StatRow` on purpose, so `TrendRun` (which carries the same pair, from
 * the same rollup) can be clamped by the same function rather than by a
 * second copy of `Math.min(Math.max(...))` in `RunStats`.
 */
export interface PercentileRange {
  readonly minMs: number;
  readonly maxMs: number;
}
