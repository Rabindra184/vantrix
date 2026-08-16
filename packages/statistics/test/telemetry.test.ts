import { describe, expect, it } from 'vitest';
import { toTelemetrySeries, type TelemetryInput } from '../src/telemetry.js';

const T0 = Date.UTC(2026, 7, 17, 10, 0, 0);

/**
 * Counters climb linearly with `n`; overrides state what a test is about.
 *
 * `cpuIowaitMs` is non-zero (unlike the brief's original `0`) so that a test
 * asserting `cpuTotalPct` actually exercises whether iowait is folded into
 * "busy" — with it pinned at zero the formula would pass whether or not the
 * implementation counted iowait as busy, which is the entire question this
 * package has to get right (see `telemetry.ts`'s "Total CPU" comment).
 */
const at = (n: number, over: Partial<TelemetryInput> = {}): TelemetryInput => ({
  host: 'gen-1',
  sampledAtMs: T0 + n * 1000,
  receivedAtMs: T0 + n * 1000 + 50,
  cpuUserMs: 100 * n, cpuSystemMs: 50 * n, cpuIdleMs: 850 * n, cpuIowaitMs: 20 * n,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000 * n, netTxBytes: 20_000 * n,
  tcpInSegs: 100 * n, tcpOutSegs: 120 * n, tcpRetransSegs: 2 * n, tcpInErrs: n,
  tcpActiveOpens: 5 * n, tcpPassiveOpens: 3 * n,
  tcpStates: { ESTABLISHED: 10 },
  ...over,
});

describe('toTelemetrySeries', () => {
  it('derives CPU percentages from Δbusy/Δtotal, with iowait counted as busy', () => {
    const samples = [at(1), at(2)];
    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    // DERIVED FROM THE INPUT, not written down. busy = user + system + iowait,
    // per this task's controller ruling: a load generator blocked on disk is a
    // generator not generating load, which is exactly the saturation this
    // feature exists to surface, so iowait counts as NOT idle.
    const dUser = samples[1]!.cpuUserMs - samples[0]!.cpuUserMs;
    const dSys = samples[1]!.cpuSystemMs - samples[0]!.cpuSystemMs;
    const dIowait = samples[1]!.cpuIowaitMs - samples[0]!.cpuIowaitMs;
    const dIdle = samples[1]!.cpuIdleMs - samples[0]!.cpuIdleMs;
    const dTotal = dUser + dSys + dIowait + dIdle;

    expect(point.cpuUserPct).toBeCloseTo((dUser / dTotal) * 100, 6);
    expect(point.cpuSystemPct).toBeCloseTo((dSys / dTotal) * 100, 6);
    expect(point.cpuTotalPct).toBeCloseTo(((dUser + dSys + dIowait) / dTotal) * 100, 6);
  });

  it('derives byte and segment rates against the ACTUAL elapsed time', () => {
    // 2500ms apart, not the agent's nominal 1000. A rate computed against an
    // assumed interval would be wrong by exactly this drift.
    const samples = [at(1), at(1, { sampledAtMs: T0 + 3500 })];
    samples[1] = { ...samples[1]!, netRxBytes: samples[0]!.netRxBytes + 25_000 };

    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    const dBytes = samples[1]!.netRxBytes - samples[0]!.netRxBytes;
    const dSeconds = (samples[1]!.sampledAtMs - samples[0]!.sampledAtMs) / 1000;
    expect(point.rxBytesPerSec).toBeCloseTo(dBytes / dSeconds, 6);
  });

  it('SKIPS the interval across a counter reset rather than drawing a spike', () => {
    // A process restart or interface flap sends the counter back to zero.
    // Given raw values the server sees current < previous; given a
    // pre-computed rate it would see a plausible enormous spike and draw it.
    const samples = [at(5), at(6, { netRxBytes: 0, netTxBytes: 0 })];
    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    expect(point.rxBytesPerSec).toBeNull();
    expect(point.txBytesPerSec).toBeNull();
    // The whole interval is void, not just the counter that reset: the reset
    // means the source restarted, so nothing it reported is comparable.
    expect(point.cpuTotalPct).toBeNull();
    expect(point.inSegsPerSec).toBeNull();
    // GAUGES SURVIVE. Memory and connection states are instantaneous readings,
    // not differences, and are still true across a restart.
    expect(point.memUsedBytes).toBe(samples[1]!.memUsedBytes);
    expect(point.tcpStates).toEqual(samples[1]!.tcpStates);
  });

  it('drops samples before the run and keeps the one that seeds the first delta', () => {
    // The lookback sample at -1s produces no point of its own (negative
    // offset) but IS the predecessor the first in-run point differences
    // against — which is the entire reason TELEMETRY_LOOKBACK_MS exists.
    const before = at(0, { sampledAtMs: T0 - 1000 });
    const first = at(1, { sampledAtMs: T0 });
    const [series] = toTelemetrySeries([before, first], T0, 1000);

    expect(series!.points.map((p) => p.startOffsetMs)).toEqual([0]);
    expect(series!.points[0]!.cpuTotalPct).not.toBeNull();
  });

  it('excludes a sample past the end of the window', () => {
    const inside = at(1, { sampledAtMs: T0 + 1000 });
    const outside = at(2, { sampledAtMs: T0 + 9000 });
    const [series] = toTelemetrySeries([inside, outside], T0, 1000, 5000);
    expect(series!.points.every((p) => p.startOffsetMs < 5000)).toBe(true);
  });

  it('buckets to the run width and separates hosts, in a STABLE alphabetical order', () => {
    const a = [at(1), at(2), at(3)]; // host 'gen-1' (the `at()` default)
    const b = a.map((s) => ({ ...s, host: 'gen-2' }));
    // 'gen-2' is fed FIRST. `byHost` is a Map keyed by first-seen host, so
    // its iteration order here is ['gen-2', 'gen-1'] — the opposite of the
    // alphabetical order the chart legend needs. Only an implementation that
    // actually sorts hosts before returning produces ['gen-1', 'gen-2'] from
    // THIS input; one that returned Map-iteration order (or simply deleted
    // the `out.sort(...)` line) would report ['gen-2', 'gen-1'] instead, and
    // the assertion below does not re-sort the actual value, so it would
    // catch that.
    const series = toTelemetrySeries([...b, ...a], T0, 2000);

    expect(series.map((s) => s.host)).toEqual(['gen-1', 'gen-2']);
    // Offsets are multiples of the bucket width, ascending, unique.
    for (const s of series) {
      const offsets = s.points.map((p) => p.startOffsetMs);
      expect(offsets.every((o) => o % 2000 === 0)).toBe(true);
      expect([...offsets].sort((x, y) => x - y)).toEqual(offsets);
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it('averages multiple pair-rates landing in the same bucket, rather than summing them', () => {
    // Three samples, one bucket (width 10 000 ms): s0→s1 and s1→s2 are two
    // SEPARATE deltas whose `cur` (s1 and s2 respectively) both fall in
    // bucket [0, 10000). Their time AND byte gaps are deliberately unequal —
    // with the rest of this file's linearly-climbing `at()` series, two
    // deltas landing in one bucket would happen to be numerically identical,
    // and sum/mean of two equal numbers cannot be told apart by inspecting
    // just one of them. Here rate1 (36 000 B/s) and rate2 (6 000 B/s) differ,
    // so `sums / n` (mean) and plain `sums` (sum) diverge to 21 000 vs 42 000
    // — an implementation that dropped the division would fail this.
    const s0 = at(1, { sampledAtMs: T0 + 500 });
    const s1 = at(2, { sampledAtMs: T0 + 3000, netRxBytes: 100_000 });
    const s2 = at(3, { sampledAtMs: T0 + 8000, netRxBytes: 130_000 });

    const [series] = toTelemetrySeries([s0, s1, s2], T0, 10_000);
    const bucket = series!.points.find((p) => p.startOffsetMs === 0)!;

    const rate1 = (s1.netRxBytes - s0.netRxBytes) / ((s1.sampledAtMs - s0.sampledAtMs) / 1000);
    const rate2 = (s2.netRxBytes - s1.netRxBytes) / ((s2.sampledAtMs - s1.sampledAtMs) / 1000);
    expect(bucket.rxBytesPerSec).toBeCloseTo((rate1 + rate2) / 2, 6);
  });

  it('reports the largest ABSOLUTE clock gap, signed — not merely the last sample seen', () => {
    // The LARGE-magnitude skew sits on the EARLIER sample; a much smaller one
    // follows it chronologically. An implementation that dropped the running
    // `Math.abs(...) > Math.abs(...)` maximum and simply kept whichever
    // sample it processed last would report the SECOND (small, positive)
    // skew here instead of the first (large, negative) one.
    const early = at(0, { receivedAtMs: T0 - 30_000 });
    const later = at(5);
    const [series] = toTelemetrySeries([early, later], T0, 1000);
    // received BEFORE sampled means the agent's clock is AHEAD of the
    // server's. Negative, and large — a generator thirty seconds fast would
    // otherwise misalign every chart with nothing looking wrong.
    expect(series!.clockSkewMs).toBe(early.receivedAtMs - early.sampledAtMs);
  });

  it('returns nothing for no samples', () => {
    expect(toTelemetrySeries([], T0, 1000)).toEqual([]);
  });
});
