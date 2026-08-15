import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { BAND_ROLES, toIndicators, toRowIndicators } from './transforms/indicators';

/**
 * §13.2 ③ — the response-time indicator bands (Appendix A G-06…G-09).
 *
 * A transform and a title, which is all a chart component is meant to be: the
 * numbers are `toIndicators`' and are unit-tested without a DOM, the drawing is
 * `Chart`'s and is proven in a real browser.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT. Design §6: "A chart never fetches; it
 * receives already-validated data." `RunDetail` runs the one `statsQuery` (Task
 * 10) and hands the same response to this chart and to `RequestCountChart` —
 * one request for the two charts §13.2 draws from `/stats`, which is also why
 * `statsQuery` is deliberately unfiltered.
 *
 * `useMemo` on the transform because `Chart`'s option effect depends on `data`
 * by identity: a fresh object every render would re-issue `setOption` on every
 * render, including on every React Query background refetch.
 */
export default function IndicatorsChart({
  stats,
  row,
  label,
  noun,
}: {
  readonly stats: StatsResponse;
  /** A specific row's bands. Absent on the run's own overview, which folds the
   *  response-level `indicators` — the run row's — instead. */
  readonly row?: StatRow;
  /** What that row is called on the axis. Required whenever `row` is given. */
  readonly label?: string;
  /** What the subject is called when there is nothing to fold. */
  readonly noun?: string;
}) {
  const data = useMemo(
    () =>
      label === undefined
        ? toIndicators(stats)
        : toRowIndicators(stats, row, label, noun ?? 'request'),
    [stats, row, label, noun],
  );

  return (
    <Chart
      // NAMES ITSELF, DELIBERATELY — unlike `DistributionChart` and
      // `ScopedStatistics`, which take `id`/`title` and `heading` from their
      // caller. That is not an oversight, and the difference is not stylistic.
      //
      // Those two acquired a SECOND caller on one page: the group detail page
      // renders a distribution and a statistics table per metric family
      // (cumulated response time and duration), and a component that names
      // itself cannot appear twice — two figures would share a DOM id and a
      // heading, and nothing on screen would tell the two measures apart.
      //
      // This chart has no such caller and cannot acquire one from parity work:
      // Gatling's group page carries a single `RangesContainerId`, so GR-09
      // folds one row (the cumulated one) and draws one figure. All three
      // pages render exactly one of these. Props nothing passes would be
      // speculative generality, and a test for them would need an invented
      // caller to have anything to assert.
      //
      // The rule, stated once so the asymmetry reads as a decision: a chart
      // names itself until a page needs two of it. If one ever does — a
      // future page showing both group measures' bands side by side — give it
      // `id` and `title` props with these values as defaults, exactly as
      // `DistributionChart` did.
      id="indicators"
      title="Response time ranges"
      data={data}
      kind="bar"
      stacked
      horizontal
      // The four-step severity ramp, not the categorical palette and not the
      // app-wide status colours — see `BandRole` in theme.ts.
      roles={BAND_ROLES}
      yAxis={{ name: 'Requests' }}
      unit="requests"
    />
  );
}
