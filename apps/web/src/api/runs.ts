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

export type RunListStatusFilter = 'pending' | 'parsing' | 'running' | 'complete' | 'failed' | 'incomplete';
export type RunListVerdictFilter = 'passed' | 'failed' | 'not_evaluated' | 'none';

export interface RunListFilters {
  readonly q?: string;
  readonly status?: RunListStatusFilter | null;
  readonly verdict?: RunListVerdictFilter | null;
}

function normaliseFilters(filters: RunListFilters = {}) {
  const q = filters.q?.trim();
  return {
    q: q ? q : undefined,
    status: filters.status ? filters.status : undefined,
    verdict: filters.verdict ? filters.verdict : undefined,
  };
}

/**
 * ONE query key for the run list, exported rather than spelled out at each
 * call site — and a FUNCTION of the cursor AND the project slug, because
 * paging means the same component holds a different page under a different
 * key, and a filtered and an unfiltered list are different data under the
 * same cursor: sharing a key would serve one as the other.
 *
 * `runsQueryKey()` with no arguments is the first unfiltered page of the
 * org-wide list, and the exact key `AuthGate`'s membership probe uses. That
 * identity is deliberate — the list's first page renders from the bootstrap's
 * cached result instead of showing a second loading state on first paint.
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
export const runsQueryKey = (
  cursor: string | null = null,
  projectSlug: string | null = null,
  filters: RunListFilters = {},
  testSlug: string | null = null,
) => ['runs', cursor, projectSlug, normaliseFilters(filters), testSlug] as const;

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
 * `testSlug` narrows further, to one test's runs, via `?test=`. IT IS ONLY
 * EVER SENT ALONGSIDE `?project=`, and that is the API's rule rather than a
 * convention here: a test slug is unique within its project, not across the
 * organisation, so `GET /v1/runs?test=checkout` names nothing and the server
 * answers 400 TEST_NEEDS_PROJECT. The guard below makes that unreachable from
 * this client rather than relying on every caller to remember.
 *
 * Rejects with `ProblemError` for every non-2xx, per `apiFetch`'s contract.
 * The 401/403 distinction that rejection carries is the whole point of the
 * bootstrap probe: a valid session belonging to no organisation is a 403
 * here, and nothing in `/auth/get-session` can tell you that.
 */
export function fetchRuns(
  cursor: string | null = null,
  projectSlug: string | null = null,
  filters: RunListFilters = {},
  testSlug: string | null = null,
): Promise<RunListResponse> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  const activeFilters = normaliseFilters(filters);
  if (cursor !== null) query.set('cursor', cursor);
  if (projectSlug !== null) query.set('project', projectSlug);
  if (projectSlug !== null && testSlug !== null) query.set('test', testSlug);
  if (activeFilters.q) query.set('q', activeFilters.q);
  if (activeFilters.status) query.set('status', activeFilters.status);
  if (activeFilters.verdict) query.set('verdict', activeFilters.verdict);
  return apiFetch(RunListResponseSchema, `/v1/runs?${query.toString()}`);
}

/**
 * The command palette's run search: `GET /v1/runs?limit=&q=` — the first page
 * of the org-wide list, matched by the same `q` the run list's own search box
 * sends, and nothing else.
 *
 * Deliberately not `fetchRuns`: that one always sends the list's own page size
 * and takes a cursor, a project, a test and two filters, and a palette wants
 * none of them. A separate function means a palette search cannot be narrowed
 * by a parameter somebody later adds to the list. `q` is trimmed and an empty
 * one is not sent, which `normaliseFilters` does for the list for the same
 * reason: whitespace is not a search.
 */
export function searchRuns(q: string, limit: number): Promise<RunListResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  const text = q.trim();
  if (text) query.set('q', text);
  return apiFetch(RunListResponseSchema, `/v1/runs?${query.toString()}`);
}

/**
 * One run, by its number within its test: `GET /v1/runs?limit=1&project=&test=&number=`.
 *
 * A run number names nothing on its own — "Run 12" is the twelfth run of ONE
 * test — so both slugs are required parameters here, and the API's own rule
 * (400 NUMBER_NEEDS_TEST without a resolved test, and a test slug is unique
 * only within its project) is unreachable from this client rather than left
 * for every caller to remember. The answer is a list of zero or one: a test
 * that has no run N is an empty list, not an error, because a palette typing
 * `#999` is not making a mistake the server should refuse. A project or test
 * slug that names nothing IS an error — the API answers 404, as it does for
 * any unknown slug on the run list — and the caller decides what that means
 * (the palette counts a test deleted between two requests as no hit).
 */
export function fetchRunByNumber(
  projectSlug: string,
  testSlug: string,
  n: number,
): Promise<RunListResponse> {
  const query = new URLSearchParams({
    limit: '1',
    project: projectSlug,
    test: testSlug,
    number: String(n),
  });
  return apiFetch(RunListResponseSchema, `/v1/runs?${query.toString()}`);
}
