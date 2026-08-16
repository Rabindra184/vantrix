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

  it('buckets to the run width and separates hosts', () => {
    const a = [at(1), at(2), at(3)];
    const b = a.map((s) => ({ ...s, host: 'gen-2' }));
    const series = toTelemetrySeries([...a, ...b], T0, 2000);

    expect(series.map((s) => s.host).sort()).toEqual(['gen-1', 'gen-2']);
    // Offsets are multiples of the bucket width, ascending, unique.
    for (const s of series) {
      const offsets = s.points.map((p) => p.startOffsetMs);
      expect(offsets.every((o) => o % 2000 === 0)).toBe(true);
      expect([...offsets].sort((x, y) => x - y)).toEqual(offsets);
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it('reports the largest clock gap, signed', () => {
    const ahead = at(1, { sampledAtMs: T0 + 1000, receivedAtMs: T0 + 1000 - 30_000 });
    const [series] = toTelemetrySeries([at(0), ahead], T0, 1000);
    // received BEFORE sampled means the agent's clock is AHEAD of the
    // server's. Negative, and large — a generator thirty seconds fast would
    // otherwise misalign every chart with nothing looking wrong.
    expect(series!.clockSkewMs).toBe(ahead.receivedAtMs - ahead.sampledAtMs);
  });

  it('returns nothing for no samples', () => {
    expect(toTelemetrySeries([], T0, 1000)).toEqual([]);
  });
});
