import {
  TestListResponseSchema,
  TestSummarySchema,
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
