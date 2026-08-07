import { describe, expect, it } from 'vitest';
import { Sketch } from '../src/sketch.js';

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
