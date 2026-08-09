import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import { bandsFrom, isWarmup } from '../src/indicators.js';

const histOf = (...values: number[]): Histogram => {
  const h = new Histogram();
  for (const v of values) h.accept(v);
  return h;
};

describe('bandsFrom', () => {
  it('splits on t < lower, lower <= t < higher, t >= higher', () => {
    const ok = histOf(799, 800, 801, 1199, 1200, 1201);
    expect(bandsFrom(ok, 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 1, between: 3, over: 2, failed: 0,
    });
  });

  it('takes failed from the KO count, never from the OK histogram', () => {
    expect(bandsFrom(histOf(10, 20), 7, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 2, between: 0, over: 0, failed: 7,
    });
  });

  // This is the whole point of the redesign: the SAME stored histogram yields
  // different bands under different project settings, with no re-ingest.
  it('honours non-default bounds against unchanged stored data (AC-PARITY-4)', () => {
    const ok = histOf(100, 500, 900, 1500);
    expect(bandsFrom(ok, 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 2, between: 1, over: 1, failed: 0,
    });
    expect(bandsFrom(ok, 0, { lowerMs: 200, higherMs: 1000 })).toEqual({
      under: 1, between: 2, over: 1, failed: 0,
    });
  });

  it('is all zeroes for an empty histogram', () => {
    expect(bandsFrom(new Histogram(), 0, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 0, between: 0, over: 0, failed: 0,
    });
  });

  it('reproduces the fixture bands 848/0/23/24 at Gatling defaults', () => {
    const ok = new Histogram();
    for (let i = 0; i < 848; i++) ok.accept(300);      // < 800
    for (let i = 0; i < 23; i++) ok.accept(2000);      // >= 1200
    expect(bandsFrom(ok, 24, { lowerMs: 800, higherMs: 1200 })).toEqual({
      under: 848, between: 0, over: 23, failed: 24,
    });
  });

  it('rejects inverted bounds rather than returning a negative count', () => {
    const ok = histOf(100, 1000, 2000);
    expect(() => bandsFrom(ok, 0, { lowerMs: 1200, higherMs: 800 })).toThrow(/inverted/i);
  });

  it('accepts equal bounds, which collapse the middle band', () => {
    const ok = histOf(100, 1000, 2000);
    expect(bandsFrom(ok, 0, { lowerMs: 1000, higherMs: 1000 })).toEqual({
      under: 1, between: 0, over: 2, failed: 0,
    });
  });
});

describe('isWarmup', () => {
  it('is false when no warm-up is configured', () => {
    expect(isWarmup(1_000, 0, 0)).toBe(false);
  });
  it('is true strictly inside the window', () => {
    expect(isWarmup(4_999, 0, 5_000)).toBe(true);
    expect(isWarmup(5_000, 0, 5_000)).toBe(false);
  });
});
