import { describe, expect, it } from 'vitest';
import type { StatsResponse } from '@perfportal/contracts';
import { buildCompareSummary } from '../src/routes/compareSummary';
import { metricValue, toCompareMatrix, type CompareStats } from '../src/tables/buildCompareMatrix';

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
  /* `runMetricValue` is gone: the tiles read the matrix's first row now, so
     the only reader of the run row's per-metric value is `metricValue` — kept
     pinned here, errors as a RATE included, because the overlay's word means it. */
  it('reads run-level values for the selected metric', () => {
    const row = (over: Partial<StatsResponse['stats'][number]>) => stats(over).stats[0]!;
    expect(metricValue(row({ percentiles: { p95: 250 } }), 'p95')).toBe(250);
    expect(metricValue(row({ throughputRps: 42 }), 'throughput')).toBe(42);
    expect(metricValue(row({ throughputRps: 20, errorRate: 0.1 }), 'errors')).toBe(2);
  });

  it('marks lower latency as better and names the best selected run', () => {
    const summary = buildCompareSummary(
      [
        { id: 'current', label: 'Current', exact: true, stats: stats({ percentiles: { p95: 240 } }), peakUsers: null, cpu: null },
        { id: 'baseline', label: 'Baseline', exact: true, stats: stats({ percentiles: { p95: 300 } }), peakUsers: null, cpu: null },
      ],
      'current',
      'baseline',
      'p95',
    );

    expect(summary.deltaPercent).toBe(-20);
    expect(summary.deltaGood).toBe(true);
    expect(summary.bestLabel).toBe('Current');
  });

  it('marks higher throughput as better', () => {
    const summary = buildCompareSummary(
      [
        { id: 'current', label: 'Current', exact: true, stats: stats({ throughputRps: 80 }), peakUsers: null, cpu: null },
        { id: 'baseline', label: 'Baseline', exact: true, stats: stats({ throughputRps: 100 }), peakUsers: null, cpu: null },
      ],
      'current',
      'baseline',
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
 * The model has to distinguish them; the tile can then say "0 → 2 failed,
 * relative change undefined" rather than pretending nothing was selected. (The
 * tiles read the table's first row now, so the errors tile counts failed
 * requests rather than the overlay's rate — see `unit` below.)
 */
describe('buildCompareSummary — why a delta is missing', () => {
  const row = (id: string, value: number) => ({
    id,
    label: id,
    exact: true,
    peakUsers: null,
    cpu: null,
    stats: {
      runId: id,
      stats: [
        {
          scope: 'run' as const,
          name: '',
          family: 'response_time' as const,
          count: 100,
          okCount: 100 - value,
          koCount: value,
          errorRate: value / 100,
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
    // errors: the matrix's first row is `Count` (koCount), so 0 KO is a zero baseline.
    const summary = buildCompareSummary([row('b', 0), row('a', 2)], 'a', 'b', 'errors');
    expect(summary.baselineValue).toBe(0);
    expect(summary.deltaPercent).toBeNull();
    expect(summary.deltaUnavailable).toBe('zero-baseline');
  });

  it('distinguishes that from having no baseline at all', () => {
    const summary = buildCompareSummary([row('a', 2)], 'a', null, 'errors');
    expect(summary.baselineValue).toBeNull();
    expect(summary.deltaUnavailable).toBe('no-baseline');
  });

  it('reports nothing unavailable when the delta is real', () => {
    const summary = buildCompareSummary([row('b', 1), row('a', 2)], 'a', 'b', 'errors');
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
    peakUsers: null,
    cpu: null,
    stats: stats({ percentiles: { p95 }, throughputRps: p95 }),
  });

  it('marks the delta when either side is estimated, and the best by its own run', () => {
    const bothExact = buildCompareSummary([at('a', 200, true), at('b', 300, true)], 'a', 'b', 'p95');
    expect([bothExact.deltaExact, bothExact.bestExact]).toEqual([true, true]);

    const baselineEstimated = buildCompareSummary([at('a', 200, true), at('b', 300, false)], 'a', 'b', 'p95');
    // The best (a, 200) is exact; the delta leans on the estimated baseline.
    expect([baselineEstimated.deltaExact, baselineEstimated.bestExact]).toEqual([false, true]);

    const currentEstimated = buildCompareSummary([at('a', 200, false), at('b', 300, true)], 'a', 'b', 'p95');
    expect([currentEstimated.deltaExact, currentEstimated.bestExact]).toEqual([false, false]);
  });

  /** "Select a baseline run" and "Not measured" state no number: no ≈, even
   *  when a run is estimated. One rule, in the model — not patched in by the tile. */
  it('makes no estimate claim where the tile states no figure', () => {
    const noBaseline = buildCompareSummary([at('a', 200, false)], 'a', null, 'p95');
    expect(noBaseline.deltaUnavailable).toBe('no-baseline');
    expect(noBaseline.deltaExact).toBe(true);

    const unmeasured = { id: 'b', label: 'b', exact: false, stats: stats({ percentiles: {} }), peakUsers: null, cpu: null };
    const notMeasured = buildCompareSummary([at('a', 200, false), unmeasured], 'a', 'b', 'p95');
    expect(notMeasured.deltaUnavailable).toBe('not-measured');
    expect(notMeasured.deltaExact).toBe(true);
  });

  it('makes no estimate claim for a metric that is not a percentile', () => {
    for (const metric of ['max', 'throughput', 'errors'] as const) {
      const summary = buildCompareSummary([at('a', 200, false), at('b', 300, false)], 'a', 'b', metric);
      expect([summary.deltaExact, summary.bestExact], metric).toEqual([true, true]);
    }
  });
});

/**
 * ═══ THE TILES FOLLOW THE REFERENCE, AND READ THE TABLE'S OWN FIRST ROW ═══
 *
 * The tiles and the comparison table sit one above the other and state the
 * same comparison, so they are built from one source: each run's value is its
 * cell in `toCompareMatrix`'s FIRST row, measured against the reference the
 * table uses (`resolveReference`'s answer, passed in). Before this, the tiles
 * compared "the first other run" whatever the reader had pinned, read the run
 * row on their own (errors as a RATE where the table's first row is a COUNT),
 * and coloured an unchanged figure as an improvement where the table drew a
 * muted `=`. Expectations below are read off the matrix, so these cases state
 * agreement rather than restating numbers.
 */
describe('buildCompareSummary — follows the reference', () => {
  const run = (
    id: string,
    over: Partial<StatsResponse['stats'][number]>,
    extra: Partial<Pick<CompareStats, 'peakUsers' | 'cpu'>> = {},
  ): CompareStats => ({
    id,
    label: `Run ${id}`,
    exact: true,
    stats: stats(over),
    peakUsers: extra.peakUsers ?? null,
    cpu: extra.cpu ?? null,
  });

  /** The first matrix row's cell for one run, against one reference. */
  const firstRowCell = (
    runs: readonly CompareStats[],
    reference: string | null,
    metric: Parameters<typeof toCompareMatrix>[1],
    id: string,
  ) => {
    const m = toCompareMatrix(runs, metric, reference);
    const column = m.columns.findIndex((c) => c.id === id);
    return m.rows[0]!.cells[column] ?? null;
  };

  it('compares the current run against a pinned reference', () => {
    const runs = [
      run('a', { percentiles: { p95: 240 } }),
      run('b', { percentiles: { p95: 300 } }),
      run('c', { percentiles: { p95: 480 } }),
    ];
    // Pinned on c: the default ("first other run") would be b.
    const summary = buildCompareSummary(runs, 'a', 'c', 'p95');
    const cell = firstRowCell(runs, 'c', 'p95', 'a')!;

    expect(summary.currentLabel).toBe('Run a');
    expect(summary.baselineLabel).toBe('Run c');
    expect(summary.baselineValue).toBe(firstRowCell(runs, 'c', 'p95', 'c')!.value);
    expect(summary.currentValue).toBe(cell.value);
    expect(summary.deltaPercent).toBe(cell.change!.percent);
    expect(summary.deltaGood).toBe(cell.change!.good);
    expect(summary.deltaUnavailable).toBeNull();
  });

  /* Review focus 5: pinning the run being read must not reduce the tile to a
     self-comparison of 0%. The subject becomes the first OTHER selected run. */
  it('reference is the current run', () => {
    const runs = [
      run('a', { percentiles: { p95: 240 } }),
      run('b', { percentiles: { p95: 300 } }),
      run('c', { percentiles: { p95: 480 } }),
    ];
    const summary = buildCompareSummary(runs, 'a', 'a', 'p95');
    const cell = firstRowCell(runs, 'a', 'p95', 'b')!;

    expect(summary.currentLabel).toBe('Run b');
    expect(summary.baselineLabel).toBe('Run a');
    expect(summary.currentValue).toBe(cell.value);
    expect(summary.deltaPercent).toBe(cell.change!.percent);
    expect(summary.deltaPercent).not.toBe(0);
    expect(summary.deltaUnavailable).toBeNull();
  });

  it('states no comparison when the reference is the only run', () => {
    const summary = buildCompareSummary([run('a', { percentiles: { p95: 240 } })], 'a', 'a', 'p95');
    expect(summary.deltaUnavailable).toBe('no-baseline');
    expect(summary.deltaPercent).toBeNull();
    expect(summary.baselineLabel).toBeNull();
  });

  /* errors: the table's first row is `Count` (koCount), not the overlay's
     KO-per-second rate — so the tiles read a count, and say so in their unit. */
  it('uses the first matrix row', () => {
    const runs = [
      // Rates (40 × 0.25 = 10/s, 10 × 0.1 = 1/s) differ from both counts, so a
      // tile that read the overlay's rate cannot pass on either side.
      run('a', { koCount: 12, throughputRps: 40, errorRate: 0.25 }),
      run('b', { koCount: 8, throughputRps: 10, errorRate: 0.1 }),
    ];
    const summary = buildCompareSummary(runs, 'a', 'b', 'errors');
    const m = toCompareMatrix(runs, 'errors', 'b');

    expect(m.rows[0]!.label).toBe('Count');
    expect(summary.currentValue).toBe(runs[0]!.stats!.stats[0]!.koCount);
    expect(summary.baselineValue).toBe(runs[1]!.stats!.stats[0]!.koCount);
    expect(summary.currentValue).toBe(firstRowCell(runs, 'b', 'errors', 'a')!.value);
    expect(summary.unit).toBe('failed');
    // The best is read off the same row: the fewer failed requests.
    expect(summary.bestLabel).toBe('Run b');
    expect(summary.bestValue).toBe(runs[1]!.stats!.stats[0]!.koCount);
  });

  it('neutral for users', () => {
    const runs = [
      run('a', {}, { peakUsers: 40 }),
      run('b', {}, { peakUsers: 20 }),
    ];
    const summary = buildCompareSummary(runs, 'a', 'b', 'users');
    const cell = firstRowCell(runs, 'b', 'users', 'a')!;

    // A change is still stated: users doubled.
    expect(summary.deltaPercent).toBe(cell.change!.percent);
    expect(summary.deltaPercent).toBe(100);
    // With no direction, nothing is better or worse, and no run is "best".
    expect(summary.deltaGood).toBeNull();
    expect(summary.directional).toBe(false);
    expect(summary.bestLabel).toBeNull();
    expect(summary.bestValue).toBeNull();
    expect(summary.unit).toBe('users');
  });

  it('colours an unchanged figure as neither better nor worse, as the table does', () => {
    const runs = [run('a', { percentiles: { p95: 300 } }), run('b', { percentiles: { p95: 300 } })];
    const summary = buildCompareSummary(runs, 'a', 'b', 'p95');

    expect(summary.deltaPercent).toBe(0);
    expect(summary.deltaGood).toBe(firstRowCell(runs, 'b', 'p95', 'a')!.change!.good);
    expect(summary.deltaGood).toBeNull();
    expect(summary.directional).toBe(true);
  });

  /* A zero baseline has no percentage and still has a direction: 0 → 12
     failed is the regression an engineer most needs to see, and the table
     colours it. The tile agrees. */
  it('judges a change from a zero baseline as the table does', () => {
    const runs = [run('a', { koCount: 12 }), run('b', { koCount: 0 })];
    const summary = buildCompareSummary(runs, 'a', 'b', 'errors');

    expect(summary.deltaUnavailable).toBe('zero-baseline');
    expect(summary.deltaGood).toBe(firstRowCell(runs, 'b', 'errors', 'a')!.change!.good);
    expect(summary.deltaGood).toBe(false);
  });
});
