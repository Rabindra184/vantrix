import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Window } from '@perfportal/contracts';
import { asWindow } from '../routes/window';
import Chart from './Chart';
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
/**
 * How long a drag has to rest before it is written to the URL — `TimeBrush`'s
 * figure, for its reason: `datazoom` fires on every frame of a drag, and each
 * write here refetches every selected run's figures.
 */
const SETTLE_MS = 250;

export default function CompareChart({
  runs,
  metric,
  onMetricChange,
  window,
  extentMs,
  onWindow,
}: {
  readonly runs: readonly CompareRun[];
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
  const data = useMemo(() => toCompare(runs, metric), [runs, metric]);

  /* ═══ ONE DRAG IS ONE NAVIGATION ═══
   *
   * The slider reports its range on every frame; the range is held and written
   * once the drag rests. A span covering the whole extent is the whole run
   * (`asWindow`), so the URL loses its parameters rather than pinning a range
   * that equals no window at all. */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current !== null) clearTimeout(settle.current);
    },
    [],
  );
  const onBrush = (fromMs: number, toMs: number): void => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      onWindow(asWindow(fromMs, Math.min(toMs, extentMs), extentMs));
    }, SETTLE_MS);
  };
  /** A typed window or Whole run is one navigation too, and must not be undone
   *  by a drag still settling. */
  const commit = (next: Window | null): void => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = null;
    onWindow(next);
  };
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
          brush={ranged ? { value: window, onChange: onBrush } : undefined}
        />
      </ElapsedOnly>

      {/* THE SLIDER IS POINTER-ONLY, so the same window is typed here — the
          keyboard path, and the exact one (`Chart`'s `brush` docstring). */}
      {ranged && <WindowFields window={window} extentMs={extentMs} onCommit={commit} />}
    </div>
  );
}

const asSeconds = (ms: number): string => String(Math.round(ms / 1000));

/**
 * From/To in seconds, Apply, and Whole run — `TimeBrush`'s fields, for the
 * comparison's extent rather than one run's.
 *
 * ═══ IT COMMITS WHAT THE READER CHANGED, AND NOTHING ELSE ═══
 *
 * The fields SHOW whole seconds, so a dragged 27,412 ms reads `27`; a field
 * nobody typed in keeps the URL's exact bound rather than committing what it
 * displays. And a To reading exactly what the extent reads IS the extent.
 *
 * ═══ AN INVALID RANGE IS REFUSED, NEVER WIDENED ═══
 *
 * `null` means every run whole, so answering a reversed or unparseable range
 * with it would silently broaden the reader's scope. It is refused, and the
 * previous window stands.
 */
function WindowFields({
  window,
  extentMs,
  onCommit,
}: {
  readonly window: Window | null;
  readonly extentMs: number;
  readonly onCommit: (window: Window | null) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const [from, setFrom] = useState(() => (window ? asSeconds(window.fromMs) : ''));
  const [to, setTo] = useState(() => (window ? asSeconds(window.toMs) : ''));
  const [fromEdited, setFromEdited] = useState(false);
  const [toEdited, setToEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The URL is the source of truth, so a back button or a drag moves the
     fields. Keyed on the BOUNDS, not the object: the page parses the window
     afresh every render, and an object dependency would wipe the reader's
     typing on each one. */
  const fromMs = window?.fromMs ?? null;
  const toMs = window?.toMs ?? null;
  useEffect(() => {
    setFrom(fromMs === null ? '' : asSeconds(fromMs));
    setTo(toMs === null ? '' : asSeconds(toMs));
    setFromEdited(false);
    setToEdited(false);
    setError(null);
  }, [fromMs, toMs]);

  const apply = (): void => {
    const parse = (raw: string, fallback: number): number | null => {
      if (raw.trim() === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
    };
    const start = window !== null && !fromEdited ? window.fromMs : parse(from, 0);
    const end =
      window !== null && !toEdited
        ? window.toMs
        : to.trim() === asSeconds(extentMs)
          ? extentMs
          : parse(to, extentMs);
    if (start === null || end === null) {
      setError('Enter the window as seconds — for example 10 and 30.');
      return;
    }
    if (start >= end) {
      setError('End must be later than start.');
      return;
    }
    setError(null);
    onCommit(asWindow(start, Math.min(end, extentMs), extentMs));
  };

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
          onChange={(e) => {
            setFrom(e.target.value);
            setFromEdited(true);
          }}
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
          onChange={(e) => {
            setTo(e.target.value);
            setToEdited(true);
          }}
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
          onClick={() => onCommit(null)}
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
