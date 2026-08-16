/**
 * One run, named at minute resolution, for an axis tick or a legend entry.
 *
 * ═══ ONE COPY, BECAUSE THERE WERE TWO AND THEY DRIFTED ═══
 *
 * The trends axis and the compare legend each had their own `new Date(at)
 * .toISOString().slice(5, 16).replace('T', ' ')`. Identical, independent, and
 * on the same screen — the Trends tab draws the axis, and its "Compare these
 * runs" link leads straight to the legend. Fixing the zone in one would have
 * left the other reading differently for the same run, which is the failure
 * this file exists to make impossible rather than merely unlikely.
 *
 * ═══ THE READER'S ZONE ═══
 *
 * Local, like `routes/format.ts`'s `formatStarted` — the run header and the
 * run list already render instants in the viewer's own zone. Sliced out of an
 * ISO string these read in UTC, so an Asia/Kolkata reader saw a run labelled
 * `08-07 05:30` on an axis sitting directly below a header that called the
 * same instant `Aug 7, 2026, 11:00 AM`. A reader placing runs against their
 * own working day needs the local reading, and two clocks on one page is
 * worse than either.
 *
 * ═══ NOT `Intl`, UNLIKE `formatStarted` ═══
 *
 * This string is an ECharts SERIES NAME and a matrix column key, so its shape
 * carries weight a caption's does not: `compareLabels` decides collisions by
 * string equality, and a locale-dependent rendering would vary that — and the
 * column headers — by whose machine rendered them. `en-US`'s
 * `08/07, 11:00 AM` is also nearly twice as wide under an axis tick with
 * twenty of them side by side. Fixed `MM-DD HH:mm`, local components, in
 * every locale.
 *
 * SHORT ON PURPOSE: the full timestamp goes in each chart's data table, which
 * is where a reader identifies a specific point and the screen-reader route to
 * the same information.
 */
export function runMinuteLabel(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  // The LOCAL accessors. Their UTC counterparts are what the ISO-slicing this
  // replaced read through.
  return (
    `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
