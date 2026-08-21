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
        { id: 'current', label: 'Current', stats: stats({ percentiles: { p95: 240 } }) },
        { id: 'baseline', label: 'Baseline', stats: stats({ percentiles: { p95: 300 } }) },
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
        { id: 'current', label: 'Current', stats: stats({ throughputRps: 80 }) },
        { id: 'baseline', label: 'Baseline', stats: stats({ throughputRps: 100 }) },
      ],
      'current',
      'throughput',
    );

    expect(summary.deltaPercent).toBe(-20);
    expect(summary.deltaGood).toBe(false);
    expect(summary.bestLabel).toBe('Baseline');
  });
});
