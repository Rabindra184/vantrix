import { AgentInjectorsResponseSchema, TCP_EVENT_NAMES, TCP_SEGMENT_NAMES } from '@perfportal/contracts';
import type { AgentInjectorsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { expectAboutTheRun, expectAboutTheWindow } from './support/emptySentence';
import { unreadSeriesNote, zeroSeriesNote } from '../src/charts/transforms/agentRates';
import {
  MEMORY_SERIES,
  TCP_EVENT_LABELS,
  TCP_SEGMENT_LABELS,
  toCpu,
  toGcCounts,
  toGcTime,
  toMemory,
  toTcpEvents,
  toTcpSegments,
} from '../src/charts/transforms/agentInjectors';
import { BYTES_PER_MB } from '../src/charts/transforms/telemetry';
import type { ChartData } from '../src/charts/types';
import fixture from './fixtures/agent-run.json';

/**
 * The Report's Load generators charts, read against `fixtures/agent-run.json`
 * — a Linux run, so every machine figure is present — parsed with the contract
 * schema so a drifted fixture fails here rather than feeding a shape the page
 * never gets.
 *
 * THE FIXTURE'S WIDTH IS 1000 MS, so a rate and a stored value agree in every
 * bucket and cannot tell a counter from a gauge. Every divisor case therefore
 * builds a 2000 ms payload, which is also the only way to tell `established`
 * (a gauge) from the four counters beside it.
 */

const injectors = AgentInjectorsResponseSchema.parse(fixture.injectors);

const RUN = { windowSelected: false } as const;
const WINDOW = { windowSelected: true } as const;

type Bucket = AgentInjectorsResponse['buckets'][number];

/** One drawn series' y values, by name. */
function ys(chart: ChartData, name: string): readonly (number | null)[] {
  const series = chart.series.find((s) => s.name === name);
  if (series === undefined) throw new Error(`no series ${name}`);
  return (series.data as readonly (readonly [number, number | null])[]).map(([, y]) => y);
}

/** An injectors payload with the given buckets and width, everything else the fixture's. */
function withBuckets(buckets: readonly Bucket[], bucketWidthMs = injectors.bucketWidthMs): AgentInjectorsResponse {
  return { ...injectors, bucketWidthMs, buckets: [...buckets] };
}

/** A bucket with nothing in it but what the case sets. */
function bucket(over: Partial<Bucket>): Bucket {
  return {
    startOffsetMs: 0,
    gcCount: {},
    gcTimeMs: {},
    cpuUserPct: null,
    cpuSysPct: null,
    ramTotalBytes: null,
    ramUsedBytes: null,
    heapMaxBytes: null,
    heapCommittedBytes: null,
    heapUsedBytes: null,
    nettyDirectBytes: null,
    nettyHeapBytes: null,
    tcpEvents: null,
    tcpSegments: null,
    ...over,
  };
}

/** The fixture as a machine-off run reports it: no CPU, RAM or kernel TCP. */
const machineOff: AgentInjectorsResponse = {
  ...injectors,
  machine: { available: false, reason: 'macOS' },
  buckets: injectors.buckets.map((b) => ({
    ...b,
    cpuUserPct: null,
    cpuSysPct: null,
    ramTotalBytes: null,
    ramUsedBytes: null,
    tcpEvents: null,
    tcpSegments: null,
  })),
};

/**
 * The ruling every agent chart follows: a chart left with nothing to plot says
 * why in `empty`, and draws no series — never a markless grid. Checked for the
 * run and the window, since the sentence must be about the one asked for.
 */
function expectNothingDrawn(fn: (inj: AgentInjectorsResponse, o: typeof RUN | typeof WINDOW) => ChartData, inj: AgentInjectorsResponse, names: readonly string[]): void {
  const run = fn(inj, RUN);
  expect(run.series).toEqual([]);
  expectAboutTheRun(run.empty);
  for (const n of names) expect(run.empty, n).toContain(n);
  expect(run.rows.length).toBe(inj.buckets.length);
  const window = fn(inj, WINDOW);
  expect(window.series).toEqual([]);
  expectAboutTheWindow(window.empty);
}

const collectors = (field: 'gcCount' | 'gcTimeMs') =>
  [...new Set(injectors.buckets.flatMap((b) => Object.keys(b[field])))].sort();

describe('toGcCounts and toGcTime', () => {
  it.each([
    ['toGcCounts', toGcCounts, 'gcCount'],
    ['toGcTime', toGcTime, 'gcTimeMs'],
  ] as const)('%s keeps a column per collector, the sorted union, and draws the ones that collected', (_, fn, field) => {
    const union = collectors(field);
    const chart = fn(injectors, RUN);
    expect(chart.columns).toEqual(['Elapsed (s)', ...union]);
    const zero = union.filter((c) => injectors.buckets.every((b) => (b[field][c] ?? 0) === 0));
    // The fixture has a collector that never ran (G1 Old) and ones that did.
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.length).toBeLessThan(union.length);
    expect(chart.series.map((s) => s.name)).toEqual(union.filter((c) => !zero.includes(c)));
    expect(chart.limitation).toContain(zeroSeriesNote(zero)!);
  });

  it('divides by the payload width, and a collector absent from a bucket is a measured 0', () => {
    const payload = withBuckets(
      [
        bucket({ startOffsetMs: 0, gcCount: { Young: 6 }, gcTimeMs: { Young: 40 } }),
        bucket({ startOffsetMs: 2000, gcCount: { Young: 2, Old: 4 }, gcTimeMs: { Young: 10, Old: 30 } }),
      ],
      2000,
    );
    const counts = toGcCounts(payload, RUN);
    expect(counts.series.map((s) => s.name)).toEqual(['Old', 'Young']);
    expect(ys(counts, 'Young')).toEqual([3, 1]);
    expect(ys(counts, 'Old')).toEqual([0, 2]);
    const time = toGcTime(payload, RUN);
    expect(ys(time, 'Young')).toEqual([20, 5]);
    expect(ys(time, 'Old')).toEqual([0, 15]);
  });

  it('is empty, naming every collector, when no collector moved — a quiet short window', () => {
    // The producer files every collector on every sample, zero deltas included.
    const quiet = withBuckets([
      bucket({ startOffsetMs: 0, gcCount: { Young: 0, Old: 0 }, gcTimeMs: { Young: 0, Old: 0 } }),
      bucket({ startOffsetMs: 1000, gcCount: { Young: 0, Old: 0 }, gcTimeMs: { Young: 0, Old: 0 } }),
    ]);
    expectNothingDrawn(toGcCounts, quiet, ['Old', 'Young']);
    expectNothingDrawn(toGcTime, quiet, ['Old', 'Young']);
    expect(toGcCounts(quiet, RUN).empty).toMatch(/zero/);
  });

  it('is empty rather than assuming 1000 ms when the payload carries no width', () => {
    for (const fn of [toGcCounts, toGcTime]) {
      const chart = fn({ ...injectors, bucketWidthMs: null }, RUN);
      expect(chart.series).toEqual([]);
      expect(chart.empty).toMatch(/bucket width/);
    }
  });

  it('says whether the window or the run recorded nothing', () => {
    for (const fn of [toGcCounts, toGcTime]) {
      expectAboutTheWindow(fn(withBuckets([]), WINDOW).empty);
      expectAboutTheRun(fn(withBuckets([]), RUN).empty);
    }
  });
});

describe('toCpu', () => {
  it('draws User and Sys as stored, never divided, even at a wider bucket', () => {
    const chart = toCpu(withBuckets([bucket({ cpuUserPct: 30, cpuSysPct: 12 })], 2000), RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['User', 'Sys']);
    expect(ys(chart, 'User')).toEqual([30]);
    expect(ys(chart, 'Sys')).toEqual([12]);
  });

  it("matches the fixture's own percentages", () => {
    const chart = toCpu(injectors, RUN);
    expect(ys(chart, 'User')).toEqual(injectors.buckets.map((b) => b.cpuUserPct));
    expect(ys(chart, 'Sys')).toEqual(injectors.buckets.map((b) => b.cpuSysPct));
  });

  it('is empty, naming both, when the machine was read but no CPU figure was', () => {
    // A machine-on run whose sample pairs gave no Δtotal: null in every bucket.
    const noDelta = withBuckets([bucket({ startOffsetMs: 0 }), bucket({ startOffsetMs: 1000 })]);
    expectNothingDrawn(toCpu, noDelta, ['User', 'Sys']);
    expect(toCpu(noDelta, RUN).empty).toMatch(/no reading/);
  });

  it('drops and names a CPU series with no reading, and draws a measured zero', () => {
    const chart = toCpu(withBuckets([bucket({ cpuUserPct: 0, cpuSysPct: null })]), RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['User']);
    expect(ys(chart, 'User')).toEqual([0]);
    expect(chart.limitation).toContain(unreadSeriesNote(['Sys'])!);
  });

  it("is empty with the machine's own reason when the machine collector was off", () => {
    const chart = toCpu(machineOff, RUN);
    expect(chart.empty).toBe('macOS');
    expect(chart.series).toEqual([]);
  });

  it('says why the machine was not read even with no reason and no buckets', () => {
    const chart = toCpu({ ...machineOff, machine: { available: false, reason: null }, buckets: [] }, WINDOW);
    expect(chart.empty).toBe('The agent did not collect machine figures.');
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toCpu(withBuckets([]), WINDOW).empty);
    expectAboutTheRun(toCpu(withBuckets([]), RUN).empty);
  });
});

describe('toMemory', () => {
  it("draws GE's seven series, in GE's order", () => {
    expect(MEMORY_SERIES).toEqual([
      'RAM total',
      'RAM used',
      'Heap max',
      'Heap committed',
      'Heap used',
      'Netty direct',
      'Netty heap',
    ]);
    expect(toMemory(injectors, RUN).series.map((s) => s.name)).toEqual([...MEMORY_SERIES]);
  });

  it('converts bytes to MB', () => {
    const chart = toMemory(injectors, RUN);
    const first = injectors.buckets[0]!;
    expect(BYTES_PER_MB).toBe(1048576);
    expect(ys(chart, 'Heap used')[0]).toBe(first.heapUsedBytes! / 1048576);
    expect(ys(chart, 'RAM total')[0]).toBe(first.ramTotalBytes! / BYTES_PER_MB);
    expect(ys(chart, 'Netty direct')[0]).toBe(first.nettyDirectBytes! / BYTES_PER_MB);
  });

  it('keeps a measured zero: memory is not under the zero-series ruling', () => {
    // Netty heap is 0 bytes in every fixture bucket — a reading, not an absence.
    expect(injectors.buckets.every((b) => b.nettyHeapBytes === 0)).toBe(true);
    const chart = toMemory(injectors, RUN);
    expect(ys(chart, 'Netty heap').every((y) => y === 0)).toBe(true);
    expect(chart.limitation ?? '').not.toContain('Netty heap');
  });

  it('omits RAM on a machine-off run, names it, and still draws heap and Netty', () => {
    const chart = toMemory(machineOff, RUN);
    expect(chart.series.map((s) => s.name)).toEqual(
      MEMORY_SERIES.filter((s) => s !== 'RAM total' && s !== 'RAM used'),
    );
    expect(chart.limitation).toContain(unreadSeriesNote(['RAM total', 'RAM used'])!);
    expect(chart.columns).toEqual(['Elapsed (s)', ...MEMORY_SERIES]);
  });

  it("carries the machine's reason beside the unread RAM, or a plain one", () => {
    expect(toMemory(machineOff, RUN).limitation).toContain('macOS');
    const noReason = { ...machineOff, machine: { available: false, reason: null } };
    expect(toMemory(noReason, RUN).limitation).toContain('The agent did not collect machine figures.');
    // On a machine-on run the RAM note has no machine reason to give.
    expect(toMemory(injectors, RUN).limitation ?? '').not.toContain('machine');
  });

  it('is empty, naming all seven, when no memory figure was read', () => {
    expectNothingDrawn(toMemory, withBuckets([bucket({ startOffsetMs: 0 }), bucket({ startOffsetMs: 1000 })]), [
      ...MEMORY_SERIES,
    ]);
  });

  it('keeps a null a gap in a series that has readings elsewhere', () => {
    const chart = toMemory(
      withBuckets([
        bucket({ startOffsetMs: 0, heapUsedBytes: BYTES_PER_MB * 4 }),
        bucket({ startOffsetMs: 1000, heapUsedBytes: null }),
      ]),
      RUN,
    );
    expect(ys(chart, 'Heap used')).toEqual([4, null]);
    expect(chart.rows[1]!.values[MEMORY_SERIES.indexOf('Heap used')]).toBe('—');
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toMemory(withBuckets([]), WINDOW).empty);
    expectAboutTheRun(toMemory(withBuckets([]), RUN).empty);
  });
});

describe('toTcpEvents', () => {
  const events = (over: Partial<NonNullable<Bucket['tcpEvents']>>): NonNullable<Bucket['tcpEvents']> => ({
    activeOpenings: 0,
    failedAttempts: 0,
    established: 0,
    receivedResets: 0,
    sentResets: 0,
    ...over,
  });

  it("names GE's five series, one per contract field", () => {
    expect(TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k])).toEqual([
      'active openings',
      'failed attempts',
      'established',
      'received resets',
      'sent resets',
    ]);
  });

  it('draws established as stored and the counters per second', () => {
    const chart = toTcpEvents(
      withBuckets(
        [bucket({ tcpEvents: events({ established: 7, activeOpenings: 10, failedAttempts: 4, receivedResets: 2, sentResets: 6 }) })],
        2000,
      ),
      RUN,
    );
    expect(ys(chart, 'established')).toEqual([7]);
    expect(ys(chart, 'active openings')).toEqual([5]);
    expect(ys(chart, 'failed attempts')).toEqual([2]);
    expect(ys(chart, 'received resets')).toEqual([1]);
    expect(ys(chart, 'sent resets')).toEqual([3]);
  });

  it('says established is a gauge', () => {
    expect(toTcpEvents(injectors, RUN).limitation).toMatch(/established.*not.*per second/i);
  });

  it('keeps a null counter a gap while drawing the established it came with', () => {
    // A first sample: the gauge is read, the counters have no predecessor yet.
    const first = { activeOpenings: null, failedAttempts: null, established: 3, receivedResets: null, sentResets: null };
    const chart = toTcpEvents(
      withBuckets([
        bucket({ startOffsetMs: 0, tcpEvents: first }),
        bucket({ startOffsetMs: 1000, tcpEvents: events({ activeOpenings: 4, established: 5 }) }),
      ]),
      RUN,
    );
    expect(ys(chart, 'established')).toEqual([3, 5]);
    expect(ys(chart, 'active openings')).toEqual([null, 4]);
    expect(chart.rows[0]!.values[TCP_EVENT_NAMES.indexOf('activeOpenings')]).toBe('—');
  });

  it('gives a bucket with no tcpEvents a null on every series', () => {
    const chart = toTcpEvents(
      withBuckets([
        bucket({ startOffsetMs: 0, tcpEvents: events({ activeOpenings: 2, established: 1 }) }),
        bucket({ startOffsetMs: 1000, tcpEvents: null }),
      ]),
      RUN,
    );
    for (const s of chart.series) expect(ys(chart, s.name)[1], s.name).toBeNull();
  });

  it('does not draw an event whose every reading is zero, but names it and keeps its column', () => {
    const chart = toTcpEvents(injectors, RUN);
    const zero = TCP_EVENT_NAMES.filter((k) => injectors.buckets.every((b) => b.tcpEvents?.[k] === 0)).map(
      (k) => TCP_EVENT_LABELS[k],
    );
    expect(zero.length).toBeGreaterThan(0);
    expect(chart.series.map((s) => s.name)).toEqual(
      TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k]).filter((n) => !zero.includes(n)),
    );
    expect(chart.limitation).toContain(zeroSeriesNote(zero)!);
    expect(chart.columns).toEqual(['Elapsed (s)', ...TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k])]);
  });

  it('does not say established is a gauge when established was not drawn', () => {
    const chart = toTcpEvents(
      withBuckets([
        bucket({ startOffsetMs: 0, tcpEvents: events({ activeOpenings: 4, established: 0 }) }),
        bucket({ startOffsetMs: 1000, tcpEvents: events({ activeOpenings: 2, established: null }) }),
      ]),
      RUN,
    );
    expect(chart.series.map((s) => s.name)).toEqual(['active openings']);
    expect(chart.limitation).toContain('established');
    expect(chart.limitation).not.toMatch(/drawn as stored/);
  });

  it('is empty when no bucket carries tcpEvents', () => {
    const none = withBuckets([bucket({ startOffsetMs: 0 }), bucket({ startOffsetMs: 1000 })]);
    expectNothingDrawn(toTcpEvents, none, TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k]));
    expect(toTcpEvents(none, RUN).limitation ?? '').not.toMatch(/drawn as stored/);
  });

  it('is empty when every counter is zero and established is zero or unread', () => {
    const quiet = withBuckets([
      bucket({ startOffsetMs: 0, tcpEvents: events({ established: null }) }),
      bucket({ startOffsetMs: 1000, tcpEvents: events({}) }),
    ]);
    expectNothingDrawn(toTcpEvents, quiet, TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k]));
  });

  it("is empty with the machine's reason when the machine collector was off, buckets or not", () => {
    expect(toTcpEvents(machineOff, RUN).empty).toBe('macOS');
    expect(toTcpEvents(machineOff, RUN).series).toEqual([]);
    expect(toTcpEvents({ ...machineOff, buckets: [], bucketWidthMs: null }, RUN).empty).toBe('macOS');
  });

  it('is empty rather than assuming 1000 ms when the payload carries no width', () => {
    expect(toTcpEvents({ ...injectors, bucketWidthMs: null }, RUN).empty).toMatch(/bucket width/);
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toTcpEvents(withBuckets([]), WINDOW).empty);
    expectAboutTheRun(toTcpEvents(withBuckets([]), RUN).empty);
  });
});

describe('toTcpSegments', () => {
  it("names GE's four series, one per contract field", () => {
    expect(TCP_SEGMENT_NAMES.map((k) => TCP_SEGMENT_LABELS[k])).toEqual([
      'received',
      'sent',
      'retransmitted',
      'received bad',
    ]);
  });

  it('draws every segment counter per second', () => {
    const chart = toTcpSegments(
      withBuckets([bucket({ tcpSegments: { received: 40, sent: 20, retransmitted: 6, receivedBad: 2 } })], 2000),
      RUN,
    );
    expect(ys(chart, 'received')).toEqual([20]);
    expect(ys(chart, 'sent')).toEqual([10]);
    expect(ys(chart, 'retransmitted')).toEqual([3]);
    expect(ys(chart, 'received bad')).toEqual([1]);
  });

  it("matches the fixture's sums divided by its width", () => {
    const chart = toTcpSegments(injectors, RUN);
    const w = injectors.bucketWidthMs! / 1000;
    expect(ys(chart, 'received')).toEqual(injectors.buckets.map((b) => b.tcpSegments!.received / w));
  });

  it('does not draw a segment counter whose every reading is zero, and names it', () => {
    const chart = toTcpSegments(injectors, RUN);
    expect(injectors.buckets.every((b) => b.tcpSegments?.receivedBad === 0)).toBe(true);
    expect(chart.series.map((s) => s.name)).not.toContain('received bad');
    expect(chart.limitation).toContain('received bad');
    expect(chart.columns).toEqual(['Elapsed (s)', 'received', 'sent', 'retransmitted', 'received bad']);
  });

  it('gives a bucket with no tcpSegments a null, never a zero', () => {
    const chart = toTcpSegments(
      withBuckets([
        bucket({ startOffsetMs: 0, tcpSegments: { received: 4, sent: 4, retransmitted: 1, receivedBad: 1 } }),
        bucket({ startOffsetMs: 1000, tcpSegments: null }),
      ]),
      RUN,
    );
    for (const s of chart.series) expect(ys(chart, s.name)[1], s.name).toBeNull();
  });

  it('is empty when no bucket carries tcpSegments, or every counter is zero', () => {
    const names = TCP_SEGMENT_NAMES.map((k) => TCP_SEGMENT_LABELS[k]);
    expectNothingDrawn(toTcpSegments, withBuckets([bucket({ startOffsetMs: 0 }), bucket({ startOffsetMs: 1000 })]), names);
    const zero = { received: 0, sent: 0, retransmitted: 0, receivedBad: 0 };
    expectNothingDrawn(
      toTcpSegments,
      withBuckets([bucket({ startOffsetMs: 0, tcpSegments: zero }), bucket({ startOffsetMs: 1000, tcpSegments: zero })]),
      names,
    );
  });

  it("is empty with the machine's reason when the machine collector was off", () => {
    expect(toTcpSegments(machineOff, RUN).empty).toBe('macOS');
    expect(toTcpSegments(machineOff, RUN).series).toEqual([]);
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toTcpSegments(withBuckets([]), WINDOW).empty);
    expectAboutTheRun(toTcpSegments(withBuckets([]), RUN).empty);
  });
});
