import type { DistributionResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toPercentileDistribution } from '../src/charts/transforms/percentileDistribution';
import fixture from './fixtures/reference-run.json';

const distribution = fixture.distribution as unknown as DistributionResponse;

/** The `[percentile, responseTimeMs]` pairs of the one drawn series. */
function points(d: DistributionResponse, outcome: 'ok' | 'ko' | 'all') {
  const data = toPercentileDistribution(d, outcome).series[0]?.data;
  return (data ?? []) as readonly (readonly [number, number])[];
}

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

describe('toPercentileDistribution', () => {
  it('rises monotonically in both axes', () => {
    // A percentile curve that ever descends is not a percentile curve. Both
    // axes: the x because it is a cumulative share, the y because the labels
    // are walked in ascending order.
    const p = points(distribution, 'ok');
    expect(p.length).toBeGreaterThan(1);

    for (let i = 1; i < p.length; i += 1) {
      expect(p[i]![0]).toBeGreaterThan(p[i - 1]![0]);
      expect(p[i]![1]).toBeGreaterThanOrEqual(p[i - 1]![1]);
    }
  });

  it('reaches 100 per cent of the binned observations', () => {
    const p = points({ ...distribution, overflowCount: 0 }, 'ok');
    expect(p.at(-1)![0]).toBeCloseTo(100, 6);
  });

  it('plots payload labels as the y values, never a bin index', () => {
    // The parity surface for "bin labels exact" — plotting the INDEX is what a
    // histogram invites and would lose the one quantity G-20/G-21 name.
    for (const [, y] of points(distribution, 'ok')) {
      expect(distribution.labels).toContain(y);
    }
  });

  it('adds no point for a bin nothing landed in', () => {
    // Such a point would repeat the previous percentile at a higher response
    // time, drawing a horizontal run that asserts observations at times
    // nothing was observed at.
    const nonEmpty = distribution.okCount.filter((n) => n > 0).length;
    expect(points(distribution, 'ok')).toHaveLength(nonEmpty);
  });

  it('counts every binned observation of the selected outcome', () => {
    // Derived from the payload: the last cumulative figure in the table is the
    // outcome's own total, so nothing was dropped on the way through.
    const rows = toPercentileDistribution(distribution, 'ok').rows;
    expect(Number(rows.at(-1)!.values[1])).toBe(sum(distribution.okCount));
  });

  it('combines both outcomes when all is selected', () => {
    const rows = toPercentileDistribution(distribution, 'all').rows;
    expect(Number(rows.at(-1)!.values[1])).toBe(
      sum(distribution.okCount) + sum(distribution.koCount),
    );
  });

  it('draws a different curve for KO than for OK', () => {
    // The fixture has failures, and they are slower than the successes. If
    // these two ever match, the outcome argument is being ignored.
    expect(sum(distribution.koCount)).toBeGreaterThan(0);
    expect(points(distribution, 'ko')).not.toEqual(points(distribution, 'ok'));
  });

  it('says so when observations overflowed the histogram', () => {
    const d = { ...distribution, overflowCount: 7 };
    expect(toPercentileDistribution(d, 'ok').limitation).toContain('7');
  });

  it('states no limitation when nothing overflowed', () => {
    const d = { ...distribution, overflowCount: 0 };
    expect(toPercentileDistribution(d, 'ok').limitation).toBeUndefined();
  });

  it('is empty, with a reason, for an outcome that recorded nothing', () => {
    const d = { ...distribution, koCount: distribution.koCount.map(() => 0) };
    const data = toPercentileDistribution(d, 'ko');
    expect(data.series).toHaveLength(0);
    expect(data.empty).toBeTruthy();
  });

  it('tells a run with no data apart from an outcome with none', () => {
    // A reader acts on these differently, so they must not read the same.
    const noData = toPercentileDistribution(
      { ...distribution, labels: [], okCount: [], koCount: [] },
      'ok',
    );
    const noKo = toPercentileDistribution(
      { ...distribution, koCount: distribution.koCount.map(() => 0) },
      'ko',
    );
    expect(noData.empty).not.toBe(noKo.empty);
  });

  it('names the label kind, so a midpoint is not read as an observation', () => {
    const exact = toPercentileDistribution({ ...distribution, exactValues: true }, 'ok');
    const binned = toPercentileDistribution({ ...distribution, exactValues: false }, 'ok');
    expect(exact.columns[1]).toContain('exact');
    expect(binned.columns[1]).toContain('midpoint');
  });

  it('carries a row per drawn point, so the table and the drawing agree', () => {
    const data = toPercentileDistribution(distribution, 'ok');
    expect(data.rows).toHaveLength(points(distribution, 'ok').length);
  });
});
