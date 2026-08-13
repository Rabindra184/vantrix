import type { DistributionResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { DISTRIBUTION_ROLES, toDistribution } from './transforms/distribution';

/**
 * §13.2 ⑧ — the response-time distribution (Appendix A G-20/G-21).
 *
 * A transform and a title, which is all a chart component is meant to be: the
 * numbers are `toDistribution`'s and are unit-tested without a DOM, the drawing
 * is `Chart`'s and is proven in a real browser.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT. Design §6: "A chart never fetches; it
 * receives already-validated data." `RunDetail` runs the one
 * `distributionQuery` (Task 10) and hands the response here.
 *
 * `useMemo` on the transform because `Chart`'s option effect depends on `data`
 * by identity: a fresh object every render would re-issue `setOption` on every
 * render, including on every React Query background refetch.
 */
export default function DistributionChart({
  distribution,
}: {
  readonly distribution: DistributionResponse;
}) {
  const data = useMemo(() => toDistribution(distribution), [distribution]);

  return (
    <Chart
      id="distribution"
      title="Response time distribution"
      data={data}
      // A histogram, and STACKED. The two series are shares of one combined
      // total (§A.9 F-8), so a stack height is "this much of all the run's
      // traffic landed in this bin" and the split inside it is the outcome —
      // which is the question the chart is asked. Side-by-side bars would
      // invite reading each series against 100% of its own, the very mistake
      // `toDistribution` refuses to make arithmetically, and at a hundred bins
      // would halve every bar's width to draw a KO series that is zero in
      // sixty of them.
      kind="bar"
      stacked
      // The app-wide status colours, per series — see `DISTRIBUTION_ROLES`.
      roles={DISTRIBUTION_ROLES}
      // The transform's own label-column header, which says whether the labels
      // are bin midpoints or exact values. One string for the axis and the
      // table, so a reader of either is told the same thing.
      xAxis={{ name: data.columns[0] }}
      // Not "Requests": the plotted numbers are percentages of the combined
      // OK+KO count, which is what Gatling displays and what G-20/G-21's
      // tolerance is written against. The exact counts are in the table.
      yAxis={{ name: '% of all requests' }}
    />
  );
}
