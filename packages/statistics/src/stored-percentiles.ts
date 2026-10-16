import type { Histogram } from './histogram.js';
import { clampPercentile } from './percentile.js';
import { mergedHistogram, percentilesOf } from './rollup.js';

/** What a stored statistics row carries for recomputing its percentiles. */
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

/**
 * Percentiles for a STORED row at the project's current set (spec §4).
 *
 * An exact row (both histograms present and `sparse-ms-v2`) is recomputed
 * from its histograms — exact at any percentile. A row written before
 * 2026-10-15 keeps the legacy path it has always had: its sketch, clamped
 * against its exact extremes, so its numbers do not move until the backfill
 * (PR 2) rewrites it. With neither, or with no observations, the frozen
 * column is the only answer.
 *
 * This is the ONE production caller of a sketch quantile, and the clamp is
 * what `clamped-quantiles.test.ts` requires of it.
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
