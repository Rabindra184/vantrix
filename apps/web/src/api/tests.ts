import {
  OrgTestListResponseSchema,
  TestListResponseSchema,
  TestSummarySchema,
  type OrgTestListResponse,
  type TestListResponse,
  type TestSummary,
  type UpdateTestRequest,
} from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * Keys parameterised by project — the distinction `rules.ts` documents
 * between a constant org-wide key (`projectsQueryKey`) and a per-project one.
 *
 * The detail key is a CHILD of the list key's shape rather than a sibling
 * (`['project-tests', slug, testSlug]`), so a rename can invalidate
 * `['project-tests', slug]` and refresh both the list and the open test in one
 * call. TanStack matches keys by prefix, which is the whole reason to spell
 * them this way round.
 */
export const projectTestsQueryKey = (slug: string) => ['project-tests', slug] as const;
export const projectTestQueryKey = (slug: string, testSlug: string) =>
  ['project-tests', slug, testSlug] as const;

/**
 * `GET /v1/projects/:slug/tests`.
 *
 * No `staleTime`, for the reason `fetchProjects` gives: each row carries its
 * run count and its latest run's status and verdict, and both move as runs are
 * ingested and as the worker finishes parsing them. Caching this indefinitely
 * would freeze a verdict badge on a value that has since changed.
 */
export function fetchProjectTests(slug: string): Promise<TestListResponse> {
  return apiFetch(TestListResponseSchema, `/v1/projects/${encodeURIComponent(slug)}/tests`);
}

/**
 * The org-wide test search the command palette reads: one answer per
 * `(search text, page size)`. The cursor is not part of the key — a palette
 * shows the first page only, and a caller that pages owns its own key.
 *
 * Distinct from `projectTestsQueryKey` on purpose: that one is a PROJECT's
 * whole catalogue and is invalidated by a rename or a delete; this one is a
 * ranked, truncated slice of the org's and nothing about it is worth
 * invalidating by prefix.
 */
export const orgTestsQueryKey = (q: string, limit: number) => ['org-tests', q, limit] as const;

export interface OrgTestsOptions {
  /** Search text. Trimmed; empty after trimming sends no `q` at all. */
  readonly q?: string;
  readonly limit?: number;
  /** The `nextCursor` of a previous answer, passed through untouched. */
  readonly cursor?: string | null;
}

/**
 * `GET /v1/tests` — every test in the organisation, most recently run first.
 *
 * Each parameter is sent ONLY when given. `limit` in particular is optional
 * here, unlike `fetchRuns`' always-sent page size: the palette names its own
 * (5), and a caller with no opinion should get the server's default rather
 * than a number this module invented.
 *
 * `cursor` is the server's opaque string, not an id: it is handed back as
 * received and never parsed, built or compared here, so the server stays free
 * to change what it encodes.
 *
 * Built with `URLSearchParams`, which percent-encodes. That matters for `q`
 * because it is whatever somebody typed: a raw `#` would start a URL fragment
 * and a browser never sends a fragment, so the rest of the query — including
 * `limit` — would vanish without an error.
 */
export function fetchOrgTests(opts: OrgTestsOptions): Promise<OrgTestListResponse> {
  const query = new URLSearchParams();
  const q = opts.q?.trim();
  if (q) query.set('q', q);
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  if (opts.cursor) query.set('cursor', opts.cursor);
  const qs = query.toString();
  return apiFetch(OrgTestListResponseSchema, qs ? `/v1/tests?${qs}` : '/v1/tests');
}

export function fetchProjectTest(slug: string, testSlug: string): Promise<TestSummary> {
  return apiFetch(
    TestSummarySchema,
    `/v1/projects/${encodeURIComponent(slug)}/tests/${encodeURIComponent(testSlug)}`,
  );
}

/**
 * Rename or re-describe a test. Session-only at the API (`SessionOnlyGuard`),
 * which is exactly right for this caller: the browser sends the cookie.
 *
 * `UpdateTestRequest` cannot express a change to `simulationClass` or `slug`,
 * and that is the contract doing its job rather than an omission here — see
 * `UpdateTestRequestSchema`'s own docstring for what editing the class would
 * silently do to a test's history.
 */
/**
 * Delete a test. Returns the test that was deleted, so a caller can name what
 * it just removed rather than saying "done".
 *
 * Its RUNS SURVIVE and move to the project's run list, un-grouped; its own SLA
 * rules go with it. `TestRepository.remove` documents why those two cascade
 * differently, and `TestRuns` states both to the reader BEFORE arming the
 * button — a destructive action whose consequences are only discoverable
 * afterwards is not a confirmed one.
 */
export function deleteProjectTest(slug: string, testSlug: string): Promise<TestSummary> {
  return apiFetch(
    TestSummarySchema,
    `/v1/projects/${encodeURIComponent(slug)}/tests/${encodeURIComponent(testSlug)}`,
    { method: 'DELETE' },
  );
}

export function updateProjectTest(
  slug: string,
  testSlug: string,
  body: UpdateTestRequest,
): Promise<TestSummary> {
  return apiFetch(
    TestSummarySchema,
    `/v1/projects/${encodeURIComponent(slug)}/tests/${encodeURIComponent(testSlug)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}
