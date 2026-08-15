import { RunListResponseSchema, type RunListResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * How many runs one page asks for. Sent on EVERY request, never omitted:
 * `GET /v1/runs` has its own default (25, see parseLimit in
 * apps/api/src/common/validation.ts), and a client that relies on it is
 * silently repaginated the day the server's default moves. The page size the
 * UI's "Next" control walks must be a number this app chose.
 */
export const PAGE_SIZE = 25;

/**
 * ONE query key for the run list, exported rather than spelled out at each
 * call site — and a FUNCTION of the cursor AND the project slug, because
 * paging means the same component holds a different page under a different
 * key, and a filtered and an unfiltered list are different data under the
 * same cursor: sharing a key would serve one as the other.
 *
 * `runsQueryKey()` with no arguments is `['runs', null, null]`: the first
 * page of the org-wide list, and the exact key `AuthGate`'s membership probe
 * uses. That identity is deliberate — the list's first page renders from the
 * bootstrap's cached result instead of showing a second loading state on
 * first paint.
 *
 * It does NOT mean the first page fires zero requests. `staleTime` is unset
 * (default `0`) and `AuthGate` stays mounted as a layout route, so the list
 * mounting a second observer on the same key renders from cache *and*
 * triggers a background refetch. That refetch is wanted, not tolerated: a
 * run's `status` and `verdict` change underneath this list as the worker
 * processes it, so data cached during the bootstrap is exactly the data most
 * likely to be out of date by the time the user is looking at it. The win is
 * the instant paint, not a saved GET.
 */
export const runsQueryKey = (cursor: string | null = null, projectSlug: string | null = null) =>
  ['runs', cursor, projectSlug] as const;

/**
 * `GET /v1/runs`, org-scoped by the session cookie (the API derives the org
 * from the session — there is no org in this URL; see RunsController.list).
 *
 * `cursor` is keyset pagination, the only kind that exists here: the API
 * takes the `id` of a previously-returned item and answers with everything
 * strictly after it in the list's own order (RunRepository.list). There is no
 * offset/page-number form to fall back on, so a caller cannot jump to page N
 * — only follow `nextCursor` forward.
 *
 * `projectSlug`, when given, narrows the list to one project via `?project=`
 * (RunsController.list) — `null` asks for the whole org.
 *
 * Rejects with `ProblemError` for every non-2xx, per `apiFetch`'s contract.
 * The 401/403 distinction that rejection carries is the whole point of the
 * bootstrap probe: a valid session belonging to no organisation is a 403
 * here, and nothing in `/auth/get-session` can tell you that.
 */
export function fetchRuns(
  cursor: string | null = null,
  projectSlug: string | null = null,
): Promise<RunListResponse> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('cursor', cursor);
  if (projectSlug !== null) query.set('project', projectSlug);
  return apiFetch(RunListResponseSchema, `/v1/runs?${query.toString()}`);
}
