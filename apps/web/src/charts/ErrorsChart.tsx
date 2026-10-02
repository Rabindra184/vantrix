import type { ErrorSeriesResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { RUN_TIME_GROUP } from './crosshair';
import type { TimeDomainMs } from './types';
import { toErrorSeries } from './transforms/errorSeries';

/**
 * Failures per second, in the Report's Requests section. (The errors table
 * it was drawn above lives on the Summary now; this chart is windowed with its
 * neighbours and that table cannot be.)
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
export default function ErrorsChart(
  { data, domainMs, warmupMs, windowSelected }: {
    readonly data: ErrorSeriesResponse;
    readonly domainMs?: TimeDomainMs;
  /**
   * The run's warm-up window, shaded on the elapsed-time axis (AC-STAT-4).
   * Travels with `domainMs` because it is a fact about the same axis.
   */
    readonly warmupMs?: number;
    /**
     * Did the reader narrow the Report to a time window? REQUIRED, no default: a
     * window that selects nothing and a run that recorded nothing draw the same
     * empty payload, and the sentence under the figure must not claim a fact about
     * the RUN when the reader asked about a WINDOW. The Report passes
     * `window !== null`; the Summary and the drill-downs pass `false`.
     */
    readonly windowSelected: boolean;
  },
) {
  const chart = useMemo(() => toErrorSeries(data, { windowSelected }), [data, windowSelected]);

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
      group={RUN_TIME_GROUP}
      // Already a value axis; now labelled in SECONDS like every other time
      // chart, and pinned to the same domain so the shared pointer lines up.
      // Its x is an INSTANT, not a measurement — the tooltip title names it.
      pairValue="y"
      xAxis={{
        type: 'value',
        tickUnit: 'ms-as-s',
        min: domainMs?.[0],
        max: domainMs?.[1],
        warmupMs,
      }}
      yAxis={{ name: 'Errors/s' }}
      unit="/s"
    />
  );
}
