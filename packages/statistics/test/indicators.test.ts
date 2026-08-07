import { describe, expect, it } from 'vitest';
import { IndicatorCounter, isWarmup } from '../src/indicators.js';

describe('IndicatorCounter', () => {
  it('splits OK requests across the three bands and counts failures separately', () => {
    const c = new IndicatorCounter({ lowerMs: 800, higherMs: 1200 });
    c.add(100, true); c.add(799, true);      // under
    c.add(800, true); c.add(1199, true);     // between
    c.add(1200, true); c.add(5000, true);    // over
    c.add(50, false);                        // failed, regardless of duration
    expect(c.bands()).toEqual({ under: 2, between: 2, over: 2, failed: 1 });
  });
});

describe('isWarmup', () => {
  it('is true strictly inside the warm-up window', () => {
    expect(isWarmup(1_000_500, 1_000_000, 1000)).toBe(true);
    expect(isWarmup(1_001_000, 1_000_000, 1000)).toBe(false);
    expect(isWarmup(1_000_500, 1_000_000, 0)).toBe(false);
  });
});
