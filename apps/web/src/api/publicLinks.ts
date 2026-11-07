import {
  CreatePublicLinkResponseSchema,
  PublicLinkListResponseSchema,
  PublicLinkResolveResponseSchema,
  type CreatePublicLinkRequest,
  type CreatePublicLinkResponse,
  type PublicLinkListResponse,
  type PublicLinkResolveResponse,
} from '@perfportal/contracts';
import { apiFetch, apiFetchNoContent } from './fetch';

/**
 * A run's public links (spec 4).
 *
 * `GET /v1/public-link` is the public page's FIRST read: the URL carries only
 * the secret, so this is how the page learns which run it is reading and when
 * the link expires. It needs no argument, because the credential that names
 * the link is the request's own — `apiFetch` adds `Authorization: PublicLink
 * <secret>` on a share path, taken from the URL (`withCredential`).
 *
 * The key names no secret: each link's page owns a query client of its own
 * (`routes/share/PublicLinkApp.tsx`), so one key cannot serve two links.
 */
export const publicLinkQueryKey = ['public-link'] as const;

export function resolvePublicLink(): Promise<PublicLinkResolveResponse> {
  return apiFetch(PublicLinkResolveResponseSchema, '/v1/public-link');
}

/* ═══ MANAGING A RUN'S LINKS, FROM THE RUN'S OWN PAGE (spec 4.1, 6.4) ═══
 *
 * Signed-in only: the three routes are session-only and ask for `run:share`
 * (Member). Each sends the session's cookie as every app read does — the fetch
 * layer adds a link credential only on a share path, which the run page is not.
 */

/** One run's links. A different first element from `publicLinkQueryKey`, so
 *  the two never match each other's partial keys. */
export const publicLinksQueryKey = (runId: string) => ['public-links', runId] as const;

const linksPath = (runId: string): string => `/v1/runs/${encodeURIComponent(runId)}/public-links`;

/** The run's links, newest first, and whether the org lets anyone create one. */
export function fetchPublicLinks(runId: string): Promise<PublicLinkListResponse> {
  return apiFetch(PublicLinkListResponseSchema, linksPath(runId));
}

/**
 * Creates a link expiring at `expiresAt` (an ISO instant), and answers the
 * ONLY copy of its secret: the server stores its hash and nothing else.
 */
export function createPublicLink(runId: string, expiresAt: string): Promise<CreatePublicLinkResponse> {
  const body: CreatePublicLinkRequest = { expiresAt };
  return apiFetch(CreatePublicLinkResponseSchema, linksPath(runId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Stops one of the run's links at once. Idempotent on the server: a link
 *  already revoked keeps its first revocation. Answers 204. */
export function revokePublicLink(runId: string, linkId: string): Promise<void> {
  return apiFetchNoContent(`${linksPath(runId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}
