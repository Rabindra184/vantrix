import { describe, expect, it } from 'vitest';
import { Histogram, Sketch, storedPercentiles } from '../src/index.js';

const exactRow = () => {
  const ok = new Histogram();
  for (let v = 1; v <= 1000; v++) ok.accept(v);
  return { count: 1000, minMs: 1, maxMs: 1000, percentiles: { p50: 500 }, histogramOk: ok, histogramKo: new Histogram(), sketch: null };
};

describe('storedPercentiles', () => {
  it('recomputes an exact (v2) row at any set from its histograms', () => {
    expect(storedPercentiles(exactRow(), [50, 99.9])).toEqual({ p50: 500, 'p99.9': 999 });
  });

  /**
   * The reference run's shape: 95 requests at 100 ms and 5 at the same top
   * value, so the p99 rank is interior and lands in the maximum's own sketch
   * bucket, whose midpoint sits ABOVE the maximum. Only a population where
   * the raw estimate escapes the row's range can tell a clamp from none: a
   * uniform 1..1000 stays inside it either way.
   */
  it('keeps the legacy sketch path, clamped to the row it sits beside', () => {
    const s = new Sketch();
    for (let i = 0; i < 95; i++) s.accept(100);
    for (let i = 0; i < 5; i++) s.accept(2503);
    const sketch = Sketch.deserialize(s.serialize());
    expect(sketch.quantile(0.99)).toBeGreaterThan(2503); // the raw estimate escapes
    const legacy = {
      count: 100, minMs: 100, maxMs: 2503, percentiles: { p99: 2503 },
      histogramOk: Histogram.deserialize(Histogram.legacyV1ForTests([1, 2, 3])), histogramKo: null,
      sketch,
    };
    expect(storedPercentiles(legacy, [99])).toEqual({ p99: 2503 });
  });

  it('falls back to the frozen column for an empty row or a row with neither source', () => {
    expect(storedPercentiles({ ...exactRow(), count: 0 }, [50])).toEqual({ p50: 500 });
    expect(storedPercentiles({ count: 5, minMs: 1, maxMs: 9, percentiles: { p50: 4 }, histogramOk: null, histogramKo: null, sketch: null }, [50])).toEqual({ p50: 4 });
  });
});
