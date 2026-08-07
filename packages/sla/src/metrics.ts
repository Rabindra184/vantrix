import type { Sketch } from '@perfportal/statistics';

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
  /** The persisted summary sketch, when loaded. */
  sketch?: Sketch;
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
 * summary sketch. That fallback is why summary sketches are persisted at all
 * (spec §9.1): a rule may ask for p99.9 while the project stores only
 * [50, 75, 95, 99], and the alternative would be freezing the answerable
 * percentile set at ingest time forever.
 */
export function resolveMetric(stat: EvaluableStat, metric: string): number | null {
  const scalar = SCALARS[metric];
  if (scalar) return scalar(stat);

  const m = PERCENTILE.exec(metric);
  if (!m) return null;

  const stored = stat.percentiles[metric];
  if (stored !== undefined) return stored;

  const p = Number(m[1]);
  if (!(p > 0 && p < 100)) return null;
  if (!stat.sketch || stat.sketch.count === 0) return null;
  return stat.sketch.quantile(p / 100);
}
