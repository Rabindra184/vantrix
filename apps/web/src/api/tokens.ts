import {
  MintedTokenSchema,
  TokenListResponseSchema,
  TokenSummarySchema,
  type MintedToken,
  type MintTokenRequest,
  type TokenListResponse,
  type TokenSummary,
} from '@perfportal/contracts';
import { apiFetch } from './fetch';

export const projectTokensQueryKey = (slug: string) => ['project-tokens', slug] as const;

export function fetchProjectTokens(slug: string): Promise<TokenListResponse> {
  return apiFetch(TokenListResponseSchema, `/v1/projects/${encodeURIComponent(slug)}/tokens`);
}

export function mintProjectToken(slug: string, body: MintTokenRequest): Promise<MintedToken> {
  return apiFetch(MintedTokenSchema, `/v1/projects/${encodeURIComponent(slug)}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function revokeProjectToken(slug: string, prefix: string): Promise<TokenSummary> {
  return apiFetch(
    TokenSummarySchema,
    `/v1/projects/${encodeURIComponent(slug)}/tokens/${encodeURIComponent(prefix)}`,
    { method: 'DELETE' },
  );
}
