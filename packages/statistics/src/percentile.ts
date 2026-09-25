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
 * `RollupBuilder.finish` and `bucketLatency` assemble that triple;
 * `resolveMetric`, the metrics controller and `tool-assertions.ts` recompute a
 * percentile against one already assembled.
 *
 * ═══ AND THAT SENTENCE IS NO LONGER THE LIST ═══
 *
 * It was, and it drifted: the enumeration first written here named four call
 * sites, `tool-assertions.ts` was added as a fifth without touching it, and a
 * reader auditing this rule against that list would have concluded the G-05
 * verdict path was covered when it was judging Gatling assertions against an
 * estimate 12.46 ms above the run's own maximum. The names above are kept
 * because they orient a reader; they are NOT what keeps the rule true.
 *
 * `packages/statistics/test/clamped-quantiles.test.ts` derives the set from the
 * source — every `.quantile(` call in production must be wrapped in
 * `clampPercentile` or named in that file's `EXEMPT` with its reason — so a
 * sixth caller joins the check by EXISTING rather than by somebody remembering
 * this paragraph.
 *
 * `window.ts` needs no call, and THE REASON FIRST WRITTEN HERE WAS WRONG. It
 * said that file "reports the merged RELOADED sketch's own extremes", which
 * describes a mechanism it does not have: a windowed row is built from
 * `Histogram`, not `Sketch`. The conclusion survives and is stronger than the
 * argument it was given — a `Histogram` is an EXACT 1 ms structure whose
 * `quantile` is nearest-rank over observed values and whose `min`/`max` are
 * observed values, so its answer is inside its own range by construction
 * rather than by estimate. Corrected here rather than quietly, because a
 * docstring asserting a mechanism the code does not have is the defect this
 * very file was written to fix, and it went in with the fix.
 */
export function clampPercentile(value: number, range: PercentileRange): number {
  return Math.min(Math.max(value, range.minMs), range.maxMs);
}

/** The two exactly-tracked extremes an estimate is clamped against. */
export interface PercentileRange {
  readonly minMs: number;
  readonly maxMs: number;
}
