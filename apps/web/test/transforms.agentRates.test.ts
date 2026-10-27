import {
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  AgentStatusResponseSchema,
  TCP_STATE_NAMES,
} from '@perfportal/contracts';
import type { AgentConnectionsResponse, AgentDnsResponse, AgentStatusResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { expectAboutTheRun, expectAboutTheWindow } from './support/emptySentence';
import {
  DNS_RATE_ROLES,
  dropAllZero,
  perSecond,
  unreadSeriesNote,
  zeroSeriesNote,
  toBandwidth,
  toConnectionRate,
  toDnsRate,
  toStatusRate,
  toTcpStates,
} from '../src/charts/transforms/agentRates';
import type { ChartData } from '../src/charts/types';
import fixture from './fixtures/agent-run.json';

/**
 * The Report's Connections, DNS and status rate charts, read against
 * `fixtures/agent-run.json` — captured from a real API over a real agent file
 * (Task 1), parsed here with the contract schemas so a drifted fixture fails
 * loudly rather than feeding these cases a shape the page never gets.
 *
 * THE FIXTURE CANNOT DISCRIMINATE THE DIVISOR ON ITS OWN: its `bucketWidthMs`
 * is 1000, so `value / (width/1000)` and `value / 1` agree in every bucket. The
 * width cases therefore build payloads at 2000 ms, the same trap
 * `transforms.rates.test.ts` records for `/series`.
 *
 * Nor does it carry a bucket with `states: null` (the agent read the kernel
 * every second of that run), so the null-states case is synthetic too.
 */

const connections = AgentConnectionsResponseSchema.parse(fixture.connections);
const dns = AgentDnsResponseSchema.parse(fixture.dns);
const status = AgentStatusResponseSchema.parse(fixture.status);

const RUN = { windowSelected: false } as const;
const WINDOW = { windowSelected: true } as const;

/** One drawn series' y values, by name. */
function ys(chart: ChartData, name: string): readonly (number | null)[] {
  const series = chart.series.find((s) => s.name === name);
  if (series === undefined) throw new Error(`no series ${name}`);
  return (series.data as readonly (readonly [number, number | null])[]).map(([, y]) => y);
}

/** A connections payload with the given buckets and width, everything else the fixture's. */
function withBuckets(
  buckets: AgentConnectionsResponse['buckets'],
  bucketWidthMs = connections.bucketWidthMs,
): AgentConnectionsResponse {
  return { ...connections, bucketWidthMs, buckets };
}

const ZERO_STATES = Object.fromEntries(TCP_STATE_NAMES.map((s) => [s, 0])) as Record<
  (typeof TCP_STATE_NAMES)[number],
  number
>;

describe('perSecond and dropAllZero', () => {
  it('divides by the bucket width in seconds and keeps a null a null', () => {
    expect(perSecond(10, 2000)).toBe(5);
    expect(perSecond(null, 2000)).toBeNull();
  });

  it('sorts series into kept, zero (read, every reading 0) and unread (no reading at all)', () => {
    const { kept, zero, unread } = dropAllZero([
      { name: 'a', data: [[0, 0], [1000, null]] },
      { name: 'b', data: [[0, 0], [1000, 3]] },
      { name: 'c', data: [[0, null], [1000, null]] },
    ]);
    expect(kept.map((s) => s.name)).toEqual(['b']);
    expect(zero).toEqual(['a']);
    expect(unread).toEqual(['c']);
  });

  it('names each group in its own sentence, and says nothing for an empty group', () => {
    expect(zeroSeriesNote(['a', 'b'])).toMatch(/every reading is zero.*a, b/);
    expect(unreadSeriesNote(['c'])).toMatch(/no reading.*c/);
    expect(unreadSeriesNote(['c'])).not.toMatch(/zero/);
    expect(zeroSeriesNote([])).toBeUndefined();
    expect(unreadSeriesNote([])).toBeUndefined();
  });
});

describe('a payload with no bucket width', () => {
  it('is empty on every rate chart rather than assuming 1000 ms', () => {
    const charts = [
      toConnectionRate({ ...connections, bucketWidthMs: null }, RUN),
      toBandwidth({ ...connections, bucketWidthMs: null }, RUN),
      toDnsRate({ ...dns, bucketWidthMs: null }, RUN),
      toStatusRate({ ...status, bucketWidthMs: null }, RUN),
    ];
    for (const chart of charts) {
      expect(chart.series).toEqual([]);
      expect(chart.empty).toMatch(/bucket width/);
      expect(chart.columns[0]).toBe('Elapsed (s)');
    }
  });
});

describe('toConnectionRate', () => {
  it('draws Opened and Closed, as pairs on the bucket offsets', () => {
    const chart = toConnectionRate(connections, RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['Opened', 'Closed']);
    expect(chart.columns[0]).toBe('Elapsed (s)');
    const xs = (chart.series[0]!.data as readonly (readonly [number, number | null])[]).map(([x]) => x);
    expect(xs).toEqual(connections.buckets.map((b) => b.startOffsetMs));
  });

  it('draws rates that integrate back to the run sums', () => {
    const chart = toConnectionRate(connections, RUN);
    const widthS = connections.bucketWidthMs! / 1000;
    const opened = ys(chart, 'Opened').reduce<number>((sum, y) => sum + (y ?? 0) * widthS, 0);
    const closed = ys(chart, 'Closed').reduce<number>((sum, y) => sum + (y ?? 0) * widthS, 0);
    expect(opened).toBe(connections.sums.opened);
    expect(closed).toBe(connections.sums.closed);
  });

  it('divides by the payload width: 10 opened in a 2000 ms bucket is 5 per second', () => {
    const chart = toConnectionRate(
      withBuckets([{ startOffsetMs: 0, opened: 10, closed: 4, bitsOut: 0, bitsIn: 0, states: null }], 2000),
      RUN,
    );
    expect(ys(chart, 'Opened')).toEqual([10 / 2]);
    expect(ys(chart, 'Closed')).toEqual([4 / 2]);
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toConnectionRate(withBuckets([]), WINDOW).empty, /connections/);
    expectAboutTheRun(toConnectionRate(withBuckets([]), RUN).empty, /connections/);
  });
});

describe('toBandwidth', () => {
  it('draws Sent and Received in Mbps', () => {
    const chart = toBandwidth(connections, RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['Sent', 'Received']);
    const i = connections.buckets.findIndex((b) => b.bitsOut > 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const b = connections.buckets[i]!;
    const w = connections.bucketWidthMs!;
    expect(ys(chart, 'Sent')[i]).toBe(b.bitsOut / (w / 1000) / 1e6);
    expect(ys(chart, 'Received')[i]).toBe(b.bitsIn / (w / 1000) / 1e6);
  });

  it('divides by the payload width', () => {
    const chart = toBandwidth(
      withBuckets([{ startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 4e6, bitsIn: 2e6, states: null }], 2000),
      RUN,
    );
    expect(ys(chart, 'Sent')).toEqual([2]);
    expect(ys(chart, 'Received')).toEqual([1]);
  });
});

describe('toTcpStates', () => {
  it('draws each state as stored, never divided, even at a wider bucket', () => {
    const states = { ...ZERO_STATES, established: 8, timeWait: 3 };
    const chart = toTcpStates(
      withBuckets([{ startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states }], 2000),
      RUN,
    );
    expect(ys(chart, 'established')).toEqual([states.established]);
    expect(ys(chart, 'timeWait')).toEqual([states.timeWait]);
  });

  it('gives a bucket with no reading a null on every state series, never a zero', () => {
    const everyState = Object.fromEntries(TCP_STATE_NAMES.map((s, i) => [s, i + 1])) as typeof ZERO_STATES;
    const chart = toTcpStates(
      withBuckets([
        { startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states: everyState },
        { startOffsetMs: 1000, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states: null },
      ]),
      RUN,
    );
    expect(chart.series.map((s) => s.name)).toEqual([...TCP_STATE_NAMES]);
    for (const s of chart.series) expect(ys(chart, s.name)[1], s.name).toBeNull();
    // And the table says so with a dash, not a zero.
    expect(chart.rows[1]!.values.every((v) => v === '—')).toBe(true);
  });

  it('does not draw a state whose every reading is zero, but names it and keeps its column', () => {
    const chart = toTcpStates(connections, RUN);
    const allZero = TCP_STATE_NAMES.filter((s) =>
      connections.buckets.every((b) => b.states === null || b.states[s] === 0),
    );
    const drawn = TCP_STATE_NAMES.filter((s) => !allZero.includes(s));
    // The fixture has both kinds, or this case proves nothing.
    expect(allZero.length).toBeGreaterThan(0);
    expect(drawn.length).toBeGreaterThan(0);
    expect(chart.series.map((s) => s.name)).toEqual(drawn);
    for (const s of allZero) expect(chart.limitation, s).toContain(s);
    for (const s of drawn) expect(chart.limitation, s).not.toMatch(new RegExp(`\\b${s}\\b`));
    expect(chart.columns).toEqual(['Elapsed (s)', ...TCP_STATE_NAMES]);
  });

  it('is empty, with no series, when no bucket carries a reading — the macOS run', () => {
    const unread = withBuckets([
      { startOffsetMs: 0, opened: 1, closed: 0, bitsOut: 0, bitsIn: 0, states: null },
      { startOffsetMs: 1000, opened: 0, closed: 1, bitsOut: 0, bitsIn: 0, states: null },
    ]);
    const chart = toTcpStates(unread, RUN);
    expect(chart.series).toEqual([]);
    expectAboutTheRun(chart.empty, /TCP connection state was read/);
    expectAboutTheWindow(toTcpStates(unread, WINDOW).empty, /TCP connection state was read/);
    expect(chart.columns).toEqual(['Elapsed (s)', ...TCP_STATE_NAMES]);
    const reason = 'The machine collector is Linux-only.';
    expect(toTcpStates(unread, { ...RUN, notMeasuredReason: reason }).empty).toContain(reason);
  });

  it('puts an all-null state and an all-zero state in separate sentences, beside a read one', () => {
    // TODAY'S CONTRACT CANNOT SEND THIS: `states` is null or a whole object, so
    // one state alone is never unread, and the all-unread payload is the empty
    // case above. It is built with a cast because `tcpEvents` already went
    // per-field nullable for the same reason, and the day `states` does, the
    // transform must route the two groups to their own sentences, not draw a gap.
    const read = Object.fromEntries(TCP_STATE_NAMES.map((s) => [s, 2])) as typeof ZERO_STATES;
    const states = { ...read, closing: null, finWait2: 0 } as unknown as typeof ZERO_STATES;
    const chart = toTcpStates(
      withBuckets([
        { startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states },
        { startOffsetMs: 1000, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states },
      ]),
      RUN,
    );
    const names = chart.series.map((s) => s.name);
    expect(names).toEqual(TCP_STATE_NAMES.filter((s) => s !== 'closing' && s !== 'finWait2'));
    expect(chart.limitation).toContain(zeroSeriesNote(['finWait2'])!);
    expect(chart.limitation).toContain(unreadSeriesNote(['closing'])!);
    expect(chart.columns).toEqual(['Elapsed (s)', ...TCP_STATE_NAMES]);
  });

  it('is empty, naming every state, when states were read and every one stayed at zero', () => {
    const chart = toTcpStates(
      withBuckets([
        { startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states: ZERO_STATES },
        { startOffsetMs: 1000, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states: ZERO_STATES },
      ]),
      RUN,
    );
    expect(chart.series).toEqual([]);
    expectAboutTheRun(chart.empty, /zero/);
    for (const s of TCP_STATE_NAMES) expect(chart.empty, s).toContain(s);
    expect(chart.rows.length).toBe(2);
    expect(chart.columns).toEqual(['Elapsed (s)', ...TCP_STATE_NAMES]);
  });

  it("says GE's bound and idle are not measured", () => {
    expect(toTcpStates(connections, RUN).limitation).toMatch(/\bbound\b.*\bidle\b/);
  });

  it('says whether the window or the run recorded nothing', () => {
    expectAboutTheWindow(toTcpStates(withBuckets([]), WINDOW).empty, /connections/);
    expectAboutTheRun(toTcpStates(withBuckets([]), RUN).empty, /connections/);
  });
});

describe('toDnsRate', () => {
  it('draws Requests, OK and KO per second, in the role order exported for them', () => {
    const chart = toDnsRate(dns, RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['Requests', 'OK', 'KO']);
    expect(DNS_RATE_ROLES).toEqual(['neutral', 'passed', 'failed']);
    const widthS = dns.bucketWidthMs! / 1000;
    const requests = ys(chart, 'Requests').reduce<number>((sum, y) => sum + (y ?? 0) * widthS, 0);
    expect(requests).toBe(dns.sums.requests);
  });

  it('divides by the payload width', () => {
    const wide: AgentDnsResponse = {
      ...dns,
      bucketWidthMs: 2000,
      buckets: [{ startOffsetMs: 0, requests: 10, ok: 8, ko: 2 }],
    };
    const chart = toDnsRate(wide, RUN);
    expect(ys(chart, 'Requests')).toEqual([5]);
    expect(ys(chart, 'OK')).toEqual([4]);
    expect(ys(chart, 'KO')).toEqual([1]);
  });

  it('says whether the window or the run recorded nothing', () => {
    const none: AgentDnsResponse = { ...dns, buckets: [] };
    expectAboutTheWindow(toDnsRate(none, WINDOW).empty, /lookups/);
    expectAboutTheRun(toDnsRate(none, RUN).empty, /lookups/);
  });
});

describe('toStatusRate', () => {
  it('draws one series per code, in the payload order', () => {
    expect(toStatusRate(status, RUN).series.map((s) => s.name)).toEqual(status.codes);
  });

  it('draws a code absent from a bucket as a measured zero, and divides by the width', () => {
    const wide: AgentStatusResponse = {
      ...status,
      codes: ['200', '500'],
      bucketWidthMs: 2000,
      buckets: [
        { startOffsetMs: 0, counts: { '200': 10 } },
        { startOffsetMs: 2000, counts: { '200': 4, '500': 6 } },
      ],
    };
    const chart = toStatusRate(wide, RUN);
    expect(ys(chart, '200')).toEqual([5, 2]);
    expect(ys(chart, '500')).toEqual([0, 3]);
  });

  it('does not draw a code with no response in the window, and names it', () => {
    const quiet: AgentStatusResponse = {
      ...status,
      codes: ['200', '503'],
      buckets: [{ startOffsetMs: 0, counts: { '200': 3 } }],
    };
    const chart = toStatusRate(quiet, RUN);
    expect(chart.series.map((s) => s.name)).toEqual(['200']);
    expect(chart.limitation).toContain('503');
    expect(chart.columns).toEqual(['Elapsed (s)', '200', '503']);
  });

  it('is empty, naming every code, when no code had a response', () => {
    const quiet: AgentStatusResponse = {
      ...status,
      codes: ['200', '503'],
      buckets: [{ startOffsetMs: 0, counts: {} }],
    };
    const chart = toStatusRate(quiet, RUN);
    expect(chart.series).toEqual([]);
    expectAboutTheRun(chart.empty, /200, 503/);
    expectAboutTheWindow(toStatusRate(quiet, WINDOW).empty, /200, 503/);
  });

  it('is empty when the payload names no code while buckets exist', () => {
    const codeless: AgentStatusResponse = { ...status, codes: [], buckets: [{ startOffsetMs: 0, counts: {} }] };
    expect(toStatusRate(codeless, RUN).series).toEqual([]);
    expectAboutTheRun(toStatusRate(codeless, RUN).empty, /responses/);
    expectAboutTheWindow(toStatusRate(codeless, WINDOW).empty, /responses/);
  });

  it('says whether the window or the run recorded nothing', () => {
    const none: AgentStatusResponse = { ...status, buckets: [] };
    expectAboutTheWindow(toStatusRate(none, WINDOW).empty, /responses/);
    expectAboutTheRun(toStatusRate(none, RUN).empty, /responses/);
  });
});
