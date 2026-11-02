/**
 * ═══ HOW A FACT IS WRITTEN DOWN ═══
 *
 * Every fact's `display` comes from one of these, and from nothing else. The
 * model is told to cite a fact in its displayed form, and the number check
 * accepts exactly the renderings this module produces — so a second spelling
 * of "2,383 ms" anywhere in the package would be a number the check refuses
 * for a reason nobody could see.
 *
 * ═══ THE ROUNDING IS THE PAGE'S; THE GROUPING IS NOT, ON PURPOSE ═══
 *
 * Milliseconds round to whole numbers, as the statistics table writes them
 * (`StatisticsTable.formatMs`, after Gatling's own table); rates and
 * percentages take two decimals, as `% KO` and `Cnt/s` do; an elapsed offset
 * is the run page axis's floored `hh:mm:ss` clock. The page writes counts
 * ungrouped (`2383`) because its cells are compared against Gatling's report,
 * which writes them plain. A sentence is not a table cell — "1,724 requests"
 * is how prose carries a count — so the facts group thousands, and the number
 * check reads a separator as part of the number.
 *
 * `en-US` is named rather than left to the host: a fact rendered with a
 * German separator on one worker and an English one on another would be the
 * same fact two ways, and a stored analysis would stop matching its facts the
 * day the worker moved.
 */

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const TWO = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UP_TO_TWO = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** What a figure that is not a number reads as — the page's own dash. */
export const NOT_A_NUMBER = '—';

/** Whole milliseconds, thousands grouped: `2,383 ms`. Rounded, never floored. */
export function formatMs(n: number): string {
  return Number.isFinite(n) ? `${WHOLE.format(Math.round(n))} ms` : NOT_A_NUMBER;
}

/** A count, thousands grouped: `1,724`. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? WHOLE.format(Math.round(n)) : NOT_A_NUMBER;
}

/**
 * A FRACTION as a percentage to two decimals: `0.16763…` reads `16.76%`.
 *
 * The argument is the fraction because that is how `error_rate` is stored. A
 * fact's `value` carries the percentage (16.763…), because that is the number
 * a reader — and the model — writes in front of the `%`.
 */
export function formatPercent(fraction: number): string {
  return Number.isFinite(fraction) ? `${TWO.format(fraction * 100)}%` : NOT_A_NUMBER;
}

/** A per-second rate to two decimals: `18.95/s`. */
export function formatRate(n: number): string {
  return Number.isFinite(n) ? `${TWO.format(n)}/s` : NOT_A_NUMBER;
}

/**
 * A number with no unit of its own — an assertion target this package does
 * not know — to at most two decimals, thousands grouped: `1,234.5`.
 */
export function formatNumber(n: number): string {
  return Number.isFinite(n) ? UP_TO_TWO.format(n) : NOT_A_NUMBER;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * An offset into the run as `hh:mm:ss`, the run page axis's notation
 * (`formatElapsedClock` in the web app). FLOORED, like a clock — `00:01:28`
 * until the 89th second has begun — and the hours do not wrap: a 26-hour soak
 * reads `26:00:00`.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return NOT_A_NUMBER;
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/**
 * A run's own length, as the run header's Duration chip writes it
 * (`formatDuration` in the web app): whole seconds below ten minutes ("91s"),
 * `1h 2m 3s` above it, a zero component omitted.
 *
 * Added beside the four the plan names rather than bending one of them to
 * fit: "90,800 ms" is not how the page shows a duration, and `00:01:30` is
 * how it writes an OFFSET, which a duration is not.
 */
const LONG_RUN_MS = 10 * 60_000;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return NOT_A_NUMBER;
  const seconds = Math.round(ms / 1000);
  if (ms < LONG_RUN_MS) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h > 0 ? `${h}h` : null, m > 0 ? `${m}m` : null, s > 0 ? `${s}s` : null]
    .filter((part): part is string => part !== null)
    .join(' ');
}
