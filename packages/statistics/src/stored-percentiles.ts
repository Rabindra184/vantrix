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
}

/**
 * Percentiles for a STORED row at the project's current set (spec §4).
 *
 * An exact row (both histograms present and `sparse-ms-v2`) is recomputed
 * from its histograms — exact at any percentile.
 *
 * A LEGACY row — written before 2026-10-15 and not (yet) recomputed from its
 * raw log — has nothing left to recompute from: the DDSketch it once carried
 * was dropped with the run_stat.sketch column. It answers the ranks its frozen
 * column stored, each clamped against the row's exact extremes (the retired
 * sketch overshot its own maximum by up to 1%, and the browser already showed
 * that value clamped). A requested rank the row never stored is OMITTED — the
 * statistics table draws a dash — never zero and never interpolated between
 * the stored neighbours, which would be a number nobody measured.
 *
 * A row with no observations answers its frozen column as it always has.
 */
export function storedPercentiles(row: StoredPercentileSource, set: readonly number[]): Record<string, number> {
  if (row.count === 0) return row.percentiles;
  const { histogramOk: ok, histogramKo: ko } = row;
  if (ok && ko && ok.exact && ko.exact) return percentilesOf(mergedHistogram(ok, ko), set);
  const out: Record<string, number> = {};
  for (const p of set) {
    const key = `p${p}`;
    const stored = row.percentiles[key];
    if (stored !== undefined) out[key] = clampPercentile(stored, row);
  }
  return out;
}
