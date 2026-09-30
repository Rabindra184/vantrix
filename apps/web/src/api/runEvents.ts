import { RunEventsResponseSchema, type RunEventsResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/** How often a live run's events are re-read — Gatling Enterprise's own Logs
 *  tab follows its log about this often. */
export const RUN_EVENTS_POLL_MS = 2_000;

export function fetchRunEvents(runId: string): Promise<RunEventsResponse> {
  return apiFetch(RunEventsResponseSchema, `/v1/runs/${encodeURIComponent(runId)}/events`);
}

/**
 * ONE key per run, stable across the run's whole life — never a function of
 * whether it has finished. A key that changed at the terminal flip would give
 * the tab a brand-new, empty query for its last read, and a failure there
 * would replace the events on screen with an error instead of leaving them
 * standing. The read on finishing is an explicit `refetch()` in `RunLogs`.
 */
export const runEventsQueryKey = (runId: string) => ['run', runId, 'events'] as const;
