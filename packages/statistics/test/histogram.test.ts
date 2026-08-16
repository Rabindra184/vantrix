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

  it('folds values above the cap into one overflow bin, keeping count, sum and max exact', () => {
    const h = new Histogram({ capMs: 1000 });
    h.accept(500);
    h.accept(5_000);
    h.accept(9_000);
    expect(h.total).toBe(3);
    expect(h.overflowCount).toBe(2);
    expect(h.sum).toBe(14_500);
    expect(h.max).toBe(9_000);
    expect(h.countBelow(1_000)).toBe(1);
    // Above the cap, countBelow cannot be exact — it must not silently claim to be.
    expect(() => h.countBelow(6_000)).toThrow(/overflow/i);
    const back = Histogram.deserialize(h.serialize());
    expect(back.overflowCount).toBe(2);
    expect(back.sum).toBe(14_500);
    expect(back.max).toBe(9_000);
  });

  it('declares its wire format', () => {
    expect(HISTOGRAM_KIND).toBe('sparse-ms-v1');
  });
});

describe('Histogram#quantile', () => {
  /** Ground truth, the nearest-rank convention this repo uses everywhere. */
  const trueQuantile = (sorted: number[], q: number): number =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;

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

    for (const q of [0.5, 0.75, 0.95, 0.99]) {
      // EXACT, not within RELATIVE_ACCURACY. 1ms bins and integer inputs mean
      // there is no error term at all to allow for.
      expect(h.quantile(q)).toBe(trueQuantile(sorted, q));
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

    for (const q of [0.5, 0.95, 0.99]) {
      const relative = Math.abs(h.quantile(q) - s.quantile(q)) / h.quantile(q);
      expect(relative).toBeLessThanOrEqual(RELATIVE_ACCURACY);
    }
  });

  it('answers the boundary ranks with min and max', () => {
    const h = new Histogram();
    for (const v of [5, 10, 20, 40]) h.accept(v);
    expect(h.quantile(0)).toBe(h.min);
    expect(h.quantile(1)).toBe(h.max);
  });

  it('returns NaN for an empty histogram rather than a fabricated 0', () => {
    expect(Number.isNaN(new Histogram().quantile(0.95))).toBe(true);
  });

  it('throws rather than guess when the rank lands in the overflow bin', () => {
    // Same stance as countBelow: an unrecoverable answer is refused, never
    // approximated. At the 120s default cap this is theoretical, which is
    // exactly why it must not be silent.
    const h = new Histogram({ capMs: 100 });
    for (let i = 0; i < 10; i += 1) h.accept(10);
    for (let i = 0; i < 90; i += 1) h.accept(5_000);   // all overflow
    expect(() => h.quantile(0.95)).toThrow(/overflow/i);
  });

  it('still answers a rank below the overflow bin', () => {
    // Overflow poisons only the ranks it actually covers. Refusing every
    // quantile because the tail is unrecoverable would throw away answers we
    // genuinely have.
    const h = new Histogram({ capMs: 100 });
    for (let i = 0; i < 90; i += 1) h.accept(10);
    for (let i = 0; i < 10; i += 1) h.accept(5_000);
    expect(h.quantile(0.5)).toBe(10);
  });

  it('survives a serialize round trip', () => {
    const h = new Histogram();
    for (const v of sample()) h.accept(v);
    const back = Histogram.deserialize(h.serialize());
    for (const q of [0.5, 0.95, 0.99]) expect(back.quantile(q)).toBe(h.quantile(q));
  });
});

describe('Histogram#sumOfSquares', () => {
  it('gives an exact standard deviation over a merged set', () => {
    const values = [3, 5, 5, 9, 11, 20, 20, 20];
    const h = new Histogram();
    for (const v of values) h.accept(v);

    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const expected = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

    const variance = h.sumOfSquares() / h.total - (h.sum / h.total) ** 2;
    expect(Math.sqrt(variance)).toBeCloseTo(expected, 9);
  });

  it('is additive across a merge, which is what a window needs', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (const v of [1, 2, 3]) a.accept(v);
    for (const v of [4, 5, 6]) b.accept(v);
    const both = new Histogram();
    for (const v of [1, 2, 3, 4, 5, 6]) both.accept(v);

    a.merge(b);
    expect(a.sumOfSquares()).toBe(both.sumOfSquares());
  });

  it('is zero for an empty histogram', () => {
    expect(new Histogram().sumOfSquares()).toBe(0);
  });
});
