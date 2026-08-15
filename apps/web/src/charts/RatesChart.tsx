import type { SeriesResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { RATE_ROLES, toRequestRate, toResponseRate } from './transforms/rates';
import type { ChartData } from './types';

/**
 * §13.2 ⑩ requests per second (Appendix A G-23) and ⑪ responses per second
 * (G-24) — a transform and a title each, which is all a chart component is
 * meant to be. The numbers are `rates.ts`'s and are unit-tested without a DOM;
 * the drawing is `Chart`'s and is proven in a real browser.
 *
 * TWO NAMED COMPONENTS, NOT ONE WITH AN `edge` PROP. The single mistake these
 * two charts invite is reading the other one's counters (`rates.ts` says why),
 * and a shared component taking `edge="start" | "end"` would move that mistake
 * from a place where it is typed and tested to a call site in `RunDetail` where
 * it is a string. There is no way to write `<ResponseRateChart/>` and get the
 * start edge.
 *
 * THEY TAKE THE PAYLOAD, THEY DO NOT FETCH IT. Design §6: "A chart never
 * fetches; it receives already-validated data." One `seriesQuery` in
 * `RunDetail` (Task 10) feeds these two and the percentile bands ⑨.
 *
 * `useMemo` on the transform because `Chart`'s option effect depends on `data`
 * by identity: a fresh object every render would re-issue `setOption` on every
 * render, including on every React Query background refetch.
 */

function RateChart({ id, title, yName, data }: {
  readonly id: string;
  readonly title: string;
  readonly yName: string;
  readonly data: ChartData;
}) {
  return (
    <Chart
      id={id}
      title={title}
      data={data}
      // Lines, and NOT stacked. `All` is already the sum of `OK` and `KO`, so
      // stacking would draw it at twice its own height and put the outcome
      // lines on top of the total they are part of.
      kind="line"
      // The app-wide status colours — see `RATE_ROLES`. OK/KO mean here what
      // they mean on the donut ④ and the distribution ⑧.
      roles={RATE_ROLES}
      yAxis={{ name: yName }}
      xAxis={{ name: 'Elapsed (s)' }}
      unit="/s"
      // Shares one crosshair with the other time-axis charts (§22.4/§22.5).
      // This is the linkage that replaces Gatling's dual axis: active users is
      // its own chart directly above rather than an overlay on this one, and
      // the shared pointer is what recovers "read these two together".
      group="run-time"
    />
  );
}

/**
 * `title` is a prop because the REQUEST detail page titles this chart
 * differently — Gatling's own request pages head it "Number of requests" where
 * the global page says "Requests per second over time" (§13.3 ⑦). The data,
 * the transform and the axis are identical; only the heading differs, so this
 * is one component with two names rather than two components.
 */
/** ⑩ — requests per second over time, bucketed by START time (G-23). */
export function RequestRateChart({
  series,
  title = 'Requests per second over time',
}: {
  readonly series: SeriesResponse;
  readonly title?: string;
}) {
  const data = useMemo(() => toRequestRate(series), [series]);
  return <RateChart id="requests-per-second" title={title} yName="Requests per second" data={data} />;
}

/** ⑪ — responses per second over time, bucketed by END time (G-24). */
export function ResponseRateChart({
  series,
  title = 'Responses per second over time',
}: {
  readonly series: SeriesResponse;
  readonly title?: string;
}) {
  const data = useMemo(() => toResponseRate(series), [series]);
  return <RateChart id="responses-per-second" title={title} yName="Responses per second" data={data} />;
}
