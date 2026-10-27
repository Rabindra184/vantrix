import { TCP_STATE_NAMES } from '@perfportal/contracts';
import type { AgentConnectionsResponse, AgentDnsResponse, AgentStatusResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * The Report's agent rate and gauge charts — Connections, DNS and the HTTP
 * status breakdown — one function per GE chart, each from one
 * `/v1/runs/:id/agent*` response.
 *
 * ═══ RATES ARE THE READER'S, GAUGES ARE NOT ═══
 *
 * A counter in these payloads is the bucket's SUM, and every response carries
 * the width it was bucketed on, so a per-second figure is
 * `value / (bucketWidthMs / 1000)` — the payload's own width, never an assumed
 * 1000 (`rates.ts`' divisor note; a long run's buckets are 2000 or 4000 ms wide
 * and nothing about a mis-scaled chart looks wrong). A TCP state is a GAUGE —
 * the highest count the agent saw in the bucket — and dividing it by anything
 * would invent a "connections per second" no kernel reported.
 *
 * ═══ NEVER A ZERO WHERE NOTHING WAS MEASURED ═══
 *
 * A bucket with `states: null` is a second the agent took no reading in, so it
 * is a null y — a gap — on every state series and a dash in the table. A
 * counter, by contrast, is zero when the bucket simply saw no event, and a
 * status code absent from a bucket's `counts` had no responses there: both are
 * measured zeros and drawn as such.
 *
 * ═══ THE ZERO-SERIES RULING ═══
 *
 * The categorical palette has six hues and never cycles, and TCP states have
 * nine series while status codes are open-ended. So a series with no non-zero
 * reading in the payload is not plotted, and the chart's `limitation` names it;
 * the data table keeps every column. If more than six are still left, `Chart`'s
 * own cap and its note apply.
 *
 * Every series is `[startOffsetMs, y]` pairs on the run page's shared value
 * axis (see `telemetry.ts` for why a category axis cannot share a crosshair).
 * The unavailable cases (`available: false`) are the section's to explain, from
 * the response's `reason` and `detail`; these functions are called only for a
 * collected run, so their empty sentences are about a run or a window that
 * recorded nothing.
 */

/** Heads every data table's label column. The drawn axis is named by `Chart`. */
const TIME_COLUMN = 'Elapsed (s)';

type Opts = { readonly windowSelected: boolean };
type Pair = readonly [number, number | null];

/**
 * A bucket's sum as a per-second rate, or `null` where nothing was measured.
 *
 * Exported because the Load generators charts apply the same rate (GC counts
 * and time, TCP events and segments). `?? 0` is what this must never do.
 */
export function perSecond(value: number | null, widthMs: number): number | null {
  return value === null ? null : value / (widthMs / 1000);
}

/**
 * The zero-series ruling: the series worth drawing, and the names of those
 * whose every reading is zero.
 *
 * A series with NO reading at all — every y null — is kept, not dropped:
 * "every reading is zero" is a claim about readings, and it would be false of
 * a state the agent never managed to read. Drawn, it is a gap, which is what
 * it is. Exported for the Load generators charts, which apply the same rule.
 */
export function dropAllZero(series: readonly ChartSeries[]): {
  readonly kept: ChartSeries[];
  readonly dropped: string[];
} {
  const kept: ChartSeries[] = [];
  const dropped: string[] = [];
  for (const s of series) {
    const values = (s.data as readonly (number | null | Pair)[]).map((d) => (Array.isArray(d) ? d[1] : d) as number | null);
    const measured = values.filter((v): v is number => v !== null);
    if (measured.length > 0 && measured.every((v) => v === 0)) dropped.push(s.name);
    else kept.push(s);
  }
  return { kept, dropped };
}

/** The `limitation` sentence for what `dropAllZero` left out, or nothing. */
export function notDrawnNote(dropped: readonly string[]): string | undefined {
  return dropped.length === 0 ? undefined : `Not drawn: every reading is zero — ${dropped.join(', ')}.`;
}

/** One series' name and how to read its y off a bucket. */
interface Measure<B> {
  readonly name: string;
  readonly read: (bucket: B) => number | null;
}

/**
 * Every chart here has this shape: buckets with an offset, a fixed list of
 * measures, pairs for the drawing and the same numbers for the table.
 */
function bucketChart<B extends { readonly startOffsetMs: number }>(
  buckets: readonly B[],
  measures: readonly Measure<B>[],
  empty: string,
): ChartData {
  const columns = [TIME_COLUMN, ...measures.map((m) => m.name)];
  if (buckets.length === 0) {
    // Not a flat zero line: a window or run that recorded nothing is said so.
    return { series: [], axisLabels: [], columns, rows: [], empty };
  }
  const measured = measures.map((m) => buckets.map((b) => m.read(b)));
  const series: ChartSeries[] = measures.map((m, s) => ({
    name: m.name,
    // A null y keeps its pair — omitting the point would draw a line across the gap.
    data: buckets.map((b, i) => [b.startOffsetMs, measured[s]![i] ?? null] as Pair),
  }));
  const rows: ChartTableRow[] = buckets.map((b, i) => ({
    label: String(b.startOffsetMs / 1000),
    values: measured.map((line) => line[i] ?? '—'),
  }));
  return { series, axisLabels: [], columns, rows };
}

/** "No <things> fall in the selected window." or "… were recorded for this run." */
function emptySentence(things: string, opts: Opts): string {
  return opts.windowSelected
    ? `No ${things} fall in the selected window.`
    : `No ${things} were recorded for this run.`;
}

/** Applies the zero-series ruling to a built chart, joining its note to any other. */
function withoutAllZero(chart: ChartData, ...otherNotes: string[]): ChartData {
  const { kept, dropped } = dropAllZero(chart.series);
  const notes = [notDrawnNote(dropped), ...otherNotes].filter((n): n is string => n !== undefined);
  return { ...chart, series: kept, limitation: notes.length > 0 ? notes.join(' ') : undefined };
}

/** The width a rate divides by. Null only when nothing was collected, which these never see. */
function widthOf(response: { readonly bucketWidthMs: number | null }): number {
  return response.bucketWidthMs ?? 1000;
}

type ConnectionBucket = AgentConnectionsResponse['buckets'][number];

/**
 * GE's "Connection Open and Close Rate": Opened and Closed per second.
 *
 * No status roles: closing a connection is not a failure, so green and red
 * would misread it. The categorical palette draws them.
 */
export function toConnectionRate(c: AgentConnectionsResponse, opts: Opts): ChartData {
  const w = widthOf(c);
  return bucketChart<ConnectionBucket>(
    c.buckets,
    [
      { name: 'Opened', read: (b) => perSecond(b.opened, w) },
      { name: 'Closed', read: (b) => perSecond(b.closed, w) },
    ],
    emptySentence('connections', opts),
  );
}

const STATES_NOT_MEASURED =
  "GE's bound and idle states have no kernel state behind them, so they are not measured.";

/**
 * GE's "TCP Connection By State": one gauge series per kernel state, as GE
 * spells it, drawn as stored. A bucket with no reading is a gap on all nine.
 */
export function toTcpStates(c: AgentConnectionsResponse, opts: Opts): ChartData {
  const chart = bucketChart<ConnectionBucket>(
    c.buckets,
    TCP_STATE_NAMES.map((state) => ({ name: state, read: (b) => (b.states === null ? null : b.states[state]) })),
    emptySentence('connections', opts),
  );
  if (chart.empty !== undefined) return chart;
  return withoutAllZero(chart, STATES_NOT_MEASURED);
}

/** GE's "Bandwidth Usage per second": Sent and Received in Mbps, `bits / (width/1000) / 1e6`. */
export function toBandwidth(c: AgentConnectionsResponse, opts: Opts): ChartData {
  const w = widthOf(c);
  const mbps = (bits: number) => perSecond(bits, w)! / 1e6;
  return bucketChart<ConnectionBucket>(
    c.buckets,
    [
      { name: 'Sent', read: (b) => mbps(b.bitsOut) },
      { name: 'Received', read: (b) => mbps(b.bitsIn) },
    ],
    emptySentence('connections', opts),
  );
}

/**
 * Requests, OK and KO, in `toDnsRate`'s series order. KO is a failed lookup, so
 * here the status colours do mean what they mean everywhere else. A module
 * constant: it lands in a `useEffect` dependency list.
 */
export const DNS_RATE_ROLES: readonly StatusRole[] = ['neutral', 'passed', 'failed'];

/** GE's "DNS Resolution per Second": Requests, OK and KO per second. */
export function toDnsRate(d: AgentDnsResponse, opts: Opts): ChartData {
  const w = widthOf(d);
  return bucketChart<AgentDnsResponse['buckets'][number]>(
    d.buckets,
    [
      { name: 'Requests', read: (b) => perSecond(b.requests, w) },
      { name: 'OK', read: (b) => perSecond(b.ok, w) },
      { name: 'KO', read: (b) => perSecond(b.ko, w) },
    ],
    emptySentence('lookups', opts),
  );
}

/**
 * GE's "Responses per Second by Status": one series per code, in `s.codes`'
 * order, per second. A code absent from a bucket had no responses there — a
 * measured zero. A code with none in the whole payload falls under the
 * zero-series ruling.
 */
export function toStatusRate(s: AgentStatusResponse, opts: Opts): ChartData {
  const w = widthOf(s);
  const chart = bucketChart<AgentStatusResponse['buckets'][number]>(
    s.buckets,
    s.codes.map((code) => ({ name: code, read: (b) => perSecond(b.counts[code] ?? 0, w) })),
    emptySentence('responses', opts),
  );
  if (chart.empty !== undefined) return chart;
  return withoutAllZero(chart);
}
