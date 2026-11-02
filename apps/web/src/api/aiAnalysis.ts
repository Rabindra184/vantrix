import { AiAnalysisResponseSchema, type AiAnalysisResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * `GET` and `POST /v1/runs/{id}/ai-analysis`: one finished run's AI analysis,
 * or why it has none, and the request to write one.
 *
 * The POST answers the same shape the GET does — the pending row it queued, or
 * the ready analysis it declined to queue again — so the card writes the
 * answer straight into this key and its polling takes over from there. A 409
 * (`AI_ANALYSIS_UNAVAILABLE`) or a 403 rejects as a `ProblemError` like every
 * other refusal.
 */
export const aiAnalysisQueryKey = (runId: string) => ['run-ai-analysis', runId] as const;

const path = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/ai-analysis`;

export function fetchAiAnalysis(runId: string): Promise<AiAnalysisResponse> {
  return apiFetch(AiAnalysisResponseSchema, path(runId));
}

export function requestAiAnalysis(runId: string): Promise<AiAnalysisResponse> {
  return apiFetch(AiAnalysisResponseSchema, path(runId), { method: 'POST' });
}
