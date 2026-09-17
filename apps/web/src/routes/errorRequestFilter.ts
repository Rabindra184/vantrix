import type { StatsResponse } from '@perfportal/contracts';

/**
 * The requests worth offering in the Errors tab's filter (review 09-13 M15).
 *
 * ═══ ONLY THE ONES THAT ACTUALLY FAILED ═══
 *
 * The obvious list is every request the run made. It is the wrong one: the
 * filter exists to answer "which request do I investigate", and a request with
 * no failures has no errors to show, so choosing it lands the reader on an
 * empty table having spent a decision to learn nothing. On the reference run
 * that is five of seven requests.
 *
 * Offering only `koCount > 0` makes every option lead somewhere — the list IS
 * the answer to the question, before the reader has selected anything, which
 * is more than a filter usually manages.
 *
 * ORDERED BY FAILURES, DESCENDING, because that is the order a reader wants to
 * work through them in; ties by name so the list is stable between renders of
 * the same payload rather than inheriting row order from the engine.
 *
 * GROUP AND RUN SCOPES ARE EXCLUDED, deliberately. `run` is the unfiltered view
 * the control already offers as "All requests", and a group is a container
 * whose failures are its requests' failures counted again — offering both would
 * let a reader pick two options that are the same errors under different
 * names.
 */
export function failingRequestNames(stats: StatsResponse): readonly string[] {
  return stats.stats
    .filter((row) => row.scope === 'request' && row.koCount > 0)
    .sort((a, b) => b.koCount - a.koCount || a.name.localeCompare(b.name))
    .map((row) => row.name);
}
