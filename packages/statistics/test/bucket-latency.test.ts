import { describe, expect, it } from 'vitest';
import { BUCKET_PERCENTILES, Histogram, bucketLatency } from '../src/index.js';

/** A bucket-shaped object carrying only what bucketLatency reads. */
function bucketOf(ok: number[], ko: number[]) {
  const fill = (xs: number[]) => {
    const h = new Histogram();
    for (const x of xs) h.accept(x);
    return h;
  };
  return { histogramOk: fill(ok), histogramKo: fill(ko) };
}

describe('bucketLatency', () => {
  it('derives min, max and mean from the merge of both statuses', () => {
    const out = bucketLatency(bucketOf([10, 20], [60]));
    expect(out.minMs).toBe(10);
    expect(out.maxMs).toBe(60);
    expect(out.meanMs).toBe(30);
  });

  /**
   * The same rule `RollupBuilder` holds, one level down: a bucket reports
   * `minMs`/`maxMs` beside its bands, so no band may fall outside them. The
   * bands are exact nearest-rank values now, so this holds by construction;
   * the plateau is kept because it is the shape that broke the old DDSketch
   * estimate (2515.4601126102525 against a maximum of 2503).
   */
  it('keeps every band inside the min and max it reports, where the tail plateaus', () => {
    const plateau = [...Array<number>(450).fill(100), ...Array<number>(50).fill(2503)];
    const out = bucketLatency(bucketOf(plateau, []));
    expect(out.maxMs).toBe(2503); // the tail really is a plateau at the maximum
    for (const [key, v] of Object.entries(out.percentiles)) {
      expect(v, `${key} is inside [${out.minMs}, ${out.maxMs}]`).toBeLessThanOrEqual(out.maxMs);
      expect(v, `${key} is inside [${out.minMs}, ${out.maxMs}]`).toBeGreaterThanOrEqual(out.minMs);
    }
    expect(out.percentiles.p99!).toBe(2503);
  });

  it('emits every fixed band, for each outcome split', () => {
    const out = bucketLatency(bucketOf([10, 20], [60]));
    const expected = BUCKET_PERCENTILES.map((p) => `p${p}`);
    expect(Object.keys(out.percentiles)).toEqual(expected);
    expect(Object.keys(out.percentilesOk)).toEqual(expected);
    expect(Object.keys(out.percentilesKo)).toEqual(expected);
  });

  // The asymmetry is deliberate and is the thing a reimplementation gets
  // wrong: an empty histogram has no observations, so a p95 of 0 would be
  // fabricated -- but min/max/mean are 0 because the batch writer's columns
  // are NOT NULL. Both halves are asserted so neither can drift alone.
  it('returns {} for an empty histogram but 0 for its min, max and mean', () => {
    const out = bucketLatency(bucketOf([], []));
    expect(out.percentiles).toEqual({});
    expect(out.percentilesOk).toEqual({});
    expect(out.percentilesKo).toEqual({});
    expect(out.minMs).toBe(0);
    expect(out.maxMs).toBe(0);
    expect(out.meanMs).toBe(0);
  });

  it('gives an all-KO bucket empty OK bands and populated KO bands', () => {
    const out = bucketLatency(bucketOf([], [60]));
    expect(out.percentilesOk).toEqual({});
    expect(Object.keys(out.percentilesKo)).toHaveLength(BUCKET_PERCENTILES.length);
  });

  it('answers {} for an empty population and exact values otherwise', () => {
    const okOnlyKo = { histogramOk: new Histogram(), histogramKo: new Histogram() };
    okOnlyKo.histogramKo.accept(401);
    okOnlyKo.histogramKo.accept(403);
    const lat = bucketLatency(okOnlyKo);
    expect(lat.percentilesOk).toEqual({});
    expect(lat.percentilesKo.p50).toBe(401);
    expect(lat.minMs).toBe(401);
    expect(lat.maxMs).toBe(403);
    expect(lat.meanMs).toBe(402);
    expect(Object.values(lat.percentiles).every(Number.isFinite)).toBe(true);
  });

  it('answers zeros and {} for a bucket that saw nothing', () => {
    const lat = bucketLatency({ histogramOk: new Histogram(), histogramKo: new Histogram() });
    expect(lat).toEqual({ minMs: 0, maxMs: 0, meanMs: 0, percentiles: {}, percentilesOk: {}, percentilesKo: {} });
  });
});
