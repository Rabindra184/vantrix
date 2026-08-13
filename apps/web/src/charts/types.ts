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
 */
export interface ChartSeries {
  readonly name: string;
  readonly data: readonly (number | null)[] | readonly (readonly [number, number])[];
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
