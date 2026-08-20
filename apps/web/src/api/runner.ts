import {
  RunnerJobActionResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobLogsResponseSchema,
  RunnerStartResponseSchema,
  type RunnerJobActionResponse,
  type RunnerJobListResponse,
  type RunnerJobLogsResponse,
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
