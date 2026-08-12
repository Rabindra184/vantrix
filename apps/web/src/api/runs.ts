import { RunListResponseSchema, type RunListResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * ONE query key for the run list, exported rather than spelled out at each
 * call site. `AuthGate`'s membership probe and the run list itself are the
 * same request; sharing this key is what makes the list render from the
 * bootstrap's cached result instead of firing a second identical GET on
 * first paint.
 */
export const runsQueryKey = ['runs'] as const;

/**
 * `GET /v1/runs`, org-scoped by the session cookie (the API derives the org
 * from the session — there is no org in this URL; see RunsController.list).
 *
 * Rejects with `ProblemError` for every non-2xx, per `apiFetch`'s contract.
 * The 401/403 distinction that rejection carries is the whole point of the
 * bootstrap probe: a valid session belonging to no organisation is a 403
 * here, and nothing in `/auth/get-session` can tell you that.
 */
export function fetchRuns(): Promise<RunListResponse> {
  return apiFetch(RunListResponseSchema, '/v1/runs');
}
