import type { StatRollup } from '@perfportal/statistics';
import type { EvaluableStat } from './metrics.js';

/**
 * THE ONE MAPPING from the engine's rollups into the evaluator's input.
 *
 * `PipelineService` evaluates a finished run; `LiveFoldOwner` evaluates the
 * same run while it streams. A second copy drifts, and the drift surfaces as a
 * live breach that disagrees with the final verdict for the same run -- the
 * same failure, on the same product surface, as a live chart contradicting the
 * final report. This project has already paid for that lesson twice, in the
 * record decoder and in `bucketLatency`.
 *
 * THE EXPLICIT FIELD LIST IS THE POINT, even though `StatRollup` is already
 * structurally assignable to `EvaluableStat` and the type checker would accept
 * a pass-through. This is a boundary: a field added to `StatRollup` must not
 * become an input to SLA evaluation without someone deciding that it should.
 */
export function toEvaluableStats(stats: readonly StatRollup[]): EvaluableStat[] {
  return stats.map((s) => ({
    scope: s.scope,
    name: s.name,
    family: s.family,
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
    sketch: s.sketch,
  }));
}
