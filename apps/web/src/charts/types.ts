/**
 * The one shape every transform produces and every chart consumes.
 *
 * Deliberately plain data — no React, no ECharts types anywhere in these
 * declarations. That is what lets `charts/transforms/*` be pure TypeScript
 * unit-tested in the node environment against the captured payload fixture,
 * with no DOM and no renderer, while `Chart.tsx` is the only module that has
 * to know what an ECharts option object looks like.
 */

/**
 * One row of the accessible data table: a label for the row, then one value
 * per value-column.
 *
 * `values` lines up with `ChartData.columns.slice(1)` — `columns[0]` heads the
 * LABEL column. So a chart with columns `['Band', 'Count', 'Percent']` has
 * rows whose `label` is the band and whose `values` are `[count, percent]`.
 */
export interface ChartTableRow {
  readonly label: string;
  readonly values: readonly (string | number)[];
}

/**
 * One plotted series.
 *
 * `data` is either one value per `axisLabels` entry — `null` for a gap, which
 * is not the same as zero and must not be drawn as one — or explicit
 * `[x, y]` pairs for the charts whose x is a measured quantity rather than a
 * category.
 *
 * A PAIR'S y IS NULLABLE FOR THE SAME REASON A SCALAR IS. The gap rule is a
 * property of the measurement, not of the axis it is drawn against: a bucket
 * whose count was never recorded is a hole in both forms. Omitting the point
 * instead would let a line join its neighbours straight across the hole, which
 * draws a measurement nobody took — so the point keeps its x and carries a
 * null y.
 */
export interface ChartSeries {
  readonly name: string;
  readonly data: readonly (number | null)[] | readonly (readonly [number, number | null])[];
  /**
   * "Draw this one even if the palette runs out."
   *
   * The categorical palette has six hues and never cycles, so a seventh series
   * is left undrawn and said so (`assignPalette`). By default the six that
   * survive are the first six, which is the right rule when series are peers —
   * and the wrong one when one of them is the summary the others decompose.
   *
   * `toConcurrentUsers` is that case: its order is `[...scenarios, total]`, so
   * a run with six scenarios would drop the TOTAL — the one line that answers
   * "how loaded was the system" — while drawing every scenario. Marking it
   * essential caps the scenarios instead. The ORDER is unchanged (the total is
   * still `series.at(-1)`); only the selection is.
   *
   * Essential series are exempt in declaration order, and no more than the
   * palette can hold — this cannot conjure a seventh hue, it only decides who
   * spends the six.
   */
  readonly essential?: boolean;
}

export interface ChartData {
  readonly series: readonly ChartSeries[];
  readonly axisLabels: readonly (string | number)[];
  /** Header row for the data table, INCLUDING the label column at index 0. */
  readonly columns: readonly string[];
  readonly rows: readonly ChartTableRow[];
  /**
   * Set when there is nothing to draw, and carrying the REASON — "this run is
   * still processing", "no requests were recorded" — because a chart with no
   * data must show an explanation rather than empty axes (design §11). Charts
   * still render their (empty) data table when this is set, so the parity
   * surface is present on every chart on the page unconditionally.
   */
  readonly empty?: string;
  /**
   * Set when the chart is drawing less than the whole truth and the reader has
   * to be told — bins truncated by a histogram overflow, a split the run
   * predates, series beyond the six the palette has hues for. Rendered as
   * prose beside the chart, never swallowed.
   */
  readonly limitation?: string;
}

/**
 * The shared time domain, in elapsed milliseconds — see `ChartXAxis.min`.
 *
 * Optional so a chart rendered outside the run page (the request and group
 * detail pages, which each show one run's slice) still auto-scales. Supplied on
 * the run page so every time chart draws the same span and the crosshair they
 * share means ONE instant.
 */
export type TimeDomainMs = readonly [number, number];
