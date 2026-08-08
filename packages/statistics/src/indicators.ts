import type { Histogram } from './histogram.js';

export interface IndicatorBands { under: number; between: number; over: number; failed: number; }

/**
 * Bands folded out of the OK histogram at read time.
 *
 * Previously an IndicatorCounter incremented during ingest, whose result was
 * written to a `run_indicator` table. That froze the bounds at ingest: changing
 * a project's thresholds could not restate its own history, and AC-PARITY-4
 * ("non-default bounds render accordingly") would have held only for runs
 * ingested after the change. An exact histogram makes the bounds a display
 * threshold applied to complete data, so the table is gone.
 *
 * `failed` is the KO count, which lives on run_stat.ko_count - it is not a
 * response-time band and must never be derived from the OK histogram.
 */
export function bandsFrom(
  ok: Histogram,
  koCount: number,
  bounds: { lowerMs: number; higherMs: number },
): IndicatorBands {
  const under = ok.countBelow(bounds.lowerMs);
  const belowHigher = ok.countBelow(bounds.higherMs);
  return {
    under,
    between: belowHigher - under,
    over: ok.total - belowHigher,
    failed: koCount,
  };
}

/** Warm-up requests stay in the time series but are excluded from summary stats (PRD 7.4). */
export function isWarmup(tsMs: number, runStartMs: number, warmupMs: number): boolean {
  return warmupMs > 0 && tsMs - runStartMs < warmupMs;
}
