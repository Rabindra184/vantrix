import { describe, expect, it } from 'vitest';
import { BUCKET_PERCENTILES, Sketch, bucketLatency } from '../src/index.js';

/** A bucket-shaped object carrying only what bucketLatency reads. */
function bucketOf(all: number[], ok: number[], ko: number[]) {
  const fill = (xs: number[]) => {
    const s = new Sketch();
    for (const x of xs) s.accept(x);
    return s;
  };
  return { sketch: fill(all), sketchOk: fill(ok), sketchKo: fill(ko) };
}

describe('bucketLatency', () => {
  it('derives min, max and mean from the all-outcomes sketch', () => {
    const out = bucketLatency(bucketOf([10, 20, 60], [10, 20], [60]));
    expect(out.minMs).toBe(10);
    expect(out.maxMs).toBe(60);
    expect(out.meanMs).toBe(30);
  });

  it('emits every fixed band, for each outcome split', () => {
    const out = bucketLatency(bucketOf([10, 20, 60], [10, 20], [60]));
    const expected = BUCKET_PERCENTILES.map((p) => `p${p}`);
    expect(Object.keys(out.percentiles)).toEqual(expected);
    expect(Object.keys(out.percentilesOk)).toEqual(expected);
    expect(Object.keys(out.percentilesKo)).toEqual(expected);
  });

  // The asymmetry is deliberate and is the thing a reimplementation gets
  // wrong: an empty sketch has no observations, so a p95 of 0 would be
  // fabricated -- but min/max/mean are 0 because the batch writer's columns
  // are NOT NULL. Both halves are asserted so neither can drift alone.
  it('returns {} for an empty sketch but 0 for its min, max and mean', () => {
    const out = bucketLatency(bucketOf([], [], []));
    expect(out.percentiles).toEqual({});
    expect(out.percentilesOk).toEqual({});
    expect(out.percentilesKo).toEqual({});
    expect(out.minMs).toBe(0);
    expect(out.maxMs).toBe(0);
    expect(out.meanMs).toBe(0);
  });

  it('gives an all-KO bucket empty OK bands and populated KO bands', () => {
    const out = bucketLatency(bucketOf([60], [], [60]));
    expect(out.percentilesOk).toEqual({});
    expect(Object.keys(out.percentilesKo)).toHaveLength(BUCKET_PERCENTILES.length);
  });
});
