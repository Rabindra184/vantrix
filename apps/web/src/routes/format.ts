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
const INSTANT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, INSTANT_OPTIONS);

export function formatInstant(iso: string): string {
  return INSTANT_FORMAT.format(new Date(iso));
}

/**
 * `formatInstant` to the SECOND, for the ends of a time window.
 *
 * `formatInstant` stops at the minute, so both ends of a 30-second window
 * would read identically. Same locale, same zone name, same date style, so
 * the run header and the window's range line never write one instant two
 * ways.
 *
 * BUILT PER CALL, NOT AT MODULE SCOPE, and that is a measurement: a
 * module-scope `Intl.DateTimeFormat` resolves the zone once, at import, and
 * one built under TZ=UTC kept printing UTC after the zone was switched to
 * Asia/Kolkata. A zone-pinned test could not be written against it. The range
 * line calls this twice per render.
 */
export function formatInstantSeconds(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { ...INSTANT_OPTIONS, second: '2-digit' }).format(
    epochMs,
  );
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * An offset into a run as `HH:MM:SS`, the notation Gatling Enterprise's Offset
 * mode ticks an axis in.
 *
 * FLOORED, like a clock: `00:00:42` until the 43rd second has begun. The
 * wall-clock twin below floors too, reading the date's own fields, so the two
 * modes never disagree about which second a point is in.
 *
 * THE HOURS ARE NOT WRAPPED. A 26-hour soak reads `26:00:00`, not `02:00:00`.
 */
export function formatElapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/**
 * An instant as `HH:MM:SS` on the reader's own 24-hour clock, Datetime mode's
 * tick notation. The date is not repeated per tick; the range line above the
 * charts carries it.
 *
 * FROM THE DATE'S OWN FIELDS, not `Intl`: they follow the zone the page is in
 * at the moment of the call, and cost nothing in an axis formatter that
 * ECharts calls once per tick per redraw.
 */
export function formatClockTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/**
 * The reader's UTC offset AT A GIVEN INSTANT, spelled as `Intl` spells a short
 * offset: `GMT+5:30`, `GMT-4`, `GMT`.
 *
 * AT AN INSTANT, NOT NOW. A run recorded in New York in July is GMT-4 when it
 * is read in January, and labelling its axis GMT-5 would put every tick an
 * hour out. Callers pass the run's own start.
 */
export function formatZoneOffset(epochMs: number): string {
  const minutes = -new Date(epochMs).getTimezoneOffset();
  if (minutes === 0) return 'GMT';
  const sign = minutes > 0 ? '+' : '-';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `GMT${sign}${h}${m === 0 ? '' : `:${two(m)}`}`;
}

/** The reader's IANA zone as the browser names it, e.g. `Asia/Calcutta`. */
export function formatZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
