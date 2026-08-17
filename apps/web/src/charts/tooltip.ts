import { formatCell } from './DataTable';

/**
 * The tooltip, as a string of HTML.
 *
 * Kept out of `Chart.tsx` so it can be tested without a DOM and without a
 * renderer — the same boundary `charts/transforms/*` already has, and for the
 * same reason: everything here is a decision about what a reader sees, and
 * none of it needs ECharts to be true.
 *
 * ECharts wants a `formatter` that returns markup. That makes every
 * interpolated value an injection site, and SERIES NAMES ARE NOT OURS: they
 * come from the tool's payload, which came from someone's simulation. A
 * request named `<img src=x onerror=…>` must render as text. Everything except
 * ECharts' own `marker` is escaped.
 */

/**
 * Above EIGHT series the tooltip lays out in two columns.
 *
 * The percentiles chart draws ten, and a ten-row tooltip near the bottom of a
 * chart runs off the viewport — the reader hovers to read a number and the
 * number is not on screen. Eight or fewer stays a single column, so every
 * other chart in the app is visually unchanged by this rule.
 */
export const TWO_COLUMN_THRESHOLD = 8;

export interface TooltipRow {
  /**
   * ECharts' own colour swatch, already markup and already ours. The one thing
   * here that is NOT escaped, because escaping it would render the span as
   * text and the reader would lose the colour that ties a row to its line.
   */
  readonly marker: string;
  /** From the payload. Untrusted. */
  readonly name: string;
  readonly value: unknown;
}

/**
 * `&` FIRST, and the order is load-bearing rather than stylistic: replacing
 * `<` before `&` turns `&lt;` into `&amp;lt;` correctly, but replacing `&`
 * last turns the `&` this function just introduced into `&amp;`, double-
 * escaping every entity it wrote. One test pins the ordering.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * THE SAME FORMATTING THE DATA TABLE USES, from the same function.
 *
 * The reasoning is `Chart.tsx`'s and is unchanged by moving here: the tooltip
 * once rendered ECharts' raw values — `122.74516052680153 ms` for a
 * percentile, seventeen significant digits of a number nothing measures to
 * more than two — and `formatCell` was written for the table half of exactly
 * that problem. Sharing it is what stops the two surfaces disagreeing about a
 * value a reader can see in both.
 *
 * A SCATTER POINT IS AN ARRAY, not a scalar. Its series data is `[x, y]` pairs
 * and ECharts hands the whole pair over at once, so a naive `String(value)`
 * gives `"3,120"` — which on a milliseconds axis reads as three thousand one
 * hundred twenty rather than two separate measurements. Formatted
 * component-by-component and joined by a comma-space no reader mistakes for a
 * digit grouping.
 *
 * A GAP TAKES NO UNIT. "— ms" reads as a measurement that came out empty,
 * which is precisely the thing a gap is not.
 */
export function formatTooltipValue(value: unknown, unit?: string, pair: PairValue = 'xy'): string {
  if (value === null || value === undefined) return '—';
  const one = (v: unknown): string =>
    typeof v === 'number' || typeof v === 'string' ? formatCell(v) : String(v);
  const text = ((): string => {
    if (!Array.isArray(value)) return one(value);
    // A TIME SERIES' VALUE IS ITS Y. The pair's x is the instant, and the
    // tooltip's own title already names it — rendering both put
    // "42000, 127.75 ms" on every row of every time chart the moment those
    // charts moved to a value axis.
    if (pair === 'y') return one(value[value.length - 1]);
    // A SCATTER POINT IS THE PAIR. Its x is a measured quantity (global
    // requests/s, RQ-09) rather than a position, so dropping it would throw
    // away half the observation. Joined with ', ' rather than String()'s bare
    // comma: `String([3, 120])` is "3,120", indistinguishable from a single
    // four-figure number on a milliseconds axis.
    return value.map(one).join(', ');
  })();
  return unit === undefined ? text : `${text} ${unit}`;
}

function renderRow(row: TooltipRow, unit?: string, pair?: PairValue): string {
  return (
    '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">' +
    row.marker +
    `<span style="flex:1">${escapeHtml(row.name)}</span>` +
    '<span style="font-variant-numeric:tabular-nums;font-weight:600">' +
    escapeHtml(formatTooltipValue(row.value, unit, pair)) +
    '</span></div>'
  );
}

/**
 * ONE FORMATTER, NOT TWO.
 *
 * The tempting shape is to keep ECharts' `valueFormatter` for the narrow case
 * and add a custom `formatter` only for the wide one. That puts two code paths
 * on the same value, which is exactly the class of bug that sharing
 * `formatCell` with the data table exists to prevent — the two would be free
 * to round, or unit, or dash differently, and nothing would notice. This
 * always runs.
 *
 * Columns fill top-to-bottom then across, so series order reads down the first
 * column and continues down the second — the order the legend and the
 * percentile ramp are both already in. Filling across would interleave the
 * ramp and make a green band sit beside a red one for no reason.
 */
export function renderTooltip(
  title: string,
  rows: readonly TooltipRow[],
  unit?: string,
  /** How a `[x, y]` point reads — see `PairValue`. */
  pair?: PairValue,
): string {
  const head = `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(title)}</div>`;

  if (rows.length <= TWO_COLUMN_THRESHOLD) {
    return `${head}<div>${rows.map((row) => renderRow(row, unit, pair)).join('')}</div>`;
  }

  // Ceil, so an odd count puts the extra row in the FIRST column. The
  // alternative leaves a ragged left edge, and the first column is the one a
  // reader's eye starts at.
  const split = Math.ceil(rows.length / 2);
  const column = (slice: readonly TooltipRow[], n: number): string =>
    `<div data-tooltip-column="${n}">${slice.map((row) => renderRow(row, unit, pair)).join('')}</div>`;

  return (
    `${head}<div style="display:flex;gap:16px">` +
    column(rows.slice(0, split), 1) +
    column(rows.slice(split), 2) +
    '</div>'
  );
}

/**
 * ECharts hands an `axis`-triggered tooltip an ARRAY of params and an
 * `item`-triggered one (the pie) a single object. Normalised here so
 * `renderTooltip` never has to know a renderer shape, and so the pie keeps
 * working — it has one row and one name, and falls out of the same code.
 *
 * Typed through `Record<string, unknown>` rather than ECharts' own param
 * types: those are a union wide enough that every field access needs a
 * narrowing that says nothing, and this module is deliberately free of
 * renderer imports.
 */
/**
 * How a `[x, y]` point is read out — see `formatTooltipValue`. `'y'` for a
 * series whose x is a POSITION (elapsed time), `'xy'` for one whose x is a
 * MEASUREMENT (the response-time scatter).
 */
export type PairValue = 'y' | 'xy';

export function tooltipFormatter(params: unknown, unit?: string, pair?: PairValue): string {
  const list = Array.isArray(params) ? params : [params];
  const first = list[0] as Record<string, unknown> | undefined;
  if (first === undefined) return '';

  const title = String(first['axisValueLabel'] ?? first['name'] ?? '');

  const rows: TooltipRow[] = list.map((entry) => {
    const param = entry as Record<string, unknown>;
    return {
      marker: String(param['marker'] ?? ''),
      name: String(param['seriesName'] ?? param['name'] ?? ''),
      value: param['value'],
    };
  });

  return renderTooltip(title, rows, unit, pair);
}
