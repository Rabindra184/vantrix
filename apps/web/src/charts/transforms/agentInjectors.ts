import { TCP_EVENT_NAMES, TCP_SEGMENT_NAMES } from '@perfportal/contracts';
import type { AgentInjectorsResponse } from '@perfportal/contracts';
import type { ChartData } from '../types';
import {
  bucketChart,
  dropAllZero,
  emptySentence,
  noWidth,
  perSecond,
  TIME_COLUMN,
  withoutAllZero,
  withoutUnread,
  type Measure,
  type Opts,
} from './agentChart';
import { BYTES_PER_MB } from './telemetry';

/**
 * The Report's Load generators charts — GE's GC, CPU, memory and kernel TCP
 * figures for the load generator's JVM and machine — one function per chart,
 * all from one `/v1/runs/:id/agent/injectors` response.
 *
 * They follow `agentRates.ts` exactly, and share its kit (`agentChart.ts`):
 * pair series on the run's shared value axis, a COUNTER drawn per second at the
 * payload's own width (`perSecond`), a GAUGE drawn as stored, and a `null` kept
 * a gap and a dash — never a zero.
 *
 * ═══ WHICH FIGURES ARE GAUGES ═══
 *
 * GC counts and time, the four TCP event counters and the four segment counters
 * are bucket sums, so they are divided. CPU %, every memory byte figure and
 * `established` are readings of a level, and dividing one by the bucket width
 * would draw a "per second" nothing measured. `established` is the trap: it
 * sits in GE's "TCP Connections Events per Second" beside four counters, so
 * that chart's `limitation` says it is drawn as stored.
 *
 * ═══ THE ZERO-SERIES RULING APPLIES TO GC, EVENTS AND SEGMENTS, NOT MEMORY ═══
 *
 * Collectors are open-ended and the kernel counters mostly sit at zero, so a
 * series with no non-zero reading is not drawn and is named (`withoutAllZero`).
 * Memory is not under it: 0 bytes of Netty heap is a measurement worth seeing.
 * Only a memory or CPU series that was never READ is left out — RAM on a
 * machine-off run — and named (`withoutUnread`). Memory's seven series exceed
 * the six-hue palette on Linux; `Chart`'s own cap and note handle that, as the
 * plan rules. Either helper turns a chart left with no series into an `empty`
 * sentence saying why, so no chart here draws a markless grid.
 *
 * ═══ A MACHINE THAT WAS NOT READ ═══
 *
 * CPU and kernel TCP come from the machine collector alone, so when
 * `machine.available` is false those three charts are `empty` with the agent's
 * own reason, checked before anything else: an empty run or a missing width
 * would otherwise be blamed for what is really an operating system. Memory is
 * not empty then — heap and Netty are the JVM's, read on every platform.
 */

type Bucket = AgentInjectorsResponse['buckets'][number];
type TcpEventName = (typeof TCP_EVENT_NAMES)[number];
type TcpSegmentName = (typeof TCP_SEGMENT_NAMES)[number];

/** What an empty bucket list is: seconds the agent sampled nothing in. */
const THINGS = 'load generator samples';

/** GE's "Memory Usage in MB" series, in GE's order. */
export const MEMORY_SERIES = [
  'RAM total',
  'RAM used',
  'Heap max',
  'Heap committed',
  'Heap used',
  'Netty direct',
  'Netty heap',
] as const;

/** GE's "TCP Connections Events per Second" labels, keyed by contract field. */
export const TCP_EVENT_LABELS: Readonly<Record<TcpEventName, string>> = {
  activeOpenings: 'active openings',
  failedAttempts: 'failed attempts',
  established: 'established',
  receivedResets: 'received resets',
  sentResets: 'sent resets',
};

/** GE's "TCP Segment Events per Second" labels, keyed by contract field. */
export const TCP_SEGMENT_LABELS: Readonly<Record<TcpSegmentName, string>> = {
  received: 'received',
  sent: 'sent',
  retransmitted: 'retransmitted',
  receivedBad: 'received bad',
};

const ESTABLISHED_IS_A_GAUGE =
  'The established series is the number of connections the kernel held open, so it is drawn as stored, not per second.';

/** The agent's own reason the machine collector was off, or a plain one. */
function machineReason(inj: AgentInjectorsResponse): string {
  return inj.machine.reason ?? 'The agent did not collect machine figures.';
}

/** The machine-off chart: no series, the agent's reason, every column kept. */
function machineNotRead(inj: AgentInjectorsResponse, names: readonly string[]): ChartData | undefined {
  if (inj.machine.available) return undefined;
  return {
    series: [],
    axisLabels: [],
    columns: [TIME_COLUMN, ...names],
    rows: [],
    empty: machineReason(inj),
  };
}

/**
 * One series per collector — the union over every bucket, sorted, so a
 * collector that ran in only some seconds still has a column. Absent from a
 * bucket means it did not collect there: a measured 0, not a gap.
 */
function gcChart(inj: AgentInjectorsResponse, field: 'gcCount' | 'gcTimeMs', opts: Opts): ChartData {
  const names = [...new Set(inj.buckets.flatMap((b) => Object.keys(b[field])))].sort();
  const w = inj.bucketWidthMs;
  if (w === null) return noWidth(names);
  const chart = bucketChart<Bucket>(
    inj.buckets,
    names.map((name) => ({ name, read: (b: Bucket) => perSecond(b[field][name] ?? 0, w), gap: 'counter' as const })),
    emptySentence(THINGS, opts),
    w,
  );
  if (chart.empty !== undefined) return chart;
  if (names.length === 0) return { ...chart, empty: emptySentence('garbage collections', opts) };
  return withoutAllZero(chart, opts);
}

/** GE's "GC Counts per Second": collections per second, per collector. */
export function toGcCounts(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  return gcChart(inj, 'gcCount', opts);
}

/** GE's "GC Time per Second": milliseconds of collection per second, per collector. */
export function toGcTime(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  return gcChart(inj, 'gcTimeMs', opts);
}

/**
 * GE's "CPU usage in percent": User and Sys, as stored. Even with the machine
 * collector on, a bucket's CPU is null when the sample pair gave no Δtotal, so
 * a series with no reading at all is dropped and named like any other.
 */
export function toCpu(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  const measures: Measure<Bucket>[] = [
    { name: 'User', read: (b) => b.cpuUserPct, gap: 'gauge' },
    { name: 'Sys', read: (b) => b.cpuSysPct, gap: 'gauge' },
  ];
  const off = machineNotRead(inj, measures.map((m) => m.name));
  if (off !== undefined) return off;
  const chart = bucketChart<Bucket>(inj.buckets, measures, emptySentence(THINGS, opts), inj.bucketWidthMs);
  if (chart.empty !== undefined) return chart;
  return withoutUnread(chart, opts);
}

const READ_MEMORY: Readonly<Record<(typeof MEMORY_SERIES)[number], (b: Bucket) => number | null>> = {
  'RAM total': (b) => b.ramTotalBytes,
  'RAM used': (b) => b.ramUsedBytes,
  'Heap max': (b) => b.heapMaxBytes,
  'Heap committed': (b) => b.heapCommittedBytes,
  'Heap used': (b) => b.heapUsedBytes,
  'Netty direct': (b) => b.nettyDirectBytes,
  'Netty heap': (b) => b.nettyHeapBytes,
};

/**
 * GE's "Memory Usage in MB": seven gauges, bytes / 2^20 (`telemetry.ts`' MB).
 * A series null in every bucket is left out and named; a zero is drawn. On a
 * machine-off run that is RAM, and the note carries the agent's reason, so the
 * chart says why rather than only what (`toTcpStates`' `notMeasuredReason`).
 */
export function toMemory(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  const chart = bucketChart<Bucket>(
    inj.buckets,
    MEMORY_SERIES.map((name) => ({
      name,
      read: (b) => {
        const bytes = READ_MEMORY[name](b);
        return bytes === null ? null : bytes / BYTES_PER_MB;
      },
      gap: 'gauge' as const,
    })),
    emptySentence(THINGS, opts),
    inj.bucketWidthMs,
  );
  if (chart.empty !== undefined) return chart;
  const { unread } = dropAllZero(chart.series);
  const ramUnread = unread.includes('RAM total') || unread.includes('RAM used');
  return withoutUnread(chart, opts, !inj.machine.available && ramUnread ? machineReason(inj) : undefined);
}

/**
 * GE's "TCP Connections Events per Second": four counters per second and
 * `established`, a gauge, as stored. Each field is null on its own (a first
 * sample has the gauge and no counter delta), and a null stays a gap.
 */
export function toTcpEvents(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  const names = TCP_EVENT_NAMES.map((k) => TCP_EVENT_LABELS[k]);
  const off = machineNotRead(inj, names);
  if (off !== undefined) return off;
  const w = inj.bucketWidthMs;
  if (w === null) return noWidth(names);
  const chart = bucketChart<Bucket>(
    inj.buckets,
    TCP_EVENT_NAMES.map((k) => ({
      name: TCP_EVENT_LABELS[k],
      read: (b) => {
        const value = b.tcpEvents?.[k] ?? null;
        return k === 'established' ? value : perSecond(value, w);
      },
      // The four counters' missing step saw no event; established is a level nobody read there.
      gap: k === 'established' ? ('gauge' as const) : ('counter' as const),
    })),
    emptySentence(THINGS, opts),
    w,
  );
  if (chart.empty !== undefined) return chart;
  // The gauge note is about a drawn line; said of a dropped one it explains nothing.
  const established = dropAllZero(chart.series).kept.some((s) => s.name === TCP_EVENT_LABELS.established);
  return withoutAllZero(chart, opts, established ? ESTABLISHED_IS_A_GAUGE : undefined);
}

/** GE's "TCP Segment Events per Second": four counters, per second. */
export function toTcpSegments(inj: AgentInjectorsResponse, opts: Opts): ChartData {
  const names = TCP_SEGMENT_NAMES.map((k) => TCP_SEGMENT_LABELS[k]);
  const off = machineNotRead(inj, names);
  if (off !== undefined) return off;
  const w = inj.bucketWidthMs;
  if (w === null) return noWidth(names);
  const chart = bucketChart<Bucket>(
    inj.buckets,
    TCP_SEGMENT_NAMES.map((k) => ({
      name: TCP_SEGMENT_LABELS[k],
      read: (b: Bucket) => perSecond(b.tcpSegments?.[k] ?? null, w),
      gap: 'counter' as const,
    })),
    emptySentence(THINGS, opts),
    w,
  );
  if (chart.empty !== undefined) return chart;
  return withoutAllZero(chart, opts);
}
