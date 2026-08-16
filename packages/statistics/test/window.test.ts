import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import { rollupFromHistograms } from '../src/window.js';
import { RollupBuilder } from '../src/rollup.js';

const fill = (h: Histogram, values: readonly number[]): Histogram => {
  for (const v of values) h.accept(v);
  return h;
};

const OK = [12, 15, 15, 20, 33, 41, 58, 90];
const KO = [120, 400];

describe('rollupFromHistograms', () => {
  it('agrees with the full-run RollupBuilder on the same observations', () => {
    // The load-bearing property: a window covering everything must reproduce
    // what the unwindowed path reports. Derived from RollupBuilder itself, so
    // a change to either has to be a deliberate change to both.
    const builder = new RollupBuilder();
    for (const v of OK) builder.add(v, true);
    for (const v of KO) builder.add(v, false);
    const full = builder.finish({
      scope: 'run', name: '', family: 'response_time',
      windowMs: 10_000, percentiles: [50, 95],
    });

    const w = rollupFromHistograms(
      fill(new Histogram(), OK), fill(new Histogram(), KO), 10_000, [50, 95]);

    expect(w.count).toBe(full.count);
    expect(w.okCount).toBe(full.okCount);
    expect(w.koCount).toBe(full.koCount);
    expect(w.errorRate).toBeCloseTo(full.errorRate, 9);
    expect(w.minMs).toBe(full.minMs);
    expect(w.maxMs).toBe(full.maxMs);
    expect(w.meanMs).toBeCloseTo(full.meanMs, 9);
    expect(w.stddevMs).toBeCloseTo(full.stddevMs, 9);
    expect(w.throughputRps).toBeCloseTo(full.throughputRps, 9);
  });

  it('takes percentiles over OK AND KO together, like the full-run row', () => {
    // Not OK-only. The statistics table's percentile columns describe every
    // request; only the percentiles-over-time chart is OK-only (G-22).
    const w = rollupFromHistograms(
      fill(new Histogram(), OK), fill(new Histogram(), KO), 10_000, [50, 95]);
    const combined = fill(fill(new Histogram(), OK), KO);
    expect(w.percentiles['p95']).toBe(combined.quantile(0.95));
  });

  it('does not mutate the histograms it was handed', () => {
    // `merge` is destructive and the caller still needs the OK-only set for
    // the indicator bands. Merging in place would silently fold KO durations
    // into the band counts.
    const ok = fill(new Histogram(), OK);
    const before = ok.total;
    rollupFromHistograms(ok, fill(new Histogram(), KO), 10_000, [95]);
    expect(ok.total).toBe(before);
  });

  it('divides throughput by the WINDOW, not the run', () => {
    // This is what makes a brushed rate change — the whole point of the
    // feature. Halving the window doubles the rate for the same requests.
    const ok = fill(new Histogram(), OK);
    const ko = fill(new Histogram(), KO);
    const wide = rollupFromHistograms(ok, ko, 10_000, [95]);
    const narrow = rollupFromHistograms(ok, ko, 5_000, [95]);
    expect(narrow.throughputRps).toBeCloseTo(wide.throughputRps * 2, 9);
  });

  it('reports zeros, not NaN, for an empty window', () => {
    // A window a reader dragged over an idle stretch is a legitimate question
    // with a legitimate answer.
    const w = rollupFromHistograms(new Histogram(), new Histogram(), 1_000, [95]);
    expect(w.count).toBe(0);
    expect(w.errorRate).toBe(0);
    expect(w.meanMs).toBe(0);
    expect(w.percentiles).toEqual({});
  });

  it('never divides by a zero-length window', () => {
    const w = rollupFromHistograms(fill(new Histogram(), OK), new Histogram(), 0, [95]);
    expect(Number.isFinite(w.throughputRps)).toBe(true);
  });

  it('reports a zero standard deviation for a uniform sample, never a negative root', () => {
    // Σx²/n − mean² can come out fractionally negative through floating-point
    // cancellation when every observation is identical, and Math.sqrt of that
    // is NaN.
    const ok = new Histogram();
    for (let i = 0; i < 1_000; i += 1) ok.accept(37);
    const w = rollupFromHistograms(ok, new Histogram(), 1_000, [95]);
    expect(w.stddevMs).toBe(0);
  });
});
