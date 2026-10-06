import { ActivityResponseSchema, type ActivityResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * ═══ THE HOME PAGE'S ONE QUESTION (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md) ═══
 *
 * `GET /v1/activity` answers everything the page draws above its tests table
 * (which is `GET /v1/tests`'s) — the window, the seven-day glance, the pass
 * rate, what is running, the busiest projects, the tests that need attention
 * and the last run — so the page asks once, and `AuthGate` asks the very same
 * question on a cold load to learn whether the signed-in user has an
 * organisation at all. Both read it under this key, which is what lets the
 * landing page render from the probe's own result instead of asking again.
 *
 * KEYED BY ZONE. The days are the viewer's local calendar days, so the same
 * org answers differently from Kolkata and from Honolulu; a key without the
 * zone would hand one of them the other's week.
 */
export const activityQueryKey = (tz: string) => ['activity', tz] as const;

/**
 * The zone this browser says it is in, or `UTC`.
 *
 * Both fallbacks are real. `resolvedOptions().timeZone` is `undefined` in an
 * engine built without ICU's zone data and some privacy modes answer an empty
 * string; and `Intl.DateTimeFormat` itself can be absent or replaced. A zone
 * the API refuses is a 400 on the page every signed-in reader lands on, so the
 * answer here is always one it will accept — and `UTC` is the API's own
 * default, so the fallback asks exactly the question an absent `tz` would.
 */
export function browserTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * `GET /v1/activity?tz=<zone>`.
 *
 * `encodeURIComponent`, because a zone has a slash in it (`Asia/Kolkata`) and
 * a raw one is a path separator to any proxy that normalises before it
 * forwards. No `staleTime`, for the reason `fetchProjects` gives: the counts
 * move as runs arrive and as the worker finishes them.
 */
export function fetchActivity(tz: string): Promise<ActivityResponse> {
  return apiFetch(ActivityResponseSchema, `/v1/activity?tz=${encodeURIComponent(tz)}`);
}

/** How often the page re-asks while something is running. */
export const ACTIVITY_POLL_MS = 30_000;

/**
 * TanStack's `refetchInterval` for the activity query: every thirty seconds
 * while a run is live, and not at all otherwise.
 *
 * `running` is the one number on this page that changes with nobody
 * touching it, so polling is worth its cost only while it is above zero — an
 * idle portfolio asks once and goes quiet, which is what `AuthGate`'s probe
 * wants of the same query. `undefined` data (the first fetch still in flight,
 * or a failed one) is `false` too: a poll that starts before there is anything
 * to poll for is a request storm waiting for a bad day.
 */
export function activityRefetchInterval(data: ActivityResponse | undefined): number | false {
  return data !== undefined && data.running > 0 ? ACTIVITY_POLL_MS : false;
}
