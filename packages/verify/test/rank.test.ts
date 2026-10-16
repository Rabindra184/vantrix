import { describe, expect, it } from 'vitest';
import { nearestRankIndex } from '../src/rank.js';

/**
 * THE ORACLE IS A DIFFERENT ALGORITHM, NOT THE SAME FORMULA TWICE.
 *
 * Nearest rank, by definition: the smallest observed value v such that at
 * least p percent of the observations are <= v. The oracle answers exactly
 * that question by WALKING the sorted values and comparing counts in exact
 * BigInt arithmetic — no ceiling, no division, no float — so it cannot share
 * a rounding mistake with the function under test. The function returns an
 * INDEX; the claim compared is the VALUE at that index, which is what a
 * stored percentile is.
 */
function oracleValue(p: number, values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const [whole, frac = ''] = String(p).split('.');
  const scale = 10n ** BigInt(frac.length);
  const pScaled = BigInt(whole! + frac); // p * scale, exactly
  const n = BigInt(sorted.length);
  for (let i = 0; i < sorted.length; i += 1) {
    const atMost = BigInt(sorted.filter((v) => v <= sorted[i]!).length);
    // atMost / n >= p / 100  <=>  atMost * 100 * scale >= pScaled * n
    if (atMost * 100n * scale >= pScaled * n) return sorted[i]!;
  }
  return sorted[sorted.length - 1]!;
}

/** A deterministic generator, so a failure names a dataset that can be replayed. */
function dataset(n: number, seed: number, distinct: number): number[] {
  let x = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(x % distinct);
  }
  return out;
}

const PERCENTILES = [0, 25, 50, 75, 95, 99, 99.9, 7, 100];

describe('nearestRankIndex', () => {
  it('answers -1 for an empty population', () => {
    expect(nearestRankIndex(50, 0)).toBe(-1);
  });

  it('agrees with the counting oracle over generated datasets, ties included', () => {
    const cases: string[] = [];
    for (const n of [1, 2, 3, 7, 10, 99, 100, 101, 999, 1000, 1001]) {
      for (const distinct of [1, 3, 1000000]) {
        const values = dataset(n, n * 31 + distinct, distinct);
        const sorted = [...values].sort((a, b) => a - b);
        for (const p of PERCENTILES) {
          const got = sorted[nearestRankIndex(p, n)];
          const want = oracleValue(p, values);
          if (got !== want) cases.push(`p=${p} n=${n} distinct=${distinct}: ${got} != ${want}`);
        }
      }
    }
    expect(cases).toEqual([]);
  });

  /**
   * The two cases PR 1 measured a float rank getting wrong: 99.9 / 100 * 1000
   * is 999.0000000000001 and 7 / 100 * 100 is 7.000000000000001, so a float
   * ceiling picks the NEXT rank. Distinct values make an index error a value
   * error.
   */
  it.each([
    [99.9, 1000],
    [7, 100],
  ])('picks the exact rank for p=%s over n=%s, where a float ceiling does not', (p, n) => {
    const values = Array.from({ length: n }, (_, i) => i + 1);
    expect(values[nearestRankIndex(p, n)]).toBe(oracleValue(p, values));
  });

  it('answers the minimum at p=0 and the maximum at p=100', () => {
    expect(nearestRankIndex(0, 5)).toBe(0);
    expect(nearestRankIndex(100, 5)).toBe(4);
    expect(nearestRankIndex(99.9, 1)).toBe(0);
  });
});
