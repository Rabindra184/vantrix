import { useId, useMemo } from 'react';
import type { Window } from '@perfportal/contracts';
import Chart from './Chart';
import { asSeconds, useWindowControl, type WindowControl } from './useWindowControl';
import { ElapsedOnly } from './TimeAxisContext';
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
  pending,
  metric,
  onMetricChange,
  window,
  extentMs,
  onWindow,
}: {
  readonly runs: readonly CompareRun[];
  /**
   * One of the OVERLAY'S OWN reads is still answering — its `/series`,
   * `/users` or CPU sources, never the page's `/stats`, which the table waits
   * on and this chart does not draw from. `runs` then holds only the runs that
   * have arrived — possibly none — and a sentence drawn from them ("Select at
   * least one run", "was not recorded") would be a claim about reads that
   * have not answered. REQUIRED, with no default: forgetting it would bring
   * that claim back silently.
   */
  readonly pending: boolean;
  readonly metric: CompareMetric;
  readonly onMetricChange: (metric: CompareMetric) => void;
  /** The comparison's window, `null` for every run whole. */
  readonly window: Window | null;
  /**
   * The slider's extent: the LONGEST selected run's duration, so every run's
   * whole span is reachable. `0` when no selected run reports a duration, and
   * then there is nothing to slide over and no time-range control is drawn.
   */
  readonly extentMs: number;
  /** Writes the window to the URL; `null` is the whole of every run. */
  readonly onWindow: (window: Window | null) => void;
}) {
  const data = useMemo(
    () =>
      pending
        ? {
            series: [],
            axisLabels: [],
            columns: ['Elapsed (s)'],
            rows: [],
            empty: 'Loading the selected runs…',
          }
        : toCompare(runs, metric),
    [pending, runs, metric],
  );

  /* The slider, the fields and Whole run behave exactly as the run page's
     `TimeBrush` does — the same hook, so a drag settles before it is written,
     Apply leaves a settling drag to land, and Whole run cancels it. The
     window here must be a stable object; `RunCompare` memoises it. */
  const control = useWindowControl({ window, extentMs, onChange: onWindow });
  const ranged = extentMs > 0;

  const label = COMPARE_METRICS.find((m) => m.value === metric)?.label ?? metric;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* A real `<label htmlFor>` rather than a placeholder: this is the one
            control that decides what the whole figure means, and a screen
            reader meets it with no chart context. */}
        <label htmlFor="compare-metric" className="shrink-0 text-[0.75rem] text-muted">
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

      <ElapsedOnly>
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
          /* ═══ ELAPSED, LIKE EVERY OTHER TIME CHART; ITS TABLE STAYS IN SECONDS ═══
           *
           * `toCompare` plots `[bucket.startOffsetMs, value]` — raw
           * milliseconds, because a value axis carries x per point — and the
           * TABLE beneath this chart writes `offset / 1000` under a column
           * headed `Elapsed (s)`. So one screen showed one quantity in two
           * units: a bucket at 42 s was drawn at 42000 and tabulated at 42,
           * and the axis pointer's label said 42000 too.
           *
           * `tickUnit: 'ms-as-s'` is how every other time chart in this product
           * reconciles the two (`RatesChart`, `UsersChart`, `ErrorsChart`,
           * `PercentilesChart`, `TelemetryCharts`, `TimeBrush` — twelve axes,
           * twelve declarations). This one was the only exception, and it named
           * its axis `Elapsed (ms)` rather than converting, which made the
           * mismatch honest about the ticks and silent about the table.
           *
           * ELAPSED ALWAYS, wrapped in `ElapsedOnly`: five runs have five wall
           * clocks and no single anchor, so this axis never takes the viewer's
           * Datetime mode. Gatling Enterprise's comparison does the same. */
          /* ═══ THE AXIS SPANS THE LONGEST RUN, WHATEVER THE WINDOW ═══
           *
           * The overlay's figures are read for the window, so its own data
           * covers only that slice. Left to auto-scale, the slider's extent
           * would shrink to the slice under the handles and no gesture could
           * widen it again — `TimeBrush` solves the same problem by drawing
           * the whole run in its strip. Pinning the domain to `[0, extent]`
           * keeps the map whole while the territory narrows. */
          xAxis={
            ranged
              ? { type: 'value', tickUnit: 'ms-as-s', min: 0, max: extentMs }
              : { type: 'value', tickUnit: 'ms-as-s' }
          }
          yAxis={{ name: label }}
          unit={compareUnit(metric)}
          brush={ranged ? { value: window, onChange: control.drag } : undefined}
        />
      </ElapsedOnly>

      {/* THE SLIDER IS POINTER-ONLY, so the same window is typed here — the
          keyboard path, and the exact one (`Chart`'s `brush` docstring). */}
      {ranged && <WindowFields window={window} extentMs={extentMs} control={control} />}
    </div>
  );
}

/**
 * From/To in seconds, Apply, and Whole run — the markup only. What each one
 * does is `useWindowControl`'s, shared with `TimeBrush`, so the two windows
 * cannot come to behave differently.
 */
function WindowFields({
  window,
  extentMs,
  control,
}: {
  readonly window: Window | null;
  readonly extentMs: number;
  readonly control: WindowControl;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const { from, to, editFrom, editTo, rangeError: error, apply, navigate } = control;

  return (
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-[0.75rem] text-muted">
          From (s)
        </label>
        <input
          id={fromId}
          data-testid="compare-window-from"
          inputMode="numeric"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          value={from}
          onChange={(e) => editFrom(e.target.value)}
          placeholder="0"
          className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-[0.75rem] text-muted">
          To (s)
        </label>
        <input
          id={toId}
          data-testid="compare-window-to"
          inputMode="numeric"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          value={to}
          onChange={(e) => editTo(e.target.value)}
          placeholder={asSeconds(extentMs)}
          className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
        />
      </div>
      <button
        type="button"
        onClick={apply}
        data-testid="compare-window-apply"
        className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
      >
        Apply window
      </button>
      {window !== null && (
        <button
          type="button"
          onClick={() => navigate(null)}
          data-testid="compare-window-clear"
          className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
        >
          Whole run
        </button>
      )}
      {/* Rendered only with something to say, so the page gains no empty live
          region — the rule `TimeBrush` follows for the same message. */}
      {error !== null && (
        <p id={errorId} role="alert" className="text-[0.75rem] text-primary">
          {error}
        </p>
      )}
    </div>
  );
}
