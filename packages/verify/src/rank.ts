/**
 * The 0-based index of the nearest-rank percentile `p` in an ascending
 * population of `n` values, or -1 for an empty one.
 *
 * Nearest rank is the ceil(p/100 · n)-th smallest value, clamped to [1, n].
 * The ceiling is taken in INTEGER arithmetic: `p` is written as an integer over
 * a power of ten (99.9 = 999/10), so the comparison never passes through a
 * float that lands a hair above a whole rank. A float form —
 * `Math.ceil(p / 100 * n)` — picks the NEXT rank for 99.9 of 1000 and for 7
 * of 100, because 99.9/100*1000 is 999.0000000000001 and 7/100*100 is
 * 7.000000000000001.
 *
 * Written here rather than imported: the verifier exists to check the engine,
 * and a shared rank function would agree with the engine whether or not
 * either is right (eslint.config.js refuses the import).
 */
export function nearestRankIndex(p: number, n: number): number {
  if (n <= 0) return -1;
  const fraction = String(p).split('.')[1] ?? '';
  const scale = 10 ** fraction.length;
  const numerator = Math.round(p * scale) * n; // exact: both are integers well below 2^53
  const denominator = 100 * scale;
  let rank = Math.floor(numerator / denominator);
  // The quotient of two exact integers rounds to the nearest double; settle
  // the ceiling against the integers themselves, in both directions.
  while (rank * denominator < numerator) rank += 1;
  while (rank > 0 && (rank - 1) * denominator >= numerator) rank -= 1;
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return rank - 1;
}
