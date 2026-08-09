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
