/**
 * THE ONE NEAREST-RANK FORMULA (spec §2): the value at 1-based position
 * ⌈p/100 × n⌉, returned as a 0-based index.
 *
 * Computed on integers because the floating-point form is wrong at round
 * sample sizes: Math.ceil(0.999 * 1000) is 1000 and Math.ceil(0.07 * 100) is
 * 8 (measured), so p99.9 over 1,000 values would return the maximum. `p` is
 * scaled by 10^decimals to an integer, so `num * n` is an exact integer and
 * the division below is the only rounding, applied once and upward.
 */
export function nearestRankIndex(p: number, n: number): number {
  if (n <= 0) return -1;
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile ${p} is outside [0, 100]`);
  const decimals = (String(p).split('.')[1] ?? '').length;
  const scale = 10 ** decimals;
  const num = Math.round(p * scale);
  const den = 100 * scale;
  const rank = Math.ceil((num * n) / den);
  return Math.min(n, Math.max(1, rank)) - 1;
}
