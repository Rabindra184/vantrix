import type { SeriesResponse } from '@perfportal/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * ═══ PINNED TO A ZONE, BECAUSE THE LABEL IS NOW IN THE READER'S ═══
 *
 * These labels used to be sliced out of `toISOString()`, so they read in UTC
 * while every other time in the app — the run header, the run list — goes
 * through `Intl.DateTimeFormat` in the viewer's zone. On an Asia/Kolkata
 * machine the Trends page therefore labelled a run `08-07 05:30` directly
 * under a header reading `Aug 7, 2026, 11:00 AM`: one instant, two clocks,
 * and no way for a reader to know which was theirs.
 *
 * Which means the expectations below are only meaningful against a KNOWN
 * zone. Left to the runner's own, they would assert one thing on a UTC CI box
 * and another on the machine this was written on — the exact asymmetry that
 * let the underlying timestamp bug survive. `+05:30` is chosen because it
 * moves both the clock and, in one case below, the DATE.
 *
 * Safe to set here: Vitest 2 runs each file in a forked worker PROCESS
 * (`pool: 'forks'`, the default this repo does not override), so `process.env`
 * is this file's alone, and files inside one worker run sequentially.
 */
describe('compareLabels', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('reads in the reader’s zone, like every other time in the app', () => {
    // The precondition, asserted rather than assumed: Node honours a TZ set
    // after startup, and if it ever stops doing so every expectation in this
    // describe silently becomes a UTC assertion again. +05:30 puts midnight
    // UTC at 05:30 local.
    expect(new Date('2026-08-07T00:00:00Z').getHours()).toBe(5);

    // 05:30Z is 11:00 local — the very reading the run header shows beside it.
    expect(compareLabels([{ id: 'aaaaaaaa-1111', at: '2026-08-07T05:30:02.171Z' }])).toEqual([
      '08-07 11:00',
    ]);
  });

  it('carries the local DATE too, not merely the local clock', () => {
    // 19:00Z is half past midnight the NEXT day at +05:30. A label that took
    // its time locally and its date from the ISO string would read `08-07
    // 00:30` here — right clock, wrong day, and wrong in the direction that
    // makes a run look like it happened before it did.
    expect(compareLabels([{ id: 'aaaaaaaa-1111', at: '2026-08-07T19:00:00.000Z' }])).toEqual([
      '08-08 00:30',
    ]);
  });

  it('is a short timestamp when nothing collides', () => {
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-14T09:30:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:00.000Z' },
    ]);
    expect(labels).toEqual(['08-14 15:00', '08-15 22:15']);
  });

  it('disambiguates runs that share a minute', () => {
    // ECharts DEDUPES SERIES BY NAME, so two identically-labelled runs draw
    // one legend entry and the matrix grows two columns with the same header
    // — a comparison whose columns cannot be told apart.
    //
    // Still true in a local zone: every UTC offset is a whole number of
    // minutes, so two runs sharing a minute in UTC share one locally.
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-15T16:45:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:30.000Z' },
    ]);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toContain('08-15 22:15');
  });

  it('suffixes only the colliding labels, leaving the rest clean', () => {
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-15T16:45:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:10.000Z' },
      { id: 'cccccccc-3333', at: '2026-08-14T09:30:00.000Z' },
    ]);
    expect(labels[2]).toBe('08-14 15:00');
    expect(labels[0]).not.toBe(labels[1]);
  });
});

describe('compareLabels — ids that share a prefix', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('grows the suffix until the labels really are distinct', () => {
    // Six characters is usually enough and occasionally is not. Two runs whose
    // ids share a prefix AND a minute would get identical labels again, which
    // merges their ECharts series and duplicates a matrix column key — the
    // exact failure this function exists to prevent.
    const labels = compareLabels([
      { id: 'aaaaaa-1111-4444-8888-000000000001', at: '2026-08-15T16:45:00.000Z' },
      { id: 'aaaaaa-1111-4444-8888-000000000002', at: '2026-08-15T16:45:30.000Z' },
    ]);
    expect(new Set(labels).size).toBe(2);
  });

  it('keeps the suffix short when six characters already separate them', () => {
    const labels = compareLabels([
      { id: 'aaaaaaaa-1111', at: '2026-08-15T16:45:00.000Z' },
      { id: 'bbbbbbbb-2222', at: '2026-08-15T16:45:30.000Z' },
    ]);
    for (const label of labels) expect(label).toHaveLength('08-15 22:15 · aaaaaa'.length);
  });
});

/**
 * REVIEW C07 — THE OVERLAY AND THE MATRIX MUST MEAN THE SAME POPULATION.
 *
 * A `SeriesBucket` carries THREE percentile maps — `percentiles` (every
 * response), `percentilesOk`, `percentilesKo`. A `StatRow` carries exactly
 * one, the combined set, and has no OK-only variant at all.
 *
 * The overlay read `percentilesOk` while `metricValue` — which feeds both the
 * comparison matrix and the summary tiles directly above the overlay — read
 * `row.percentiles`. Same word on three surfaces of one screen, two different
 * populations, and no way for a reader to know which they were looking at. The
 * combined set is the only one all three CAN share without a backend change,
 * so that is the one they share.
 */
describe('toCompare — one population, the same one the matrix uses', () => {
  const bucketAt = (over: Partial<SeriesResponse['buckets'][number]>) => ({
    ...REFERENCE.buckets[0]!,
    ...over,
  });

  /**
   * ═══ AND IT CLAMPS THAT POPULATION TO ITS OWN RANGE ═══
   *
   * The same invariant the statistics table and the run totals tiles have
   * always applied, one scope narrower: a bucket's percentiles and its
   * `minMs`/`maxMs` come from one sketch over one slice, so an estimate above
   * that bucket's own maximum is known to be wrong. The overlay plotted the
   * raw value, so the same run's p99 could read higher here than on its own
   * page — 30 of 384 percentile values across nine real runs sit above their
   * own max, worst +0.59%.
   *
   * `max` is deliberately read BEFORE this and is exact — the case above
   * pins that, and this must not disturb it.
   */
  it('projects a percentile back onto the bucket it was taken from', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ minMs: 100, maxMs: 2503, percentiles: { p99: 2515.46 } })],
    });
    expect(points(toCompare([run], 'p99').series[0]!.data)[0]![1]).toBe(2503);
  });

  /** Inside its range, untouched — or "clamped" would mean "pinned to the
   *  maximum", which would flatten every line this chart draws. */
  it('leaves a percentile inside its bucket range exactly where it is', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ minMs: 100, maxMs: 2503, percentiles: { p99: 1800.25 } })],
    });
    expect(points(toCompare([run], 'p99').series[0]!.data)[0]![1]).toBe(1800.25);
  });

  it('reads the combined percentiles, as `metricValue` does', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ percentiles: { p95: 500 }, percentilesOk: { p95: 111 } })],
    });
    expect(points(toCompare([run], 'p95').series[0]!.data)[0]![1]).toBe(500);
  });

  /**
   * THE BUG THE POPULATION MIX-UP HID.
   *
   * `max` read `bucket.maxMs` — a combined extremum — but sat BEHIND a guard
   * on `percentilesOk` being empty. A bucket in which every request failed has
   * no OK percentiles and a perfectly real maximum, so the overlay dropped the
   * slowest measurement in exactly the buckets a regression hunt cares about
   * most. Nothing threw; the line simply had a hole in it.
   */
  it('keeps the maximum of a bucket where every request failed', () => {
    const run = asRun('r', {
      buckets: [
        bucketAt({
          okCount: 0,
          koCount: 7,
          maxMs: 2503,
          percentiles: {},
          percentilesOk: {},
        }),
      ],
    });
    expect(points(toCompare([run], 'max').series[0]!.data)[0]![1]).toBe(2503);
  });

  /** A bucket that measured nothing at all still has no value — the fix must
   *  not turn "no data" into a zero or a stale carry-forward. */
  it('still has no percentile for a bucket that measured nothing', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ percentiles: {}, percentilesOk: {}, okCount: 0, koCount: 0 })],
    });
    expect(points(toCompare([run], 'p95').series[0]!.data)).toHaveLength(0);
  });

  it('declares the population it drew, so the reader is not left guessing', () => {
    expect(toCompare(TWO, 'p95').limitation ?? '').toMatch(
      /every response|all responses|successful and failed/i,
    );
  });

  /** A rate says nothing about response populations, so the note belongs only
   *  on the metrics it actually qualifies. */
  it('says nothing about populations for a rate metric', () => {
    expect(toCompare(TWO, 'throughput').limitation ?? '').not.toMatch(/response/i);
  });
});
