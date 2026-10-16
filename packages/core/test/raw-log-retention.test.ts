import { describe, expect, it } from 'vitest';
import { parseRawLogRetentionDays, retainedUntil } from '../src/raw-log-retention.js';

describe('retainedUntil', () => {
  it('is the UTC calendar day of the ingest plus the days, as that day\'s UTC midnight', () => {
    // 23:30 UTC is already the next day east of UTC: the answer is the UTC day's.
    expect(retainedUntil(new Date('2026-10-16T23:30:00Z'), 30)?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(retainedUntil(new Date('2026-10-16T00:00:00Z'), 90)?.toISOString()).toBe('2027-01-14T00:00:00.000Z');
  });

  it('is null when raw logs are kept for ever', () => {
    expect(retainedUntil(new Date('2026-10-16T09:00:00Z'), 0)).toBeNull();
  });
});

/**
 * The worker DELETES on this number and the API STATES it, so a value read
 * wrongly either deletes logs nobody chose to delete or states a retention the
 * worker does not apply. Anything that is not a whole number of days in range
 * stops the process, naming the variable.
 */
describe('parseRawLogRetentionDays', () => {
  it('reads unset or blank as ninety days', () => {
    expect(parseRawLogRetentionDays(undefined)).toBe(90);
    expect(parseRawLogRetentionDays('')).toBe(90);
    expect(parseRawLogRetentionDays('  ')).toBe(90);
  });

  it('passes 0 (for ever), 7 and the hundred-year bound through', () => {
    expect(parseRawLogRetentionDays('0')).toBe(0);
    expect(parseRawLogRetentionDays('7')).toBe(7);
    expect(parseRawLogRetentionDays('36500')).toBe(36_500);
  });

  it.each(['-1', '1.5', '36501', '99999999999'])('refuses %s, naming the variable', (v) => {
    expect(() => parseRawLogRetentionDays(v)).toThrow(/RAW_LOG_RETENTION_DAYS/);
  });
});
