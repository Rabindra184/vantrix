import type { Histogram } from '@perfportal/statistics';

export interface EvaluableStat {
  scope: string;
  name: string;
  family: string;
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
  /** All-responses exact histogram, for percentiles outside the stored set. */
  histogram?: Histogram;
}

const SCALARS: Record<string, (s: EvaluableStat) => number> = {
  count: (s) => s.count,
  mean: (s) => s.meanMs,
  min: (s) => s.minMs,
  max: (s) => s.maxMs,
  stddev: (s) => s.stddevMs,
  error_rate: (s) => s.errorRate,
  throughput_rps: (s) => s.throughputRps,
};

/** p50, p95, p99.9 — a percentile is p followed by a number in (0, 100). */
const PERCENTILE = /^p(\d+(?:\.\d+)?)$/;

/**
 * Percentiles come from the stored JSONB when present, and otherwise from the
 * row's all-responses histogram, exactly: nearest-rank over the observed 1 ms
 * bins, at full precision (spec §2). That fallback is why the histograms are
 * kept and not only the configured columns: a rule may ask for p99.9 while the
 * project stores only [50, 75, 95, 99], and the alternative would be freezing
 * the answerable percentile set at ingest time forever.
 *
 * Both doors give the same answer, because the stored values are themselves
 * projections of that same merged histogram (`StatRollup.percentiles`). And a
 * nearest-rank answer is an OBSERVED value, so unlike the sketch estimate it
 * replaced it needs no clamp to stay inside the row's own min and max.
 */
export function resolveMetric(stat: EvaluableStat, metric: string): number | null {
  const scalar = SCALARS[metric];
  if (scalar) return scalar(stat);

  const m = PERCENTILE.exec(metric);
  if (!m) return null;

  const stored = stat.percentiles[metric];
  if (stored !== undefined) return stored;

  const p = Number(m[1]);
  // The pattern admits any number (`p150`), and `nearestRankIndex` THROWS
  // outside [0, 100] — a stored rule would take the whole evaluation down. An
  // unanswerable rank is unresolvable: null, which `evaluateRules` records as
  // `not_applicable`. The bound is strict at both ends to match
  // `isResolvableSlaMetric` in contracts (which pins this text): `p0` and
  // `p100` are the min and the max, and have their own scalar names.
  if (!(p > 0 && p < 100)) return null;
  // `undefined` for an empty histogram or a legacy overflow bin hiding the
  // rank — nothing measured, never a guessed extreme.
  return stat.histogram?.percentile(p) ?? null;
}
