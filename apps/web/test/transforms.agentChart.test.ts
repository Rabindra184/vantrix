import { AgentConnectionsResponseSchema, AgentDnsResponseSchema, AgentInjectorsResponseSchema } from '@perfportal/contracts';
import type { AgentDnsResponse, AgentInjectorsResponse, DurationSection } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { bucketGrid } from '../src/charts/transforms/agentChart';
import { AGENT_ROW_LABEL, DEFAULT_AGENT_ROWS, toDurationOverTime } from '../src/charts/transforms/agentDurations';
import { toCpu, toTcpEvents } from '../src/charts/transforms/agentInjectors';
import { toDnsRate } from '../src/charts/transforms/agentRates';
import type { ChartData } from '../src/charts/types';
import fixture from './fixtures/agent-run.json';

/**
 * ═══ THE SPARSE-BUCKET POLICY, ONE CASE PER KIND OF MEASURE ═══
 *
 * The API writes the DNS rate, the status rate and every duration's
 * percentiles over time only for buckets that had an event (`agentChart.ts`).
 * The captured fixture cannot show what that costs: its run's buckets are four
 * adjacent seconds, with no missing step to fill. So every payload here is the
 * fixture's with a TEN-BUCKET hole cut between its first bucket and a later
 * one — the shape a real run has (nine seconds of connects, then thirty of
 * nothing, then one more) — and the expectations are read off that payload.
 */

const connections = AgentConnectionsResponseSchema.parse(fixture.connections);
const dns = AgentDnsResponseSchema.parse(fixture.dns);
const injectors = AgentInjectorsResponseSchema.parse(fixture.injectors);

const RUN = { windowSelected: false, filter: null } as const;
const GAP = 10;

/** Pairs of one drawn series, by name. */
function pairs(chart: ChartData, name: string): readonly (readonly [number, number | null])[] {
  const series = chart.series.find((s) => s.name === name);
  if (series === undefined) throw new Error(`no series ${name}`);
  return series.data as readonly (readonly [number, number | null])[];
}

/** Two of `buckets`, the second moved `GAP` widths past the first's neighbour. */
function holed<B extends { readonly startOffsetMs: number }>(buckets: readonly B[], width: number): B[] {
  const [first, second] = buckets;
  if (first === undefined || second === undefined) throw new Error('the fixture needs two buckets');
  return [first, { ...second, startOffsetMs: first.startOffsetMs + (GAP + 1) * width }];
}

/** The offsets a filled grid must hold between the two buckets `holed` built. */
function missingSteps(from: number, width: number): number[] {
  return Array.from({ length: GAP }, (_, i) => from + (i + 1) * width);
}

describe('bucketGrid', () => {
  it('fills every missing step between two buckets, and nothing before the first or after the last', () => {
    const grid = bucketGrid([{ startOffsetMs: 2000 }, { startOffsetMs: 5000 }], 1000);
    expect(grid.map((g) => g.x)).toEqual([2000, 3000, 4000, 5000]);
    expect(grid.map((g) => g.bucket === null)).toEqual([false, true, true, false]);
  });

  it('fills nothing without a width to step by', () => {
    expect(bucketGrid([{ startOffsetMs: 0 }, { startOffsetMs: 9000 }], null)).toHaveLength(2);
  });
});

describe('a counter: a missing bucket saw no event, a measured zero', () => {
  const w = dns.bucketWidthMs!;
  const payload: AgentDnsResponse = { ...dns, buckets: holed(dns.buckets, w) };
  const chart = toDnsRate(payload, RUN);
  const first = payload.buckets[0]!.startOffsetMs;

  it('draws each missing step as 0, never a line across it', () => {
    for (const name of ['Requests', 'OK', 'KO']) {
      const drawn = pairs(chart, name);
      expect(drawn).toHaveLength(GAP + 2);
      expect(drawn.slice(1, -1)).toEqual(missingSteps(first, w).map((x) => [x, 0]));
    }
    // The real buckets keep their own rates.
    expect(pairs(chart, 'Requests')[0]![1]).toBe(payload.buckets[0]!.requests / (w / 1000));
  });

  it('gives the table the same rows, with 0', () => {
    expect(chart.rows).toHaveLength(GAP + 2);
    for (const row of chart.rows.slice(1, -1)) expect(row.values).toEqual([0, 0, 0]);
  });
});

describe('a gauge: a missing bucket is a level nobody read, a break', () => {
  const w = injectors.bucketWidthMs!;
  const payload: AgentInjectorsResponse = { ...injectors, buckets: holed(injectors.buckets, w) };
  const chart = toCpu(payload, RUN);
  const first = payload.buckets[0]!.startOffsetMs;

  it('draws each missing step as a null, never a zero', () => {
    for (const s of chart.series) {
      expect(pairs(chart, s.name).slice(1, -1), s.name).toEqual(missingSteps(first, w).map((x) => [x, null]));
    }
    expect(chart.series.length).toBeGreaterThan(0);
  });

  it('gives the table a dash for each missing step', () => {
    expect(chart.rows).toHaveLength(GAP + 2);
    for (const row of chart.rows.slice(1, -1)) expect(row.values.every((v) => v === '—')).toBe(true);
  });
});

describe('a duration: a missing bucket measured nothing, a break', () => {
  const w = connections.bucketWidthMs!;
  const section: DurationSection = { ...connections.tcpConnect, overTime: holed(connections.tcpConnect.overTime, w) };
  const chart = toDurationOverTime(section, {
    ...RUN,
    noun: 'TCP connects',
    outcome: 'ok',
    rows: DEFAULT_AGENT_ROWS,
    widthMs: w,
  });
  const first = section.overTime[0]!.startOffsetMs;

  it('draws each missing step as a null on every row', () => {
    for (const row of DEFAULT_AGENT_ROWS) {
      expect(pairs(chart, AGENT_ROW_LABEL[row]).slice(1, -1)).toEqual(missingSteps(first, w).map((x) => [x, null]));
    }
  });

  it('counts the filled grid in its limitation, and says what it counts', () => {
    expect(chart.rows).toHaveLength(GAP + 2);
    expect(chart.limitation).toContain(`${GAP} of the ${GAP + 2} buckets this chart spans`);
  });
});

describe('a chart mixing both: TCP Connections Events per Second', () => {
  const w = injectors.bucketWidthMs!;
  const events = { activeOpenings: 4, failedAttempts: 1, established: 6, receivedResets: 2, sentResets: 3 };
  const payload: AgentInjectorsResponse = {
    ...injectors,
    buckets: holed(injectors.buckets, w).map((b) => ({ ...b, tcpEvents: events })),
  };
  const chart = toTcpEvents(payload, RUN);
  const first = payload.buckets[0]!.startOffsetMs;

  it('fills the four counters with 0 and breaks established with nulls', () => {
    for (const name of ['active openings', 'failed attempts', 'received resets', 'sent resets']) {
      expect(pairs(chart, name).slice(1, -1), name).toEqual(missingSteps(first, w).map((x) => [x, 0]));
    }
    expect(pairs(chart, 'established').slice(1, -1)).toEqual(missingSteps(first, w).map((x) => [x, null]));
  });
});
