/**
 * How this app renders a run's start time — one definition, for the same
 * reason `marks.tsx` holds one definition of the status glyphs.
 *
 * Both the run list and the run detail page carry a comment saying the two
 * screens must not disagree about when a run started, and both then held a
 * byte-identical private copy of this formatter. Two copies of a rule that
 * must not drift is the setup for the drift, not a defence against it: a
 * change to one screen's `dateStyle` would leave the other reading the same
 * instant differently, and nothing would fail.
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
const STARTED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatStarted(iso: string): string {
  return STARTED_FORMAT.format(new Date(iso));
}
