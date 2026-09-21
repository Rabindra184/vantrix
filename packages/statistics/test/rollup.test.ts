import { describe, expect, it } from 'vitest';
import { bandsFrom } from '../src/indicators.js';
import { RollupBuilder } from '../src/rollup.js';

describe('RollupBuilder', () => {
  it('computes exact counts, min, max, mean and population stddev', () => {
    const b = new RollupBuilder();
    for (const v of [10, 20, 30, 40]) b.add(v, true);
    b.add(50, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 95] });
    expect(r.count).toBe(5);
    expect(r.okCount).toBe(4);
    expect(r.koCount).toBe(1);
    expect(r.errorRate).toBeCloseTo(0.2, 10);
    expect(r.minMs).toBe(10);
    expect(r.maxMs).toBe(50);
    expect(r.meanMs).toBeCloseTo(30, 10);
    expect(r.stddevMs).toBeCloseTo(Math.sqrt(200), 10);   // population sd of 10..50 step 10
    expect(r.throughputRps).toBeCloseTo(5, 10);           // 5 events over 1000 ms
  });

  it('exposes percentiles keyed as p50, p95', () => {
    const b = new RollupBuilder();
    for (let i = 1; i <= 1000; i++) b.add(i, true);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 95] });
    expect(Object.keys(r.percentiles).sort()).toEqual(['p50', 'p95']);
    expect(r.percentiles.p95!).toBeGreaterThan(r.percentiles.p50!);
  });
});

/**
 * A percentile cannot lie outside the sample it came from, and `minMs`/`maxMs`
 * are tracked exactly while the sketch carries 1% relative error — so the
 * estimate sometimes does. Unclamped it reached the SLA evaluator, which failed
 * runs on a p99 above their own maximum while the statistics table showed the
 * maximum one column over.
 *
 * THE SHAPE THAT REACHES A BOUND IS A PLATEAU, which is why these fixtures are
 * not noise: an interior rank whose TRUE value is the extreme puts the estimate
 * at the edge with nowhere safe to be wrong. Both are ordinary load-test shapes
 * — a slow tail that levels off, and a fast path almost every request takes —
 * and the ceiling one reproduces the reference run's own number exactly
 * (unclamped: 2515.4601126102525 against a maximum of 2503).
 *
 * BOTH DIRECTIONS, because a clamp written with one bound is silent about the
 * other and real data cannot tell you: across the nine runs in the developer
 * database, 24 of 436 values sit above their maximum and NONE below their
 * minimum, so an upper-bound-only clamp would look complete against every run
 * this project has ever ingested.
 *
 * `expect(...).toBe(<the plateau>)` first in each: if the plateau ever stops
 * being the true answer at that rank the fixture has stopped reaching the
 * bound, and the case has stopped testing this.
 */
describe('RollupBuilder percentiles stay inside the range reported beside them', () => {
  const rollupOf = (vals: number[]) => {
    const b = new RollupBuilder();
    for (const v of vals) b.add(v, true);
    return b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [1, 5, 50, 95, 99] });
  };

  it('never reports a percentile above its own maximum', () => {
    const r = rollupOf([...Array<number>(450).fill(100), ...Array<number>(50).fill(2503)]);
    expect(r.maxMs).toBe(2503); // the tail really is a plateau at the maximum
    expect(r.percentiles.p95!).toBe(2503);
    expect(r.percentiles.p99!).toBe(2503);
  });

  it('never reports a percentile below its own minimum', () => {
    const r = rollupOf([...Array<number>(450).fill(50), ...Array.from({ length: 50 }, (_, i) => 3000 + i * 10)]);
    expect(r.minMs).toBe(50); // the fast path really is a plateau at the minimum
    // Unclamped these answered 49.90296094906744 — faster than the fastest
    // observation the rollup contains, beside a Min column reading 50.
    expect(r.percentiles.p1!).toBe(50);
    expect(r.percentiles.p5!).toBe(50);
  });
});

describe('RollupBuilder histograms', () => {
  it('routes observations to the OK or KO histogram by status', () => {
    const b = new RollupBuilder();
    b.add(100, true);
    b.add(100, true);
    b.add(900, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(r.histogramOk.total).toBe(2);
    expect(r.histogramOk.countAt(100)).toBe(2);
    expect(r.histogramKo.total).toBe(1);
    expect(r.histogramKo.countAt(900)).toBe(1);
  });

  it('keeps the sketch over BOTH statuses, matching the existing percentile columns', () => {
    const b = new RollupBuilder();
    b.add(10, true);
    b.add(20, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(r.count).toBe(2);
    expect(r.histogramOk.total + r.histogramKo.total).toBe(r.count);
  });

  it('yields bands that agree with the rollup counts', () => {
    const b = new RollupBuilder();
    for (let i = 0; i < 848; i++) b.add(300, true);
    for (let i = 0; i < 23; i++) b.add(2000, true);
    for (let i = 0; i < 24; i++) b.add(50, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(bandsFrom(r.histogramOk, r.koCount, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 848, between: 0, over: 23, failed: 24,
    });
  });
});
