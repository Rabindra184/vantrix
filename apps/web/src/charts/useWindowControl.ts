import { useEffect, useRef, useState } from 'react';
import type { Window } from '@perfportal/contracts';
import { asWindow } from '../routes/window';

/**
 * THE TIME-WINDOW CONTROL'S BEHAVIOUR, ONCE, for every chart that offers one.
 *
 * A dragged slider, typed From/To fields with Apply, and one-click navigations
 * (Whole run, and on the run page the steps and presets). `TimeBrush` drew
 * these first; Compare's overlay drew them again by copying `TimeBrush`'s code,
 * and the copy drifted in the one place that matters — it routed Apply through
 * the cancel a navigation makes, so a drag followed by Apply inside the settle
 * window committed the PRE-drag fields and lost the drag. One implementation,
 * both callers, and the two rules below are no longer each caller's to keep.
 *
 * Each caller keeps its own markup, which is all that genuinely differs.
 */

/**
 * How long a drag has to rest before it is committed.
 *
 * ═══ ONE DRAG IS ONE NAVIGATION ═══
 *
 * `datazoom` fires on every frame of a drag. Committing each frame would mean
 * a URL entry and a refetch of every figure per pixel; the range is held and
 * written once the drag settles.
 */
export const SETTLE_MS = 250;

/** A bound as the fields show it: whole seconds. */
export const asSeconds = (ms: number): string => String(Math.round(ms / 1000));

export interface WindowControl {
  readonly from: string;
  readonly to: string;
  /** The reader typed in From / To. Marks the field edited (see `apply`). */
  readonly editFrom: (value: string) => void;
  readonly editTo: (value: string) => void;
  /** Set when `apply` refuses; cleared by a valid apply, and by any change to
   *  the selection itself so a stale complaint never outlives its input. */
  readonly rangeError: string | null;
  /** Commits the fields. Does NOT cancel a settling drag — see below. */
  readonly apply: () => void;
  /** The slider's handler, `Chart`'s `brush.onChange`: commits once the drag rests. */
  readonly drag: (fromMs: number, toMs: number) => void;
  /**
   * A one-click navigation — Whole run, a step, a preset. It reads no fields,
   * so it CANCELS a drag still settling: the drag must not land after it and
   * undo it.
   */
  readonly navigate: (next: Window | null) => void;
}

export function useWindowControl({
  window,
  extentMs,
  onChange,
}: {
  /** The window in the URL, `null` for the whole extent. */
  readonly window: Window | null;
  /** The span a window lives in: the run, or on Compare the longest selected run. */
  readonly extentMs: number;
  readonly onChange: (next: Window | null) => void;
}): WindowControl {
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
  const [rangeError, setRangeError] = useState<string | null>(null);

  // The URL is the source of truth, so a back button or a pasted link moves the
  // fields rather than leaving them describing a window no longer selected —
  // and an edit made before it describes that old window too, so it goes.
  // Keyed on the OBJECT, so a caller must hand a stable one (`useRunWindow`
  // and `RunCompare` both memoise it): a fresh object per render would wipe
  // the reader's typing on each one.
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

  const drag = (fromMs: number, toMs: number): void => {
    cancelSettle();
    settle.current = setTimeout(() => {
      // A drag covering the whole extent is a request for the whole run, not a
      // window that happens to match it, so the URL loses its parameters
      // rather than pinning a range that would then not follow a re-ingest.
      onChange(asWindow(fromMs, Math.min(toMs, extentMs), extentMs));
    }, SETTLE_MS);
  };

  const navigate = (next: Window | null): void => {
    cancelSettle();
    onChange(next);
  };

  /**
   * Commits the From/To fields.
   *
   * ═══ IT DOES NOT CANCEL A SETTLING DRAG, DELIBERATELY ═══
   *
   * The fields follow the URL, so in the 250 ms a drag takes to settle they
   * still hold the window from BEFORE it. Cancelling here would commit those
   * numbers and throw the drag away; left alone, the drag lands a moment
   * later, as the reader made it. A navigation reads no fields, which is why
   * it can cancel and this cannot.
   *
   * ═══ IT COMMITS WHAT THE READER CHANGED, AND NOTHING ELSE ═══
   *
   * A field the reader has not typed in keeps the URL's exact bound (see
   * `fromEdited`), and a span covering the whole extent commits no window at
   * all through `asWindow`, the rule a drag and every step already follow.
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
       exactly what the extent's end reads is the extent's end. */
    const toMs =
      window !== null && !toEdited
        ? window.toMs
        : to.trim() === asSeconds(extentMs)
          ? extentMs
          : parse(to, extentMs);

    /* ═══ AN INVALID RANGE IS REFUSED, NEVER WIDENED ═══
     *
     * This used to answer every unparseable, negative or reversed input with
     * `onChange(null)`, which is not a neutral failure: it is the signal for
     * "the whole run". So a reader who typed From=30 To=10 got a SILENTLY
     * BROADER scope than the one they already had. Refusing leaves the
     * previous window standing, and `window` not changing keeps the reader's
     * typing in place so the mistake can be corrected. Widening on purpose is
     * still one click away. */
    if (fromMs === null || toMs === null) {
      setRangeError('Enter the window as seconds — for example 10 and 30.');
      return;
    }
    if (fromMs >= toMs) {
      setRangeError('End must be later than start.');
      return;
    }

    setRangeError(null);
    onChange(asWindow(fromMs, Math.min(toMs, extentMs), extentMs));
  };

  return {
    from,
    to,
    editFrom: (value) => {
      setFrom(value);
      setFromEdited(true);
    },
    editTo: (value) => {
      setTo(value);
      setToEdited(true);
    },
    rangeError,
    apply,
    drag,
    navigate,
  };
}
