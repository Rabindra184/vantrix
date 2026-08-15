import type { SeriesResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  COMPARE_METRICS,
  compareLabels,
  toCompare,
  type CompareRun,
} from '../src/charts/transforms/compare';
import fixture from './fixtures/reference-run.json';

const REFERENCE = fixture.series as unknown as SeriesResponse;

/** The same buckets under a different run identity, and optionally a different
 *  bucket width — which is the case the whole overlay design turns on. */
function asRun(id: string, over: Partial<SeriesResponse> = {}): CompareRun {
  return { id, label: id, series: { ...REFERENCE, ...over } };
}

/** The `[elapsedMs, value]` pairs of one drawn series. */
function points(data: unknown): readonly (readonly [number, number])[] {
  return data as readonly (readonly [number, number])[];
}

const TWO = [asRun('run-a'), asRun('run-b')];

describe('toCompare', () => {
  it('draws one series per run, named by its label', () => {
    const d = toCompare(TWO, 'p95');
    expect(d.series.map((s) => s.name)).toEqual(['run-a', 'run-b']);
  });

  it('plots [elapsedMs, value] pairs, not one value per shared category', () => {
    // The x is a MEASURED QUANTITY, so runs of different durations and
    // different bucket widths overlay at real elapsed times rather than being
    // indexed by position against each other.
    const first = points(toCompare(TWO, 'p95').series[0]!.data)[0]!;
    expect(Array.isArray(first)).toBe(true);
    expect(first[0]).toBe(REFERENCE.buckets[0]!.startOffsetMs);
  });

  /**
   * THE CASE THE SPEC WANTED RESAMPLING FOR.
   *
   * A 2000 ms bucket holding the same number of events as a 1000 ms bucket is
   * HALF the rate. Dividing by each run's own width is what makes that true on
   * screen, and it is what `transforms/rates.ts` already does — so there is
   * nothing to resample, and resampling percentiles would have been unsound
   * anyway.
   */
  it('divides a rate by each run’s OWN bucket width', () => {
    const [fine, coarse] = [asRun('fine'), asRun('coarse', { bucketWidthMs: 2000 })];
    const d = toCompare([fine, coarse], 'throughput');

    const at0 = (name: string) => points(d.series.find((s) => s.name === name)!.data)[0]![1];
    // Same counts, twice the window: exactly half the rate.
    expect(at0('coarse')).toBeCloseTo(at0('fine') / 2, 9);
  });

  it('reads a percentile exactly, never merging buckets', () => {
    // Merging is sound for counts, which sum, and unsound for quantiles: the
    // 95th of a union is not a function of two buckets' 95ths.
    const i = REFERENCE.buckets.findIndex((b) => Object.keys(b.percentilesOk).length > 0);
    const drawn = points(toCompare([asRun('a')], 'p95').series[0]!.data);
    const found = drawn.find(([x]) => x === REFERENCE.buckets[i]!.startOffsetMs)!;
    expect(found[1]).toBe(REFERENCE.buckets[i]!.percentilesOk.p95);
  });

  it('omits a bucket that measured no successful response, rather than plotting zero', () => {
    // Keyed on the percentile map being empty, exactly as
    // transforms/percentiles.ts argues — and on a value axis an absent point
    // is simply not plotted, so the line joins its neighbours instead of
    // diving to the axis.
    const unmeasured = REFERENCE.buckets.filter(
      (b) => Object.keys(b.percentilesOk).length === 0,
    ).length;
    expect(unmeasured).toBeGreaterThan(0);

    const drawn = points(toCompare([asRun('a')], 'p95').series[0]!.data);
    expect(drawn).toHaveLength(REFERENCE.buckets.length - unmeasured);
  });

  it('does not pad a shorter run to the longer one’s length', () => {
    // Padding with zeros would draw a run as having collapsed to nothing at
    // the moment it simply ended.
    const short = asRun('short', { buckets: REFERENCE.buckets.slice(0, 5) });
    const d = toCompare([asRun('long'), short], 'throughput');

    const lengths = d.series.map((s) => points(s.data).length);
    expect(lengths[1]).toBeLessThan(lengths[0]!);
    expect(lengths[1]).toBe(5);
  });

  it('states the differing widths, because the densities will differ visibly', () => {
    const d = toCompare([asRun('fine'), asRun('coarse', { bucketWidthMs: 2000 })], 'throughput');
    expect(d.limitation).toBeTruthy();
    expect(d.limitation).toContain('2000');
  });

  it('states nothing when every run shares a width', () => {
    expect(toCompare(TWO, 'throughput').limitation).toBeUndefined();
  });

  it('explains an empty selection instead of drawing empty axes', () => {
    const d = toCompare([], 'p95');
    expect(d.series).toHaveLength(0);
    expect(d.empty).toBeTruthy();
  });

  it('carries a table row per bucket of the longest run', () => {
    const short = asRun('short', { buckets: REFERENCE.buckets.slice(0, 5) });
    const d = toCompare([asRun('long'), short], 'throughput');
    // One row per distinct elapsed offset across every run — the union, so no
    // run's measurement is missing from the parity surface.
    expect(d.rows.length).toBe(REFERENCE.buckets.length);
  });

  it('offers only metrics the series payload can answer', () => {
    // Concurrent users lives in /users, not /series, and CPU is not collected
    // at all. A selector offering either would promise data this page cannot
    // fetch from what it holds.
    const names = COMPARE_METRICS.map((m) => m.value);
    expect(names).toContain('throughput');
    expect(names).toContain('p95');
    expect(names).not.toContain('users');
    expect(names).not.toContain('cpu');
  });

  it('derives its percentile metrics from keys the payload really carries', () => {
    const available = new Set(
      REFERENCE.buckets.flatMap((b) => Object.keys(b.percentilesOk)),
    );
    for (const metric of COMPARE_METRICS) {
      if (!metric.value.startsWith('p')) continue;
      expect(available.has(metric.value), `${metric.value} is not in the payload`).toBe(true);
    }
  });
});

describe('compareLabels', () => {
  it('is a short timestamp when nothing collides', () => {
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-14T09:30:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:00.000Z' },
    ]);
    expect(labels).toEqual(['08-14 09:30', '08-15 16:45']);
  });

  it('disambiguates runs that share a minute', () => {
    // ECharts DEDUPES SERIES BY NAME, so two identically-labelled runs draw
    // one legend entry and the matrix grows two columns with the same header
    // — a comparison whose columns cannot be told apart.
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-15T16:45:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:30.000Z' },
    ]);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toContain('08-15 16:45');
  });

  it('suffixes only the colliding labels, leaving the rest clean', () => {
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-15T16:45:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:10.000Z' },
      { id: 'cccccccc-3333', at: '2026-08-14T09:30:00.000Z' },
    ]);
    expect(labels[2]).toBe('08-14 09:30');
    expect(labels[0]).not.toBe(labels[1]);
  });
});
