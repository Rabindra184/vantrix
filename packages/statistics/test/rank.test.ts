import { describe, expect, it } from 'vitest';
import { nearestRankIndex } from '../src/rank.js';

describe('nearestRankIndex', () => {
  it('is the 1-based position ceil(p/100*n), as a 0-based index', () => {
    expect(nearestRankIndex(50, 4)).toBe(1);   // 2nd of 4
    expect(nearestRankIndex(95, 20)).toBe(18); // 19th of 20
    expect(nearestRankIndex(99, 1718)).toBe(1700); // ceil(1700.82) = 1701st
  });

  it('answers min for p=0 and max for p=100', () => {
    expect(nearestRankIndex(0, 10)).toBe(0);
    expect(nearestRankIndex(100, 10)).toBe(9);
  });

  it('is -1 for an empty sample', () => {
    expect(nearestRankIndex(50, 0)).toBe(-1);
  });

  // The floating-point formula Math.ceil(p / 100 * n) gets both of these wrong
  // (measured 2026-10-15): 0.07 * 100 is 7.000000000000001 and 0.999 * 1000 is
  // 999.0000000000001, so it returns the 8th and the 1000th value.
  it('is exact for decimal and round-sample percentiles', () => {
    expect(nearestRankIndex(7, 100)).toBe(6);       // 7th
    expect(nearestRankIndex(99.9, 1000)).toBe(998); // 999th
    expect(nearestRankIndex(99.99, 10000)).toBe(9998);
  });

  it('agrees with an exact rational computation for every p and n swept', () => {
    const ps = [1, 5, 7, 25, 50, 75, 80, 85, 90, 95, 99, 99.5, 99.9, 99.99];
    for (const p of ps) {
      const scale = 10 ** ((String(p).split('.')[1] ?? '').length);
      const num = BigInt(Math.round(p * scale));
      for (let n = 1; n <= 5000; n++) {
        const den = 100n * BigInt(scale);
        const prod = num * BigInt(n);
        const rank = Number((prod + den - 1n) / den); // exact ceil
        expect(nearestRankIndex(p, n), `p=${p} n=${n}`).toBe(Math.max(1, rank) - 1);
      }
    }
  });
});
