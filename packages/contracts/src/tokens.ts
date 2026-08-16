import { z } from 'zod';

/**
 * The scopes a token may carry.
 *
 * DECLARED HERE rather than imported from the API, because `TokenScope` lives
 * in `apps/api/src/auth/scopes.decorator.ts` and this package is consumed by
 * the browser. Task 3 asserts the two lists agree, so the duplication cannot
 * drift silently.
 */
export const TOKEN_SCOPES = ['ingest', 'read', 'telemetry'] as const;
export type TokenScopeName = (typeof TOKEN_SCOPES)[number];

/**
 * The body of POST /v1/projects/:slug/tokens.
 *
 * `.strict()` for the same reason `TelemetryBatchSchema` is strict: a field we
 * silently ignore is a field a caller believes is doing something. There is no
 * `projectId` here — the slug in the URL names the project and the org comes
 * from the session.
 */
export const MintTokenRequestSchema = z
  .object({
    /** Free text, and required. An unnamed credential is one nobody dares
     *  revoke, because nothing on the list says what it was for. */
    name: z.string().trim().min(1).max(120),
    /** Non-empty. A token with no scopes authenticates and can do nothing. */
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  })
  .strict();
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

/**
 * What a mint returns — and the ONLY moment `token` exists anywhere.
 *
 * Only `tokenHash` is persisted, so this value cannot be recovered or
 * re-derived. A caller who loses it mints a new token.
 */
export const MintedTokenSchema = z.object({
  token: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  createdAt: z.string().datetime(),
});
export type MintedToken = z.infer<typeof MintedTokenSchema>;

/**
 * One row of the list. NOTE the absence of `token` — the secret is never
 * returned again, and the hash is never returned at all.
 *
 * `lastUsedAt` is what makes this list actionable rather than decorative: it
 * is how an operator finds the credential nothing has used since March.
 * `authenticateRequest` maintains it, throttled to at most one write per
 * minute per token.
 */
export const TokenSummarySchema = z.object({
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type TokenSummary = z.infer<typeof TokenSummarySchema>;

export const TokenListResponseSchema = z.object({
  tokens: z.array(TokenSummarySchema),
});
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>;
