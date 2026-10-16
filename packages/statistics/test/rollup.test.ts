import { describe, expect, it } from 'vitest';
import { bandsFrom } from '../src/indicators.js';
import { Histogram } from '../src/histogram.js';
import { mergedHistogram, RollupBuilder } from '../src/rollup.js';

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

  it('has no sketch and derives mean and population stddev from the histograms', () => {
    const b = new RollupBuilder();
    for (const v of [10, 20, 30, 40]) b.add(v, true);
    b.add(1000, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 99.9] });
    expect('sketch' in r).toBe(false);
    expect(r.meanMs).toBe(220);
    expect(r.stddevMs).toBeCloseTo(Math.sqrt((100 + 400 + 900 + 1600 + 1_000_000) / 5 - 220 ** 2), 9);
    expect(r.percentiles).toEqual({ p50: 30, 'p99.9': 1000 });
  });

  /**
   * `√(Σx²/n − mean²)` cancels catastrophically on values far from zero and
   * close together — a long group duration. Measured at 4.0e-7 relative error
   * on exactly this fixture; the PR 3 verifier compares within 1e-9.
   */
  it('keeps the standard deviation of large, tightly packed values within 1e-12 of a two-pass oracle', () => {
    const values = (() => { let s = 1; return Array.from({ length: 200_000 }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 300_000 + Math.floor((s / 0x7fffffff) * 20); }); })();
    const b = new RollupBuilder();
    values.forEach((v, i) => b.add(v, i % 50 !== 0));
    const r = b.finish({ scope: 'group', name: 'Browse', family: 'group_duration', windowMs: 1000, percentiles: [50] });
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    const oracle = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    expect(oracle).toBeGreaterThan(0);
    expect(Math.abs(r.stddevMs - oracle) / oracle).toBeLessThanOrEqual(1e-12);
  });

  it('keeps a five-minute group duration exact', () => {
    const b = new RollupBuilder();
    b.add(300_700, true);
    const r = b.finish({ scope: 'group', name: 'Browse', family: 'group_duration', windowMs: 1000, percentiles: [50] });
    expect(r.percentiles.p50).toBe(300_700);
  });
});

/**
 * A percentile cannot lie outside the sample it came from. The DDSketch these
 * rollups used to carry had 1% relative error, so its estimate sometimes did —
 * and reached the SLA evaluator, which failed runs on a p99 above their own
 * maximum while the statistics table showed the maximum one column over. The
 * percentiles are exact nearest-rank values now, so they are inside the range
 * by construction; these cases stay because they are the shapes that broke it.
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

  it('takes the percentile columns over BOTH statuses, the merge of the two histograms', () => {
    const b = new RollupBuilder();
    b.add(10, true);
    b.add(20, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50] });
    expect(r.count).toBe(2);
    expect(r.histogramOk.total + r.histogramKo.total).toBe(r.count);
    expect(r.percentiles.p50).toBe(10); // nearest rank 1 of [10, 20], across both statuses
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

/**
 * `mergedHistogram` is memoised so a row's merge is built once and shared by
 * `finish`, `toEvaluableStats` and the Gatling assertions. A memo is only
 * correct while it notices writes, and a SHARED merge is only safe while
 * nobody can write to it — so both halves are pinned here, beside the reuse.
 */
describe('mergedHistogram', () => {
  const pair = () => {
    const ok = new Histogram();
    const ko = new Histogram();
    for (const v of [10, 20, 30]) ok.accept(v);
    ko.accept(400);
    return { ok, ko };
  };

  it('hands back the merge already built for the same two unwritten histograms', () => {
    const { ok, ko } = pair();
    expect(mergedHistogram(ok, ko)).toBe(mergedHistogram(ok, ko));
  });

  it('rebuilds the merge once either input has been written to', () => {
    const { ok, ko } = pair();
    expect(mergedHistogram(ok, ko).max).toBe(400);
    ko.accept(900);
    expect(mergedHistogram(ok, ko).max).toBe(900);
    ok.accept(1);
    expect(mergedHistogram(ok, ko).min).toBe(1);
    expect(mergedHistogram(ok, ko).total).toBe(6);
  });

  it('refuses a write to the shared merge rather than change every reader', () => {
    const { ok, ko } = pair();
    const all = mergedHistogram(ok, ko);
    expect(() => all.accept(5)).toThrow(/read-only/);
    expect(() => all.merge(new Histogram())).toThrow(/read-only/);
    expect(all.total).toBe(4);
  });

  it('is the merge a finished row hands to whoever asks for it next', () => {
    const b = new RollupBuilder();
    for (const v of [10, 20, 30]) b.add(v, true);
    b.add(400, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50], clone: true });
    const all = mergedHistogram(r.histogramOk, r.histogramKo);
    expect(mergedHistogram(r.histogramOk, r.histogramKo)).toBe(all);
    expect(all.total).toBe(r.count);
  });
});
