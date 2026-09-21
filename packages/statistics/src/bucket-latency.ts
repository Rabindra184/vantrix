import type { Bucket } from './buckets.js';
import { BUCKET_PERCENTILES } from './engine.js';
import { clampPercentile } from './percentile.js';

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
 *
 * CLAMPED AGAINST THE SKETCH'S OWN EXTREMES, not the all-outcomes ones this
 * function is called with three times. A bucket reports one `minMs`/`maxMs`
 * pair — the all-outcomes sketch's — and the OK and KO populations are subsets
 * of it, so projecting each onto its own range is both tighter and still inside
 * what is reported. See `clampPercentile` for why this is not in `Sketch`.
 */
function percentilesOf(
  sketch: { count: number; min: number; max: number; quantile(q: number): number },
): Record<string, number> {
  if (sketch.count === 0) return {};
  const range = { minMs: sketch.min, maxMs: sketch.max };
  const out: Record<string, number> = {};
  for (const p of BUCKET_PERCENTILES) out[`p${p}`] = clampPercentile(sketch.quantile(p / 100), range);
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
