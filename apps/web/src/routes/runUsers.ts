import type { UsersResponse } from '@perfportal/contracts';

/**
 * The highest number of users the run had running at once.
 *
 * READS `total`, NEVER SUMS THE SCENARIOS. The payload's `total` is already
 * the per-scenario sum at each offset — the contract says so, and says why:
 * `max(a+b) != max(a)+max(b)`, so summing each scenario's own maximum reports
 * a peak the run never reached whenever two scenarios peak at different
 * moments.
 *
 * Null, not zero, for a run with no buckets: zero is a measurement.
 */
export function peakConcurrentUsers(users: UsersResponse): number | null {
  if (users.total.length === 0) return null;
  return Math.max(...users.total.map((bucket) => bucket.maxConcurrent));
}
