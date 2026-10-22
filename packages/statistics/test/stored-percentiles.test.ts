import { describe, expect, it } from 'vitest';
import { Histogram, storedPercentiles } from '../src/index.js';

const exactRow = () => {
  const ok = new Histogram();
  for (let v = 1; v <= 1000; v++) ok.accept(v);
  return { count: 1000, minMs: 1, maxMs: 1000, percentiles: { p50: 500 }, histogramOk: ok, histogramKo: new Histogram() };
};

/**
 * A row written before 2026-10-15 and never recomputed: a v1 histogram (not
 * exact) and the frozen column the retired sketch engine wrote at ingest.
 * `p95: 2515` is the DDSketch's 1% overshoot above the row's exact maximum
 * of 2503 — the reference run's own numbers.
 */
const legacyRow = () => ({
  count: 100,
  minMs: 100,
  maxMs: 2503,
  percentiles: { p50: 100, p95: 2515 },
  histogramOk: Histogram.deserialize(Histogram.legacyV1ForTests([1, 2, 3])),
  histogramKo: null,
});

describe('storedPercentiles', () => {
  it('an exact row is unchanged: recomputed at any set from its histograms', () => {
    expect(storedPercentiles(exactRow(), [50, 99.9])).toEqual({ p50: 500, 'p99.9': 999 });
  });

  it('a legacy row answers its stored ranks, clamped', () => {
    expect(storedPercentiles(legacyRow(), [50, 95])).toEqual({ p50: 100, p95: 2503 });
  });

  /**
   * A project that gained p90 after this run was ingested: the frozen column
   * never stored it, and with the sketch gone there is nothing to estimate it
   * from. It is OMITTED — never zero and never interpolated between the
   * stored neighbours. (The run's own statistics table then has no p90
   * column at all; only a trends cohort or Compare, where other runs carry
   * the rank, shows a gap or a dash for it.)
   */
  it('a legacy row omits a rank it never stored', () => {
    const out = storedPercentiles(legacyRow(), [50, 90]);
    expect(out).toEqual({ p50: 100 });
    expect('p90' in out).toBe(false);
  });

  /**
   * The frozen column is JSONB, so it can hold a null where a number was
   * expected. Clamping a null would answer the row's minimum — a value
   * nobody measured — so it is omitted like a rank never stored.
   */
  it('a legacy row omits a rank whose frozen value is not a number', () => {
    const row = { ...legacyRow(), percentiles: { p50: null, p95: 2515 } as unknown as Record<string, number> };
    const out = storedPercentiles(row, [50, 95]);
    expect(out).toEqual({ p95: 2503 });
    expect('p50' in out).toBe(false);
  });

  it('an empty row answers its frozen column', () => {
    expect(storedPercentiles({ ...exactRow(), count: 0 }, [50])).toEqual({ p50: 500 });
    expect(storedPercentiles({ ...legacyRow(), count: 0 }, [50, 90])).toEqual({ p50: 100, p95: 2515 });
  });

  it('a row with no histograms at all is a legacy row too', () => {
    const out = storedPercentiles(
      { count: 5, minMs: 1, maxMs: 9, percentiles: { p50: 4, p99: 12 }, histogramOk: null, histogramKo: null },
      [50, 99],
    );
    expect(out).toEqual({ p50: 4, p99: 9 });
  });
});
