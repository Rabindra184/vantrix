import type { StatsResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { BAND_ROLES, toIndicators } from './transforms/indicators';

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
export default function IndicatorsChart({ stats }: { stats: StatsResponse }) {
  const data = useMemo(() => toIndicators(stats), [stats]);

  return (
    <Chart
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
    />
  );
}
