import { describe, expect, it } from 'vitest';
import { RELATIVE_ACCURACY, Sketch } from '../src/sketch.js';

/** Deterministic three-segment mixture: 90% uniform [20,200], 9% uniform [300,800], 1% uniform [1500,3000] — no Math.random, so failures reproduce. */
function latencies(n: number): number[] {
  let seed = 7;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return Math.abs(seed) / 2147483647; };
  return Array.from({ length: n }, () => {
    const r = rnd();
    return r < 0.9 ? 20 + rnd() * 180 : r < 0.99 ? 300 + rnd() * 500 : 1500 + rnd() * 1500;
  });
}
const trueQuantile = (sorted: number[], q: number) =>
  sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;

describe('Sketch accuracy (AC-STAT-1)', () => {
  it('is within 1% relative error of the true quantile at every percentile', () => {
    const vals = latencies(200_000);
    const sorted = [...vals].sort((a, b) => a - b);
    const s = new Sketch();
    for (const v of vals) s.accept(v);
    for (const q of [0.5, 0.75, 0.95, 0.99, 0.999]) {
      const err = Math.abs(s.quantile(q) - trueQuantile(sorted, q)) / trueQuantile(sorted, q);
      // <= not <: measured error reaches exactly 1.0% on uniform data.
      expect(err).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('Sketch quantile (discontinuity regression)', () => {
  it('handles sharp discontinuities at tail without interpolation artifacts', () => {
    // Synthetic data designed to fail with naive linear interpolation:
    // 845 values at 100 (tight low band), then hard jump to 1000 (high cluster), nothing between.
    // For q ≈ 0.9446, old linear interpolation (q * (n-1)) lands in interpolation zone right at
    // the discontinuity, picking an intermediate value instead of the true high-band value.
    // New nearest-rank (ceil(q * n) - 1) resolves to exact indices, picking the correct value.
    const vals: number[] = [];
    for (let i = 0; i < 845; i++) vals.push(100);
    for (let i = 0; i < 50; i++) vals.push(1000);

    const sorted = [...vals].sort((a, b) => a - b);
    const s = new Sketch();
    for (const v of vals) s.accept(v);

    // Test at q = 0.9446, where the old naive version's rank (0.9446 * 894 ≈ 844.47)
    // interpolates across the discontinuity (indices 844→845, values 100→1000),
    // yielding ~525. The true nearest-rank quantile (index 845, value 1000) differs by ~47%.
    const q = 0.9446;
    const measured = s.quantile(q);
    const truth = trueQuantile(sorted, q);

    expect(truth).toBe(1000); // Verify test setup: true answer is in high band

    const relErr = Math.abs(measured - truth) / truth;
    expect(relErr).toBeLessThanOrEqual(0.01); // Within 1% of true quantile
  });
});

describe('Sketch quantile fuzz (regression for the float round-trip rank bug)', () => {
  // Deterministic seeded PRNG (mulberry32) so any failure reproduces exactly. Never Math.random.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  type Dist = { name: string; gen: (rnd: () => number, n: number) => number[] };
  const distributions: Dist[] = [
    { name: 'uniform', gen: (rnd, n) => Array.from({ length: n }, () => 1 + rnd() * 9999) },
    {
      // Log-normal-ish: exponentiate an approximate-normal (Box-Muller) variate. Always positive.
      name: 'log-normal-ish',
      gen: (rnd, n) => Array.from({ length: n }, () => {
        const u1 = Math.max(rnd(), 1e-12);
        const u2 = rnd();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.exp(5 + z);
      }),
    },
    {
      name: 'bimodal',
      gen: (rnd, n) => Array.from({ length: n }, () => (rnd() < 0.5 ? 90 + rnd() * 20 : 9900 + rnd() * 200)),
    },
    {
      // Sharp discontinuities: three widely separated clusters, nothing between them.
      name: 'sharp-discontinuity',
      gen: (rnd, n) => Array.from({ length: n }, () => {
        const r = rnd();
        return r < 0.7 ? 10 : r < 0.9 ? 5000 : 200_000;
      }),
    },
  ];

  const nValues = [3, 5, 10, 17, 31, 50, 97, 149, 211, 337, 500, 733, 999, 1500, 1647, 2000, 2500, 3000];
  const qValues = [0.01, 0.05, 0.5, 0.75, 0.95, 0.99, 0.999, 1.0];

  const trueQ = (sorted: number[], q: number) =>
    sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;

  it('is within 1% relative of the nearest-rank ground truth for every distribution/n/quantile combination', () => {
    const violations: { dist: string; n: number; q: number; measured: number; truth: number; relErr: number }[] = [];
    let seed = 1;
    for (const dist of distributions) {
      for (const n of nValues) {
        const rnd = mulberry32(seed++);
        const vals = dist.gen(rnd, n);
        const sorted = [...vals].sort((a, b) => a - b);
        const s = new Sketch();
        for (const v of vals) s.accept(v);
        for (const q of qValues) {
          const measured = s.quantile(q);
          const truth = trueQ(sorted, q);
          const relErr = Math.abs(measured - truth) / Math.abs(truth);
          // <= not <: the guarantee is exactly 1%, never a stricter bound.
          if (!(relErr <= 0.01)) {
            violations.push({ dist: dist.name, n, q, measured, truth, relErr });
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('Sketch sum (persist -> reload)', () => {
  it('reconstructs sum from the bucket store within the relative-accuracy bound, instead of silently returning 0', () => {
    const vals = latencies(200_000);
    const trueSum = vals.reduce((a, b) => a + b, 0);
    const s = new Sketch();
    for (const v of vals) s.accept(v);

    // Before any serialization, sum is exact (accumulated directly by DDSketch#accept).
    expect(s.sum).toBeCloseTo(trueSum, 6);

    const reloaded = Sketch.deserialize(s.serialize());
    // The bug this regresses: `fromProto` never restores `sum`, so an unpatched
    // deserialize silently returns 0 here instead of throwing or reconstructing.
    expect(reloaded.sum).not.toBe(0);
    const relErr = Math.abs(reloaded.sum - trueSum) / trueSum;
    // <= not <: same convention as every other accuracy assertion in this file.
    expect(relErr).toBeLessThanOrEqual(RELATIVE_ACCURACY);
  });

  it('reconstructed sum survives merge after a reload, same as count and quantiles', () => {
    const a = new Sketch();
    const b = new Sketch();
    for (let i = 1; i <= 5000; i++) a.accept(i);
    for (let i = 5001; i <= 10000; i++) b.accept(i);
    const trueSum = ((10000 * 10001) / 2);

    const ra = Sketch.deserialize(a.serialize());
    const rb = Sketch.deserialize(b.serialize());
    ra.merge(rb);

    const relErr = Math.abs(ra.sum - trueSum) / trueSum;
    expect(relErr).toBeLessThanOrEqual(RELATIVE_ACCURACY);
  });

  it('an empty sketch reloads with sum 0, exactly — no bucket to reconstruct from', () => {
    const s = new Sketch();
    const reloaded = Sketch.deserialize(s.serialize());
    expect(reloaded.count).toBe(0);
    expect(reloaded.sum).toBe(0);
  });
});

describe('Sketch merge', () => {
  it('merging halves equals accepting the whole', () => {
    const vals = latencies(50_000);
    const whole = new Sketch(); for (const v of vals) whole.accept(v);
    const a = new Sketch(), b = new Sketch();
    vals.forEach((v, i) => (i % 2 ? a : b).accept(v));
    a.merge(b);
    expect(a.count).toBe(whole.count);
    expect(a.quantile(0.99)).toBeCloseTo(whole.quantile(0.99), 6);
  });

  it('survives the persist -> reload -> merge path', () => {
    const a = new Sketch(), b = new Sketch(), whole = new Sketch();
    for (let i = 1; i <= 5000; i++) { a.accept(i); whole.accept(i); }
    for (let i = 5001; i <= 10000; i++) { b.accept(i); whole.accept(i); }
    const ra = Sketch.deserialize(a.serialize());
    const rb = Sketch.deserialize(b.serialize());
    ra.merge(rb);
    expect(ra.quantile(0.99)).toBeCloseTo(whole.quantile(0.99), 6);
  });
});
