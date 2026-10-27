import { TCP_STATE_NAMES } from '@perfportal/contracts';
import type { AgentConnectionsResponse, AgentDnsResponse, AgentStatusResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData } from '../types';
import { bucketChart, emptySentence, noWidth, perSecond, withoutAllZero, type Opts } from './agentChart';

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
 * reading in the payload is not plotted, and the chart's `limitation` names it
 * — in one of two sentences, because "every reading was zero" and "nothing was
 * read" are different facts; the data table keeps every column. If more than
 * six are still left, `Chart`'s own cap and its note apply.
 *
 * Every series is `[startOffsetMs, y]` pairs on the run page's shared value
 * axis (see `telemetry.ts` for why a category axis cannot share a crosshair),
 * built from `agentChart.ts`' kit — which also fills the missing steps of a
 * sparse payload, by whether each measure is a counter or a gauge.
 * The unavailable cases (`available: false`) are the section's to explain, from
 * the response's `reason` and `detail`; these functions are called only for a
 * collected run, so their empty sentences are about a run or a window that
 * recorded nothing.
 */

type ConnectionBucket = AgentConnectionsResponse['buckets'][number];

/**
 * GE's "Connection Open and Close Rate": Opened and Closed per second.
 *
 * No status roles: closing a connection is not a failure, so green and red
 * would misread it. The categorical palette draws them.
 */
export function toConnectionRate(c: AgentConnectionsResponse, opts: Opts): ChartData {
  const w = c.bucketWidthMs;
  if (w === null) return noWidth(['Opened', 'Closed']);
  return bucketChart<ConnectionBucket>(
    c.buckets,
    [
      { name: 'Opened', read: (b) => perSecond(b.opened, w), gap: 'counter' },
      { name: 'Closed', read: (b) => perSecond(b.closed, w), gap: 'counter' },
    ],
    emptySentence('connections', opts),
    w,
  );
}

const STATES_NOT_MEASURED =
  "GE's bound and idle states have no kernel state behind them, so they are not measured.";

/**
 * GE's "TCP Connection By State": one gauge series per kernel state, as GE
 * spells it, drawn as stored. A bucket with no reading is a gap on all nine.
 *
 * WHEN NO BUCKET CARRIES A READING the chart is `empty`, not nine invisible
 * lines: that is every macOS run, whose kernel TCP states the agent cannot
 * read. `notMeasuredReason` is the agent's own reason the machine collector
 * was off (`summary.header.reasons.machine`), appended when the caller has it.
 */
export function toTcpStates(
  c: AgentConnectionsResponse,
  opts: Opts & { readonly notMeasuredReason?: string },
): ChartData {
  const chart = bucketChart<ConnectionBucket>(
    c.buckets,
    TCP_STATE_NAMES.map((state) => ({
      name: state,
      read: (b: ConnectionBucket) => (b.states === null ? null : b.states[state]),
      gap: 'gauge' as const,
    })),
    emptySentence('connections', opts),
    c.bucketWidthMs,
  );
  if (chart.empty !== undefined) return chart;
  if (c.buckets.every((b) => b.states === null)) {
    const unread = opts.windowSelected
      ? 'No TCP connection state was read in the selected window.'
      : 'No TCP connection state was read for this run.';
    return {
      ...chart,
      series: [],
      empty: opts.notMeasuredReason === undefined ? unread : `${unread} ${opts.notMeasuredReason}`,
    };
  }
  return withoutAllZero(chart, opts, STATES_NOT_MEASURED);
}

/** GE's "Bandwidth Usage per second": Sent and Received in Mbps, `bits / (width/1000) / 1e6`. */
export function toBandwidth(c: AgentConnectionsResponse, opts: Opts): ChartData {
  const w = c.bucketWidthMs;
  if (w === null) return noWidth(['Sent', 'Received']);
  const mbps = (bits: number) => bits / (w / 1000) / 1e6;
  return bucketChart<ConnectionBucket>(
    c.buckets,
    [
      { name: 'Sent', read: (b) => mbps(b.bitsOut), gap: 'counter' },
      { name: 'Received', read: (b) => mbps(b.bitsIn), gap: 'counter' },
    ],
    emptySentence('connections', opts),
    w,
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
  const w = d.bucketWidthMs;
  if (w === null) return noWidth(['Requests', 'OK', 'KO']);
  return bucketChart<AgentDnsResponse['buckets'][number]>(
    d.buckets,
    [
      { name: 'Requests', read: (b) => perSecond(b.requests, w), gap: 'counter' },
      { name: 'OK', read: (b) => perSecond(b.ok, w), gap: 'counter' },
      { name: 'KO', read: (b) => perSecond(b.ko, w), gap: 'counter' },
    ],
    emptySentence('lookups', opts),
    w,
  );
}

/**
 * GE's "Responses per Second by Status": one series per code, in `s.codes`'
 * order, per second. A code absent from a bucket had no responses there — a
 * measured zero. A code with none in the whole payload falls under the
 * zero-series ruling.
 */
export function toStatusRate(s: AgentStatusResponse, opts: Opts): ChartData {
  const w = s.bucketWidthMs;
  if (w === null) return noWidth(s.codes);
  const chart = bucketChart<AgentStatusResponse['buckets'][number]>(
    s.buckets,
    s.codes.map((code) => ({
      name: code,
      read: (b: AgentStatusResponse['buckets'][number]) => perSecond(b.counts[code] ?? 0, w),
      gap: 'counter' as const,
    })),
    emptySentence('responses', opts),
    w,
  );
  if (chart.empty !== undefined) return chart;
  // A payload naming no code at all has nothing to drop, and nothing to draw.
  if (s.codes.length === 0) return { ...chart, empty: emptySentence('responses', opts) };
  return withoutAllZero(chart, opts);
}
