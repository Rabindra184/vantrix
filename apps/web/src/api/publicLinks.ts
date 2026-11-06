import { PublicLinkResolveResponseSchema, type PublicLinkResolveResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

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
