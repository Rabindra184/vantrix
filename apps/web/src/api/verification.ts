import { VerificationSchema, type Verification } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * `GET /v1/runs/{id}/verification`: the whole verification record for one run
 * — the figures checked, the verifier's version and time, the raw log's
 * retention, and every mismatch. Read only when the run header's verification
 * panel is OPENED: the header itself needs only the summary the run's identity
 * already carries.
 */
export const verificationQueryKey = (runId: string) => ['run-verification', runId] as const;

export function fetchVerification(runId: string): Promise<Verification> {
  return apiFetch(VerificationSchema, `/v1/runs/${encodeURIComponent(runId)}/verification`);
}
