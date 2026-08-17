import { describe, expect, it } from 'vitest';
import type { TelemetryResponse } from '@perfportal/contracts';
import {
  toBandwidthChart,
  toConnectionEventsChart,
  toCpuChart,
  toMemoryChart,
  toSegmentEventsChart,
  toTcpStateChart,
} from '../src/charts/transforms/telemetry';

/**
 * The y of a series' nth point.
 *
 * These transforms emit PAIR-shaped data — `[elapsedMs, value]` — because the
 * telemetry charts share the run page's crosshair and a connected pointer on a
 * category axis syncs by INDEX, which is wrong the moment two payloads have
 * different bucket counts (§22.5, `ChartXAxis.min`). The assertions below are
 * about the VALUE, unchanged; this is the one place that knows the shape.
 */
function y(series: { data: unknown }, i: number): number | null {
  const point = (series.data as readonly (readonly [number, number | null])[])[i];
  if (point === undefined) throw new Error(`no point at index ${i}`);
  return point[1];
}


type TelemetryHost = TelemetryResponse['hosts'][number];

/**
 * Written against the REAL `ChartData` contract (`src/charts/types.ts`):
 * `series[].data` and `axisLabels`, never `chart.x` / `series[].values`. See
 * controller ruling R1 in the task brief — the brief's own draft test used a
 * shape that does not exist, and `transforms/rates.ts` is the precedent this
 * follows: a CATEGORY axis, one plain `(number | null)[]` per series, aligned
 * with `axisLabels` by index.
 *
 * One host, two points: the first fully measured, the second a counter reset
 * (every rate null) that still reports a memory gauge and a narrower TCP
 * state histogram — exactly what `packages/statistics/src/telemetry.ts`
 * actually produces across a reset (`toTelemetrySeries`'s docstring).
 */
const host: TelemetryHost = {
  host: 'gen-1',
  clockSkewMs: 40,
  points: [
    {
      startOffsetMs: 0,
      cpuTotalPct: 12,
      cpuUserPct: 8,
      cpuSystemPct: 4,
      memUsedBytes: 2 * 1024 * 1024,
      memTotalBytes: 8 * 1024 * 1024,
      rxBytesPerSec: 1000,
      txBytesPerSec: 2000,
      inSegsPerSec: 10,
      outSegsPerSec: 12,
      retransSegsPerSec: 0,
      inErrsPerSec: 0,
      activeOpensPerSec: 1,
      passiveOpensPerSec: 0,
      tcpStates: { ESTABLISHED: 10, TIME_WAIT: 4 },
    },
    {
      startOffsetMs: 1000,
      cpuTotalPct: null,
      cpuUserPct: null,
      cpuSystemPct: null,
      memUsedBytes: 3 * 1024 * 1024,
      memTotalBytes: 8 * 1024 * 1024,
      rxBytesPerSec: null,
      txBytesPerSec: null,
      inSegsPerSec: null,
      outSegsPerSec: null,
      retransSegsPerSec: null,
      inErrsPerSec: null,
      activeOpensPerSec: null,
      passiveOpensPerSec: null,
      tcpStates: { ESTABLISHED: 12 },
    },
  ],
};

describe('telemetry transforms', () => {
  it('keeps an unmeasurable interval as null rather than zero', () => {
    const chart = toCpuChart(host);
    const total = chart.series.find((s) => /total/i.test(s.name))!;
    // ECharts draws a GAP for null and a point on the floor for 0. Zero here
    // would claim the generator was idle across a counter reset.
    expect(y(total, 1)).toBeNull();
  });

  it('converts memory to MB, as Gatling labels it', () => {
    const chart = toMemoryChart(host);
    const used = chart.series.find((s) => /used/i.test(s.name))!;
    expect(y(used, 0)).toBeCloseTo(host.points[0]!.memUsedBytes / (1024 * 1024), 6);
  });

  it('gives every state seen anywhere its own series, zero-filled where absent', () => {
    const chart = toTcpStateChart(host);
    expect(chart.series.map((s) => s.name).sort()).toEqual(['ESTABLISHED', 'TIME_WAIT']);
    // TIME_WAIT is absent from the second point — absent means zero (the
    // migration's "absent when zero"), NOT a gap in the line.
    const timeWait = chart.series.find((s) => s.name === 'TIME_WAIT')!;
    expect(y(timeWait, 1)).toBe(0);
  });

  it("uses the payload's own offsets as the x axis", () => {
    expect(toCpuChart(host).axisLabels).toEqual(host.points.map((p) => p.startOffsetMs));
  });

  it('lists the label column first, then one column per series, in Gatling order', () => {
    expect(toCpuChart(host).columns).toEqual(['Elapsed (ms)', 'Total', 'User', 'Sys']);
  });

  it('rows carry a dash where a rate could not be measured, never a zero', () => {
    const row = toCpuChart(host).rows.find((r) => r.label === '1000')!;
    expect(row.values).toEqual(['—', '—', '—']);
  });

  it('passes bandwidth counters straight through in bytes per second', () => {
    const chart = toBandwidthChart(host);
    const received = chart.series.find((s) => /received/i.test(s.name))!;
    expect(y(received, 0)).toBe(host.points[0]!.rxBytesPerSec);
    expect(y(received, 1)).toBeNull();
  });

  it('names the TCP connection-event series Active opens / Passive opens', () => {
    const chart = toConnectionEventsChart(host);
    expect(chart.series.map((s) => s.name)).toEqual(['Active opens', 'Passive opens']);
    expect(y(chart.series[0]!, 0)).toBe(host.points[0]!.activeOpensPerSec);
  });

  it('names the four segment-event series and maps "Received bad" to inErrsPerSec', () => {
    const chart = toSegmentEventsChart(host);
    expect(chart.series.map((s) => s.name)).toEqual([
      'Received',
      'Sent',
      'Retransmitted',
      'Received bad',
    ]);
    const receivedBad = chart.series.find((s) => s.name === 'Received bad')!;
    expect(y(receivedBad, 0)).toBe(host.points[0]!.inErrsPerSec);
  });

  it('keeps a measured zero as zero, not as a gap — the opposite defect from null coercion', () => {
    // point[0].retransSegsPerSec is 0, a real measurement. A transform reading
    // it with `value || null` (rather than the null check the schema needs)
    // would turn this specific zero into a gap.
    const chart = toSegmentEventsChart(host);
    const retransmitted = chart.series.find((s) => s.name === 'Retransmitted')!;
    expect(y(retransmitted, 0)).toBe(0);
  });

  it('explains rather than draws empty axes when a host reports no points', () => {
    const emptyHost = { host: 'gen-2', clockSkewMs: 0, points: [] };
    const chart = toCpuChart(emptyHost);
    expect(chart.series).toEqual([]);
    expect(chart.axisLabels).toEqual([]);
    expect(chart.empty).toBeDefined();
  });
});
