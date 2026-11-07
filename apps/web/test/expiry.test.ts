import { describe, expect, it } from 'vitest';
import { PUBLIC_LINK_MAX_EXPIRY_DAYS, publicLinkExpiryProblem } from '@perfportal/contracts';
import { EXPIRY_PRESETS, customDateBounds, expiryFor } from '../src/routes/share/expiry';

const DAY_MS = 86_400_000;

/**
 * A link's expiry, chosen in the reader's own calendar (spec 6.4).
 *
 * Every instant here is built with the LOCAL `Date` constructor, never from an
 * ISO string, so each case says the same thing in whichever zone the suite runs
 * in: a preset is calendar arithmetic in the reader's zone, and a custom date
 * is the end of that day where the reader is.
 */
describe('EXPIRY_PRESETS', () => {
  it('offers the six spans and Custom, in order, in words', () => {
    expect(EXPIRY_PRESETS.map((preset) => [preset.value, preset.label])).toEqual([
      ['1w', '1 week'],
      ['2w', '2 weeks'],
      ['1m', '1 month'],
      ['6m', '6 months'],
      ['1y', '1 year'],
      ['2y', '2 years'],
      ['custom', 'Custom'],
    ]);
  });
});

describe('expiryFor', () => {
  const NOW = new Date(2026, 10, 6, 15, 30, 0, 0);

  it('counts weeks in calendar days and keeps the time of day', () => {
    expect(expiryFor('1w', NOW)).toEqual(new Date(2026, 10, 13, 15, 30, 0, 0));
    expect(expiryFor('2w', NOW)).toEqual(new Date(2026, 10, 20, 15, 30, 0, 0));
  });

  it('counts months and years as calendar months', () => {
    expect(expiryFor('1m', NOW)).toEqual(new Date(2026, 11, 6, 15, 30, 0, 0));
    expect(expiryFor('6m', NOW)).toEqual(new Date(2027, 4, 6, 15, 30, 0, 0));
    expect(expiryFor('1y', NOW)).toEqual(new Date(2027, 10, 6, 15, 30, 0, 0));
    expect(expiryFor('2y', NOW)).toEqual(new Date(2028, 10, 6, 15, 30, 0, 0));
  });

  /**
   * "One month from 31 January" has no right answer, so the one this gives is
   * pinned rather than argued: `Date#setMonth` overflows February 31st into
   * March, and in 2027 (not a leap year) that is 3 March.
   */
  it('lets one month from 31 January overflow February, as setMonth does', () => {
    expect(expiryFor('1m', new Date(2027, 0, 31, 10, 0, 0, 0))).toEqual(new Date(2027, 2, 3, 10, 0, 0, 0));
  });

  it('never moves the instant it was given', () => {
    const now = new Date(NOW.getTime());
    expiryFor('2y', now);
    expect(now).toEqual(NOW);
  });

  /** The server refuses anything further than 732 days ahead. */
  it('puts two years from today at most 732 days away', () => {
    const now = new Date();
    const lead = expiryFor('2y', now).getTime() - now.getTime();
    expect(lead).toBeLessThanOrEqual(PUBLIC_LINK_MAX_EXPIRY_DAYS * DAY_MS);
    expect(lead).toBeGreaterThan(729 * DAY_MS);
    // From a leap day, where the calendar is least kind.
    const leap = new Date(2028, 1, 29, 12, 0, 0, 0);
    expect(expiryFor('2y', leap).getTime() - leap.getTime()).toBeLessThanOrEqual(
      PUBLIC_LINK_MAX_EXPIRY_DAYS * DAY_MS,
    );
  });

  it('ends a custom date at the last millisecond of that day, in the reader’s zone', () => {
    expect(expiryFor('custom', NOW, '2026-12-25')).toEqual(new Date(2026, 11, 25, 23, 59, 59, 999));
  });

  it('answers an Invalid Date for a custom date that is missing or not a day', () => {
    for (const value of [undefined, '', '2026-02-30', '2026-13-01', '25/12/2026', '2026-12-25T00:00']) {
      expect(Number.isNaN(expiryFor('custom', NOW, value).getTime()), String(value)).toBe(true);
    }
  });

  /** What the browser computes, the server must accept: every preset, now. */
  it('gives the server an expiry it accepts, for every preset', () => {
    const now = new Date();
    for (const { value } of EXPIRY_PRESETS.filter((preset) => preset.value !== 'custom')) {
      expect(publicLinkExpiryProblem(expiryFor(value, now), now), value).toBeNull();
    }
  });
});

/**
 * Review Focus 5: a custom date at the edges. The input's bounds stop today and
 * anything past two years in the browser; the server refuses them anyway.
 */
describe('customDateBounds', () => {
  it('runs from tomorrow to two years from today, as local dates', () => {
    expect(customDateBounds(new Date(2026, 10, 6, 15, 30))).toEqual({ min: '2026-11-07', max: '2028-11-06' });
  });

  it('turns over the month and the year', () => {
    expect(customDateBounds(new Date(2026, 11, 31, 23, 59))).toEqual({ min: '2027-01-01', max: '2028-12-31' });
  });

  /**
   * Both ends are dates the server accepts, at the hours that strain them: just
   * past midnight (the furthest `max` reaches, across a leap day) and just
   * before it (the nearest `min` is).
   */
  it.each([
    ['now', new Date()],
    ['just past midnight, two years spanning a leap day', new Date(2026, 10, 6, 0, 0, 30)],
    ['just before midnight', new Date(2026, 10, 6, 23, 59, 30)],
    ['on a leap day', new Date(2028, 1, 29, 0, 0, 30)],
  ])('bounds dates the server accepts, at either end (%s)', (_label, now) => {
    const { min, max } = customDateBounds(now);
    expect(publicLinkExpiryProblem(expiryFor('custom', now, min), now)).toBeNull();
    expect(publicLinkExpiryProblem(expiryFor('custom', now, max), now)).toBeNull();
  });

  /** Today is what `min` keeps out: just before midnight its end is too close. */
  it('keeps out today, whose end can be under a minute away', () => {
    const now = new Date(2026, 10, 6, 23, 59, 30);
    expect(customDateBounds(now).min).toBe('2026-11-07');
    expect(publicLinkExpiryProblem(expiryFor('custom', now, '2026-11-06'), now)).not.toBeNull();
  });
});
