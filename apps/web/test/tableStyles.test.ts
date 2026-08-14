import { describe, expect, it } from 'vitest';
import { TD_NUM, THEAD } from '../src/components/tableStyles';

describe('table styles', () => {
  /**
   * Numeric columns must be tabular and right-aligned or a column of response
   * times cannot be scanned — digits of different widths make 1,143 look
   * shorter than 999. This is the one style with a legibility argument behind
   * it rather than a taste one, so it is the one with a test.
   */
  it('right-aligns numerics and uses tabular figures', () => {
    expect(TD_NUM).toContain('text-right');
    expect(TD_NUM).toContain('tabular-nums');
  });

  it('gives the header the sunken surface', () => {
    expect(THEAD).toContain('bg-sunken');
  });
});
