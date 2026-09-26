import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Window } from '@perfportal/contracts';
import Chart from './Chart';
import { seriesQuery } from '../api/metrics';
import { RATE_ROLES, toRequestRate } from './transforms/rates';
import { useTimeAxis } from './TimeAxisContext';
import {
  formatDuration,
  formatElapsedClock,
  formatInstantSeconds,
  formatZoneName,
  formatZoneOffset,
} from '../routes/format';
import {
  WINDOW_PRESETS,
  WINDOW_STEPS,
  asWindow,
  canStep,
  presetWindow,
  stepWindow,
  type Span,
  type WindowStep,
} from '../routes/window';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FastBackwardIcon,
  FastForwardIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../components/icons';

/**
 * The run's time window, after Gatling Enterprise's time controls: an
 * always-visible range with presets, the Offset/Datetime mode every
 * single-run axis follows, and a timeline holding the navigator strip, its
 * six zoom and pan controls, and the exact From/To fields.
 * (docs/superpowers/specs/2026-09-26-time-window-gatling-style-design.md)
 *
 * ═══ THE STRIP ALWAYS SHOWS THE WHOLE RUN ═══
 *
 * `seriesQuery(..., null)`, never the current window. If the strip narrowed
 * with the selection, a reader would be brushing the very thing they brush
 * with: each drag would shrink the axis under the handles and there would be
 * no gesture that widens it again. The strip is the map, not the territory.
 * It also shares its cache key with the unwindowed series the rest of the
 * page may already hold, so it usually costs nothing.
 *
 * ═══ THE FIELDS ARE NOT A FALLBACK, THEY ARE THE PRECISION PATH ═══
 *
 * ECharts' dataZoom is pointer-only, and six coarse steps cannot reach an
 * exact 30 s to 90 s. Gatling has no fields; this keeps them (the spec's
 * deviation C) because they are what makes the window usable without a mouse
 * and exact with one.
 *
 * ═══ ONE DRAG IS ONE NAVIGATION ═══
 *
 * `datazoom` fires on every frame of a drag. Committing each frame would mean
 * a URL entry and six refetches per pixel; the range is held and written once
 * the drag settles. A step, a preset or Whole run is one navigation too, and
 * cancels a drag still settling so the drag cannot land after it and undo it.
 * Apply deliberately does not; `apply` says why.
 */
const SETTLE_MS = 250;

const STEP_ICONS: Record<WindowStep, ComponentType<{ className?: string }>> = {
  'fast-backward': FastBackwardIcon,
  backward: ChevronLeftIcon,
  'zoom-out': ZoomOutIcon,
  'zoom-in': ZoomInIcon,
  forward: ChevronRightIcon,
  'fast-forward': FastForwardIcon,
};

/**
 * Both ends of a stretch and its width, as the range line writes them.
 *
 * ABSOLUTE WHENEVER THE RUN HAS AN ANCHOR, in either mode: Gatling
 * Enterprise's range line does not change with Offset or Datetime, which
 * relabel the AXES. Without an anchor there is no absolute time to write, so
 * the ends are elapsed clock time (deviation E).
 */
function describeSpan(span: Span, anchorMs: number | null) {
  const at = (offsetMs: number): string =>
    anchorMs === null ? formatElapsedClock(offsetMs) : formatInstantSeconds(anchorMs + offsetMs);
  return { start: at(span.fromMs), end: at(span.toMs), width: formatDuration(span.toMs - span.fromMs) };
}

export default function TimeBrush({
  runId,
  runDurationMs,
  runActivityMs,
  window,
  applied,
  onChange,
}: {
  readonly runId: string;
  readonly runDurationMs: number;
  /**
   * The span the run page labels "Duration" (`activityMs`), for the
   * navigator's own Duration. Absent, the series span stands in, the same
   * `activityMs ?? durationMs` `RunHeader` computes.
   */
  readonly runActivityMs?: number | null;
  readonly window: Window | null;
  /** The snapped window a response reported, when one has arrived. */
  readonly applied?: Window | null;
  readonly onChange: (next: Window | null) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const noAnchorId = useId();
  const { mode, anchorMs, setMode } = useTimeAxis();

  /** Set when `apply` refuses; cleared by a valid apply, and by any change to
   *  the selection itself so a stale complaint never outlives its input. */
  const [rangeError, setRangeError] = useState<string | null>(null);

  /* Open when the run is already narrowed, closed when it is not. The EFFECT
     keeps that true after the first render: the shell does not remount
     between tabs, so a window arriving from a URL would otherwise leave an
     active narrowing behind a closed timeline. It never closes the timeline
     on its own; that is the reader's to do. */
  const [open, setOpen] = useState(() => window !== null);
  useEffect(() => {
    if (window !== null) setOpen(true);
  }, [window]);

  // THE WHOLE RUN, deliberately unwindowed; see the docstring.
  const series = useQuery(seriesQuery(runId, 'run', '', 'response_time', null));

  /** The navigator's resolution: the width of the buckets it draws. Until they
   *  arrive it is unknown, and so is every step. */
  const resolutionMs = series.data?.bucketWidthMs ?? null;

  /**
   * WHERE A STEP STARTS: the window in the URL, or the whole run.
   *
   * NOT the snapped `applied` window the range line states. Its end is
   * `min(ceil(to / width) × width, last bucket + width)`, which can land a
   * bucket short of the run's end or past it, so every "at the end" decision
   * (is Forward live, where does a pan slide to) would be wrong by that
   * bucket.
   */
  const current: Span = window ?? { fromMs: 0, toMs: runDurationMs };

  /**
   * WHAT THE NUMBERS DESCRIBE: the snapped window once a response reports it,
   * the requested one until then, the whole run when neither, held to the
   * run itself because the snap can reach a bucket past its end. A window's
   * header states the range the numbers were computed over, never the one
   * that was dragged (`WindowSchema.bucketWidthMs`).
   */
  const shownWindow = applied ?? window;
  const range = describeSpan(
    {
      fromMs: Math.max(0, shownWindow?.fromMs ?? 0),
      toMs: Math.min(runDurationMs, shownWindow?.toMs ?? runDurationMs),
    },
    anchorMs,
  );
  const zoneLabel = anchorMs === null ? null : `${formatZoneName()} - ${formatZoneOffset(anchorMs)}`;

  const asSeconds = (ms: number): string => String(Math.round(ms / 1000));
  const [from, setFrom] = useState(() => (window ? asSeconds(window.fromMs) : ''));
  const [to, setTo] = useState(() => (window ? asSeconds(window.toMs) : ''));
  /* WHETHER THE READER HAS TYPED IN EACH FIELD since the URL last set it. The
     fields SHOW whole seconds, so a dragged 27,412 ms reads `27`; Apply keeps
     the exact bound for a field nobody touched rather than committing what it
     happens to display. Typing is the edit, not "reads differently":
     retyping the number already shown is how a reader asks for that whole
     second. */
  const [fromEdited, setFromEdited] = useState(false);
  const [toEdited, setToEdited] = useState(false);

  // The URL is the source of truth, so a back button or a pasted link moves the
  // fields rather than leaving them describing a window no longer selected —
  // and an edit made before it describes that old window too, so it goes.
  useEffect(() => {
    setFrom(window ? asSeconds(window.fromMs) : '');
    setTo(window ? asSeconds(window.toMs) : '');
    setFromEdited(false);
    setToEdited(false);
    setRangeError(null);
  }, [window]);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);
  const cancelSettle = (): void => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = null;
  };

  const commit = (fromMs: number, toMs: number): void => {
    cancelSettle();
    settle.current = setTimeout(() => {
      // A drag covering the whole extent is a request for the whole run, not a
      // window that happens to match it, so the URL loses its parameters
      // rather than pinning a range that would then not follow a re-ingest.
      onChange(asWindow(fromMs, Math.min(toMs, runDurationMs), runDurationMs));
    }, SETTLE_MS);
  };

  const step = (which: WindowStep): void => {
    if (resolutionMs === null) return;
    cancelSettle();
    onChange(stepWindow(current, which, runDurationMs, resolutionMs));
  };

  const choosePreset = (spanMs: number | null): void => {
    if (spanMs === null) {
      cancelSettle();
      onChange(null);
    } else if (resolutionMs !== null) {
      cancelSettle();
      onChange(presetWindow(spanMs, runDurationMs, resolutionMs));
    }
  };

  /**
   * Commits the From/To fields.
   *
   * ═══ IT DOES NOT CANCEL A SETTLING DRAG, DELIBERATELY ═══
   *
   * The fields follow the URL, so in the 250 ms a drag takes to settle they
   * still hold the window from BEFORE it. Cancelling here would commit those
   * numbers and throw the drag away; left alone, the drag lands a moment
   * later, as the reader made it. A step, a preset and Whole run read no
   * fields, which is why they can cancel and this cannot.
   *
   * ═══ IT COMMITS WHAT THE READER CHANGED, AND NOTHING ELSE ═══
   *
   * A field the reader has not typed in keeps the URL's exact bound (see
   * `fromEdited`), and a span covering the whole run commits no window at all
   * through `asWindow`, the rule a drag and every step already follow.
   */
  const apply = (): void => {
    const parse = (raw: string, fallback: number): number | null => {
      if (raw.trim() === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
    };
    const fromMs = window !== null && !fromEdited ? window.fromMs : parse(from, 0);
    /* THE RUN'S END, SHOWN ROUNDED, IS STILL THE RUN'S END. The fields show
       whole seconds, so a window ending at the run's 63,161 ms reads `63`,
       and applying it untouched committed 63,000: the run's last partial
       bucket, which `snapBound` keeps exactly and the steps now reach often,
       dropped by a button that changed nothing on screen. A To reading
       exactly what the run's end reads is the run's end. */
    const toMs =
      window !== null && !toEdited
        ? window.toMs
        : to.trim() === asSeconds(runDurationMs)
          ? runDurationMs
          : parse(to, runDurationMs);

    /* ═══ AN INVALID RANGE IS REFUSED, NEVER WIDENED ═══
     *
     * This used to answer every unparseable, negative or reversed input with
     * `onChange(null)`, which is not a neutral failure: it is the signal for
     * "the whole run". So a reader who typed From=30 To=10 got a SILENTLY
     * BROADER scope than the one they already had. Refusing leaves the
     * previous window standing, and `window` not changing keeps the reader's
     * typing in place so the mistake can be corrected. Widening on purpose is
     * still one click away: "Whole run", and the Everything preset. */
    if (fromMs === null || toMs === null) {
      setRangeError('Enter the window as seconds — for example 10 and 30.');
      return;
    }
    if (fromMs >= toMs) {
      setRangeError('End must be later than start.');
      return;
    }

    setRangeError(null);
    onChange(asWindow(fromMs, Math.min(toMs, runDurationMs), runDurationMs));
  };

  // Requests/s: the densest, most continuous view of a run's shape, which is
  // what a reader is aiming at when they drag.
  //
  // `{ x: 'ms' }` IS LOAD-BEARING, not a formatting choice. The slider reports
  // its handles in the x axis' own units and `commit` writes those straight to
  // the URL as milliseconds; the category form's scalars made those units
  // RATES, and a drag across the first third of this run committed
  // `?from=0&to=7`.
  const rates = series.data ? toRequestRate(series.data, { x: 'ms' }) : null;

  return (
    <section
      aria-label="Time window"
      data-testid="time-brush"
      className="rounded border border-default bg-surface"
    >
      {/* ═══ ALWAYS VISIBLE: WHICH STRETCH, AND WHICH CLOCK ═══
       *
       * The range line states the window from outside the timeline, so a
       * closed timeline never hides an active narrowing (review M01's safety
       * property), and it opens Gatling's presets. The mode beside it relabels
       * every single-run time axis; it is a reading preference and never
       * enters the URL. Neither sits inside the `<summary>` below, whose
       * descendants are presentational in the accessibility tree. */}
      <div className="flex flex-wrap items-center gap-2 p-3">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="window-range"
              aria-label={`Time range ${range.start} to ${range.end}, ${range.width}. Choose a preset`}
              className="transition-ui inline-flex max-w-full items-center gap-2 rounded border border-default bg-surface px-2 py-1 text-left text-[0.75rem] text-primary hover:bg-sunken data-[state=open]:bg-sunken"
            >
              <span className="min-w-0">
                {range.start} → {range.end}
              </span>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-default" />
              <span className="shrink-0 tabular-nums">{range.width}</span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {WINDOW_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.label}
                disabled={preset.spanMs !== null && resolutionMs === null}
                onSelect={() => choosePreset(preset.spanMs)}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <select
          data-testid="time-axis-mode"
          aria-label="Time axis"
          // THE REASON DATETIME IS OFF IS THE CONTROL'S DESCRIPTION, so a
          // screen reader meets it on the select rather than as a stray
          // paragraph after it. Present only while the reason is rendered,
          // so it never points at nothing.
          aria-describedby={anchorMs === null ? noAnchorId : undefined}
          // A run with no anchor reads elapsed whatever was chosen, so the
          // control says so rather than showing a choice it cannot honour.
          value={anchorMs === null ? 'offset' : mode}
          onChange={(event) => setMode(event.target.value === 'datetime' ? 'datetime' : 'offset')}
          className="rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
        >
          <option value="offset">Offset</option>
          <option value="datetime" disabled={anchorMs === null}>
            {zoneLabel === null ? 'Datetime' : `Datetime (${zoneLabel})`}
          </option>
        </select>

        {anchorMs === null && (
          <p id={noAnchorId} data-testid="time-axis-no-anchor" className="text-[0.75rem] text-muted">
            Datetime needs the time this run started, which it did not record.
          </p>
        )}
      </div>

      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="group"
      >
        <summary
          data-testid="time-window-toggle"
          className="flex cursor-pointer list-none items-center gap-2 px-3 pb-3 text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2"
        >
          <span className="group-open:hidden">Timeline</span>
          <span className="hidden group-open:inline">Hide timeline</span>
          {/* "Whole run" stays load-bearing (review M01): it tells a reader the
              numbers below are the run's own before they open anything. */}
          {window === null && <span className="font-normal text-muted">· whole run</span>}
        </summary>

        <div className="flex flex-col gap-3 p-3 pt-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex gap-4 text-[0.75rem] text-muted">
              <span data-testid="window-resolution">
                Resolution: {resolutionMs === null ? '—' : formatDuration(resolutionMs)}
              </span>
              <span data-testid="window-duration">
                Duration: {formatDuration(runActivityMs ?? runDurationMs)}
              </span>
            </p>
            <div role="group" aria-label="Move the window" className="flex gap-1">
              {WINDOW_STEPS.map(({ step: which, label }) => {
                const Icon = STEP_ICONS[which];
                return (
                  <button
                    key={which}
                    type="button"
                    data-testid={`window-step-${which}`}
                    aria-label={label}
                    title={label}
                    disabled={
                      resolutionMs === null || !canStep(current, which, runDurationMs, resolutionMs)
                    }
                    onClick={() => step(which)}
                    className="transition-ui inline-flex h-7 w-7 items-center justify-center rounded border border-default bg-surface text-primary hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {rates !== null && (
            <Chart
              id="time-window"
              // NAMES THE MEASURE, not the control; "whole run" because the
              // strip never narrows with the selection (see the docstring).
              title="Requests per second, whole run"
              // A NAVIGATOR, NOT A FIGURE: axes kept so a reader can see where
              // they are dragging, the legend dropped because the chart below
              // names the same All/OK/KO.
              navigator
              data={rates}
              kind="line"
              // The app-wide status colours; without them the strip drew
              // All/OK/KO in the categorical palette, disagreeing with
              // `RatesChart` directly below.
              roles={RATE_ROLES}
              // A VALUE AXIS in elapsed milliseconds, which is what the slider
              // reports and the URL speaks. `Chart` labels it as clock time and
              // names it from the time mode.
              xAxis={{ type: 'value', tickUnit: 'ms-as-s' }}
              unit="/s"
              brush={{
                value: window,
                onChange: commit,
              }}
            />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={fromId} className="text-[0.75rem] text-muted">
                From (s)
              </label>
              <input
                id={fromId}
                data-testid="window-from"
                inputMode="numeric"
                aria-invalid={rangeError === null ? undefined : true}
                aria-describedby={rangeError === null ? undefined : errorId}
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
                data-testid="window-to"
                inputMode="numeric"
                aria-invalid={rangeError === null ? undefined : true}
                aria-describedby={rangeError === null ? undefined : errorId}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setToEdited(true);
                }}
                placeholder={asSeconds(runDurationMs)}
                className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
              />
            </div>

            <button
              type="button"
              onClick={apply}
              data-testid="window-apply"
              className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
            >
              Apply window
            </button>

            {window !== null && (
              <button
                type="button"
                onClick={() => {
                  cancelSettle();
                  onChange(null);
                }}
                data-testid="window-clear"
                className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
              >
                Whole run
              </button>
            )}

            {/* `role="alert"`: a response to the reader's own action, and the
                figures deliberately do NOT move to signal it. Rendered only
                when there is something to say, so this never contributes an
                empty live region to a page that already mounts several. */}
            {rangeError !== null && (
              <p
                id={errorId}
                role="alert"
                data-testid="window-error"
                className="w-full text-[0.75rem]"
                /* `var()`, not a `text-status-failed` utility: the status
                   tokens are declared on `:root` rather than inside
                   `@theme inline`, so that spelling emits nothing at all. */
                style={{ color: 'var(--color-status-failed)' }}
              >
                {rangeError}
              </p>
            )}

            {/* THE SNAPPED RANGE, announced: `role="status"` so a screen
                reader is told the figures now describe a different stretch,
                in the same words the range line above uses. */}
            {applied != null && (
              <p role="status" data-testid="window-applied" className="text-[0.75rem] text-muted">
                Showing {range.start} → {range.end}, snapped to{' '}
                {formatDuration(applied.bucketWidthMs)} buckets
              </p>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
