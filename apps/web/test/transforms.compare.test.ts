import type {
  AgentInjectorsResponse,
  SeriesResponse,
  TelemetryResponse,
  UsersResponse,
} from '@perfportal/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPARE_METRICS,
  STATS_RANKS,
  compareLabels,
  compareUnit,
  cpuPoints,
  isChangeGood,
  seriesPoints,
  toCompare,
  usersPoints,
  type CompareMetric,
  type CompareRun,
} from '../src/charts/transforms/compare';
import fixture from './fixtures/reference-run.json';

const REFERENCE = fixture.series as unknown as SeriesResponse;
const USERS = fixture.users as unknown as UsersResponse;

/**
 * One run's overlay input: the same buckets under a different run identity,
 * and optionally a different bucket width — which is the case the whole
 * overlay design turns on. The points are what `seriesPoints` reads for the
 * metric, exactly as the page will hand them over.
 */
type Spec = { readonly id: string; readonly over?: Partial<SeriesResponse> };
function asRun(id: string, over: Partial<SeriesResponse> = {}): Spec {
  return { id, over };
}
function runOf(spec: Spec, metric: CompareMetric): CompareRun {
  const series = { ...REFERENCE, ...spec.over };
  return {
    id: spec.id,
    label: spec.id,
    points: seriesPoints(series, metric),
    bucketWidthMs: series.bucketWidthMs,
  };
}
/** `toCompare` over specs, each run's points read for the same metric. */
function compare(specs: readonly Spec[], metric: CompareMetric) {
  return toCompare(
    specs.map((spec) => runOf(spec, metric)),
    metric,
  );
}

/** The `[elapsedMs, value]` pairs of one drawn series. */
function points(data: unknown): readonly (readonly [number, number])[] {
  return data as readonly (readonly [number, number])[];
}

const TWO = [asRun('run-a'), asRun('run-b')];

describe('toCompare', () => {
  it('draws one series per run, named by its label', () => {
    const d = compare(TWO, 'p95');
    expect(d.series.map((s) => s.name)).toEqual(['run-a', 'run-b']);
  });

  it('plots [elapsedMs, value] pairs, not one value per shared category', () => {
    // The x is a MEASURED QUANTITY, so runs of different durations and
    // different bucket widths overlay at real elapsed times rather than being
    // indexed by position against each other.
    const first = points(compare(TWO, 'p95').series[0]!.data)[0]!;
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
    const d = compare([fine, coarse], 'throughput');

    const at0 = (name: string) => points(d.series.find((s) => s.name === name)!.data)[0]![1];
    // Same counts, twice the window: exactly half the rate.
    expect(at0('coarse')).toBeCloseTo(at0('fine') / 2, 9);
  });

  it('reads a percentile exactly, never merging buckets', () => {
    // Merging is sound for counts, which sum, and unsound for quantiles: the
    // 95th of a union is not a function of two buckets' 95ths.
    const i = REFERENCE.buckets.findIndex((b) => Object.keys(b.percentilesOk).length > 0);
    const drawn = points(compare([asRun('a')], 'p95').series[0]!.data);
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

    const drawn = points(compare([asRun('a')], 'p95').series[0]!.data);
    expect(drawn).toHaveLength(REFERENCE.buckets.length - unmeasured);
  });

  it('does not pad a shorter run to the longer one’s length', () => {
    // Padding with zeros would draw a run as having collapsed to nothing at
    // the moment it simply ended.
    const short = asRun('short', { buckets: REFERENCE.buckets.slice(0, 5) });
    const d = compare([asRun('long'), short], 'throughput');

    const lengths = d.series.map((s) => points(s.data).length);
    expect(lengths[1]).toBeLessThan(lengths[0]!);
    expect(lengths[1]).toBe(5);
  });

  it('states the differing widths, because the densities will differ visibly', () => {
    const d = compare([asRun('fine'), asRun('coarse', { bucketWidthMs: 2000 })], 'throughput');
    expect(d.limitation).toBeTruthy();
    expect(d.limitation).toContain('2000');
  });

  it('states nothing when every run shares a width', () => {
    expect(compare(TWO, 'throughput').limitation).toBeUndefined();
  });

  it('explains an empty selection instead of drawing empty axes', () => {
    const d = compare([], 'p95');
    expect(d.series).toHaveLength(0);
    expect(d.empty).toBeTruthy();
  });

  it('carries a table row per bucket of the longest run', () => {
    const short = asRun('short', { buckets: REFERENCE.buckets.slice(0, 5) });
    const d = compare([asRun('long'), short], 'throughput');
    // One row per distinct elapsed offset across every run — the union, so no
    // run's measurement is missing from the parity surface.
    expect(d.rows.length).toBe(REFERENCE.buckets.length);
  });

  it('offers Gatling Enterprise\'s metrics, in its order, with this product\'s labels', () => {
    expect(COMPARE_METRICS.map((m) => [m.value, m.label])).toEqual([
      ['users', 'Concurrent users'],
      ['cpu', 'CPU usage'],
      ['errors', 'Errors'],
      ['p50', '50th percentile'],
      ['p90', '90th percentile'],
      ['p95', '95th percentile'],
      ['p99', '99th percentile'],
      ['p99.9', '99.9th percentile'],
      ['p99.99', '99.99th percentile'],
      ['max', 'Max response time'],
      ['throughput', 'Throughput'],
    ]);
  });

  /**
   * `/stats` answers only the project's configured ranks unless
   * `?percentiles=` names more, and that set can omit ANY rank. So every
   * percentile metric the selector offers asks for its own rank, and the rank
   * spells the key the server answers under — never left to the configured
   * set, where an exact run would read `—` (final review m1).
   */
  it('asks /stats for every percentile metric’s own rank, under its own key', () => {
    const percentiles = COMPARE_METRICS.map(({ value }) => value).filter((value) => /^p\d/.test(value));
    expect(percentiles.length).toBeGreaterThan(5);
    for (const value of percentiles) {
      const requested = STATS_RANKS[value];
      expect(requested, `${value} is not requested`).toBeDefined();
      expect(`p${requested}`).toBe(value);
    }
    // And nothing that is not a percentile asks for a rank.
    for (const { value } of COMPARE_METRICS) {
      if (!/^p\d/.test(value)) expect(STATS_RANKS[value]).toBeUndefined();
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
    expect(points(compare([run], 'p99').series[0]!.data)[0]![1]).toBe(2503);
  });

  /** Inside its range, untouched — or "clamped" would mean "pinned to the
   *  maximum", which would flatten every line this chart draws. */
  it('leaves a percentile inside its bucket range exactly where it is', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ minMs: 100, maxMs: 2503, percentiles: { p99: 1800.25 } })],
    });
    expect(points(compare([run], 'p99').series[0]!.data)[0]![1]).toBe(1800.25);
  });

  it('reads the combined percentiles, as `metricValue` does', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ percentiles: { p95: 500 }, percentilesOk: { p95: 111 } })],
    });
    expect(points(compare([run], 'p95').series[0]!.data)[0]![1]).toBe(500);
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
    expect(points(compare([run], 'max').series[0]!.data)[0]![1]).toBe(2503);
  });

  /** A bucket that measured nothing at all still has no value — the fix must
   *  not turn "no data" into a zero or a stale carry-forward. */
  it('still has no percentile for a bucket that measured nothing', () => {
    const run = asRun('r', {
      buckets: [bucketAt({ percentiles: {}, percentilesOk: {}, okCount: 0, koCount: 0 })],
    });
    expect(points(compare([run], 'p95').series[0]!.data)).toHaveLength(0);
  });

  it('declares the population it drew, so the reader is not left guessing', () => {
    expect(compare(TWO, 'p95').limitation ?? '').toMatch(
      /every response|all responses|successful and failed/i,
    );
  });

  /** A rate says nothing about response populations, so the note belongs only
   *  on the metrics it actually qualifies. */
  it('says nothing about populations for a rate metric', () => {
    expect(compare(TWO, 'throughput').limitation ?? '').not.toMatch(/response/i);
  });
});

/* -------------------------------------------------------------------- *
 * The points each metric's source yields
 * -------------------------------------------------------------------- */

describe('seriesPoints', () => {
  it('reads an extra rank from the bucket map under the key the server answers', () => {
    const base = REFERENCE.buckets.find((b) => b.maxMs > b.minMs)!;
    const value = (base.minMs + base.maxMs) / 2;
    const bucket = { ...base, percentiles: { ...base.percentiles, 'p99.9': value } };
    const out = seriesPoints({ ...REFERENCE, buckets: [bucket] }, 'p99.9');
    expect(out).toEqual([[bucket.startOffsetMs, value]]);
  });

  it('omits a bucket that has no such rank, rather than plotting zero', () => {
    const base = REFERENCE.buckets.find((b) => Object.keys(b.percentiles).length > 0)!;
    expect(base.percentiles['p99.9']).toBeUndefined();
    expect(seriesPoints({ ...REFERENCE, buckets: [base] }, 'p99.9')).toEqual([]);
  });
});

describe('usersPoints', () => {
  it('plots the all-scenario concurrency at each offset', () => {
    expect(USERS.total.length).toBeGreaterThan(0);
    expect(usersPoints(USERS)).toEqual(
      USERS.total.map((b) => [b.startOffsetMs, b.maxConcurrent]),
    );
  });
});

/** An injectors payload whose machine collector ran, with these CPU buckets. */
function injectors(
  buckets: readonly { startOffsetMs: number; user: number | null; sys: number | null }[],
  machine = true,
): AgentInjectorsResponse {
  return {
    runId: '4518cd74-f245-452a-a9db-937d9853c1c5',
    available: true,
    reason: null,
    detail: null,
    bucketWidthMs: 1000,
    window: null,
    machine: { available: machine, reason: machine ? null : 'not Linux' },
    buckets: buckets.map((b) => ({
      startOffsetMs: b.startOffsetMs,
      gcCount: {},
      gcTimeMs: {},
      cpuUserPct: b.user,
      cpuSysPct: b.sys,
      ramTotalBytes: null,
      ramUsedBytes: null,
      heapMaxBytes: null,
      heapCommittedBytes: null,
      heapUsedBytes: null,
      nettyDirectBytes: null,
      nettyHeapBytes: null,
      tcpEvents: null,
      tcpSegments: null,
    })),
  };
}

/** A telemetry payload, one host per entry, each `[offset, cpuTotalPct]`. */
function telemetry(
  hosts: readonly (readonly (readonly [number, number | null])[])[],
  available = true,
): TelemetryResponse {
  return {
    runId: '4518cd74-f245-452a-a9db-937d9853c1c5',
    available,
    bucketWidthMs: 1000,
    window: null,
    hosts: hosts.map((points, i) => ({
      host: `gen-${i}`,
      clockSkewMs: 0,
      points: points.map(([startOffsetMs, cpuTotalPct]) => ({
        startOffsetMs,
        cpuTotalPct,
        cpuUserPct: null,
        cpuSystemPct: null,
        memUsedBytes: 0,
        memTotalBytes: 0,
        rxBytesPerSec: null,
        txBytesPerSec: null,
        inSegsPerSec: null,
        outSegsPerSec: null,
        retransSegsPerSec: null,
        inErrsPerSec: null,
        activeOpensPerSec: null,
        passiveOpensPerSec: null,
        tcpStates: {},
      })),
    })),
  };
}

describe('cpuPoints', () => {
  it('prefers the agent\'s machine CPU, user plus system, skipping a bucket with neither', () => {
    const agent = injectors([
      { startOffsetMs: 0, user: 10, sys: 5 },
      { startOffsetMs: 1000, user: null, sys: null },
      { startOffsetMs: 2000, user: 40, sys: 2.5 },
    ]);
    const expected = agent.buckets
      .filter((b) => b.cpuUserPct !== null || b.cpuSysPct !== null)
      .map((b) => [b.startOffsetMs, (b.cpuUserPct ?? 0) + (b.cpuSysPct ?? 0)]);
    expect(cpuPoints(agent, telemetry([[[0, 99]]]))).toEqual(expected);
  });

  it('falls back to telemetry, averaging the hosts that read each bucket', () => {
    const t = telemetry([
      [
        [0, 10],
        [1000, 50],
      ],
      [
        [0, 30],
        [1000, null],
      ],
    ]);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(cpuPoints(null, t)).toEqual([
      [0, mean([10, 30])],
      [1000, mean([50])],
    ]);
  });

  it('falls back to telemetry when the agent ran without its machine collector', () => {
    const t = telemetry([[[0, 12]]]);
    expect(cpuPoints(injectors([{ startOffsetMs: 0, user: 70, sys: 1 }], false), t)).toEqual([[0, 12]]);
  });

  it('cpu with no source yields null', () => {
    expect(cpuPoints(null, null)).toBeNull();
    expect(cpuPoints(injectors([], false), telemetry([], false))).toBeNull();
  });
});

describe('toCompare — a metric one run did not record', () => {
  const label = COMPARE_METRICS.find((m) => m.value === 'cpu')!.label;
  const recorded: CompareRun = {
    id: 'a',
    label: 'Run 1',
    points: [
      [0, 10],
      [1000, 20],
    ],
    bucketWidthMs: 1000,
  };
  const missing: CompareRun = { id: 'b', label: 'Run 3', points: null, bucketWidthMs: null };

  it('names a run without CPU and draws no line for it', () => {
    const d = toCompare([recorded, missing], 'cpu');
    expect(d.series.map((s) => s.name)).toEqual([recorded.label]);
    expect(d.limitation).toContain(`${label} was not recorded for ${missing.label}.`);
    expect(d.empty).toBeUndefined();
  });

  it('says so instead of drawing empty axes when no run recorded it', () => {
    const other: CompareRun = { ...missing, id: 'c', label: 'Run 4' };
    const d = toCompare([missing, other], 'cpu');
    expect(d.series).toHaveLength(0);
    expect(d.empty).toBeTruthy();
    for (const run of [missing, other]) {
      expect(d.limitation).toContain(`${label} was not recorded for ${run.label}.`);
    }
  });

  /**
   * `[]` IS RECORDED AND EMPTY HERE, NOT UNRECORDED (final review m2). A CPU
   * source that answered with no reading in a narrow window drew a legend
   * entry and no line and said nothing, and a selection of nothing but such
   * runs drew bare axes. Each is named in its own words, and an all-empty
   * overlay explains itself — while a run that ENDED before the window is
   * left to the page's own "ended before this window" sentence.
   */
  it('names a run with no reading in this span, and says so when none has one', () => {
    const quiet: CompareRun = { id: 'q', label: 'Run 5', points: [], bucketWidthMs: null };
    const ended: CompareRun = { id: 'e', label: 'Run 6', points: [], bucketWidthMs: null, ended: true };

    const partial = toCompare([recorded, quiet, ended], 'cpu');
    expect(partial.empty).toBeUndefined();
    expect(partial.limitation).toContain(`${label} has no reading for ${quiet.label} in this span.`);
    expect(partial.limitation).not.toContain(ended.label);
    expect(partial.limitation).not.toContain(`${label} was not recorded for ${quiet.label}.`);

    const none = toCompare([quiet, ended], 'cpu');
    expect(none.empty).toBe(`${label} has no reading for any selected run in this span.`);
    expect(none.limitation).toContain(`${label} has no reading for ${quiet.label} in this span.`);
  });

  it('keeps every run\'s column, a dash where it recorded nothing', () => {
    const d = toCompare([recorded, missing], 'cpu');
    expect(d.columns).toEqual(['Elapsed (s)', recorded.label, missing.label]);
    expect(d.rows.map((r) => r.values)).toEqual(recorded.points!.map(([, v]) => [v, '—']));
  });
});

describe('isChangeGood and compareUnit', () => {
  it('judges neither direction for users and CPU', () => {
    expect(isChangeGood(5, 'users')).toBeNull();
    expect(isChangeGood(-5, 'cpu')).toBeNull();
  });

  it('keeps throughput good going up and latency good going down', () => {
    expect(isChangeGood(5, 'throughput')).toBe(true);
    expect(isChangeGood(5, 'p99.9')).toBe(false);
    expect(isChangeGood(-5, 'p90')).toBe(true);
  });

  it('names each metric\'s unit', () => {
    expect(compareUnit('users')).toBe('users');
    expect(compareUnit('cpu')).toBe('%');
    expect(compareUnit('p99.99')).toBe('ms');
    expect(compareUnit('max')).toBe('ms');
    expect(compareUnit('errors')).toBe('/s');
    expect(compareUnit('throughput')).toBe('/s');
  });
});
