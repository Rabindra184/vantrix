import {
  RunnerJobActionResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobLogsResponseSchema,
  RunnerStartResponseSchema,
  type RunnerJobActionResponse,
  type RunnerJobListResponse,
  type RunnerJobLogsResponse,
  type RunnerStartByPackageRequest,
  type RunnerStartMetadata,
  type RunnerStartResponse,
} from '@perfportal/contracts';
import { apiFetch, problemFrom } from './fetch';

export const runnerJobsQueryKey = (projectSlug: string) => ['runner-jobs', projectSlug] as const;
export const runnerJobLogsQueryKey = (projectSlug: string, jobId: string | null) =>
  ['runner-job-logs', projectSlug, jobId] as const;

export async function fetchRunnerJobs(projectSlug: string): Promise<RunnerJobListResponse> {
  const res = await fetch(`/v1/projects/${encodeURIComponent(projectSlug)}/runner/runs`, {
    credentials: 'same-origin',
  });
  if (!res.ok) throw await problemFrom(res);
  return RunnerJobListResponseSchema.parse(await res.json());
}

export async function startRunnerRun({
  projectSlug,
  metadata,
  artifact,
}: {
  readonly projectSlug: string;
  readonly metadata: RunnerStartMetadata;
  readonly artifact: File;
}): Promise<RunnerStartResponse> {
  const body = new FormData();
  body.set('metadata', JSON.stringify(metadata));
  body.set('artifact', artifact);

  const res = await fetch(`/v1/projects/${encodeURIComponent(projectSlug)}/runner/runs`, {
    method: 'POST',
    credentials: 'same-origin',
    body,
  });
  if (!res.ok) throw await problemFrom(res);
  return RunnerStartResponseSchema.parse(await res.json());
}

/**
 * Starts a run from a package's CURRENT version — a JSON body to the route the
 * multipart upload-and-start above also posts to.
 *
 * ONE ROUTE, TWO SHAPES, AND THE `Content-Type` IS WHAT CHOOSES. The server
 * reads `application/json` as "start from this package" and a multipart body
 * as "here is a file", so the header is set by hand here — the opposite of
 * `startRunnerRun`, which must NOT set one because `fetch` derives the
 * multipart boundary from the `FormData` and a hand-written header would lose
 * it. No file travels, so the start costs one small request however large the
 * package is.
 *
 * Through `apiFetch`, which `startRunnerRun` is not: nothing here needs the raw
 * response, and a refusal (a package that was deleted, a class the jar does not
 * declare) becomes the same `ProblemError` the form already renders.
 */
export function startRunnerRunFromPackage(
  slug: string,
  request: RunnerStartByPackageRequest,
): Promise<RunnerStartResponse> {
  return apiFetch(
    RunnerStartResponseSchema,
    `/v1/projects/${encodeURIComponent(slug)}/runner/runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
}

export function cancelRunnerJob(
  projectSlug: string,
  jobId: string,
): Promise<RunnerJobActionResponse> {
  return apiFetch(
    RunnerJobActionResponseSchema,
    `/v1/projects/${encodeURIComponent(projectSlug)}/runner/runs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
  );
}

export function retryRunnerJob(
  projectSlug: string,
  jobId: string,
): Promise<RunnerJobActionResponse> {
  return apiFetch(
    RunnerJobActionResponseSchema,
    `/v1/projects/${encodeURIComponent(projectSlug)}/runner/runs/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST' },
  );
}

export function fetchRunnerJobLogs(
  projectSlug: string,
  jobId: string,
): Promise<RunnerJobLogsResponse> {
  return apiFetch(
    RunnerJobLogsResponseSchema,
    `/v1/projects/${encodeURIComponent(projectSlug)}/runner/runs/${encodeURIComponent(jobId)}/logs`,
  );
}
