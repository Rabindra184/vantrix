import { describe, expect, it } from 'vitest';
import { GLANCE_DAYS, glanceDays, resolveTimeZone } from '../src/activity/days.js';

/**
 * The home page's seven-day glance counts runs per LOCAL calendar day, and
 * the boundaries between those days are computed here, in Node, with `Intl`
 * rather than in Postgres: the database's zone data and the process's can
 * disagree about a rule that changed recently, and the day a reader sees in
 * the browser has to be the day the server counted.
 *
 * Every instant below was measured with Node 22 before this file was
 * written. Expectations are written as UTC instants and not derived from the
 * function under test, so a wrong answer cannot agree with itself.
 */

/** The local calendar date (YYYY-MM-DD) of an instant in a zone, read independently of days.ts. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe('the constants', () => {
  // There is no attention-window constant any more: the window starts at
  // `boundaries[0]` (activity.integration.test.ts pins that), so a week is
  // spelled once, as seven glance days.
  it('is a seven-day glance', () => {
    expect(GLANCE_DAYS).toBe(7);
  });
});

describe('resolveTimeZone', () => {
  it('treats a missing or blank zone as UTC', () => {
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone('  ')).toBe('UTC');
  });

  it('echoes an accepted zone as sent', () => {
    expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('does not rewrite an accepted zone to its canonical name', () => {
    // ICU canonicalises Asia/Kolkata to Asia/Calcutta; a response naming a
    // zone the caller never sent reads as a bug.
    expect(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata' }).resolvedOptions().timeZone).not.toBe(
      'Asia/Kolkata',
    );
    expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('trims the zone it echoes', () => {
    expect(resolveTimeZone('  Europe/London ')).toBe('Europe/London');
  });

  it('refuses a zone Intl does not know, with a remediation naming a real one', () => {
    let thrown: unknown;
    try {
      resolveTimeZone('Mars/Base');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const problem = thrown as Error & { code?: string; remediation?: string };
    expect(problem.code).toBe('INVALID_TIMEZONE');
    expect(problem.message).toBe('"Mars/Base" is not a time zone this server recognises.');
    expect(problem.remediation).toContain('Europe/London');
  });
});

describe('glanceDays', () => {
  it('gives a daylight-saving day its 25 hours', () => {
    // New York falls back at 02:00 EDT on the first Sunday of November,
    // 2026-11-01. The window below starts on it, so its first day is the
    // 25-hour one.
    const { dates, boundaries } = glanceDays('America/New_York', new Date('2026-11-07T20:00:00Z'));

    expect(dates).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
    expect(boundaries).toHaveLength(8);
    expect(boundaries[0]?.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(boundaries[1]?.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(boundaries[7]?.toISOString()).toBe('2026-11-08T05:00:00.000Z');

    const gaps = boundaries.slice(1).map((b, i) => b.getTime() - (boundaries[i] as Date).getTime());
    expect(gaps[0]).toBe(25 * HOUR_MS);
    expect(gaps.slice(1)).toEqual([DAY_MS, DAY_MS, DAY_MS, DAY_MS, DAY_MS, DAY_MS]);
  });

  it('starts a day whose midnight is skipped at its first real instant', () => {
    // Chile springs forward at 00:00 on 2026-09-06, so that day has no 00:00:
    // the clock goes 23:59:59 on the 5th straight to 01:00 on the 6th. The
    // naive two-pass offset reads the day's midnight as 03:00Z, which is
    // 23:00 on the 5th locally.
    const { dates, boundaries } = glanceDays('America/Santiago', new Date('2026-09-06T15:00:00Z'));

    expect(dates[6]).toBe('2026-09-06');
    expect(boundaries[6]?.toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });

  it.each([
    // PAST transitions, not future ones: a rule a government has not yet
    // applied is a prediction the next tzdata release is free to change, and
    // a case pinned to one would turn red with no code change. Both were read
    // off Node 22's ICU (tzdata 2025b): the millisecond before is 23:59 on the
    // day before, and the instant below is 01:00.
    //
    // Cuba sprang forward at 00:00 on 2024-03-10: 00:00 CST never happened,
    // and 01:00 CDT (UTC-4) is 05:00Z.
    ['America/Havana', '2024-03-10', '2024-03-10T05:00:00.000Z'],
    // The Azores sprang forward at 00:00 (UTC-1) to 01:00 (UTC+0) on
    // 2024-03-31, at 01:00Z.
    ['Atlantic/Azores', '2024-03-31', '2024-03-31T01:00:00.000Z'],
  ])('skips a midnight in %s on %s the same way, so the fix is not Chile’s alone', (zone, day, first) => {
    const { dates, boundaries } = glanceDays(zone, new Date(`${day}T20:00:00Z`));

    expect(dates[6]).toBe(day);
    expect(boundaries[6]?.toISOString()).toBe(first);
  });

  it('starts a day whose midnight is read twice at the first reading', () => {
    // Jordan fell back at 01:00 EEST (UTC+3) to 00:00 EET (UTC+2) on
    // 2021-10-29, so 00:00-01:00 happened twice: 21:00Z-22:00Z and then
    // 22:00Z-23:00Z. The day starts at the first of them, and the offset read
    // at the day's UTC midnight lands on the second.
    const { dates, boundaries } = glanceDays('Asia/Amman', new Date('2021-10-29T12:00:00Z'));

    expect(dates[6]).toBe('2021-10-29');
    expect(boundaries[6]?.toISOString()).toBe('2021-10-28T21:00:00.000Z');
    expect(boundaries[7]?.toISOString()).toBe('2021-10-29T22:00:00.000Z');
  });

  it('gives a calendar day that never happened no length at all', () => {
    // Samoa skipped 2011-12-30 entirely, crossing the date line. No instant
    // has that local date, so its boundary is the first instant of the 31st
    // and the day is empty; it is not pushed back to the 29th.
    const { dates, boundaries } = glanceDays('Pacific/Apia', new Date('2011-12-30T20:00:00Z'));

    expect(dates[5]).toBe('2011-12-30');
    expect(dates[6]).toBe('2011-12-31');
    expect(boundaries[5]?.toISOString()).toBe('2011-12-30T10:00:00.000Z');
    expect(boundaries[6]?.toISOString()).toBe('2011-12-30T10:00:00.000Z');
  });

  it('ends the window at the first instant of the day after today', () => {
    const { dates, boundaries } = glanceDays('UTC', new Date('2026-10-06T13:45:10.250Z'));

    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-09-30');
    expect(dates[6]).toBe('2026-10-06');
    expect(boundaries[0]?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(boundaries[7]?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('reads today in the viewer’s zone, not in UTC', () => {
    // 20:00Z on the 6th is already the 7th in Kolkata (UTC+5:30).
    const { dates, boundaries } = glanceDays('Asia/Kolkata', new Date('2026-10-06T20:00:00Z'));

    expect(dates[6]).toBe('2026-10-07');
    expect(boundaries[6]?.toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(boundaries[7]?.toISOString()).toBe('2026-10-07T18:30:00.000Z');
  });

  it('is exact on the boundary instant itself', () => {
    // The first instant of a local day belongs to that day, not the one before.
    const { dates } = glanceDays('UTC', new Date('2026-10-07T00:00:00.000Z'));
    expect(dates[6]).toBe('2026-10-07');

    const justBefore = glanceDays('UTC', new Date('2026-10-06T23:59:59.999Z'));
    expect(justBefore.dates[6]).toBe('2026-10-06');
  });

  it('crosses a month and a year without losing a day', () => {
    const { dates } = glanceDays('UTC', new Date('2027-01-03T12:00:00Z'));
    expect(dates).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  it.each([
    ['UTC', '2026-10-06T13:45:00Z'],
    ['Asia/Kolkata', '2026-10-06T20:00:00Z'],
    ['America/New_York', '2026-11-07T20:00:00Z'],
    ['America/Santiago', '2026-09-06T15:00:00Z'],
  ])('puts every boundary on its own date in %s', (zone, nowIso) => {
    const { dates, boundaries } = glanceDays(zone, new Date(nowIso));

    expect(dates).toHaveLength(GLANCE_DAYS);
    expect(boundaries).toHaveLength(GLANCE_DAYS + 1);

    for (let i = 0; i < GLANCE_DAYS; i += 1) {
      const start = boundaries[i] as Date;
      // The boundary is the FIRST instant of its date: it is on the date, and
      // the millisecond before it is on the date before.
      expect(localDate(start, zone), `boundaries[${i}] in ${zone}`).toBe(dates[i]);
      const before = localDate(new Date(start.getTime() - 1), zone);
      expect(before, `1 ms before boundaries[${i}] in ${zone}`).not.toBe(dates[i]);
      if (i > 0) expect(before, `1 ms before boundaries[${i}] in ${zone}`).toBe(dates[i - 1]);
    }

    // The closing boundary starts the day after today, and today contains now.
    const closing = boundaries[GLANCE_DAYS] as Date;
    expect(localDate(closing, zone)).not.toBe(dates[GLANCE_DAYS - 1]);
    expect(localDate(new Date(closing.getTime() - 1), zone)).toBe(dates[GLANCE_DAYS - 1]);
    const now = new Date(nowIso);
    expect(boundaries[GLANCE_DAYS - 1]?.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime()).toBeLessThan(closing.getTime());
  });
});
