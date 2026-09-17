import { z } from 'zod';

/**
 * The scopes a token may carry.
 *
 * DECLARED HERE rather than imported from the API, because `TokenScope` lives
 * in `apps/api/src/auth/scopes.decorator.ts` and this package is consumed by
 * the browser. Task 3 asserts the two lists agree, so the duplication cannot
 * drift silently.
 *
 * `stream` and `runner` are their OWN scopes, not a reuse of `ingest`, for
 * the same reason `telemetry` is: these tokens live on load-generator hosts --
 * the least-trusted, most disposable hosts in a deployment, often shared
 * across a fleet -- and `ingest` would let either credential upload arbitrary
 * finished bundles for the whole project. `runner` is the explicit permission
 * to enqueue/cancel/retry executable on-prem jobs.
 */
export const TOKEN_SCOPES = ['ingest', 'read', 'telemetry', 'stream', 'runner'] as const;
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
    /**
     * Optional expiry (review 09-13 M18). Absent is "never expires", which is
     * what every token minted before this field existed has.
     *
     * NO DEFAULT, DELIBERATELY. A default TTL here would impose a security
     * policy on every caller of this API — including CI that has been running
     * for a year — and the finding asks for expiry to be ASSESSED as a product
     * requirement, not for one to be invented. The author chooses, or does
     * not.
     *
     * Refused in the past, because a token that is already expired at mint is
     * a credential that never works: a typo, never an intention, and the kind
     * a caller would otherwise debug against the server rather than the
     * request.
     */
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((body) => body.expiresAt === undefined || Date.parse(body.expiresAt) > Date.now(), {
    path: ['expiresAt'],
    message: 'expiresAt must be in the future; a token that expires at mint can never be used',
  });
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

/**
 * What a mint returns — and the ONLY moment `token` exists anywhere.
 *
 * Only `tokenHash` is persisted, so this value cannot be recovered or
 * re-derived. A caller who loses it mints a new token.
 *
 * `scopes` is `z.array(z.string())`, NOT `z.array(z.enum(TOKEN_SCOPES))`.
 * This is a RESPONSE schema: the controller parses the row the repository
 * just echoed back, not the request that was already validated by
 * `MintTokenRequestSchema`. A strict enum here would throw a `ZodError` (and
 * `ProblemFilter` would turn that into a bare 500) the moment a stored
 * `scopes` value doesn't match the current enum — reachable the moment a
 * scope is renamed or a row is seeded/edited by hand. Rejecting is the
 * request schema's job; this one must echo whatever is actually stored.
 */
export const MintedTokenSchema = z.object({
  token: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string().datetime(),
  /** `null` is "never expires". Optional for the rolling-deploy reason on
   *  `TokenSummarySchema` below. */
  expiresAt: z.string().datetime().nullable().optional(),
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
 *
 * `scopes` is `z.array(z.string())` for the same reason as on
 * `MintedTokenSchema` above: GET and DELETE both parse this against a row
 * already in the database, so a strict enum would let one token with a
 * stale/renamed scope 500 the whole list or revoke route for the entire
 * project — including every OTHER token in it. See `MintTokenRequestSchema`
 * for where rejecting an unknown scope belongs.
 */
export const TokenSummarySchema = z.object({
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  /**
   * `null` is "never expires" (review 09-13 M18).
   *
   * `.nullable().optional()` and the OPTIONAL half is the load-bearing one —
   * the same reasoning `live-delta.ts` and the trends contract already carry.
   * The browser drops any body that fails this schema, so during a rolling
   * deploy a response from a pod that predates this field would blank the
   * whole token list rather than degrade it.
   */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type TokenSummary = z.infer<typeof TokenSummarySchema>;

export const TokenListResponseSchema = z.object({
  tokens: z.array(TokenSummarySchema),
});
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>;
