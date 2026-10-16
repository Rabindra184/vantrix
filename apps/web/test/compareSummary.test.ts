import { describe, expect, it } from 'vitest';
import type { StatsResponse } from '@perfportal/contracts';
import { buildCompareSummary, runMetricValue } from '../src/routes/compareSummary';

function stats(over: Partial<StatsResponse['stats'][number]>): StatsResponse {
  return {
    runId: '00000000-0000-4000-8000-000000000000',
    window: null,
    configurable: true,
    bounds: { lowerMs: 800, higherMs: 1200 },
    indicators: { under: 0, between: 0, over: 0, failed: 0 },
    stats: [
      {
        scope: 'run',
        name: '',
        family: 'response_time',
        count: 100,
        okCount: 95,
        koCount: 5,
        errorRate: 0.05,
        minMs: 20,
        maxMs: 900,
        meanMs: 120,
        stddevMs: 15,
        throughputRps: 50,
        percentiles: { p50: 90, p95: 300, p99: 700 },
        indicators: { under: 80, between: 15, over: 0, failed: 5 },
        ...over,
      },
    ],
  };
}

describe('compareSummary', () => {
  it('reads run-level values for the selected metric', () => {
    expect(runMetricValue(stats({ percentiles: { p95: 250 } }), 'p95')).toBe(250);
    expect(runMetricValue(stats({ throughputRps: 42 }), 'throughput')).toBe(42);
    expect(runMetricValue(stats({ throughputRps: 20, errorRate: 0.1 }), 'errors')).toBe(2);
  });

  it('marks lower latency as better and names the best selected run', () => {
    const summary = buildCompareSummary(
      [
        { id: 'current', label: 'Current', exact: true, stats: stats({ percentiles: { p95: 240 } }) },
        { id: 'baseline', label: 'Baseline', exact: true, stats: stats({ percentiles: { p95: 300 } }) },
      ],
      'current',
      'p95',
    );

    expect(summary.deltaPercent).toBe(-20);
    expect(summary.deltaGood).toBe(true);
    expect(summary.bestLabel).toBe('Current');
  });

  it('marks higher throughput as better', () => {
    const summary = buildCompareSummary(
      [
        { id: 'current', label: 'Current', exact: true, stats: stats({ throughputRps: 80 }) },
        { id: 'baseline', label: 'Baseline', exact: true, stats: stats({ throughputRps: 100 }) },
      ],
      'current',
      'throughput',
    );

    expect(summary.deltaPercent).toBe(-20);
    expect(summary.deltaGood).toBe(false);
    expect(summary.bestLabel).toBe('Baseline');
  });
});

/**
 * REVIEW M05 — A ZERO BASELINE IS A BASELINE.
 *
 * `deltaPercent` is null for three quite different reasons: no baseline was
 * selected, a value could not be measured, or the baseline is ZERO and a
 * relative change is undefined. The UI rendered all three as "Waiting for
 * baseline" — which is false for the third, and false in the case that matters
 * most: errors rising from 0 to 2/s is the regression an engineer most needs
 * to see, and it is exactly when the baseline is zero.
 *
 * The model has to distinguish them; the tile can then say "0 → 2/s, relative
 * change undefined" rather than pretending nothing was selected.
 */
describe('buildCompareSummary — why a delta is missing', () => {
  const row = (id: string, value: number) => ({
    id,
    label: id,
    exact: true,
    stats: {
      runId: id,
      stats: [
        {
          scope: 'run' as const,
          name: '',
          family: 'response_time' as const,
          count: 100,
          okCount: 100,
          koCount: 0,
          errorRate: value,
          minMs: 1,
          maxMs: 2,
          meanMs: 1,
          stddevMs: 0,
          throughputRps: 1,
          percentiles: { p95: 10 },
          indicators: { under: 0, between: 0, over: 0, failed: 0 },
        },
      ],
      indicators: { under: 0, between: 0, over: 0, failed: 0 },
      configurable: true,
      bounds: { lowerMs: 800, higherMs: 1200 },
      window: null,
    },
  });

  it('reports a zero baseline as undefined-relative, not as missing', () => {
    // errors: `throughputRps * errorRate`, so errorRate 0 gives a zero baseline.
    const summary = buildCompareSummary([row('b', 0), row('a', 2)], 'a', 'errors');
    expect(summary.baselineValue).toBe(0);
    expect(summary.deltaPercent).toBeNull();
    expect(summary.deltaUnavailable).toBe('zero-baseline');
  });

  it('distinguishes that from having no baseline at all', () => {
    const summary = buildCompareSummary([row('a', 2)], 'a', 'errors');
    expect(summary.baselineValue).toBeNull();
    expect(summary.deltaUnavailable).toBe('no-baseline');
  });

  it('reports nothing unavailable when the delta is real', () => {
    const summary = buildCompareSummary([row('b', 1), row('a', 2)], 'a', 'errors');
    expect(summary.deltaPercent).toBeCloseTo(100, 6);
    expect(summary.deltaUnavailable).toBeNull();
  });
});

/**
 * ═══ ≈ ON A TILE WHOSE FIGURE CAME FROM AN ESTIMATE ═══
 *
 * Per run, from each run's own `statsMethod` (carried as `exact`). The delta
 * is approximate when EITHER side was estimated — a difference is no more
 * exact than its least exact term — and "Best selected" follows the run it
 * names. Only for a PERCENTILE: an estimated run's max, throughput and error
 * rate are exact counts and extremes, and a ≈ on them would mark a figure
 * that is not an estimate.
 */
describe('buildCompareSummary — which figures are estimates', () => {
  const at = (id: string, p95: number, exact: boolean) => ({
    id,
    label: id,
    exact,
    stats: stats({ percentiles: { p95 }, throughputRps: p95 }),
  });

  it('marks the delta when either side is estimated, and the best by its own run', () => {
    const bothExact = buildCompareSummary([at('a', 200, true), at('b', 300, true)], 'a', 'p95');
    expect([bothExact.deltaExact, bothExact.bestExact]).toEqual([true, true]);

    const baselineEstimated = buildCompareSummary([at('a', 200, true), at('b', 300, false)], 'a', 'p95');
    // The best (a, 200) is exact; the delta leans on the estimated baseline.
    expect([baselineEstimated.deltaExact, baselineEstimated.bestExact]).toEqual([false, true]);

    const currentEstimated = buildCompareSummary([at('a', 200, false), at('b', 300, true)], 'a', 'p95');
    expect([currentEstimated.deltaExact, currentEstimated.bestExact]).toEqual([false, false]);
  });

  it('makes no estimate claim for a metric that is not a percentile', () => {
    for (const metric of ['max', 'throughput', 'errors'] as const) {
      const summary = buildCompareSummary([at('a', 200, false), at('b', 300, false)], 'a', metric);
      expect([summary.deltaExact, summary.bestExact], metric).toEqual([true, true]);
    }
  });
});
