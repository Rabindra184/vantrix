import { describe, expect, it } from 'vitest';
import { TD_NUM, TH_ROW, THEAD } from '../src/components/tableStyles';

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

  /**
   * `TH_ROW` is the constant beyond the brief's six — added because all
   * three tables need a `<th scope="row">` style identically, and it earns
   * the same coverage its siblings above get rather than shipping as the
   * one constant nobody tests.
   *
   * `font-normal` is the whole reason it exists: a `<th>` is bold by browser
   * default with nothing else said, and a row header (a request's name, an
   * error's message, a chart bucket's label) is not a heading — it should
   * read like the data cells beside it. Lose this class from the constant
   * and every row-header cell in the app goes bold at once.
   */
  it('cancels the default bold on a row-header cell', () => {
    expect(TH_ROW).toContain('font-normal');
  });
});
