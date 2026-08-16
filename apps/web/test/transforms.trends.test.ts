import type { TrendRun, TrendsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  toPercentileTrend,
  toStatusTrend,
  toThroughputTrend,
} from '../src/charts/transforms/trends';
import fixture from './fixtures/reference-run.json';

/**
 * Built from the fixture's own run-scope stat row, so the numbers a trend
 * plots are the numbers this product really stores for a run rather than ones
 * invented here. Only the fields that vary run-to-run are parameters.
 */
const REFERENCE = fixture.stats.stats.find((s) => s.scope === 'run')!;

function run(over: Partial<TrendRun> & { id: string; startedAt: string }): TrendRun {
  return {
    toolStartedAt: over.startedAt,
    durationMs: 60_000,
    verdict: 'passed',
    count: REFERENCE.count,
    okCount: REFERENCE.okCount,
    koCount: REFERENCE.koCount,
    errorRate: REFERENCE.errorRate,
    minMs: REFERENCE.minMs,
    maxMs: REFERENCE.maxMs,
    meanMs: REFERENCE.meanMs,
    throughputRps: REFERENCE.throughputRps,
    percentiles: REFERENCE.percentiles,
    ...over,
  };
}

/** Newest first, as the endpoint returns them. */
function response(runs: TrendRun[], over: Partial<TrendsResponse> = {}): TrendsResponse {
  return {
    runId: runs[0]?.id ?? '00000000-0000-0000-0000-000000000000',
    simulation: 'checkout',
    cohortSize: runs.length,
    runs,
    ...over,
  };
}

const THREE = response([
  run({ id: 'c', startedAt: '2026-08-03T10:00:00.000Z' }),
  run({ id: 'b', startedAt: '2026-08-02T10:00:00.000Z' }),
  run({ id: 'a', startedAt: '2026-08-01T10:00:00.000Z' }),
]);

const ALL = [toStatusTrend, toPercentileTrend, toThroughputTrend] as const;

describe('the trend transforms, in general', () => {
  it('reverse the response, so the oldest run is on the left', () => {
    // The endpoint is newest-first to match /v1/runs; a trend reads
    // left-to-right in time. Asserted against the reversed INPUT rather than
    // against literals, so this cannot pass by coincidence.
    const oldestFirst = [...THREE.runs].reverse();

    for (const transform of ALL) {
      const d = transform(THREE);
      expect(d.axisLabels).toHaveLength(oldestFirst.length);
      // The first row must describe the oldest run, and rows line up with the
      // axis by construction.
      expect(d.rows[0]!.values).toContain(oldestFirst[0]!.startedAt);
      expect(d.rows.at(-1)!.values).toContain(oldestFirst.at(-1)!.startedAt);
    }
  });

  /**
   * THE AXIS LABEL IS A CLOCK THE READER RECOGNISES.
   *
   * These labels sit directly under a run header that renders the same
   * instant through `Intl.DateTimeFormat` in the viewer's zone, so a UTC axis
   * put two different readings of one moment on one page — `08-07 05:30`
   * beneath `Aug 7, 2026, 11:00 AM`. Nothing here asserted the label's TEXT
   * before, only its count, which is how the two drifted apart.
   *
   * Zone-pinned for the reason `transforms.compare.test.ts` explains at
   * length: on a UTC runner a local-vs-UTC assertion cannot fail.
   */
  it('label the axis in the reader’s zone, not UTC', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      expect(new Date('2026-08-07T00:00:00Z').getHours()).toBe(5);

      const one = response([run({ id: 'a', startedAt: '2026-08-07T19:00:00.000Z' })]);
      for (const transform of ALL) {
        // 19:00Z is 00:30 the NEXT day at +05:30 — so this pins the date as
        // well as the clock.
        expect(transform(one).axisLabels).toEqual(['08-08 00:30']);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('draw a cohort of one rather than falling back to the empty state', () => {
    // One datum is not no data.
    const one = response([run({ id: 'a', startedAt: '2026-08-01T10:00:00.000Z' })]);
    for (const transform of ALL) {
      const d = transform(one);
      expect(d.empty).toBeUndefined();
      expect(d.axisLabels).toHaveLength(1);
    }
  });

  it('explain an empty cohort instead of drawing empty axes', () => {
    for (const transform of ALL) {
      const d = transform(response([]));
      expect(d.series).toHaveLength(0);
      expect(d.empty).toBeTruthy();
    }
  });

  it('say when the window is shorter than the cohort', () => {
    const truncated = response([...THREE.runs], { cohortSize: 60 });
    for (const transform of ALL) {
      const d = transform(truncated);
      // Both numbers derived from the payload: a change to THREE's length must
      // not need this assertion edited to stay honest.
      expect(d.limitation).toContain(String(truncated.runs.length));
      expect(d.limitation).toContain(String(truncated.cohortSize));
    }
  });

  it('state no limitation when the window holds the whole cohort', () => {
    for (const transform of ALL) {
      expect(transform(THREE).limitation).toBeUndefined();
    }
  });

  it('carry one table row per run', () => {
    for (const transform of ALL) {
      expect(transform(THREE).rows).toHaveLength(THREE.runs.length);
    }
  });
});

describe('toStatusTrend', () => {
  it('plots percentages, so runs of different sizes are comparable', () => {
    // A run of 100 and a run of 100,000 with the same failure ratio must draw
    // at the same height; raw counts would make load look like quality.
    const big = response([
      run({ id: 'big', startedAt: '2026-08-02T10:00:00.000Z', count: 1000, okCount: 900, koCount: 100 }),
      run({ id: 'small', startedAt: '2026-08-01T10:00:00.000Z', count: 10, okCount: 9, koCount: 1 }),
    ]);
    const d = toStatusTrend(big);

    const ok = d.series.find((s) => s.name === 'OK')!.data as readonly (number | null)[];
    const ko = d.series.find((s) => s.name === 'KO')!.data as readonly (number | null)[];
    // Derived from the two runs' own counts, so the point being made — that
    // the SHARE is what is plotted — survives a change to either run's size.
    const shares = [...big.runs].reverse().map((r) => [
      (r.okCount / r.count) * 100,
      (r.koCount / r.count) * 100,
    ]);
    expect(ok).toEqual(shares.map(([o]) => o));
    expect(ko).toEqual(shares.map(([, k]) => k));
  });

  it('sums to 100 per run', () => {
    const d = toStatusTrend(THREE);
    const ok = d.series.find((s) => s.name === 'OK')!.data as readonly (number | null)[];
    const ko = d.series.find((s) => s.name === 'KO')!.data as readonly (number | null)[];
    ok.forEach((value, i) => expect(value! + ko[i]!).toBeCloseTo(100, 6));
  });

  it('leaves a run that recorded nothing as a gap, not as zero per cent', () => {
    // 0/0 is not 0%. A run with no requests did not succeed none of them.
    const d = toStatusTrend(
      response([run({ id: 'a', startedAt: '2026-08-01T10:00:00.000Z', count: 0, okCount: 0, koCount: 0 })]),
    );
    for (const series of d.series) {
      expect((series.data as readonly (number | null)[])[0]).toBeNull();
    }
  });
});

describe('toPercentileTrend', () => {
  it('draws one series per percentile the payload carries, in numeric order', () => {
    const d = toPercentileTrend(THREE);
    const keys = Object.keys(REFERENCE.percentiles);
    expect(d.series).toHaveLength(keys.length);

    // Numeric, not lexicographic: p99.9 must not sort before p50.
    const asNumbers = d.series.map((s) => Number.parseFloat(s.name.replace('%', '')));
    expect(asNumbers).toEqual([...asNumbers].sort((x, y) => x - y));
  });

  it('finds a percentile the reference set does not have, if a run carries it', () => {
    // The set is per project and configurable, so it is read off the payload
    // rather than assumed.
    const d = toPercentileTrend(
      response([
        run({
          id: 'a',
          startedAt: '2026-08-01T10:00:00.000Z',
          percentiles: { ...REFERENCE.percentiles, 'p99.9': 1234 },
        }),
      ]),
    );
    // The label is derived from the key that was added, not written twice.
    expect(d.series.map((s) => s.name)).toContain(`${Number.parseFloat('99.9')}%`);
  });

  it('leaves a run missing a percentile as a gap, not zero', () => {
    const d = toPercentileTrend(
      response([
        run({ id: 'b', startedAt: '2026-08-02T10:00:00.000Z', percentiles: { p50: 5 } }),
        run({ id: 'a', startedAt: '2026-08-01T10:00:00.000Z', percentiles: { p50: 4, p95: 9 } }),
      ]),
    );
    const p95 = d.series.find((s) => s.name === '95%')!.data as readonly (number | null)[];
    // Oldest first: 'a' has p95, 'b' does not.
    expect(p95[0]).toBe(9);
    expect(p95[1]).toBeNull();
  });
});

describe('toThroughputTrend', () => {
  it('splits the rate by the run’s own outcome counts', () => {
    const one = response([
      run({
        id: 'a',
        startedAt: '2026-08-01T10:00:00.000Z',
        count: 100,
        okCount: 75,
        koCount: 25,
        throughputRps: 8,
      }),
    ]);
    const d = toThroughputTrend(one);
    const ok = d.series.find((s) => s.name === 'OK')!.data as readonly (number | null)[];
    const ko = d.series.find((s) => s.name === 'KO')!.data as readonly (number | null)[];
    const only = one.runs[0]!;
    expect(ok[0]).toBeCloseTo(only.throughputRps * (only.okCount / only.count), 6);
    expect(ko[0]).toBeCloseTo(only.throughputRps * (only.koCount / only.count), 6);
  });

  it('sums to the run’s total rate', () => {
    const d = toThroughputTrend(THREE);
    const ok = d.series.find((s) => s.name === 'OK')!.data as readonly (number | null)[];
    const ko = d.series.find((s) => s.name === 'KO')!.data as readonly (number | null)[];
    ok.forEach((value, i) => expect(value! + ko[i]!).toBeCloseTo(REFERENCE.throughputRps, 6));
  });

  it('leaves a run that recorded nothing as a gap', () => {
    const d = toThroughputTrend(
      response([
        run({
          id: 'a',
          startedAt: '2026-08-01T10:00:00.000Z',
          count: 0,
          okCount: 0,
          koCount: 0,
          throughputRps: 0,
        }),
      ]),
    );
    for (const series of d.series) {
      expect((series.data as readonly (number | null)[])[0]).toBeNull();
    }
  });
});
