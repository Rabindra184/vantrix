import { describe, expect, it } from 'vitest';
import type { UsersResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { peakConcurrentUsers } from '../src/routes/runUsers';

const users = reference.users as UsersResponse;

describe('peakConcurrentUsers', () => {
  it('is the maximum of the payload’s own total series', () => {
    const expected = Math.max(...users.total.map((b) => b.maxConcurrent));
    expect(peakConcurrentUsers(users)).toBe(expected);
  });

  /**
   * THE TRAP THE CONTRACT NAMES. Gatling's "All users" is the per-scenario sum
   * AT EACH OFFSET, and `max(a+b) != max(a)+max(b)`: two scenarios peaking at
   * different moments would report a peak the run never reached. Synthetic,
   * because the fixture's scenarios may happen to peak together — in which
   * case a test built only on it would prove nothing.
   */
  it('is not the sum of per-scenario maxima', () => {
    const staggered: UsersResponse = {
      runId: users.runId,
      scenarios: [
        { scenario: 'a', buckets: [bucket(0, 10), bucket(1000, 0)] },
        { scenario: 'b', buckets: [bucket(0, 0), bucket(1000, 10)] },
      ],
      total: [bucket(0, 10), bucket(1000, 10)],
    };
    // Per-scenario maxima sum to 20; the run never had more than 10 at once.
    expect(peakConcurrentUsers(staggered)).toBe(10);
  });

  it('is null when the run recorded no users at all', () => {
    expect(peakConcurrentUsers({ runId: users.runId, scenarios: [], total: [] })).toBeNull();
  });
});

function bucket(startOffsetMs: number, maxConcurrent: number) {
  return { startOffsetMs, started: 0, ended: 0, maxConcurrent };
}
