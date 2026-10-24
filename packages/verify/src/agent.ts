import type { AgentFile, AgentSample } from '@perfportal/plugin-gatling';
import { nearestRankIndex } from './rank.js';

/**
 * ═══ THE AGENT FIGURES, RE-DERIVED FROM THE RAW AGENT FILE ═══
 *
 * The second implementation of GE report parity PR 2's Global Constraints, held
 * against the rows `@perfportal/statistics`' `buildAgentFigures` stored. It
 * shares the DECODER with the builder (as `simulation.log`'s is shared) and
 * nothing else: no histogram, no shared constant table, no shared fold. Where
 * the builder walks each record type into running maps, this one first turns
 * the whole file into a flat list of CONTRIBUTIONS — (metric, dim, label,
 * bucket, value) plus whether the metric sums or maxes — and folds that list
 * once at the end; durations keep every observation and read each figure off a
 * sorted array. A rule changed on one side only reads as a mismatch.
 *
 * The rules, as this module applies them:
 *
 *   - offset = at − runStartMs. Below 0 a record is not counted (a sample there
 *     is only a delta predecessor); past durationMs it is placed AT durationMs.
 *     Bucket = floor(offset / width) × width, width being the run's own.
 *   - A warm-up connect makes its channel warm-up; that channel's tls and close
 *     are dropped. A remote whose every connect is warm-up is warm-up-only and
 *     all its tls and close are dropped whatever their channel. A remote with
 *     no non-warm-up connect is dropped from bytes and states. A warm-up dns
 *     (and a tls flagged warm-up) is dropped.
 *   - A duration is max(0, round(us / 1000)) ms; ok:false is the KO population.
 *   - `*` is the total over every remote or hostname, a row of its own.
 *   - Counters sum within a bucket, gauges take the max; a `*` gauge is summed
 *     over remotes per sample before the max.
 *   - A counter delta is current − the most recent earlier reading, never below
 *     0. A keyed counter (bytes per remote, gc per collector) first seen counts
 *     from 0; an unkeyed machine counter (cpu, an snmp Tcp field) with no
 *     earlier reading contributes nothing.
 *   - states null contributes nothing; {} contributes 0 to every `*` state.
 *     Every counted sample contributes to both `bw.bits/*` labels. A dns
 *     contributes to all three `dns.count` labels.
 */

/** One population of one duration bucket, read off its sorted observations. */
export interface AgentPopulationFigures {
  count: number;
  min: number;
  max: number;
  sum: number;
  /**
   * The 10 GE percentiles between Min and Max, in GE's row order
   * (`AGENT_PERCENTILE_RANKS`). The recomputed side always holds a number; the
   * stored side holds null for a rank its histogram refuses, which compares as
   * a mismatch against the recomputed value.
   */
  percentiles: (number | null)[];
}

export interface ExpectedAgentDuration {
  family: string;
  dim: string;
  startOffsetMs: number;
  okCount: number;
  koCount: number;
  /** Null when the bucket holds no observation of that outcome. */
  ok: AgentPopulationFigures | null;
  ko: AgentPopulationFigures | null;
}

export interface ExpectedAgentMetric {
  metric: string;
  dim: string;
  label: string;
  startOffsetMs: number;
  value: number;
}

export interface ExpectedAgent {
  /** The width every bucket below was laid on: the one it was handed. */
  bucketWidthMs: number;
  durations: ExpectedAgentDuration[];
  metrics: ExpectedAgentMetric[];
}

/** GE's percentile rows between Min and Max (spec §6): 25 … 99.99, in row order. */
export const AGENT_PERCENTILE_RANKS: readonly number[] = [25, 50, 75, 80, 85, 90, 95, 99, 99.9, 99.99];

/** The figure name a mismatch on that rank carries: `p25`, `p99.9`. */
export const agentPercentileFigure = (rank: number): string => `p${String(rank)}`;

const TOTAL = '*';

/** `/proc/net/tcp*` state code → GE label. Codes not listed here are never stored. */
const KERNEL_STATE: Readonly<Record<string, string>> = {
  '1': 'established',
  '2': 'synSent',
  '4': 'finWait1',
  '5': 'finWait2',
  '6': 'timeWait',
  '7': 'close',
  '8': 'closeWait',
  '9': 'lastAck',
  '11': 'closing',
};

/** snmp `Tcp` fields: metric, label, field. `CurrEstab` is the one gauge among them. */
const SNMP_COUNTERS: readonly { metric: string; label: string; field: string }[] = [
  { metric: 'tcp.evt', label: 'activeOpenings', field: 'ActiveOpens' },
  { metric: 'tcp.evt', label: 'failedAttempts', field: 'AttemptFails' },
  { metric: 'tcp.evt', label: 'receivedResets', field: 'EstabResets' },
  { metric: 'tcp.evt', label: 'sentResets', field: 'OutRsts' },
  { metric: 'tcp.seg', label: 'received', field: 'InSegs' },
  { metric: 'tcp.seg', label: 'sent', field: 'OutSegs' },
  { metric: 'tcp.seg', label: 'retransmitted', field: 'RetransSegs' },
  { metric: 'tcp.seg', label: 'receivedBad', field: 'InErrs' },
];

/** Metrics folded by MAX within a bucket; every other metric sums. */
const MAXED = new Set(['tcp.state', 'heap', 'netty', 'ram', 'tcp.established']);

interface Contribution {
  metric: string;
  dim: string;
  label: string;
  bucket: number;
  value: number;
}

/** A counter delta: never negative. */
function grew(now: number, before: number): number {
  return now > before ? now - before : 0;
}

function populationOf(values: number[]): AgentPopulationFigures | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    sum,
    percentiles: AGENT_PERCENTILE_RANKS.map((p) => sorted[nearestRankIndex(p, sorted.length)]!),
  };
}

export function expectedAgent(
  file: AgentFile,
  opts: { runStartMs: number; durationMs: number; bucketWidthMs: number },
): ExpectedAgent {
  const { runStartMs, durationMs, bucketWidthMs } = opts;
  if (!Number.isFinite(bucketWidthMs) || bucketWidthMs <= 0) {
    throw new RangeError(`expectedAgent: bucketWidthMs must be a positive number, not ${bucketWidthMs}`);
  }

  /** The bucket a record at `at` lands in, or null when it is before the run. */
  const bucketAt = (at: number): number | null => {
    const raw = at - runStartMs;
    if (raw < 0) return null;
    const offset = raw > durationMs ? durationMs : raw;
    return offset - (offset % bucketWidthMs);
  };

  // ── which remotes and channels are warm-up ───────────────────────────────────────────────────
  const connectTally = new Map<string, { warm: number; real: number }>();
  const warmChannel = new Set<number>();
  for (const c of file.connects) {
    const t = connectTally.get(c.remote) ?? { warm: 0, real: 0 };
    if (c.warmup) {
      t.warm += 1;
      warmChannel.add(c.ch);
    } else {
      t.real += 1;
    }
    connectTally.set(c.remote, t);
  }
  /** A remote some non-warm-up connect reached: the only remotes bytes and states keep. */
  const measured = (remote: string): boolean => (connectTally.get(remote)?.real ?? 0) > 0;
  const warmOnly = (remote: string): boolean => {
    const t = connectTally.get(remote);
    return t !== undefined && t.warm > 0 && t.real === 0;
  };
  const onWarmUp = (remote: string, ch: number | null): boolean =>
    warmOnly(remote) || (ch !== null && warmChannel.has(ch));

  // ── durations: every observation kept ────────────────────────────────────────────────────────
  const timings = new Map<string, { family: string; dim: string; bucket: number; ok: number[]; ko: number[] }>();
  const observe = (family: string, dim: string, at: number, us: number, ok: boolean): void => {
    const bucket = bucketAt(at);
    if (bucket === null) return;
    const ms = Math.max(0, Math.round(us / 1000));
    for (const d of [dim, TOTAL]) {
      const key = [family, d, bucket].join('\u0001');
      const slot = timings.get(key) ?? { family, dim: d, bucket, ok: [], ko: [] };
      (ok ? slot.ok : slot.ko).push(ms);
      timings.set(key, slot);
    }
  };

  // ── everything else: a flat list of contributions, folded once ──────────────────────────────
  const contributions: Contribution[] = [];
  const add = (metric: string, dim: string, label: string, bucket: number, value: number): void => {
    contributions.push({ metric, dim, label, bucket, value });
  };
  /** One event counted under its own dimension and under `*`. */
  const addEach = (metric: string, dim: string, label: string, bucket: number, value: number): void => {
    add(metric, dim, label, bucket, value);
    add(metric, TOTAL, label, bucket, value);
  };

  for (const c of file.connects) {
    if (c.warmup) continue;
    observe('tcp_connect', c.remote, c.at, c.us, c.ok);
    const bucket = bucketAt(c.at);
    if (bucket !== null && c.ok) addEach('conn.opened', c.remote, '', bucket, 1);
  }
  for (const t of file.tls) {
    if (t.warmup || onWarmUp(t.remote, t.ch)) continue;
    observe('tls_handshake', t.remote, t.at, t.us, t.ok);
  }
  for (const c of file.closes) {
    if (onWarmUp(c.remote, c.ch)) continue;
    const bucket = bucketAt(c.at);
    if (bucket !== null) addEach('conn.closed', c.remote, '', bucket, 1);
  }
  for (const d of file.dns) {
    if (d.warmup) continue;
    observe('dns_resolution', d.host, d.at, d.us, d.ok);
    const bucket = bucketAt(d.at);
    if (bucket === null) continue;
    addEach('dns.count', d.host, 'req', bucket, 1);
    addEach('dns.count', d.host, 'ok', bucket, d.ok ? 1 : 0);
    addEach('dns.count', d.host, 'ko', bucket, d.ok ? 0 : 1);
  }
  for (const s of file.statuses) {
    const bucket = bucketAt(s.at);
    if (bucket !== null) add('status', TOTAL, String(s.code), bucket, 1);
  }

  // ── samples, in time order (a stable sort keeps file order on a shared instant) ─────────────
  const ordered = file.samples
    .map((sample, i) => ({ sample, i }))
    .sort((a, b) => a.sample.at - b.sample.at || a.i - b.i)
    .map((x) => x.sample);

  // The most recent earlier reading of each counter, keyed `kind/key`.
  const previous = new Map<string, number>();
  let previousCpu: number[] | null = null;

  const readSample = (s: AgentSample, bucket: number): void => {
    for (const [collector, [count, timeMs]] of Object.entries(s.gc)) {
      add('gc.count', TOTAL, collector, bucket, grew(count, previous.get(`gc.count/${collector}`) ?? 0));
      add('gc.timeMs', TOTAL, collector, bucket, grew(timeMs, previous.get(`gc.timeMs/${collector}`) ?? 0));
    }

    add('heap', TOTAL, 'used', bucket, s.heap[0]);
    add('heap', TOTAL, 'committed', bucket, s.heap[1]);
    add('heap', TOTAL, 'max', bucket, s.heap[2]);

    if (s.netty !== null) {
      add('netty', TOTAL, 'direct', bucket, s.netty[0]);
      add('netty', TOTAL, 'heap', bucket, s.netty[1]);
    }

    if (s.cpu !== null && previousCpu !== null) {
      const now = s.cpu;
      const before = previousCpu;
      const pick = (v: number[], ix: number[]): number => ix.reduce((acc, k) => acc + (v[k] ?? 0), 0);
      const user = [0, 1];
      const sys = [2, 5, 6];
      const all = [0, 1, 2, 3, 4, 5, 6, 7];
      add('cpu.jiffies', TOTAL, 'user', bucket, grew(pick(now, user), pick(before, user)));
      add('cpu.jiffies', TOTAL, 'sys', bucket, grew(pick(now, sys), pick(before, sys)));
      add('cpu.jiffies', TOTAL, 'total', bucket, grew(pick(now, all), pick(before, all)));
    }

    if (s.mem !== null) {
      const [totalKb, availableKb] = s.mem;
      add('ram', TOTAL, 'total', bucket, totalKb * 1024);
      add('ram', TOTAL, 'used', bucket, (totalKb - availableKb) * 1024);
    }

    if (s.tcp !== null) {
      for (const { metric, label, field } of SNMP_COUNTERS) {
        const now = s.tcp[field];
        const before = previous.get(`tcp/${field}`);
        if (now !== undefined && before !== undefined) add(metric, TOTAL, label, bucket, grew(now, before));
      }
      const established = s.tcp['CurrEstab'];
      if (established !== undefined) add('tcp.established', TOTAL, '', bucket, established);
    }

    // Bandwidth: bits, per measured remote, and their total on every counted sample.
    let totalOut = 0;
    let totalIn = 0;
    for (const [remote, [out, inn]] of Object.entries(s.bytes)) {
      if (!measured(remote)) continue;
      const bitsOut = grew(out, previous.get(`bytes.out/${remote}`) ?? 0) * 8;
      const bitsIn = grew(inn, previous.get(`bytes.in/${remote}`) ?? 0) * 8;
      add('bw.bits', remote, 'out', bucket, bitsOut);
      add('bw.bits', remote, 'in', bucket, bitsIn);
      totalOut += bitsOut;
      totalIn += bitsIn;
    }
    add('bw.bits', TOTAL, 'out', bucket, totalOut);
    add('bw.bits', TOTAL, 'in', bucket, totalIn);

    // Socket states: nothing at all for a sample with no reading.
    if (s.states !== null) {
      const total: Record<string, number> = {};
      for (const label of Object.values(KERNEL_STATE)) total[label] = 0;
      for (const [remote, counts] of Object.entries(s.states)) {
        if (!measured(remote)) continue;
        for (const [code, label] of Object.entries(KERNEL_STATE)) {
          const n = counts[code] ?? 0;
          add('tcp.state', remote, label, bucket, n);
          total[label] = (total[label] ?? 0) + n;
        }
      }
      for (const [label, n] of Object.entries(total)) add('tcp.state', TOTAL, label, bucket, n);
    }
  };

  for (const s of ordered) {
    const bucket = bucketAt(s.at);
    if (bucket !== null) readSample(s, bucket);
    // Every sample is a predecessor, counted or not.
    for (const [collector, [count, timeMs]] of Object.entries(s.gc)) {
      previous.set(`gc.count/${collector}`, count);
      previous.set(`gc.timeMs/${collector}`, timeMs);
    }
    for (const [remote, [out, inn]] of Object.entries(s.bytes)) {
      previous.set(`bytes.out/${remote}`, out);
      previous.set(`bytes.in/${remote}`, inn);
    }
    if (s.tcp !== null) for (const [field, v] of Object.entries(s.tcp)) previous.set(`tcp/${field}`, v);
    if (s.cpu !== null) previousCpu = s.cpu;
  }

  // ── fold ─────────────────────────────────────────────────────────────────────────────────────
  const folded = new Map<string, ExpectedAgentMetric>();
  for (const c of contributions) {
    const key = [c.metric, c.dim, c.label, c.bucket].join('\u0001');
    const row = folded.get(key);
    if (row === undefined) {
      folded.set(key, { metric: c.metric, dim: c.dim, label: c.label, startOffsetMs: c.bucket, value: c.value });
    } else if (MAXED.has(c.metric)) {
      if (c.value > row.value) row.value = c.value;
    } else {
      row.value += c.value;
    }
  }

  return {
    bucketWidthMs,
    durations: [...timings.values()].map((t) => ({
      family: t.family,
      dim: t.dim,
      startOffsetMs: t.bucket,
      okCount: t.ok.length,
      koCount: t.ko.length,
      ok: populationOf(t.ok),
      ko: populationOf(t.ko),
    })),
    metrics: [...folded.values()],
  };
}
