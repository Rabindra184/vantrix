import { badRequest } from '../common/validation.js';

/** How many local calendar days the home page's glance draws, today included. */
export const GLANCE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * `tz` as the home page's query takes it: absent or blank is UTC, a zone
 * `Intl` knows is accepted and echoed AS SENT, and anything else is a 400.
 *
 * AS SENT, NOT AS ICU SPELLS IT. `resolvedOptions().timeZone` canonicalises
 * (`Asia/Kolkata` comes back `Asia/Calcutta`), and a response naming a zone
 * the caller never sent reads as a bug on the other side of the wire. The
 * constructor is only asked whether it accepts the name.
 *
 * The question is put to `Intl` and not to Postgres on purpose: the day
 * boundaries below are computed with `Intl` too, so the zone the server
 * accepts is exactly the zone it can count days in.
 */
export function resolveTimeZone(raw: string | undefined): string {
  const zone = raw?.trim() ?? '';
  if (zone === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw badRequest(
      'INVALID_TIMEZONE',
      `"${zone}" is not a time zone this server recognises.`,
      'Send an IANA time zone name such as Europe/London, or leave "tz" out for UTC.',
    );
  }
  return zone;
}

/**
 * The seven local calendar days in `tz` ending today, and the eight instants
 * that fence them, for the glance to bucket runs by. The first of them is also
 * where the attention window starts (`ActivityController`): one window for
 * every number the home page shows, so a run is in the glance, the pass rate
 * and the attention list together or in none of them.
 *
 * `dates` are `YYYY-MM-DD`, oldest first, the last being today in `tz`.
 * `boundaries[i]` is the FIRST instant whose local date in `tz` is
 * `dates[i]`, and `boundaries[7]` is the first instant of the day after
 * today, so a run arriving at `t` counts in day `i` when
 * `boundaries[i] <= t < boundaries[i + 1]`. Every day is therefore as long as
 * that zone's day really was: 23 hours across a spring-forward, 25 across a
 * fall-back.
 *
 * ═══ WHY NODE AND NOT POSTGRES ═══
 *
 * The browser draws these days with its own `Intl`, so the server counts with
 * `Intl` as well. Postgres carries its own copy of the zone database, and two
 * copies disagree whenever a zone's rule changed recently and one of them has
 * not been updated yet; a run counted on Tuesday by the server and drawn on
 * Wednesday by the browser is the defect the glance exists to avoid.
 *
 * ═══ A LOCAL MIDNIGHT CAN BE SKIPPED, OR TAKEN TWICE ═══
 *
 * The obvious algorithm reads the zone's offset near the day's UTC midnight
 * and subtracts it, twice to settle on a rule change. It is right on nearly
 * every day and wrong on the one that matters: Chile springs forward at
 * 00:00, so 2026-09-06 has no 00:00 at all and the naive answer,
 * `2026-09-06T03:00:00Z`, is 23:00 on the 5th. The first instant of the 6th
 * is `04:00:00Z`, local 01:00. And a zone that falls back across midnight
 * can read a local 00:00 twice, in which case the first reading is the one
 * the day starts at. So the offset answer is only a CANDIDATE: it is kept
 * when it is demonstrably the first instant of its date, and otherwise the
 * date's real first instant is searched for. A date that never happened at
 * all (Samoa skipped 2011-12-30) has no first instant of its own, so its
 * boundary is the first instant of the next date and the day is empty.
 *
 * Formatters are built here, per call. A module-scope `Intl.DateTimeFormat`
 * freezes its zone at import and cannot be pinned by a test.
 */
export function glanceDays(
  tz: string,
  now: Date,
): { readonly dates: string[]; readonly boundaries: Date[] } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // `h23`, not `hour12: false`: the latter prints midnight as "24" on some
    // ICU builds, which would read as the end of the day before.
    hourCycle: 'h23',
  });

  /** An instant's wall-clock fields in `tz`, as the UTC instant that has the same digits. */
  const wallAsUtc = (ms: number): number => {
    const p: Record<string, number> = {};
    for (const part of parts.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    }
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  };

  const localDate = (ms: number): string => new Date(wallAsUtc(ms)).toISOString().slice(0, 10);

  /** The zone's offset from UTC at an instant, in ms; whole seconds, which is all `Intl` reports. */
  const offsetAt = (ms: number): number => wallAsUtc(ms) - Math.floor(ms / 1000) * 1000;

  const firstInstantOf = (date: string): Date => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const midnightAsUtc = Date.UTC(y, m - 1, d);
    // Read the offset where the answer is expected, not where the digits are,
    // and once more at that answer in case a rule changed between the two.
    const first = midnightAsUtc - offsetAt(midnightAsUtc);
    const candidate = midnightAsUtc - offsetAt(first);

    const onOrAfter = (ms: number): boolean => localDate(ms) >= date;
    if (onOrAfter(candidate) && !onOrAfter(candidate - 1)) return new Date(candidate);

    // The candidate is not the date's first instant: its midnight was skipped
    // (the candidate is still on the day before), or read twice (an earlier
    // instant is on the date already). Local dates never go backwards across
    // one such transition, so the first instant on or after the date is the
    // one where the answer to `onOrAfter` flips, and it is within a day or two
    // of the candidate. `YYYY-MM-DD` compares correctly as a string.
    let lo = candidate - 2 * DAY_MS;
    let hi = candidate + 2 * DAY_MS;
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (onOrAfter(mid)) hi = mid;
      else lo = mid;
    }
    return new Date(hi);
  };

  const today = localDate(now.getTime());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const dayAt = (daysFromToday: number): string =>
    new Date(Date.UTC(y, m - 1, d + daysFromToday)).toISOString().slice(0, 10);

  const dates: string[] = [];
  for (let i = GLANCE_DAYS - 1; i >= 0; i -= 1) dates.push(dayAt(-i));

  const boundaries = [...dates, dayAt(1)].map(firstInstantOf);
  return { dates, boundaries };
}
