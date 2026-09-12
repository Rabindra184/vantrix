import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Window } from '@perfportal/contracts';
import Chart from './Chart';
import { seriesQuery } from '../api/metrics';
import { RATE_ROLES, toRequestRate } from './transforms/rates';

/**
 * The run's time window: a scrubber over the whole run, plus exact fields.
 *
 * ═══ THE STRIP ALWAYS SHOWS THE WHOLE RUN ═══
 *
 * `seriesQuery(..., null)` — never the current window. If the strip narrowed
 * with the selection, a reader would be brushing the very thing they brush
 * with: each drag would shrink the axis under the handles and there would be
 * no gesture that widens it again. The strip is the map, not the territory.
 *
 * It also means this fetch shares its cache key with the unwindowed series the
 * rest of the page may already hold, so the strip usually costs nothing.
 *
 * ═══ THE FIELDS ARE NOT A FALLBACK, THEY ARE THE KEYBOARD PATH ═══
 *
 * ECharts' dataZoom is pointer-only: no focus, no arrow keys, nothing a screen
 * reader can operate. A scrubber alone would make the window mouse-exclusive,
 * so the two fields below select the same thing precisely and are the reason
 * this control is usable without a mouse at all.
 *
 * ═══ ONE DRAG IS ONE NAVIGATION ═══
 *
 * `datazoom` fires on every frame of a drag. Committing each frame would mean
 * a URL entry and six refetches per pixel; the range is held and written once
 * the drag settles.
 */
const SETTLE_MS = 250;

export default function TimeBrush({
  runId,
  runDurationMs,
  window,
  applied,
  onChange,
}: {
  readonly runId: string;
  readonly runDurationMs: number;
  readonly window: Window | null;
  /** The snapped window a response reported, when one has arrived. */
  readonly applied?: Window | null;
  readonly onChange: (next: Window | null) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();

  /** Set when `apply` refuses; cleared by a valid apply, and by any change to
   *  the selection itself so a stale complaint never outlives its input. */
  const [rangeError, setRangeError] = useState<string | null>(null);

  // THE WHOLE RUN, deliberately unwindowed — see the docstring.
  const series = useQuery(seriesQuery(runId, 'run', '', 'response_time', null));

  const asSeconds = (ms: number): string => String(Math.round(ms / 1000));
  const [from, setFrom] = useState(() => (window ? asSeconds(window.fromMs) : ''));
  const [to, setTo] = useState(() => (window ? asSeconds(window.toMs) : ''));

  // The URL is the source of truth, so a back button or a pasted link moves the
  // fields rather than leaving them describing a window no longer selected.
  useEffect(() => {
    setFrom(window ? asSeconds(window.fromMs) : '');
    setTo(window ? asSeconds(window.toMs) : '');
    setRangeError(null);
  }, [window]);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);

  const commit = (fromMs: number, toMs: number): void => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      // A drag covering the whole extent is a request for the whole run, not a
      // window that happens to match it — so the URL loses its parameters
      // rather than pinning a range that would then not follow a re-ingest.
      if (fromMs <= 0 && toMs >= runDurationMs) onChange(null);
      else onChange({ fromMs, toMs: Math.min(toMs, runDurationMs), bucketWidthMs: 0 });
    }, SETTLE_MS);
  };

  const apply = (): void => {
    const parse = (raw: string, fallback: number): number | null => {
      if (raw.trim() === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
    };
    const fromMs = parse(from, 0);
    const toMs = parse(to, runDurationMs);

    /* ═══ AN INVALID RANGE IS REFUSED, NEVER WIDENED ═══
     *
     * This used to answer every unparseable, negative or reversed input with
     * `onChange(null)` — which is not a neutral failure, it is the signal for
     * "the whole run". So a reader who typed From=30 To=10, a plain mistake,
     * got a SILENTLY BROADER scope than the one they already had: every
     * figure on the page then described more data than they believed they had
     * selected, with nothing on screen saying so. Of all the responses to bad
     * input, a reset is the one this control must never produce.
     *
     * Refusing leaves the previous window standing, which is the other half:
     * `window` does not change, so the sync effect above does not fire, so the
     * reader's typing stays put and the mistake can be corrected in place.
     *
     * Widening on purpose is still one click away — the "Whole run" button is
     * the deliberate path, and `TimeBrush.test.tsx` pins that it survives. */
    if (fromMs === null || toMs === null) {
      setRangeError('Enter the window as seconds — for example 10 and 30.');
      return;
    }
    if (fromMs >= toMs) {
      setRangeError('End must be later than start.');
      return;
    }

    setRangeError(null);
    onChange({ fromMs, toMs: Math.min(toMs, runDurationMs), bucketWidthMs: 0 });
  };

  // Requests/s: the densest, most continuous view of a run's shape, which
  // is what a reader is aiming at when they drag.
  //
  // `{ x: 'ms' }` IS LOAD-BEARING, not a formatting choice. The slider below
  // reports its handles in the x axis' own units and `commit` writes those
  // straight to the URL as milliseconds; the category form's scalars made
  // those units RATES, so the strip drew requests/s against requests/s and a
  // drag across the first third of this run committed `?from=0&to=7`.
  const rates = series.data ? toRequestRate(series.data, { x: 'ms' }) : null;

  return (
    <section
      aria-label="Time window"
      data-testid="time-brush"
      className="flex flex-col gap-3 rounded border border-default bg-surface p-3"
    >
      {rates !== null && (
        <Chart
          id="time-window"
          // NAMES THE MEASURE, not the control. "Time window" is what the
          // surrounding section does; this figure draws requests per second,
          // and a title that described the interaction left the strip as the
          // one chart on the page whose y values were unexplained. "whole run"
          // because it deliberately never narrows with the selection (see the
          // docstring) — without that, the strip and the windowed
          // requests-per-second chart below it look like the same measure
          // disagreeing.
          title="Requests per second, whole run"
          /* ═══ A NAVIGATOR, NOT A FIGURE ═══
           *
           * This drew at the full 288px plot height, so the strip plus its
           * header, legend, slider and fields came to ~460px of chrome ABOVE
           * every tab's content — measured at 1440x900, it was what kept the
           * run's own totals at y=1570. A control for choosing a stretch of
           * time does not need to be the largest thing on the page.
           *
           * `navigator`, NOT `compact`. `compact` is the sparkline mode and
           * strips the axis labels with everything else — measured, that broke
           * `TimeBrush.test.tsx`'s "labels that axis in seconds" outright, and
           * rightly: a control you DRAG with no time labels gives the reader no
           * idea where they are. `navigator` keeps the axis and drops only the
           * legend, whose All/OK/KO the chart below already names.
           */
          navigator
          data={rates}
          kind="line"
          // The app-wide status colours — see `RATE_ROLES`. WITHOUT THIS the
          // strip fell back to the categorical palette and drew All/OK/KO as
          // indigo/teal/violet, while `RatesChart` drew the very same three
          // series as neutral/green/red directly below it: one page, one set
          // of series, two colour languages, and a KO line in a hue that
          // `rates.ts` explicitly reserves for "not an outcome".
          roles={RATE_ROLES}
          // A VALUE AXIS: the slider reports its handles in the axis' own
          // units, and this axis is elapsed milliseconds — which is what the
          // URL and every metric endpoint speak. `tickUnit` relabels those
          // ticks in seconds WITHOUT touching the units underneath, so the
          // strip agrees with its own From/To fields and with every other
          // chart on the page.
          xAxis={{ type: 'value', name: 'Elapsed (s)', tickUnit: 'ms-as-s' }}
          unit="/s"
          brush={{
            value: window,
            onChange: commit,
          }}
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={fromId} className="text-[12px] text-muted">
            From (s)
          </label>
          <input
            id={fromId}
            data-testid="window-from"
            inputMode="numeric"
            aria-invalid={rangeError === null ? undefined : true}
            aria-describedby={rangeError === null ? undefined : errorId}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="0"
            className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={toId} className="text-[12px] text-muted">
            To (s)
          </label>
          <input
            id={toId}
            data-testid="window-to"
            inputMode="numeric"
            aria-invalid={rangeError === null ? undefined : true}
            aria-describedby={rangeError === null ? undefined : errorId}
            value={to}
            onChange={(e) => setTo(e.target.value)}
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
            onClick={() => onChange(null)}
            data-testid="window-clear"
            className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
          >
            Whole run
          </button>
        )}

        {/* `role="alert"` because this is a response to the reader's own
            action and nothing else on the page moves to signal it — the
            figures deliberately do NOT change, which is the whole point of
            refusing. Rendered only when there is something to say, so this
            component never contributes an empty live region to a page that
            already mounts several charts. */}
        {rangeError !== null && (
          <p
            id={errorId}
            role="alert"
            data-testid="window-error"
            className="w-full text-[12px]"
            /* `var()`, not a `text-status-failed` utility: the status tokens
               are declared on `:root` rather than inside `@theme inline`, so
               Tailwind generates NO class for them and that spelling emits
               nothing at all, silently. `StatTile` and `RunList` reference
               them this way for the same reason. */
            style={{ color: 'var(--color-status-failed)' }}
          >
            {rangeError}
          </p>
        )}

        {/* THE SNAPPED RANGE, not the dragged one. `role="status"` so a screen
            reader is told the figures now describe a different stretch — the
            numbers change without anything else moving on screen. */}
        {applied != null && (
          <p role="status" data-testid="window-applied" className="text-[12px] text-muted">
            Showing {Math.round(applied.fromMs / 1000)}s–{Math.round(applied.toMs / 1000)}s,
            snapped to {applied.bucketWidthMs}ms buckets
          </p>
        )}
      </div>
    </section>
  );
}
