import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Window } from '@perfportal/contracts';
import Chart from './Chart';
import { seriesQuery } from '../api/metrics';
import { toRequestRate } from './transforms/rates';

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
    // A range that makes no sense clears the window rather than sending
    // something the API would reject — the page stays readable either way.
    if (fromMs === null || toMs === null || fromMs >= toMs) {
      onChange(null);
      return;
    }
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
          title="Time window"
          data={rates}
          kind="line"
          // A VALUE AXIS: the slider reports its handles in the axis' own
          // units, and this axis is elapsed milliseconds — which is what the
          // URL and every metric endpoint speak.
          xAxis={{ type: 'value', name: 'Elapsed (ms)' }}
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
