import { useEffect, useId, useState } from 'react';
import type { Window } from '@perfportal/contracts';

/**
 * The run's time window, as a control above every figure on the page.
 *
 * ═══ WHAT THIS IS NOT, YET ═══
 *
 * Gatling's is a DRAG SCRUBBER over the request timeline. This is a pair of
 * bounds and two buttons. The difference is deliberate rather than an
 * oversight: `Chart` has no `dataZoom` support, so a drag brush means
 * extending the chart core — and the one place a brush must never live is
 * inside a chart's `<figure>`, where nine specs count SVG elements to prove a
 * chart drew. The scrubber is the remaining polish; the window it selects, and
 * everything downstream of it, is complete.
 *
 * ═══ SECONDS IN, MILLISECONDS OUT ═══
 *
 * A reader thinks in seconds — the axes are labelled in them — and the API
 * frame is milliseconds. Converting here keeps every URL and every request in
 * one unit.
 *
 * ═══ IT REPORTS WHAT THE SERVER COMPUTED, NOT WHAT WAS TYPED ═══
 *
 * The window snaps outward to bucket boundaries, so `applied` (from the
 * response) can be wider than the request. Showing the typed range would claim
 * a precision the numbers underneath do not have.
 */
export default function TimeBrush({
  runDurationMs,
  window,
  applied,
  onChange,
}: {
  readonly runDurationMs: number;
  readonly window: Window | null;
  /** The snapped window a response reported, when one has arrived. */
  readonly applied?: Window | null;
  readonly onChange: (next: Window | null) => void;
}) {
  const fromId = useId();
  const toId = useId();

  const asSeconds = (ms: number): string => String(Math.round(ms / 1000));
  const [from, setFrom] = useState(() => (window ? asSeconds(window.fromMs) : ''));
  const [to, setTo] = useState(() => (window ? asSeconds(window.toMs) : ''));

  // The URL is the source of truth, so a back button or a pasted link moves
  // the inputs rather than leaving them describing a window that is no longer
  // selected.
  useEffect(() => {
    setFrom(window ? asSeconds(window.fromMs) : '');
    setTo(window ? asSeconds(window.toMs) : '');
  }, [window]);

  const apply = (): void => {
    const parse = (raw: string, fallback: number): number | null => {
      if (raw.trim() === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
    };
    const fromMs = parse(from, 0);
    const toMs = parse(to, runDurationMs);
    // A range that makes no sense clears the window instead of sending
    // something the API would reject — the page stays readable either way.
    if (fromMs === null || toMs === null || fromMs >= toMs) {
      onChange(null);
      return;
    }
    onChange({ fromMs, toMs: Math.min(toMs, runDurationMs), bucketWidthMs: 0 });
  };

  return (
    <section
      aria-label="Time window"
      data-testid="time-brush"
      className="flex flex-wrap items-end gap-3 rounded border border-default bg-surface p-3"
    >
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

      {/* THE SNAPPED RANGE, not the typed one. `role="status"` so a screen
          reader is told the figures now describe a different stretch — the
          numbers change without anything moving on screen otherwise. */}
      {applied != null && (
        <p role="status" data-testid="window-applied" className="text-[12px] text-muted">
          Showing {Math.round(applied.fromMs / 1000)}s–{Math.round(applied.toMs / 1000)}s,
          snapped to {applied.bucketWidthMs}ms buckets
        </p>
      )}
    </section>
  );
}
