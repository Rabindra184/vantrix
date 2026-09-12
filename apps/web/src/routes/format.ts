/**
 * How this app renders an INSTANT to a human — one definition, for the same
 * reason `marks.tsx` holds one definition of the status glyphs.
 *
 * Both the run list and the run detail page carry a comment saying the two
 * screens must not disagree about when a run started, and both then held a
 * byte-identical private copy of this formatter. Two copies of a rule that
 * must not drift is the setup for the drift, not a defence against it: a
 * change to one screen's `dateStyle` would leave the other reading the same
 * instant differently, and nothing would fail. `ProjectSetup`'s token table
 * proved the point by arriving with a third copy — a bare `toLocaleString()`,
 * which is a different rendering again.
 *
 * Named for what it formats rather than for the run that first needed it:
 * a token's `createdAt` and a run's start are the same kind of value, and a
 * function called `formatStarted` in a token table reads as a mistake.
 */

/**
 * Formatted in the reader's own locale and time zone — a performance run's
 * start is read against the reader's day, not the server's.
 *
 * Nothing sorts or compares this string; the `datetime` attribute rendered
 * beside it (`<time dateTime={iso}>`) is the value that carries meaning to
 * machines, and it is the API's own ISO-8601 string, unmodified.
 *
 * Constructed once at module scope rather than per render: `Intl.DateTimeFormat`
 * is comparatively expensive to build, and a run list renders one per row.
 */
/**
 * A WALL TIME WITH NO ZONE IS TWO DIFFERENT FACTS.
 *
 * This rendered a local date and minute and stopped, so two engineers looking
 * at the same run saw different wall times and neither could tell. On an
 * incident call "it started at 14:03" then is not a shared statement.
 *
 * The zone is APPENDED, not converted to: a reader wants their own clock, plus
 * enough to say which clock it is. `timeStyle: 'short'` cannot carry a zone
 * name, so the parts are spelled out — the output is the same otherwise.
 */
const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function formatInstant(iso: string): string {
  return INSTANT_FORMAT.format(new Date(iso));
}

/**
 * Whole seconds, matching what Gatling's own run header shows (G-04).
 *
 * `Math.round`, not `Math.floor`: flooring reports a 1,900ms run as "1s",
 * which is wrong by nearly a second in the one direction a reader is least
 * likely to question. Rounding is wrong by at most half a second either way.
 *
 * `durationMs` is nullable in the contract — a run whose header the parser
 * never produced has no duration at all — and an explicit dash is the honest
 * rendering of that. `0s` would assert a measurement that was never taken,
 * and `NaNs` would assert nothing at all.
 */
/**
 * RAW SECONDS STOP SCANNING SOMEWHERE ABOVE A FEW MINUTES. A 63s run reads
 * fine as "63s"; a four-hour soak as "14400s" does not.
 *
 * TEN MINUTES IS A JUDGEMENT AND DELIBERATELY GENEROUS. Below it, seconds are
 * what every table and every existing expectation already reads, and churning
 * "62s" into "1m 2s" buys a reader nothing. Above it, the number has stopped
 * being a quantity anybody holds in their head.
 *
 * A zero component is omitted rather than printed: "2h" and not "2h 0m 0s".
 */
const LONG_RUN_MS = 10 * 60_000;

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) return '—';
  const seconds = Math.round(durationMs / 1000);
  if (durationMs < LONG_RUN_MS) return `${seconds}s`;

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return [h > 0 ? `${h}h` : null, m > 0 ? `${m}m` : null, sec > 0 ? `${sec}s` : null]
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * `Xm Ys` past a minute, `Xs` below it — the unit `SlaBanner` reads a
 * breaching rule's `sinceOffsetMs` in.
 *
 * Deliberately not `formatDuration`: that one is a run's OWN length,
 * matching Gatling's own header, and a bare seconds count is the right shape
 * for a number that tops out around the length of one run. This value is an
 * OFFSET into the run at which a breach began, which a reader is scanning
 * for "roughly how far in" rather than comparing to another duration —
 * `3722s` is not a shape most people subitize, `1h 2m 2s`'s sibling `1m 2s`
 * is.
 *
 * `Math.round`, matching `formatDuration`'s own reasoning: flooring is wrong
 * in the one direction a reader is least likely to question.
 */
export function formatOffset(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
