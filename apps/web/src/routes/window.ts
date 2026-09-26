import type { Window } from '@perfportal/contracts';

/**
 * `?from=&to=` — the run's time window, in the URL rather than component state.
 *
 * The same argument `?runs=` makes on the Compare page: a window someone
 * selected is a thing they paste into a review comment or a ticket, and state
 * that lives only in a component cannot be pasted.
 *
 * ═══ VALIDATED, NEVER TRUSTED, AND NEVER THROWS ═══
 *
 * `safeNext`'s stance applied to another parameter. The reader asked to see a
 * run; a malformed query string is no reason to refuse them one. Anything that
 * does not parse falls back to the whole run — the honest default, and not an
 * error page over a mangled URL.
 *
 * `bucketWidthMs` is 0 here and the client never reads it. Only the SERVER can
 * know the width, because only the server knows how far the engine coalesced
 * this run; it reports the snapped window in every response and the header
 * renders that.
 */
export function parseWindow(
  from: string | null,
  to: string | null,
  runDurationMs: number,
): Window | null {
  if (from === null && to === null) return null;

  const bound = (raw: string | null, fallback: number): number | null => {
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const fromMs = bound(from, 0);
  const toMs = bound(to, runDurationMs);
  if (fromMs === null || toMs === null) return null;

  // Clamped to the run, so the page never asks the API for time that does not
  // exist — and an inverted range falls back to the whole run rather than
  // 400ing every figure on the page at once.
  const clampedTo = Math.min(toMs, runDurationMs);
  if (fromMs >= clampedTo) return null;
  return { fromMs, toMs: clampedTo, bucketWidthMs: 0 };
}

/** The inverse, for writing a selection back to the URL. */
export const serialiseWindow = (w: Window | null): { from?: string; to?: string } =>
  w === null ? {} : { from: String(w.fromMs), to: String(w.toMs) };

/** A stretch of the run in elapsed milliseconds, `[fromMs, toMs)`. */
export interface Span {
  readonly fromMs: number;
  readonly toMs: number;
}

export type WindowStep =
  | 'fast-backward'
  | 'backward'
  | 'zoom-out'
  | 'zoom-in'
  | 'forward'
  | 'fast-forward';

/**
 * Gatling Enterprise's six navigator controls, in its order and named with its
 * words. Each button's accessible name and tooltip is its `label`.
 */
export const WINDOW_STEPS: readonly { readonly step: WindowStep; readonly label: string }[] = [
  { step: 'fast-backward', label: 'Fast backward' },
  { step: 'backward', label: 'Backward' },
  { step: 'zoom-out', label: 'Zoom out' },
  { step: 'zoom-in', label: 'Zoom in' },
  { step: 'forward', label: 'Forward' },
  { step: 'fast-forward', label: 'Fast forward' },
];

/**
 * Gatling Enterprise's range presets, spelled as it spells them, its mixed
 * capitals included. Measured back from the run's END: a finished run's "last
 * five minutes" are its final five. `null` is the whole run.
 */
export const WINDOW_PRESETS: readonly { readonly label: string; readonly spanMs: number | null }[] = [
  { label: 'Last 5 Minutes', spanMs: 5 * 60_000 },
  { label: 'Last 15 Minutes', spanMs: 15 * 60_000 },
  { label: 'Last 30 Minutes', spanMs: 30 * 60_000 },
  { label: 'Last 1 hour', spanMs: 60 * 60_000 },
  { label: 'Last 1 day', spanMs: 24 * 60 * 60_000 },
  { label: 'Everything', spanMs: null },
];

/**
 * One bound, snapped the way every step's result is.
 *
 * AN END OF THE RUN IS KEPT EXACTLY. Rounding the run's own span to the
 * resolution would drop its last partial bucket (63,161 ms rounds to 63,000),
 * and a window stepped to the end would quietly stop short of it. Every other
 * bound lands on the nearest multiple of the resolution, which is what makes
 * each one a whole second in Gatling Enterprise's own measurements.
 */
export function snapBound(ms: number, runMs: number, resolutionMs: number): number {
  if (ms <= 0) return 0;
  if (ms >= runMs) return runMs;
  return Math.min(runMs, Math.round(ms / resolutionMs) * resolutionMs);
}

/**
 * A span covering the whole run is the whole run: no window at all.
 *
 * EXPORTED BECAUSE EVERY CONTROL HAS TO AGREE ON IT. The steps and presets
 * here, a drag in `TimeBrush.commit`, and Apply all end in this one rule, so
 * the whole run keeps an empty URL (spec deviation B) whichever control
 * reached it, and a shared link follows a re-ingested run.
 */
export function asWindow(fromMs: number, toMs: number, runMs: number): Window | null {
  return fromMs <= 0 && toMs >= runMs ? null : { fromMs, toMs, bucketWidthMs: 0 };
}

/**
 * The window one of the six controls moves to, from `current`.
 *
 * MEASURED ON GATLING ENTERPRISE, not designed (the spec's table):
 *
 *   zoom in                       each edge inward by 25% of the width
 *   zoom out                      each edge outward by 25%, CUT at the ends
 *   backward, forward             20% of the width, the width kept
 *   fast backward, fast forward   100% of the width, the width kept
 *
 * A pan that would leave the run SLIDES against the end and keeps its width;
 * a zoom that would leave it is cut. So zoom out is not zoom in's inverse:
 * in halves the width, out grows it by half. A result covering the whole run
 * is `null`, the rule `TimeBrush.commit` already applies to a drag.
 *
 * ═══ A NARROW WINDOW STILL MOVES: AT LEAST ONE BUCKET PER STEP ═══
 *
 * Gatling was measured at a two-minute width only. Each bound is snapped to
 * the resolution on its own, so below about two and a half buckets a 20% pan
 * or a 25% zoom out rounds back to where it began. Measured on a real 108.5 s
 * run at 1 s buckets: six Zoom ins reached `[54000, 55000]`, and Zoom out,
 * Backward and Forward then stayed enabled and changed nothing. So a pan
 * moves by the larger of its fraction of the width and one resolution, and
 * zoom out grows each edge by the larger of a quarter of the width and one
 * resolution. Wherever Gatling was measured the fraction is the larger, and
 * its figures are unchanged.
 *
 * ═══ AND NO STEP LANDS ON AN EMPTY WINDOW ═══
 *
 * After snapping, every bound is a bucket boundary — a multiple of the
 * resolution, or an end of the run — so a result holds at least one bucket
 * unless both bounds landed on the SAME boundary. A window narrower than a
 * bucket (typed decimals, a narrow drag, the run's last partial bucket) used
 * to do exactly that: From 30.1 To 30.4 stepped to `[30000, 30000]`, which
 * `TimeBrush` committed and `parseWindow` reads back as the WHOLE RUN, so a
 * step silently widened the view. An empty result becomes the bucket holding
 * its centre — zoom in's rule, now shared by all six — with the centre taken
 * BEFORE snapping, so a pan lands on the side it moved to.
 *
 * EMPTINESS, NOT A WIDTH BELOW THE RESOLUTION, is the test, because the run's
 * last bucket may be partial and is still one bucket. Replacing every result
 * under one resolution wide would swap that partial bucket for the one before
 * it, and Forward would move BACK: measured, `[1365, 2289]` on a 2,457 ms run
 * went to `[1000, 2000]` that way, where this rule gives `[2000, 2457]`.
 *
 * Expects `0 <= current.fromMs < current.toMs <= runMs`, which `parseWindow`
 * guarantees for every window it returns and the whole run satisfies.
 */
export function stepWindow(
  current: Span,
  step: WindowStep,
  runMs: number,
  resolutionMs: number,
): Window | null {
  const from = Math.max(0, current.fromMs);
  const to = Math.min(runMs, current.toMs);
  const width = to - from;

  /** Snaps both bounds; a stretch that snaps to nothing is the bucket
   *  holding its centre (see above). The run's last bucket may be partial,
   *  and that is still one bucket. */
  const settle = (a: number, b: number): Window | null => {
    const fromMs = snapBound(a, runMs, resolutionMs);
    const toMs = snapBound(b, runMs, resolutionMs);
    if (fromMs < toMs) return asWindow(fromMs, toMs, runMs);
    const bucket = Math.floor((a + b) / 2 / resolutionMs) * resolutionMs;
    return asWindow(bucket, Math.min(runMs, bucket + resolutionMs), runMs);
  };

  if (step === 'zoom-in') return settle(from + width / 4, to - width / 4);
  if (step === 'zoom-out') {
    const grow = Math.max(width / 4, resolutionMs);
    return settle(from - grow, to + grow);
  }

  const fraction = step === 'fast-backward' || step === 'fast-forward' ? 1 : 0.2;
  const direction = step === 'fast-backward' || step === 'backward' ? -1 : 1;
  const shift = direction * Math.max(fraction * width, resolutionMs);
  let a = from + shift;
  let b = to + shift;
  if (a < 0) {
    a = 0;
    b = width;
  }
  if (b > runMs) {
    b = runMs;
    a = runMs - width;
  }
  return settle(a, b);
}

/**
 * Whether a control can move `current` at all: the six buttons' disabled
 * state. Zoom in stops at one bucket; zoom out and every pan stop when the
 * whole run is selected; backward stops at the start, forward at the end.
 *
 * STATED AS RULES, not as "the step changes nothing": a window the reader
 * TYPED is off the resolution grid, and a step that is otherwise a no-op
 * would still nudge it by a snap, leaving a button that looks live and moves
 * a bound by 300 ms.
 *
 * AND EVERY STEP THESE RULES ALLOW MOVES THE WINDOW, because `stepWindow`
 * pans by at least one bucket and grows each edge by at least one: without
 * that floor, a window two buckets wide kept Backward and Forward live while
 * both snapped back to where they began. `window.test.ts` sweeps it over
 * windows, runs and resolutions.
 */
export function canStep(current: Span, step: WindowStep, runMs: number, resolutionMs: number): boolean {
  const from = Math.max(0, current.fromMs);
  const to = Math.min(runMs, current.toMs);
  switch (step) {
    case 'zoom-in':
      return to - from > resolutionMs;
    case 'zoom-out':
      return from > 0 || to < runMs;
    case 'backward':
    case 'fast-backward':
      return from > 0;
    case 'forward':
    case 'fast-forward':
      return to < runMs;
  }
}

/**
 * A preset's window: the final `spanMs` of the run. A preset at least as long
 * as the run is the whole run, which is Gatling's "Last 1 day" on a one-minute
 * test.
 */
export function presetWindow(spanMs: number | null, runMs: number, resolutionMs: number): Window | null {
  if (spanMs === null || spanMs >= runMs) return null;
  return asWindow(snapBound(runMs - spanMs, runMs, resolutionMs), runMs, runMs);
}

/*
 * `rangeSuffix` USED TO LIVE HERE AND IS NOW IN `../api/metricPaths`.
 *
 * Not a tidy-up. It builds a fragment of the API's query string, where
 * everything left in this file reads and writes the ROUTER's — two different
 * URLs that happen to carry the same two numbers. Putting it beside the
 * builders that consume it is what lets `metricPaths` import nothing at
 * runtime, which is in turn what lets `scripts/capture-chart-fixture.mjs`
 * import it under `node --experimental-strip-types` and stop spelling the
 * product's URLs a second time.
 */
