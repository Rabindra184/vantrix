import type { ErrorSeriesResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { toErrorSeries } from './transforms/errorSeries';

/**
 * Failures per second, above the errors table on the same tab.
 *
 * ═══ NO ICON, NO DECORATIVE SVG ═══
 *
 * `Chart` renders its data table INSIDE the `<figure>`, and nine specs across
 * `run-charts.spec.ts` and `request-detail.spec.ts` prove a chart really drew
 * by counting SVG elements within the figure — `toHaveCount(1)` per chart, and
 * `toHaveCount(0)` for one with nothing to draw. An icon here makes both counts
 * wrong AND destroys the invariant they rest on.
 *
 * ═══ THE CATEGORICAL PALETTE, NEVER `--color-status-failed` ═══
 *
 * An errors chart is the single most tempting place to reach for the status
 * tokens, and there are two reasons not to. They are a TEXT palette — labels,
 * badges, `routes/marks.tsx` — while chart marks come from `--chart-*` through
 * `assignPalette`, so a status hue would not move with the chart theme. And
 * they are deliberately kept out of `@theme`, so the utility that looks right
 * does not exist: `text-status-failed` emits no CSS at all, silently.
 */
export default function ErrorsChart({ data }: { readonly data: ErrorSeriesResponse }) {
  const chart = useMemo(() => toErrorSeries(data), [data]);

  return (
    <Chart
      id="errors-over-time"
      title="Errors per second"
      data={chart}
      kind="line"
      // The same crosshair group as every other chart measuring THIS run's
      // clock, because that is what this measures too. (The compare overlay
      // deliberately opts out, but only because its x is elapsed time within
      // several different runs.)
      group="run-time"
      xAxis={{ type: 'value', name: 'Elapsed (ms)' }}
      yAxis={{ name: 'Errors/s' }}
      unit="/s"
    />
  );
}
