import { RunEventsResponseSchema, type RunEventsResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/** How often a live run's events are re-read — Gatling Enterprise's own Logs
 *  tab follows its log about this often. */
export const RUN_EVENTS_POLL_MS = 2_000;

export function fetchRunEvents(runId: string): Promise<RunEventsResponse> {
  return apiFetch(RunEventsResponseSchema, `/v1/runs/${encodeURIComponent(runId)}/events`);
}

/**
 * `terminal` is IN the key, deliberately: the moment a run finishes the key
 * changes, so the tab fetches exactly once more — the events the runner wrote
 * while it was finishing — and the new query carries no polling.
 */
export const runEventsQueryKey = (runId: string, terminal: boolean) =>
  ['run', runId, 'events', terminal] as const;
