/**
 * Wall-clock host samples → the run's own elapsed-offset buckets.
 *
 * This one conversion is what makes the whole feature cheap. Once a telemetry
 * series is offset-based and bucketed like every other series in the system, it
 * inherits — with no further work — the shared crosshair, the same x-axis as
 * every other chart, and the `?from=&to=` window, because that window is
 * expressed in the same offsets.
 *
 * ALL COUNTER ARITHMETIC LIVES HERE, not in the agent. The spec's testing table
 * once put it on the agent; that would give two implementations of reset
 * detection that can disagree, in two languages, with only one of them covered
 * by the suite a change to the charts would run.
 *
 * ═══ "TOTAL CPU" INCLUDES IOWAIT ═══
 *
 * Linux accounting treats `iowait` as a subcategory of idle — the CPU is not
 * executing — which is why `top`-style "busy" (`us + sy`) deliberately
 * excludes it. This module makes the opposite call for `cpuTotalPct`:
 *
 *   cpuTotalPct = (Δuser + Δsystem + Δiowait) / (Δuser + Δsystem + Δiowait + Δidle) × 100
 *
 * Two reasons. First, Gatling's own chart is labelled "CPU usage in percent —
 * Total / User / Sys", where Total reads as not-idle. Second, and more
 * important: this is a LOAD GENERATOR, not a general-purpose host. A box
 * blocked on disk is a box not generating load — exactly the saturation this
 * feature exists to surface. Excluding iowait would make Total under-report
 * by precisely the iowait fraction, and the chart would say the generator was
 * healthy while it was in fact stalled.
 */

/** Above this the UI warns rather than quietly misaligning every chart. */
export const CLOCK_SKEW_WARN_MS = 5_000;

/** One stored sample. Structurally `StoredTelemetrySample` from the
 *  persistence package, restated so this pure package imports nothing. */
export interface TelemetryInput {
  host: string;
  sampledAtMs: number;
  receivedAtMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuIdleMs: number;
  cpuIowaitMs: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  tcpInSegs: number;
  tcpOutSegs: number;
  tcpRetransSegs: number;
  tcpInErrs: number;
  tcpActiveOpens: number;
  tcpPassiveOpens: number;
  tcpStates: Record<string, number>;
}

/**
 * One bucket for one host.
 *
 * Every RATE is nullable, and `null` is load-bearing: it means "this interval
 * cannot be measured" — the first sample of a host, or an interval spanning a
 * counter reset. Zero would claim the generator did nothing, which is the one
 * reading a reader must not be handed for a missing measurement.
 *
 * The two GAUGES are not nullable. They are instantaneous readings, not
 * differences, and are still true across a restart.
 */
export interface TelemetryPoint {
  startOffsetMs: number;
  cpuTotalPct: number | null;
  cpuUserPct: number | null;
  cpuSystemPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  inSegsPerSec: number | null;
  outSegsPerSec: number | null;
  retransSegsPerSec: number | null;
  inErrsPerSec: number | null;
  activeOpensPerSec: number | null;
  passiveOpensPerSec: number | null;
  tcpStates: Record<string, number>;
}

export interface TelemetryHostSeries {
  host: string;
  /**
   * `receivedAt - sampledAt` for the sample where that gap was largest in
   * absolute value, SIGNED. Healthy agents report a small positive number
   * (network latency). A large NEGATIVE value means the agent's clock is ahead
   * of the server's, which is unsolvable without a handshake and detectable
   * without one — the honest middle.
   */
  clockSkewMs: number;
  points: TelemetryPoint[];
}

/** The counters a reset can appear in. A reset in ANY of them voids the whole
 *  interval: the source restarted, so nothing it reported is comparable. */
const CUMULATIVE = [
  'cpuUserMs', 'cpuSystemMs', 'cpuIdleMs', 'cpuIowaitMs',
  'netRxBytes', 'netTxBytes',
  'tcpInSegs', 'tcpOutSegs', 'tcpRetransSegs', 'tcpInErrs',
  'tcpActiveOpens', 'tcpPassiveOpens',
] as const satisfies readonly (keyof TelemetryInput)[];

const rate = (delta: number, seconds: number): number | null =>
  seconds > 0 ? delta / seconds : null;

/**
 * @param samples      every sample for the tenant in the run's window PLUS the
 *                     lookback before it. Order does not matter; this sorts.
 * @param toolStartedAtMs the load test's own start — offset zero.
 * @param bucketWidthMs   the run's own width, so these buckets line up with
 *                        every other chart's.
 * @param durationMs      the run's span. Samples past it are excluded.
 *                        Defaults to Infinity for a caller that has already
 *                        bounded its query.
 */
export function toTelemetrySeries(
  samples: readonly TelemetryInput[],
  toolStartedAtMs: number,
  bucketWidthMs: number,
  durationMs = Number.POSITIVE_INFINITY,
): TelemetryHostSeries[] {
  const byHost = new Map<string, TelemetryInput[]>();
  for (const s of samples) {
    let list = byHost.get(s.host);
    if (!list) {
      list = [];
      byHost.set(s.host, list);
    }
    list.push(s);
  }

  const out: TelemetryHostSeries[] = [];
  for (const [host, list] of byHost) {
    list.sort((a, b) => a.sampledAtMs - b.sampledAtMs);

    let clockSkewMs = 0;
    // Rates accumulate per bucket and are averaged; several samples can land
    // in one bucket once the engine has halved a long run's resolution.
    const buckets = new Map<number, { sums: Map<string, number>; counts: Map<string, number>; last: TelemetryInput }>();

    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!;

      const skew = cur.receivedAtMs - cur.sampledAtMs;
      if (Math.abs(skew) > Math.abs(clockSkewMs)) clockSkewMs = skew;

      const offsetMs = cur.sampledAtMs - toolStartedAtMs;
      // The lookback samples land here. They produce no point of their own —
      // the run's axis starts at zero — but they have already served their
      // purpose as the predecessor of the first in-run sample. A sample past
      // the run's end is the mirror image: nothing after `durationMs` belongs
      // on the run's own axis either.
      if (offsetMs < 0 || offsetMs >= durationMs) continue;

      const startOffsetMs = Math.floor(offsetMs / bucketWidthMs) * bucketWidthMs;
      let bucket = buckets.get(startOffsetMs);
      if (!bucket) {
        bucket = { sums: new Map(), counts: new Map(), last: cur };
        buckets.set(startOffsetMs, bucket);
      }
      // Gauges take the LAST sample in the bucket rather than an average: a
      // state histogram is a snapshot, not a quantity that averages, and
      // memory follows it so the two describe the same instant.
      bucket.last = cur;

      const prev = list[i - 1];
      if (!prev) continue;

      // ═══ RESET DETECTION ═══
      // A process restart or interface flap sends a counter back to zero.
      // Skipping the interval is the only honest answer: the alternative is a
      // spike indistinguishable from a real traffic burst, which would be the
      // first thing a reader believed.
      if (CUMULATIVE.some((k) => (cur[k] as number) < (prev[k] as number))) continue;

      const seconds = (cur.sampledAtMs - prev.sampledAtMs) / 1000;

      const dUser = cur.cpuUserMs - prev.cpuUserMs;
      const dSystem = cur.cpuSystemMs - prev.cpuSystemMs;
      const dIowait = cur.cpuIowaitMs - prev.cpuIowaitMs;
      const dIdle = cur.cpuIdleMs - prev.cpuIdleMs;
      // Δbusy / Δtotal across a PAIR of samples, never cpu.Percent(), which
      // blocks for its interval and would make the agent pause inside the
      // measurement it is taking.
      const dTotal = dUser + dSystem + dIowait + dIdle;

      const add = (key: string, value: number | null) => {
        if (value === null || !Number.isFinite(value)) return;
        bucket!.sums.set(key, (bucket!.sums.get(key) ?? 0) + value);
        bucket!.counts.set(key, (bucket!.counts.get(key) ?? 0) + 1);
      };

      // "Total" is not-idle: user + system + iowait. See the file docstring
      // for why iowait counts as busy here, against the `top`-style norm.
      if (dTotal > 0) {
        add('cpuUserPct', (dUser / dTotal) * 100);
        add('cpuSystemPct', (dSystem / dTotal) * 100);
        add('cpuTotalPct', ((dUser + dSystem + dIowait) / dTotal) * 100);
      }
      add('rxBytesPerSec', rate(cur.netRxBytes - prev.netRxBytes, seconds));
      add('txBytesPerSec', rate(cur.netTxBytes - prev.netTxBytes, seconds));
      add('inSegsPerSec', rate(cur.tcpInSegs - prev.tcpInSegs, seconds));
      add('outSegsPerSec', rate(cur.tcpOutSegs - prev.tcpOutSegs, seconds));
      add('retransSegsPerSec', rate(cur.tcpRetransSegs - prev.tcpRetransSegs, seconds));
      add('inErrsPerSec', rate(cur.tcpInErrs - prev.tcpInErrs, seconds));
      add('activeOpensPerSec', rate(cur.tcpActiveOpens - prev.tcpActiveOpens, seconds));
      add('passiveOpensPerSec', rate(cur.tcpPassiveOpens - prev.tcpPassiveOpens, seconds));
    }

    const points = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([startOffsetMs, b]) => {
        const mean = (key: string): number | null => {
          const n = b.counts.get(key) ?? 0;
          return n === 0 ? null : (b.sums.get(key) ?? 0) / n;
        };
        return {
          startOffsetMs,
          cpuTotalPct: mean('cpuTotalPct'),
          cpuUserPct: mean('cpuUserPct'),
          cpuSystemPct: mean('cpuSystemPct'),
          memUsedBytes: b.last.memUsedBytes,
          memTotalBytes: b.last.memTotalBytes,
          rxBytesPerSec: mean('rxBytesPerSec'),
          txBytesPerSec: mean('txBytesPerSec'),
          inSegsPerSec: mean('inSegsPerSec'),
          outSegsPerSec: mean('outSegsPerSec'),
          retransSegsPerSec: mean('retransSegsPerSec'),
          inErrsPerSec: mean('inErrsPerSec'),
          activeOpensPerSec: mean('activeOpensPerSec'),
          passiveOpensPerSec: mean('passiveOpensPerSec'),
          tcpStates: b.last.tcpStates,
        };
      });

    out.push({ host, clockSkewMs, points });
  }

  // Stable order, so a chart's legend and its palette do not shuffle between
  // requests for a run whose hosts arrive from the database in whatever order.
  out.sort((a, b) => a.host.localeCompare(b.host));
  return out;
}
