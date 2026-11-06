/**
 * ═══ WHEN A PUBLIC LINK STOPS WORKING, CHOSEN IN THE READER'S OWN CALENDAR ═══
 *
 * Every link expires (spec 4.1; there is no "never"), and the share dialog
 * offers six spans and a date (spec 6.4). Each span is CALENDAR arithmetic in
 * the reader's zone — a week is seven days on the wall clock, a month is the
 * next calendar month — because "expires in a month" read on the 6th means the
 * 6th, not thirty 24-hour days that land on the 5th or the 7th. A custom date
 * is the end of that day where the reader is: a link "until the 25th" works
 * all through the 25th.
 *
 * The browser computes the instant and the server judges it, against its own
 * clock (`publicLinkExpiryProblem`): strictly more than a minute ahead and at
 * most 732 days. Two years from any day is at most 731 days, and the custom
 * bounds below keep the end of the furthest date inside 732, so nothing this
 * module produces is a value the server refuses.
 */

export type ExpiryPreset = '1w' | '2w' | '1m' | '6m' | '1y' | '2y' | 'custom';

/** The choices, in the order the select offers them, in words. */
export const EXPIRY_PRESETS: readonly { readonly value: ExpiryPreset; readonly label: string }[] = [
  { value: '1w', label: '1 week' },
  { value: '2w', label: '2 weeks' },
  { value: '1m', label: '1 month' },
  { value: '6m', label: '6 months' },
  { value: '1y', label: '1 year' },
  { value: '2y', label: '2 years' },
  { value: 'custom', label: 'Custom' },
];

/** Each span as calendar days and calendar months; `custom` has none. */
const SPANS: Readonly<Record<Exclude<ExpiryPreset, 'custom'>, { readonly days: number; readonly months: number }>> = {
  '1w': { days: 7, months: 0 },
  '2w': { days: 14, months: 0 },
  '1m': { days: 0, months: 1 },
  '6m': { days: 0, months: 6 },
  '1y': { days: 0, months: 12 },
  '2y': { days: 0, months: 24 },
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant a link chosen at `now` expires.
 *
 * A MONTH IS `Date#setMonth`'s, overflow included: one month from 31 January
 * is 3 March in a common year (February 31st, carried over). There is no right
 * answer to "a month from the 31st"; this is the one the calendar gives, and
 * the dialog's "This link will expire on …" states the instant it lands on
 * before anything is created.
 *
 * `customDate` is a `yyyy-mm-dd` the reader chose, read as the LAST
 * millisecond of that day in their zone. It is optional because only `custom`
 * reads it; a missing one, or one that is not a real day (`2026-02-30`), is an
 * Invalid Date — never a guess — which the dialog treats as "nothing chosen".
 * `now` is never changed.
 */
export function expiryFor(preset: ExpiryPreset, now: Date, customDate?: string): Date {
  if (preset === 'custom') return endOfLocalDay(customDate);
  const { days, months } = SPANS[preset];
  const at = new Date(now.getTime());
  if (days !== 0) at.setDate(at.getDate() + days);
  if (months !== 0) at.setMonth(at.getMonth() + months);
  return at;
}

/**
 * The dates a custom expiry may be, as the date input's `min` and `max`, both
 * `yyyy-mm-dd` in the reader's zone (Review Focus 5).
 *
 * `min` IS TOMORROW. Today's end can be under the server's one-minute lead
 * late in the evening, and a link that dies tonight is what a span is for.
 * `max` is today two years on — the furthest preset's date, so the furthest
 * end of day stays inside the server's 732 days even across a leap day.
 */
export function customDateBounds(now: Date): { readonly min: string; readonly max: string } {
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const max = new Date(now.getTime());
  max.setMonth(max.getMonth() + 24);
  return { min: localDate(tomorrow), max: localDate(max) };
}

/** A local date as `yyyy-mm-dd`, the date input's own format. */
function localDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 23:59:59.999 on `value`'s day, in the reader's zone — or an Invalid Date
 *  for anything that is not a real `yyyy-mm-dd`. The round trip refuses a day
 *  the `Date` constructor would quietly carry into the next month. */
function endOfLocalDay(value: string | undefined): Date {
  const match = value === undefined ? null : DATE.exec(value);
  if (match === null) return new Date(Number.NaN);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(year, month - 1, day, 23, 59, 59, 999);
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day
    ? at
    : new Date(Number.NaN);
}
