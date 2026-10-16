import type { Bucket } from './buckets.js';
import { BUCKET_PERCENTILES } from './engine.js';
import { Histogram } from './histogram.js';
import { percentilesOf } from './rollup.js';

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
 * THE ONLY derivation of a bucket's latency fields, and that is deliberate.
 *
 * `MetricWriter` persists these for a finished run; `buildDelta` publishes them
 * for a live one. A second copy drifts, and the drift surfaces as the live
 * chart contradicting the final report -- the worst failure this product can
 * produce, and the same argument that keeps exactly one record decoder.
 *
 * Every figure is exact, read from the bucket's status histograms (their merge
 * for the combined fields). The empty-population answers are where a
 * reimplementation goes wrong: percentiles collapse to {} while min/max/mean
 * stay 0, because the writer's columns are NOT NULL and a fabricated
 * percentile is worse than an absent one.
 */
export function bucketLatency(b: Pick<Bucket, 'histogramOk' | 'histogramKo'>): BucketLatency {
  // A fresh merge, deliberately NOT `mergedHistogram`'s memoised one: a live
  // run's buckets are long-lived accumulators, and a memo keyed on each would
  // keep a second copy of every bucket's histogram for the life of the run,
  // for a merge that nothing else asks for.
  const all = new Histogram();
  all.merge(b.histogramOk);
  all.merge(b.histogramKo);
  return {
    minMs: all.min,
    maxMs: all.max,
    meanMs: all.total === 0 ? 0 : all.sum / all.total,
    percentiles: percentilesOf(all, BUCKET_PERCENTILES),
    percentilesOk: percentilesOf(b.histogramOk, BUCKET_PERCENTILES),
    percentilesKo: percentilesOf(b.histogramKo, BUCKET_PERCENTILES),
  };
}
