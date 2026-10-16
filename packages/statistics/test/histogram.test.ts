import { describe, expect, it } from 'vitest';
import { Histogram, HISTOGRAM_KIND } from '../src/histogram.js';
import { RELATIVE_ACCURACY, Sketch } from '../src/sketch.js';

describe('Histogram', () => {
  it('counts exact integer-millisecond observations', () => {
    const h = new Histogram();
    for (const v of [10, 10, 20, 30, 30, 30]) h.accept(v);
    expect(h.total).toBe(6);
    expect(h.min).toBe(10);
    expect(h.max).toBe(30);
    expect(h.sum).toBe(130);
    expect(h.countAt(10)).toBe(2);
    expect(h.countAt(30)).toBe(3);
    expect(h.countAt(15)).toBe(0);
  });

  it('countBelow is a strict less-than, exact at any bound', () => {
    const h = new Histogram();
    for (const v of [799, 800, 801, 1199, 1200, 1201]) h.accept(v);
    expect(h.countBelow(800)).toBe(1);
    expect(h.countBelow(1200)).toBe(4);
    expect(h.countBelow(0)).toBe(0);
    expect(h.countBelow(Number.POSITIVE_INFINITY)).toBe(6);
  });

  it('merges exactly', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [5, 5, 9]) a.accept(v);
    for (const v of [9, 12]) b.accept(v);
    a.merge(b);
    expect(a.total).toBe(5);
    expect(a.countAt(5)).toBe(2);
    expect(a.countAt(9)).toBe(2);
    expect(a.countAt(12)).toBe(1);
    expect(a.min).toBe(5);
    expect(a.max).toBe(12);
    expect(a.sum).toBe(40);
  });

  // The regression the Sketch round-trip bug taught us: assert EVERY derived
  // quantity survives serialization, not just the bin counts.
  it('round-trips losslessly, including min, max, sum and count', () => {
    const h = new Histogram();
    for (const v of [1, 1, 7, 400, 400, 400, 119_999]) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    expect(back.total).toBe(h.total);
    expect(back.min).toBe(h.min);
    expect(back.max).toBe(h.max);
    expect(back.sum).toBe(h.sum);
    expect(back.countAt(400)).toBe(3);
    expect(back.countAt(119_999)).toBe(1);
    expect(back.countBelow(400)).toBe(h.countBelow(400));
    expect([...back.entries()]).toEqual([...h.entries()]);
  });

  it('round-trips an empty histogram', () => {
    const back = Histogram.deserialize(new Histogram().serialize());
    expect(back.total).toBe(0);
    expect(back.min).toBe(0);
    expect(back.max).toBe(0);
    expect(back.sum).toBe(0);
    expect([...back.entries()]).toEqual([]);
  });

  // Only a LEGACY v1 histogram has an overflow bin now: new histograms are
  // uncapped. The bytes below are exactly what the pre-2026-10-15 writer
  // produced, so this is the shape every v1 row still in the database has.
  it('reads a legacy v1 overflow bin, keeping count, sum and max exact', () => {
    const h = Histogram.deserialize(Histogram.legacyV1ForTests([500, 125_000, 130_000]));
    expect(h.total).toBe(3);
    expect(h.overflowCount).toBe(2);
    expect(h.sum).toBe(255_500);
    expect(h.max).toBe(130_000);
    expect(h.countBelow(1_000)).toBe(1);
    // Above the cap, countBelow cannot be exact — it must not silently claim to be.
    expect(() => h.countBelow(121_000)).toThrow(/overflow/i);
  });
});

describe('Histogram#percentile', () => {
  /**
   * Ground truth, the nearest-rank convention this repo uses everywhere. `p` is
   * an integer here, so `p * n` is exact and the one division is the rounding.
   */
  const truePercentile = (sorted: number[], p: number): number =>
    sorted[Math.max(0, Math.ceil((p * sorted.length) / 100) - 1)] as number;

  const sample = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 1_000; i += 1) out.push(1 + ((i * 37) % 900));
    return out;
  };

  it('is exact, unlike the sketch it replaces in a window', () => {
    const values = sample();
    const h = new Histogram();
    for (const v of values) h.accept(v);
    const sorted = [...values].sort((a, b) => a - b);

    for (const p of [50, 75, 95, 99]) {
      // EXACT, not within RELATIVE_ACCURACY. 1ms bins and integer inputs mean
      // there is no error term at all to allow for.
      expect(h.percentile(p)).toBe(truePercentile(sorted, p));
    }
  });

  it('uses the same rank convention as Sketch#quantile', () => {
    // A histogram quantile on the linear-interpolation convention would land
    // one rank away from the full-run value on identical data — a discrepancy
    // that looks like a windowing bug and is not one.
    const values = sample();
    const h = new Histogram();
    const s = new Sketch();
    for (const v of values) { h.accept(v); s.accept(v); }

    for (const p of [50, 95, 99]) {
      const exact = h.percentile(p) as number;
      const relative = Math.abs(exact - s.quantile(p / 100)) / exact;
      expect(relative).toBeLessThanOrEqual(RELATIVE_ACCURACY);
    }
  });

  it('answers the boundary ranks with min and max', () => {
    const h = new Histogram();
    for (const v of [5, 10, 20, 40]) h.accept(v);
    expect(h.percentile(0)).toBe(h.min);
    expect(h.percentile(100)).toBe(h.max);
  });

  it('answers undefined for an empty histogram rather than a fabricated 0', () => {
    expect(new Histogram().percentile(95)).toBeUndefined();
  });

  it('answers undefined rather than guess when the rank lands in a legacy overflow bin', () => {
    // Same stance as countBelow: an unrecoverable answer is refused, never
    // approximated. Only legacy v1 bytes can carry the bin now.
    const legacy = [...Array<number>(10).fill(10), ...Array<number>(90).fill(125_000)]; // 90 overflow
    const h = Histogram.deserialize(Histogram.legacyV1ForTests(legacy));
    expect(h.percentile(95)).toBeUndefined();
  });

  it('still answers a rank below a legacy overflow bin', () => {
    // Overflow poisons only the ranks it actually covers. Refusing every
    // percentile because the tail is unrecoverable would throw away answers we
    // genuinely have.
    const legacy = [...Array<number>(90).fill(10), ...Array<number>(10).fill(125_000)];
    const h = Histogram.deserialize(Histogram.legacyV1ForTests(legacy));
    expect(h.percentile(50)).toBe(10);
  });

  it('survives a serialize round trip', () => {
    const h = new Histogram();
    for (const v of sample()) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    for (const p of [50, 95, 99]) expect(back.percentile(p)).toBe(h.percentile(p));
  });
});

/**
 * The population variance as a two-pass oracle computes it over the raw
 * values: the mean first, then the mean squared deviation. This is the form
 * the PR 3 verifier compares against within 1e-9, so it is the yardstick.
 */
const twoPassVariance = (values: readonly number[]): number => {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let dev = 0;
  for (const v of values) dev += (v - mean) ** 2;
  return dev / values.length;
};

/**
 * 200,000 group durations packed into 300000-300019 ms: large and tight, and
 * UNEVENLY spread. An even spread (`300_000 + (i * 7) % 20`, equal counts per
 * value) happens to round its Σx² exactly and the one-pass form scores 0
 * error on it — measured — so a fixture of that shape cannot fail.
 */
const tightLarge = (): number[] =>
  (() => { let s = 1; return Array.from({ length: 200_000 }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 300_000 + Math.floor((s / 0x7fffffff) * 20); }); })();

describe('Histogram#variance', () => {
  it('gives the exact population variance over a merged set', () => {
    const values = [3, 5, 5, 9, 11, 20, 20, 20];
    const h = new Histogram();
    for (const v of values) h.accept(v);
    expect(h.variance()).toBeCloseTo(twoPassVariance(values), 12);
  });

  /**
   * The case `E[x²] − E[x]²` loses: values far from zero and close together,
   * which is exactly what a long group duration looks like. Measured on the
   * one-pass form at 2.5e-7 relative error on 300000–300019 ms values — the PR 3
   * verifier allows 1e-9.
   */
  it('stays within 1e-12 of a two-pass oracle on large, tightly packed values', () => {
    const values = tightLarge();
    const h = new Histogram();
    for (const v of values) h.accept(v);
    const oracle = twoPassVariance(values);
    expect(oracle).toBeGreaterThan(0); // the fixture must actually spread
    expect(Math.abs(h.variance() - oracle) / oracle).toBeLessThanOrEqual(1e-12);
  });

  it('is the same across a merge as over the whole, whatever order the bins arrived in', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [6, 5, 4]) a.accept(v);
    for (const v of [3, 2, 1]) b.accept(v);
    const both = new Histogram();
    for (const v of [1, 2, 3, 4, 5, 6]) both.accept(v);

    a.merge(b);
    expect(a.variance()).toBe(both.variance());
  });

  it('is zero for an empty histogram', () => {
    expect(new Histogram().variance()).toBe(0);
  });
});

describe('Histogram#percentiles', () => {
  it('answers a whole set in one call, identically to asking rank by rank', () => {
    const h = new Histogram();
    for (let i = 0; i < 5000; i++) h.accept(Math.floor(((i * 7919) % 4096) ** 1.3));
    // Unsorted and repeated on purpose: the walk sorts its ranks, the answer
    // keeps the caller's order.
    const set = [99, 50, 0, 99.9, 50, 100, 7, 95];
    expect(h.percentiles(set)).toEqual(set.map((p) => h.percentile(p)));
  });

  it('answers undefined for every rank of an empty histogram', () => {
    expect(new Histogram().percentiles([50, 99])).toEqual([undefined, undefined]);
  });

  it('refuses only the ranks a legacy overflow bin hides', () => {
    const legacy = [...Array<number>(90).fill(10), ...Array<number>(10).fill(125_000)];
    const h = Histogram.deserialize(Histogram.legacyV1ForTests(legacy));
    expect(h.percentiles([50, 95])).toEqual([10, undefined]);
  });

  /**
   * The keys are sorted once and kept until a write changes them. A stale
   * order would answer from the histogram as it was, which reads as a
   * plausible percentile and is not one.
   */
  it('sees a value added after it was last asked, by accept and by merge', () => {
    const h = new Histogram();
    for (const v of [10, 20, 30]) h.accept(v);
    expect(h.percentile(0)).toBe(10);
    h.accept(5);
    expect(h.percentile(0)).toBe(5);
    expect(h.variance()).toBeCloseTo(twoPassVariance([5, 10, 20, 30]), 12);
    const other = new Histogram();
    other.accept(1);
    h.merge(other);
    expect(h.percentile(0)).toBe(1);
    expect([...h.entries()].map(([v]) => v)).toEqual([1, 5, 10, 20, 30]);
  });
});

/**
 * Spec §4: one entry per distinct observed millisecond, so 1M values spread
 * across 0–30 s cost at most 30,001 entries however many there are. The
 * values are fractional on purpose — the bound is the 1 ms resolution, and
 * a histogram that kept sub-millisecond keys would hold a million.
 *
 * The byte ceiling is 64 KiB. Each entry serializes as a delta from the
 * previous key and a count, both unsigned varints: at this density every
 * delta is 1 and every count is near 33, so each is one byte — 2 bytes per
 * entry, 60,002 for 30,001 entries, plus the version, entry count and the
 * total/sum/min/max trailer. Measured: 60,018 bytes. A 300 s spread measured
 * 300,001 entries and 600,019 bytes, the same 2 bytes per entry.
 */
describe('Histogram size bound', () => {
  it('keeps 1M values spread over 0–30,000 ms within 30,001 entries and 64 KiB', () => {
    // Math.imul keeps the LCG in 32-bit integers. The float form
    // `(seed * 1103515245 + 12345) & 0x7fffffff` loses bits above 2^53 and
    // cycles after ~14,000 values (measured) — which let a histogram that
    // kept sub-millisecond keys pass this case with 14,000 entries.
    let seed = 7;
    const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
    const h = new Histogram();
    for (let i = 0; i < 1_000_000; i++) h.accept(rand() * 30_000);
    expect(h.total).toBe(1_000_000);
    expect([...h.entries()].length).toBeLessThanOrEqual(30_001);
    expect(h.serialize().length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('Histogram v2 (exact, uncapped)', () => {
  const sorted = (h: Histogram) => [...h.entries()].flatMap(([v, c]) => Array(c).fill(v) as number[]);

  it('names its format sparse-ms-v2', () => {
    expect(HISTOGRAM_KIND).toBe('sparse-ms-v2');
  });

  it('keeps values far above 120 s exactly', () => {
    const h = new Histogram();
    for (const v of [400, 300_700, 1_800_000]) h.accept(v);
    expect(h.overflowCount).toBe(0);
    expect(h.percentile(50)).toBe(300_700);
    expect(h.percentile(100)).toBe(1_800_000);
    expect(h.exact).toBe(true);
  });

  it('answers percentile(p) as the nearest-rank value of the sorted data', () => {
    const h = new Histogram();
    const values = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
    for (const v of values) h.accept(v);
    expect(h.percentile(99.9)).toBe(999);   // not 1000
    expect(h.percentile(0)).toBe(1);
    expect(h.percentile(100)).toBe(1000);
  });

  it('answers undefined for an empty histogram', () => {
    expect(new Histogram().percentile(50)).toBeUndefined();
  });

  it('round-trips v2 bytes exactly, including huge values', () => {
    const h = new Histogram();
    for (const v of [0, 1, 1, 2_147_483_647, 1_800_000]) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    expect(sorted(back)).toEqual(sorted(h));
    expect([back.total, back.sum, back.min, back.max]).toEqual([h.total, h.sum, h.min, h.max]);
    expect(back.exact).toBe(true);
    expect(h.serialize()[0]).toBe(2);
  });

  it('still reads v1 bytes, and marks them not exact', () => {
    // A v1 histogram as written before this PR: version 1, cap 120000, one
    // value 500 and one overflowed 300000.
    const legacy = Histogram.legacyV1ForTests([500, 300_000]);
    const back = Histogram.deserialize(legacy);
    expect(back.exact).toBe(false);
    expect(back.overflowCount).toBe(1);
    expect(back.percentile(50)).toBe(500);
    expect(back.percentile(100)).toBeUndefined(); // hidden in the overflow bin
  });

  it('refuses to serialize a legacy histogram that overflowed', () => {
    const back = Histogram.deserialize(Histogram.legacyV1ForTests([300_000]));
    expect(() => back.serialize()).toThrow(/overflow/);
  });

  it('merges exactly: any split merged equals the whole', () => {
    const values = Array.from({ length: 5000 }, (_, i) => Math.floor(((i * 7919) % 4096) ** 1.3));
    const whole = new Histogram();
    for (const v of values) whole.accept(v);
    for (const parts of [2, 3, 7]) {
      const merged = new Histogram();
      for (let k = 0; k < parts; k++) {
        const part = new Histogram();
        values.filter((_, i) => i % parts === k).forEach((v) => part.accept(v));
        merged.merge(part);
      }
      for (const p of [0, 25, 50, 90, 95, 99, 99.9, 100]) {
        expect(merged.percentile(p), `parts=${parts} p=${p}`).toBe(whole.percentile(p));
      }
      expect(merged.sum).toBe(whole.sum);
    }
  });

  it('matches a sorting oracle on heavy-tailed, bimodal and tied data', () => {
    const shapes: Record<string, number[]> = {
      ties: Array(500).fill(42) as number[],
      single: [7],
      bimodal: [...Array(300).fill(20), ...Array(30).fill(4000)] as number[],
      heavy: Array.from({ length: 2000 }, (_, i) => Math.floor(10 / (1 - i / 2001) ** 2)),
    };
    for (const [name, values] of Object.entries(shapes)) {
      const h = new Histogram();
      values.forEach((v) => h.accept(v));
      const s = [...values].sort((a, b) => a - b);
      for (const p of [0, 1, 7, 50, 75, 90, 95, 99, 99.9, 100]) {
        const idx = Math.min(s.length, Math.max(1, Math.ceil(Math.round(p * 10) * s.length / 1000))) - 1;
        expect(h.percentile(p), `${name} p${p}`).toBe(s[idx]);
      }
    }
  });
});
