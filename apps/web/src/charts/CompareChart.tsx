import { useMemo } from 'react';
import Chart from './Chart';
import {
  COMPARE_METRICS,
  compareUnit,
  toCompare,
  type CompareMetric,
  type CompareRun,
} from './transforms/compare';

/**
 * The overlay: two to five runs on one axis, one metric at a time.
 *
 * NO CROSSHAIR GROUP. Every other time-axis chart in this app shares
 * `run-time`, so hovering requests/s moves the pointer on concurrent users.
 * Those all measure ONE run's clock. This measures several — the x is elapsed
 * time *within each run*, and second 12 of run A is not second 12 of run B in
 * any sense a shared pointer could honour.
 */
export default function CompareChart({
  runs,
  metric,
  onMetricChange,
}: {
  readonly runs: readonly CompareRun[];
  readonly metric: CompareMetric;
  readonly onMetricChange: (metric: CompareMetric) => void;
}) {
  const data = useMemo(() => toCompare(runs, metric), [runs, metric]);

  const label = COMPARE_METRICS.find((m) => m.value === metric)?.label ?? metric;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* A real `<label htmlFor>` rather than a placeholder: this is the one
            control that decides what the whole figure means, and a screen
            reader meets it with no chart context. */}
        <label htmlFor="compare-metric" className="shrink-0 text-[12px] text-muted">
          Metric
        </label>
        <select
          id="compare-metric"
          value={metric}
          onChange={(event) => onMetricChange(event.target.value as CompareMetric)}
          className="rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
        >
          {COMPARE_METRICS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <Chart
        id="compare-overlay"
        // The metric is in the TITLE, not only in the selector: the figure's
        // accessible name has to say what it is showing, and a heading reading
        // "Comparison" over a p99 chart tells a screen-reader user nothing.
        title={`${label} across runs`}
        data={data}
        kind="line"
        // A VALUE X-AXIS. Runs differ in duration and in bucket width, so they
        // meet at real elapsed times rather than being indexed against each
        // other by bucket position — see `toCompare`'s docstring for why this
        // replaces the resampling the spec originally called for.
        xAxis={{ type: 'value', name: 'Elapsed (ms)' }}
        yAxis={{ name: label }}
        unit={compareUnit(metric)}
      />
    </div>
  );
}
