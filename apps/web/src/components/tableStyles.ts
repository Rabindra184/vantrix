/**
 * The table look, in one place.
 *
 * Three tables set these per file today — the statistics table, the errors
 * table, and every chart's data table — and a density change had to be made
 * three times and agreed three times.
 */
export const TABLE = 'w-full border-collapse text-left text-sm';
export const THEAD = 'bg-sunken';
export const TH = 'px-3 py-2 font-semibold';
export const ROW = 'border-b border-divider';
export const TD = 'px-3 py-1.5';
export const TD_NUM = 'px-3 py-1.5 text-right tabular-nums';

/**
 * A `<th scope="row">` cell — the row's own name or message, not a column
 * heading. It sits in the same row as `TD`/`TD_NUM` cells and has to line up
 * with them, so it takes `TD`'s spacing; `TH` is wrong here because it is
 * bold, and a `<th>` goes bold on every row by browser default with nothing
 * to say otherwise, which is exactly wrong for a row that is not a total.
 * `font-normal` is what cancels that default. Needed identically in all three
 * tables — the statistics table's row name, the errors table's message, and
 * the chart data table's row label — which is what earns it a name here
 * rather than three copies of the same three words.
 */
export const TH_ROW = 'px-3 py-1.5 font-normal';
