/**
 * Where a percentile estimate is projected back onto what it can possibly be.
 *
 * A quantile of a sample cannot lie outside that sample's own range, so an
 * estimate that does is known to be wrong — and `minMs`/`maxMs` are tracked
 * EXACTLY while percentiles carry DDSketch's 1% relative error. Clamping
 * projects the estimate onto the interval it was always constrained to.
 *
 * ═══ IT IS A BETTER ESTIMATE, NOT A PRETTIER ONE ═══
 *
 * Measured on the reference run, whose true p99 is 2501 (`parity.test.ts`
 * PT-G-12 computes it from the sorted durations) against an exact maximum
 * of 2503:
 *
 *     raw       2515.4601126102525    0.578% from the truth
 *     clamped   2503                  0.080% from the truth     7x closer
 *
 * ═══ WHY IT LIVES IN THIS PACKAGE ═══
 *
 * `apps/web/src/percentile.ts` has corrected four BROWSER surfaces since the
 * clamp branch, and its own docstring records that the right home is here,
 * "where the exact extremes and the estimated percentiles are produced
 * together", naming "the API, the charts, any future export" as the consumers
 * still waiting. It does not name the SLA EVALUATOR, which is the one consumer
 * that makes a JUDGEMENT rather than a display — and which was judging runs
 * against a value the product refuses to show. That is what brought this here.
 *
 * The browser copy STAYS, and not by oversight: `apps/web` does not depend on
 * `@perfportal/statistics` and adding that dependency to reach a `Math.min`
 * would pull the engine, the sketch and the histograms into the bundle. It
 * also still has raw input to correct — rows written before this existed are
 * not rewritten, and `apps/web/test/fixtures/reference-run.json` is a captured
 * payload carrying 2515.46.
 *
 * ═══ AND WHY IT IS NOT INSIDE `Sketch.quantile`, WHICH IS THE OBVIOUS PLACE ═══
 *
 * That function already answers rank 0 with `min` and rank n-1 with `max`, so
 * clamping an interior rank there looks like the same decision made once. It
 * was written that way first, and it is wrong after a round trip: a sketch's
 * tracked extremes are exact only until it is serialized, after which they are
 * reconstructed from the bucket store. Measured on the plateau fixture —
 *
 *     live      min 100                 max 2503
 *     reloaded  min 100.494567708565    max 2515.4601126101625
 *
 * — so the reloaded maximum IS the impossible value, and clamping against it
 * achieves nothing while looking complete. `packages/persistence`'s own
 * "answers a percentile that was never stored" case is what caught that,
 * by comparing a live sketch's quantiles against a reloaded one's.
 *
 * So the rule is per ASSEMBLER instead, and it is the one a reader checks:
 * **a percentile is clamped against the same min and max reported beside it.**
 * `StatRollupBuilder.finish` and `bucketLatency` assemble that triple;
 * `resolveMetric` and the metrics controller recompute a percentile against
 * one already assembled. `window.ts` needs no call — it reports the merged
 * RELOADED sketch's own extremes, so its estimates are bucket representatives
 * between two bucket representatives and cannot escape by construction.
 */
export function clampPercentile(value: number, range: PercentileRange): number {
  return Math.min(Math.max(value, range.minMs), range.maxMs);
}

/** The two exactly-tracked extremes an estimate is clamped against. */
export interface PercentileRange {
  readonly minMs: number;
  readonly maxMs: number;
}
