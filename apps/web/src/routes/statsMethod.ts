import type { RunIdentity } from '@perfportal/contracts';

/**
 * Exact only when the API says so; an API that predates the field is not
 * known to be exact.
 *
 * `'exact-v1'` runs report each percentile as the observed value at the
 * nearest rank. `'estimated'` runs were processed by the retired sketch engine
 * and keep its "within 1%" caveat — as does a response with no `statsMethod`
 * at all, because claiming exactness the API never stated would be the false
 * sentence this field exists to remove.
 */
export function isExact(statsMethod: RunIdentity['statsMethod']): boolean {
  return statsMethod === 'exact-v1';
}
