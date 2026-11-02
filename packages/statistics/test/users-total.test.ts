import { describe, expect, it } from 'vitest';
import { sumUsersByOffset } from '../src/index.js';

/**
 * The run's "All users" series is Gatling's: per bucket, the SUM of every
 * scenario's figures. `/v1/runs/:id/users` serves it and the AI analysis
 * states a peak from it, so the two have to read one definition.
 */
describe('sumUsersByOffset', () => {
  it("sums scenarios per offset, never each scenario's own maximum", () => {
    // Browse peaks at 0 ms, Checkout at 1000 ms.
    const rows = [
      { startOffsetMs: 1000, started: 1, ended: 3, maxConcurrent: 6 }, // Checkout
      { startOffsetMs: 0, started: 10, ended: 0, maxConcurrent: 10 }, // Browse
      { startOffsetMs: 1000, started: 0, ended: 4, maxConcurrent: 2 }, // Browse
      { startOffsetMs: 0, started: 2, ended: 1, maxConcurrent: 1 }, // Checkout
    ];

    const total = sumUsersByOffset(rows);

    expect(total).toEqual([
      { startOffsetMs: 0, started: 12, ended: 1, maxConcurrent: 11 },
      { startOffsetMs: 1000, started: 1, ended: 7, maxConcurrent: 8 },
    ]);
    // The peak of the totals is 11; adding each scenario's own peak (10 + 6)
    // would claim 16 users were ever running at once, which no bucket saw.
    expect(Math.max(...total.map((t) => t.maxConcurrent))).toBe(11);
  });

  it('answers nothing for no rows, and leaves its input alone', () => {
    expect(sumUsersByOffset([])).toEqual([]);
    const row = { startOffsetMs: 0, started: 1, ended: 0, maxConcurrent: 1 };
    sumUsersByOffset([row, { ...row }]);
    expect(row).toEqual({ startOffsetMs: 0, started: 1, ended: 0, maxConcurrent: 1 });
  });
});
