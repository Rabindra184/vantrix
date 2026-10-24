import type { AgentFile, AgentSample } from '@perfportal/plugin-gatling';
import type { EngineResult } from './engine.js';
import { Histogram } from './histogram.js';

/**
 * Folds a decoded agent file (`decodeAgentFile`) onto the run's OWN series width: duration
 * buckets with exact histograms (DNS resolution, TCP connect, TLS handshake) and counter/gauge
 * buckets (connections, bandwidth, socket states, DNS counts, HTTP statuses, GC, heap, netty,
 * CPU, RAM and the kernel's TCP counters).
 *
 * ═══ THE RULES, AND WHO ELSE IMPLEMENTS THEM ═══
 *
 * These are the PR's Global Constraints, implemented here and nowhere else in the product —
 * except `packages/verify`, which recomputes every stored figure from the raw file with code
 * that shares nothing with this module. A rule changed here without changing it there reads as
 * a mismatch on every run, which is the point.
 *
 *   - An offset is `at − runStartMs`. A record (event or sample) with an offset below 0 is not
 *     counted; a sample there serves ONLY as the predecessor a delta is taken from. A record
 *     whose offset exceeds `durationMs` is placed AT `durationMs` (the last bucket), never
 *     dropped: the file covers only this run's JVM, so everything after the last request is the
 *     run's own teardown — a shutdown-time close, the `final: true` sample.
 *   - Bucket start is `floor(offset / width) * width`, `width` being the run's own
 *     run-scope response-time width ({@link runSeriesWidthMs}). Nothing here coalesces.
 *   - Warm-up is excluded from every figure: a `connect` flagged warm-up makes its `ch` a
 *     warm-up channel, whose `tls` and `close` are dropped with it; a remote with no
 *     non-warm-up channel is dropped from `bytes` and `states`; a warm-up `dns` is dropped.
 *   - A duration is `us / 1000` handed to {@link Histogram.accept} (which rounds and floors at
 *     0); `ok: false` goes to the KO histogram.
 *   - Dimension {@link AGENT_ALL} (`*`) is a stored total over every remote or hostname.
 *   - Counters SUM within a bucket; gauges take the MAX of the samples in it. A `*` gauge is
 *     summed across remotes per sample first, then maxed.
 *   - A counter delta is `current − previous`, `previous` being the most recent earlier sample
 *     carrying that field; a negative delta is 0. A KEYED counter (bytes per remote, GC per
 *     collector) first seen counts from 0. An unkeyed machine counter (the CPU jiffies, each
 *     snmp TCP field) with no earlier reading files nothing: it is cumulative since boot, so
 *     counting it from 0 would put the machine's whole uptime into one bucket.
 *   - `states` null (no reading) contributes nothing; `{}` (a measured zero) contributes 0 to
 *     each `*` state. A row exists only for a (metric, dim, label, bucket) some record
 *     contributed to; a `dns` event contributes to all three `dns.count` labels (`req` 1, and
 *     1/0 to `ok`/`ko`), so a hostname's bucket with any lookup has all three rows.
 *   - `remotes` / `hostnames` are the distinct non-`*` dims of the stored remote-dimensioned
 *     (`conn.*`, `bw.bits`, `tcp.state`, `tcp_connect`, `tls_handshake`) / hostname-dimensioned
 *     (`dns.count`, `dns_resolution`) rows, sorted.
 */

export type AgentDurationFamily = 'dns_resolution' | 'tcp_connect' | 'tls_handshake';

export interface AgentDurationBucket {
  family: AgentDurationFamily;
  /** The remote (`tcp_connect`, `tls_handshake`) or hostname (`dns_resolution`), or `*`. */
  dim: string;
  startOffsetMs: number;
  okCount: number;
  koCount: number;
  histogramOk: Histogram;
  histogramKo: Histogram;
}

export interface AgentMetricBucket {
  metric: string;
  dim: string;
  label: string;
  startOffsetMs: number;
  value: number;
}

export interface AgentFigures {
  bucketWidthMs: number;
  durations: AgentDurationBucket[];
  metrics: AgentMetricBucket[];
  /** Every remote a stored row names, sorted; warm-up-only remotes never appear. */
  remotes: string[];
  /** Every hostname a stored row names, sorted; warm-up-only hostnames never appear. */
  hostnames: string[];
}

/** The all-remotes / all-hostnames dimension, stored as its own rows. */
export const AGENT_ALL = '*';

/** Every stored metric name. One table, so the independent verifier can be held to the same set. */
export const AGENT_METRICS = {
  connOpened: 'conn.opened',
  connClosed: 'conn.closed',
  bwBits: 'bw.bits',
  tcpState: 'tcp.state',
  dnsCount: 'dns.count',
  status: 'status',
  gcCount: 'gc.count',
  gcTimeMs: 'gc.timeMs',
  heap: 'heap',
  netty: 'netty',
  cpuJiffies: 'cpu.jiffies',
  ram: 'ram',
  tcpEvt: 'tcp.evt',
  tcpEstablished: 'tcp.established',
  tcpSeg: 'tcp.seg',
} as const;

/** The metrics that are gauges (max in a bucket); every other metric is a counter (sum). */
export const AGENT_GAUGE_METRICS: readonly string[] = [
  AGENT_METRICS.tcpState,
  AGENT_METRICS.heap,
  AGENT_METRICS.netty,
  AGENT_METRICS.ram,
  AGENT_METRICS.tcpEstablished,
];

/**
 * Kernel TCP state code (as `/proc/net/tcp` writes it, decimal) → GE's label, in GE's order.
 * Codes 3 (SYN_RECV), 10 (LISTEN), 12 (NEW_SYN_RECV) and anything else are not stored; GE's
 * `bound` and `idle` have no kernel state and are never stored.
 */
export const AGENT_TCP_STATES: readonly (readonly [code: string, label: string])[] = [
  ['2', 'synSent'],
  ['1', 'established'],
  ['4', 'finWait1'],
  ['5', 'finWait2'],
  ['8', 'closeWait'],
  ['11', 'closing'],
  ['9', 'lastAck'],
  ['6', 'timeWait'],
  ['7', 'close'],
];

/** snmp `Tcp` counter field → label, for `tcp.evt`. */
const TCP_EVT_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ['ActiveOpens', 'activeOpenings'],
  ['AttemptFails', 'failedAttempts'],
  ['EstabResets', 'receivedResets'],
  ['OutRsts', 'sentResets'],
];

/** snmp `Tcp` counter field → label, for `tcp.seg`. */
const TCP_SEG_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ['InSegs', 'received'],
  ['OutSegs', 'sent'],
  ['RetransSegs', 'retransmitted'],
  ['InErrs', 'receivedBad'],
];

/** The snmp `Tcp` gauge `tcp.established` reads. */
const TCP_CURR_ESTAB = 'CurrEstab';

/** `/proc/stat` jiffy indices: user, nice, system, idle, iowait, irq, softirq, steal. */
const CPU_USER = [0, 1] as const;
const CPU_SYS = [2, 5, 6] as const;

/** The run-scope `response_time` series' own width, 1000 when the run has none. */
export function runSeriesWidthMs(result: EngineResult): number {
  for (const s of result.series.values()) {
    if (s.scope === 'run' && s.family === 'response_time') return s.bucketWidthMs;
  }
  return 1000;
}

const delta = (current: number, previous: number): number => Math.max(0, current - previous);
const sumAt = (values: readonly number[], indices: readonly number[]): number =>
  indices.reduce((acc, i) => acc + (values[i] ?? 0), 0);
const sumAll = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);
const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildAgentFigures(
  file: AgentFile,
  opts: { runStartMs: number; durationMs: number; bucketWidthMs: number },
): AgentFigures {
  const { runStartMs, durationMs, bucketWidthMs: width } = opts;
  if (!(width > 0) || !Number.isFinite(width)) {
    throw new RangeError(`buildAgentFigures: bucketWidthMs must be a positive number, not ${width}`);
  }

  /** The record's offset, clamped to `durationMs`; null before the run start (not counted). */
  const placed = (at: number): number | null => {
    const offset = at - runStartMs;
    return offset < 0 ? null : Math.min(offset, durationMs);
  };
  const bucketOf = (offset: number): number => Math.floor(offset / width) * width;

  const warmChannels = new Set<number>();
  const channelRemotes = new Set<string>();
  for (const c of file.connects) {
    if (c.warmup) warmChannels.add(c.ch);
    else channelRemotes.add(c.remote);
  }

  // ── durations ──────────────────────────────────────────────────────────────────────────────
  const durations = new Map<string, AgentDurationBucket>();
  const addDuration = (family: AgentDurationFamily, dim: string, at: number, us: number, ok: boolean): void => {
    const offset = placed(at);
    if (offset === null) return;
    const startOffsetMs = bucketOf(offset);
    for (const d of [dim, AGENT_ALL]) {
      const key = `${family}\u0000${d}\u0000${startOffsetMs}`;
      let bucket = durations.get(key);
      if (bucket === undefined) {
        bucket = {
          family,
          dim: d,
          startOffsetMs,
          okCount: 0,
          koCount: 0,
          histogramOk: new Histogram(),
          histogramKo: new Histogram(),
        };
        durations.set(key, bucket);
      }
      if (ok) {
        bucket.okCount++;
        bucket.histogramOk.accept(us / 1000);
      } else {
        bucket.koCount++;
        bucket.histogramKo.accept(us / 1000);
      }
    }
  };

  // ── metrics ────────────────────────────────────────────────────────────────────────────────
  const metrics = new Map<string, AgentMetricBucket>();
  const metricKey = (metric: string, dim: string, label: string, start: number) =>
    `${metric}\u0000${dim}\u0000${label}\u0000${start}`;
  /** A counter sums within a bucket. */
  const count = (metric: string, dim: string, label: string, start: number, value: number): void => {
    const key = metricKey(metric, dim, label, start);
    const row = metrics.get(key);
    if (row === undefined) metrics.set(key, { metric, dim, label, startOffsetMs: start, value });
    else row.value += value;
  };
  /** A gauge takes the max of the samples in a bucket. */
  const gauge = (metric: string, dim: string, label: string, start: number, value: number): void => {
    const key = metricKey(metric, dim, label, start);
    const row = metrics.get(key);
    if (row === undefined) metrics.set(key, { metric, dim, label, startOffsetMs: start, value });
    else row.value = Math.max(row.value, value);
  };
  const countBoth = (metric: string, dim: string, label: string, start: number, value: number): void => {
    count(metric, dim, label, start, value);
    count(metric, AGENT_ALL, label, start, value);
  };

  for (const c of file.connects) {
    if (c.warmup) continue;
    addDuration('tcp_connect', c.remote, c.at, c.us, c.ok);
    const offset = placed(c.at);
    if (offset !== null && c.ok) countBoth(AGENT_METRICS.connOpened, c.remote, '', bucketOf(offset), 1);
  }
  for (const t of file.tls) {
    if (t.warmup || (t.ch !== null && warmChannels.has(t.ch))) continue;
    addDuration('tls_handshake', t.remote, t.at, t.us, t.ok);
  }
  for (const c of file.closes) {
    if (warmChannels.has(c.ch)) continue;
    const offset = placed(c.at);
    if (offset !== null) countBoth(AGENT_METRICS.connClosed, c.remote, '', bucketOf(offset), 1);
  }
  for (const d of file.dns) {
    if (d.warmup) continue;
    addDuration('dns_resolution', d.host, d.at, d.us, d.ok);
    const offset = placed(d.at);
    if (offset === null) continue;
    const start = bucketOf(offset);
    countBoth(AGENT_METRICS.dnsCount, d.host, 'req', start, 1);
    countBoth(AGENT_METRICS.dnsCount, d.host, 'ok', start, d.ok ? 1 : 0);
    countBoth(AGENT_METRICS.dnsCount, d.host, 'ko', start, d.ok ? 0 : 1);
  }
  for (const st of file.statuses) {
    const offset = placed(st.at);
    if (offset !== null) count(AGENT_METRICS.status, AGENT_ALL, String(st.code), bucketOf(offset), 1);
  }

  // ── samples ────────────────────────────────────────────────────────────────────────────────
  // Predecessor state: the most recent earlier sample carrying each field.
  const lastGc = new Map<string, readonly [number, number]>();
  const lastBytes = new Map<string, readonly [number, number]>();
  const lastTcp = new Map<string, number>();
  let lastCpu: readonly number[] | null = null;

  // Stable, so samples sharing an instant keep file order.
  const samples = [...file.samples].sort((a, b) => a.at - b.at);
  for (const sample of samples) {
    const offset = placed(sample.at);
    if (offset !== null) fileSample(sample, bucketOf(offset)); // else: predecessor only
    remember(sample);
  }

  function fileSample(sample: AgentSample, start: number): void {
    for (const [name, [c, t]] of Object.entries(sample.gc)) {
      const [pc, pt] = lastGc.get(name) ?? [0, 0];
      count(AGENT_METRICS.gcCount, AGENT_ALL, name, start, delta(c, pc));
      count(AGENT_METRICS.gcTimeMs, AGENT_ALL, name, start, delta(t, pt));
    }

    const [used, committed, max] = sample.heap;
    gauge(AGENT_METRICS.heap, AGENT_ALL, 'used', start, used);
    gauge(AGENT_METRICS.heap, AGENT_ALL, 'committed', start, committed);
    gauge(AGENT_METRICS.heap, AGENT_ALL, 'max', start, max);

    if (sample.netty !== null) {
      gauge(AGENT_METRICS.netty, AGENT_ALL, 'direct', start, sample.netty[0]);
      gauge(AGENT_METRICS.netty, AGENT_ALL, 'heap', start, sample.netty[1]);
    }

    if (sample.cpu !== null && lastCpu !== null) {
      const cur = sample.cpu;
      const prev = lastCpu;
      count(AGENT_METRICS.cpuJiffies, AGENT_ALL, 'user', start, delta(sumAt(cur, CPU_USER), sumAt(prev, CPU_USER)));
      count(AGENT_METRICS.cpuJiffies, AGENT_ALL, 'sys', start, delta(sumAt(cur, CPU_SYS), sumAt(prev, CPU_SYS)));
      count(AGENT_METRICS.cpuJiffies, AGENT_ALL, 'total', start, delta(sumAll(cur), sumAll(prev)));
    }

    if (sample.mem !== null) {
      const [totalKb, availableKb] = sample.mem;
      gauge(AGENT_METRICS.ram, AGENT_ALL, 'total', start, totalKb * 1024);
      gauge(AGENT_METRICS.ram, AGENT_ALL, 'used', start, (totalKb - availableKb) * 1024);
    }

    if (sample.tcp !== null) {
      const tcp = sample.tcp;
      for (const [metric, fields] of [
        [AGENT_METRICS.tcpEvt, TCP_EVT_FIELDS],
        [AGENT_METRICS.tcpSeg, TCP_SEG_FIELDS],
      ] as const) {
        for (const [field, label] of fields) {
          const cur = tcp[field];
          const prev = lastTcp.get(field);
          if (cur !== undefined && prev !== undefined) count(metric, AGENT_ALL, label, start, delta(cur, prev));
        }
      }
      const established = tcp[TCP_CURR_ESTAB];
      if (established !== undefined) gauge(AGENT_METRICS.tcpEstablished, AGENT_ALL, '', start, established);
    }

    let allOut = 0;
    let allIn = 0;
    for (const [remote, [out, inn]] of Object.entries(sample.bytes)) {
      if (!channelRemotes.has(remote)) continue;
      const [po, pi] = lastBytes.get(remote) ?? [0, 0];
      const bitsOut = delta(out, po) * 8;
      const bitsIn = delta(inn, pi) * 8;
      count(AGENT_METRICS.bwBits, remote, 'out', start, bitsOut);
      count(AGENT_METRICS.bwBits, remote, 'in', start, bitsIn);
      allOut += bitsOut;
      allIn += bitsIn;
    }
    count(AGENT_METRICS.bwBits, AGENT_ALL, 'out', start, allOut);
    count(AGENT_METRICS.bwBits, AGENT_ALL, 'in', start, allIn);

    if (sample.states !== null) {
      const all = new Map<string, number>(AGENT_TCP_STATES.map(([, label]) => [label, 0]));
      for (const [remote, codes] of Object.entries(sample.states)) {
        if (!channelRemotes.has(remote)) continue;
        for (const [code, label] of AGENT_TCP_STATES) {
          const n = codes[code] ?? 0;
          gauge(AGENT_METRICS.tcpState, remote, label, start, n);
          all.set(label, (all.get(label) ?? 0) + n);
        }
      }
      for (const [label, n] of all) gauge(AGENT_METRICS.tcpState, AGENT_ALL, label, start, n);
    }
  }

  function remember(sample: AgentSample): void {
    for (const [name, v] of Object.entries(sample.gc)) lastGc.set(name, v);
    for (const [remote, v] of Object.entries(sample.bytes)) lastBytes.set(remote, v);
    if (sample.tcp !== null) for (const [field, v] of Object.entries(sample.tcp)) lastTcp.set(field, v);
    if (sample.cpu !== null) lastCpu = sample.cpu;
  }

  // ── output ─────────────────────────────────────────────────────────────────────────────────
  const durationRows = [...durations.values()].sort(
    (a, b) => compare(a.family, b.family) || compare(a.dim, b.dim) || a.startOffsetMs - b.startOffsetMs,
  );
  const metricRows = [...metrics.values()].sort(
    (a, b) =>
      compare(a.metric, b.metric) ||
      compare(a.dim, b.dim) ||
      compare(a.label, b.label) ||
      a.startOffsetMs - b.startOffsetMs,
  );

  const remotes = new Set<string>();
  const hostnames = new Set<string>();
  for (const d of durationRows) {
    if (d.dim === AGENT_ALL) continue;
    (d.family === 'dns_resolution' ? hostnames : remotes).add(d.dim);
  }
  for (const m of metricRows) {
    if (m.dim === AGENT_ALL) continue;
    (m.metric === AGENT_METRICS.dnsCount ? hostnames : remotes).add(m.dim);
  }

  return {
    bucketWidthMs: width,
    durations: durationRows,
    metrics: metricRows,
    remotes: [...remotes].sort(compare),
    hostnames: [...hostnames].sort(compare),
  };
}
