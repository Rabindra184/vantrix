import { ProjectListResponseSchema, type ProjectListResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * ONE query key for the project list, exported beside its fetcher exactly as
 * `runsQueryKey` is beside `fetchRuns`. Not a function: this endpoint takes
 * no parameters — an org's projects are not paginated (see
 * ProjectListResponseSchema).
 */
export const projectsQueryKey = ['projects'] as const;

/**
 * `GET /v1/projects`, org-scoped by the session cookie.
 *
 * No `staleTime`: each project carries its LATEST RUN, which changes as
 * runs are ingested and as the worker moves one from pending to complete.
 * Caching this indefinitely — the way the metric queries are cached, since
 * a completed run's numbers are immutable — would freeze a verdict badge on
 * a value that has moved.
 */
export function fetchProjects(): Promise<ProjectListResponse> {
  return apiFetch(ProjectListResponseSchema, '/v1/projects');
}
