import type { ErrorSeriesResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/** What the folded remainder is called wherever a reader can see it. */
export const OTHER_LABEL = 'Other errors';

/**
 * Failures per second, one series per message.
 *
 * ═══ A VALUE X-AXIS, LIKE THE COMPARE OVERLAY AND UNLIKE EVERY OTHER RUN CHART ═══
 *
 * Errors are SPARSE. The reference run fails in 21 of its 62 buckets, and a
 * quieter run can fail in three. A category axis indexes points by position,
 * so those three would draw evenly spaced across the whole width and every one
 * of them would sit at the wrong time — a chart that answers "when did this
 * break" with a confident lie.
 *
 * On a value axis each point carries its own x, so a gap in time is a gap.
 *
 * ═══ A RATE, DIVIDED BY THIS RESPONSE'S OWN WIDTH ═══
 *
 * `bucketWidthMs` is not always 1000: the engine halves resolution on a long
 * run. A 2000 ms bucket holding the same count is half the rate, which is the
 * same argument `transforms/rates.ts` makes — and because every bucket scales
 * equally, getting it wrong changes no shape and looks like nothing is wrong.
 */
export function toErrorSeries(response: ErrorSeriesResponse): ChartData {
  const perSecond = response.bucketWidthMs / 1000;
  const label = (message: string | null): string => message ?? OTHER_LABEL;

  if (response.series.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns: ['Elapsed (s)'],
      rows: [],
      // TWO DIFFERENT SENTENCES, deliberately. Both states draw nothing, and
      // only one of them is good news; a reader who cannot tell "this run
      // passed" from "we never recorded this" has been told nothing at all.
      // This is the whole job of `available` in the contract.
      empty: response.available
        ? 'No requests failed in this run.'
        : 'This run was ingested before failures were recorded over time.',
    };
  }

  const series: ChartSeries[] = response.series.map((s) => ({
    name: label(s.message),
    data: s.points.map((p) => [p.startOffsetMs, p.count / perSecond] as [number, number]),
  }));

  // The union of every series' offsets, so a message that failed once still
  // has its row — the table is the parity surface and the screen-reader route
  // to the same data.
  const offsets = [
    ...new Set(response.series.flatMap((s) => s.points.map((p) => p.startOffsetMs))),
  ].sort((a, b) => a - b);

  const lookups = response.series.map(
    (s) => new Map(s.points.map((p) => [p.startOffsetMs, p.count / perSecond])),
  );

  const rows: ChartTableRow[] = offsets.map((offset) => ({
    label: String(offset / 1000),
    // `—` rather than 0: this message was not seen in this bucket, which is
    // not the same claim as a measured rate of zero.
    values: lookups.map((lookup) => lookup.get(offset) ?? '—'),
  }));

  return {
    series,
    // EMPTY ON PURPOSE: x is a measured quantity here, so each point carries
    // its own. See `ChartSeries.data`'s pair form and `ChartXAxis.type`.
    axisLabels: [],
    columns: ['Elapsed (s)', ...response.series.map((s) => label(s.message))],
    rows,
  };
}
