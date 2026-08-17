import type { TelemetryResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * Gatling's own decomposition of the Load Generators section, one function per
 * chart, so a difference between what they draw and what we draw is a diff in
 * one place.
 *
 * `null` IS PRESERVED, NEVER COERCED TO 0. ECharts draws a gap for null and a
 * point on the floor for zero — and a rate is null exactly when the interval
 * could not be measured (the first sample of a host, or one spanning a counter
 * reset). A zero there would claim the generator went quiet at the precise
 * moment it restarted.
 *
 * TCP STATES ARE THE OPPOSITE: absent means zero, because the migration stores
 * the states the kernel actually reported and omits the ones at zero. So the
 * state chart zero-fills, and only the state chart.
 *
 * ═══ A CATEGORY AXIS, LIKE `transforms/rates.ts` AND UNLIKE `errorSeries.ts` ═══
 *
 * Telemetry is DENSE — one sample per interval, the opposite of the sparse
 * failures `errorSeries.ts` draws on a value axis with `[x, y]` pairs. A pair
 * cannot express `null`: there is no coordinate for "no point here", only a
 * coordinate to omit, and omitting one silently drops the gap that is the
 * entire point of `packages/statistics/src/telemetry.ts`'s reset handling. So
 * every chart here is `axisLabels` (this host's own offsets, in the same
 * order for all six charts, because they are all read off the same
 * `host.points`) plus one plain `(number | null)[]` per series, index-aligned
 * with it — exactly `rates.ts`'s shape, not `errorSeries.ts`'s.
 */

/** One host's telemetry, restated from the contract so this file says what it
 *  actually reads rather than the whole response shape. */
type TelemetryHost = TelemetryResponse['hosts'][number];
type TelemetryPoint = TelemetryHost['points'][number];

/** Heads the label column of every table here, and names the shared category
 *  axis `TelemetryCharts.tsx` draws it on. */
const TIME_COLUMN = 'Elapsed (ms)';

const BYTES_PER_MB = 1024 * 1024;

/** One drawn series: its name, and how to read it off a point. */
interface Measure {
  readonly name: string;
  readonly read: (point: TelemetryPoint) => number | null;
}

/**
 * Five of the six charts share this shape exactly: a fixed list of measures,
 * each read straight off `host.points` with no further arithmetic (the rates
 * arrive already-computed, per interval, from `toTelemetrySeries` — this file
 * never divides by a bucket width). Only the TCP-state chart differs, because
 * its series list is not fixed in advance; see `toTcpStateChart`.
 */
function telemetryChart(
  host: TelemetryHost,
  measures: readonly Measure[],
  empty: string,
): ChartData {
  const columns = [TIME_COLUMN, ...measures.map((m) => m.name)];

  if (host.points.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Not a flat zero line, and not empty axes either (`Chart`'s own empty
      // branch draws the explanation): "this host reported nothing in this
      // window" and "the agent never ran" are different facts — the second is
      // `RunTelemetry`'s job, via `available`, not this function's.
      empty,
    };
  }

  // SCALARS FIRST, so the rows below index numbers rather than `[x, y]`
  // tuples — the same split `toRequestRate` and `usersChart` make.
  const measured = measures.map((m) => ({
    name: m.name,
    data: host.points.map((p) => m.read(p)),
  }));

  const rows: ChartTableRow[] = host.points.map((point, i) => ({
    label: String(point.startOffsetMs),
    // A gap is a dash, never a zero — same rule as the chart itself, and the
    // table is the more quotable of the two surfaces.
    values: measured.map((s) => s.data[i] ?? '—'),
  }));

  // PAIRS, always: these charts share the run page's crosshair, and a
  // connected pointer on a category axis syncs by index. See `ChartXAxis.min`.
  const series: ChartSeries[] = measured.map((m) => ({
    name: m.name,
    data: host.points.map((p, i) => [p.startOffsetMs, m.data[i] ?? null] as [number, number | null]),
  }));

  return {
    series,
    axisLabels: host.points.map((p) => p.startOffsetMs),
    columns,
    rows,
  };
}

/** CPU usage, Gatling's own three series and order — "Total" reads as
 *  not-idle; see `packages/statistics/src/telemetry.ts` for why iowait counts
 *  toward it on a load generator. */
export function toCpuChart(host: TelemetryHost): ChartData {
  return telemetryChart(
    host,
    [
      { name: 'Total', read: (p) => p.cpuTotalPct },
      { name: 'User', read: (p) => p.cpuUserPct },
      { name: 'Sys', read: (p) => p.cpuSystemPct },
    ],
    'No CPU samples were recorded for this load generator in this window.',
  );
}

/** Memory, in MB as Gatling labels it — the payload carries bytes, gauges
 *  rather than rates, and (unlike every other chart here) never null: an
 *  instantaneous reading survives a restart that would null a rate. */
export function toMemoryChart(host: TelemetryHost): ChartData {
  const toMb = (bytes: number) => bytes / BYTES_PER_MB;
  return telemetryChart(
    host,
    [
      { name: 'Used', read: (p) => toMb(p.memUsedBytes) },
      { name: 'Total', read: (p) => toMb(p.memTotalBytes) },
    ],
    'No memory samples were recorded for this load generator in this window.',
  );
}

/** Bandwidth, in bytes per second — already a rate in the payload. */
export function toBandwidthChart(host: TelemetryHost): ChartData {
  return telemetryChart(
    host,
    [
      { name: 'Received', read: (p) => p.rxBytesPerSec },
      { name: 'Sent', read: (p) => p.txBytesPerSec },
    ],
    'No bandwidth samples were recorded for this load generator in this window.',
  );
}

/** TCP connection events per second: new connections opened by this host
 *  (active) versus accepted onto it (passive). */
export function toConnectionEventsChart(host: TelemetryHost): ChartData {
  return telemetryChart(
    host,
    [
      { name: 'Active opens', read: (p) => p.activeOpensPerSec },
      { name: 'Passive opens', read: (p) => p.passiveOpensPerSec },
    ],
    'No TCP connection events were recorded for this load generator in this window.',
  );
}

/** TCP segment events per second. "Received bad" is `inErrsPerSec` — segments
 *  the kernel counted as errored on receipt — Gatling's own fourth series
 *  beside received/sent/retransmitted. */
export function toSegmentEventsChart(host: TelemetryHost): ChartData {
  return telemetryChart(
    host,
    [
      { name: 'Received', read: (p) => p.inSegsPerSec },
      { name: 'Sent', read: (p) => p.outSegsPerSec },
      { name: 'Retransmitted', read: (p) => p.retransSegsPerSec },
      { name: 'Received bad', read: (p) => p.inErrsPerSec },
    ],
    'No TCP segment events were recorded for this load generator in this window.',
  );
}

/**
 * Connections by state — the one chart in this file that zero-fills.
 *
 * `tcpStates` on each point holds only the states the kernel reported for
 * that sample; a state at zero is omitted rather than sent as `0`
 * (`packages/statistics/src/telemetry.ts`, and the migration underneath it).
 * So the series list cannot be fixed in advance like the other five: it is
 * the UNION of every state seen anywhere in this host's points, sorted for a
 * stable legend, and a point that did not report a given state draws `0`
 * there — the correct reading, not a gap, because the migration's own
 * "absent when zero" is the reason the field is missing rather than a claim
 * that it was unmeasurable.
 */
export function toTcpStateChart(host: TelemetryHost): ChartData {
  const states = [...new Set(host.points.flatMap((p) => Object.keys(p.tcpStates)))].sort();
  const columns = [TIME_COLUMN, ...states];

  if (host.points.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      empty: 'No TCP connection states were recorded for this load generator in this window.',
    };
  }

  const measured = states.map((state) => ({
    name: state,
    data: host.points.map((p) => p.tcpStates[state] ?? 0),
  }));

  const rows: ChartTableRow[] = host.points.map((point, i) => ({
    label: String(point.startOffsetMs),
    // Never a dash here: absence means zero for this chart alone, so every
    // cell is a real number.
    values: measured.map((s) => s.data[i]!),
  }));

  // Pairs, for the same reason as the builder above.
  const series: ChartSeries[] = measured.map((m) => ({
    name: m.name,
    data: host.points.map((p, i) => [p.startOffsetMs, m.data[i]!] as [number, number]),
  }));

  return {
    series,
    axisLabels: host.points.map((p) => p.startOffsetMs),
    columns,
    rows,
  };
}
