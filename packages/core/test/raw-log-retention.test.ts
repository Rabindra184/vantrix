import { describe, expect, it } from 'vitest';
import { retainedUntil } from '../src/raw-log-retention.js';

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
