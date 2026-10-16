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

  it('keeps the legacy sketch path, clamped, for a pre-2026-10-15 row', () => {
    const s = new Sketch();
    for (let v = 1; v <= 1000; v++) s.accept(v);
    const legacy = {
      count: 1000, minMs: 1, maxMs: 1000, percentiles: { p50: 500 },
      histogramOk: Histogram.deserialize(Histogram.legacyV1ForTests([1, 2, 3])), histogramKo: null,
      sketch: Sketch.deserialize(s.serialize()),
    };
    const out = storedPercentiles(legacy, [99]);
    expect(out.p99).toBeGreaterThanOrEqual(1);
    expect(out.p99).toBeLessThanOrEqual(1000); // clamped, as before
  });

  it('falls back to the frozen column for an empty row or a row with neither source', () => {
    expect(storedPercentiles({ ...exactRow(), count: 0 }, [50])).toEqual({ p50: 500 });
    expect(storedPercentiles({ count: 5, minMs: 1, maxMs: 9, percentiles: { p50: 4 }, histogramOk: null, histogramKo: null, sketch: null }, [50])).toEqual({ p50: 4 });
  });
});
