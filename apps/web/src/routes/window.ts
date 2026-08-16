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

/**
 * `''` for the whole run, `?from=&to=` otherwise.
 *
 * Always BOTH bounds. Each is meaningful alone on the wire, but a client that
 * knows both and sends one is only creating a chance to send the wrong one.
 */
export const rangeSuffix = (w: Window | null, join = '?'): string =>
  w === null ? '' : `${join}from=${w.fromMs}&to=${w.toMs}`;
