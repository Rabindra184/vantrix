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
