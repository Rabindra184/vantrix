import { z } from 'zod';

/**
 * A run's public link: a secret URL anyone may read the run through, without
 * signing in, until it expires or is revoked.
 *
 * The secret is `ppl_` and 43 base64url characters — 32 random bytes, minted
 * by `mintPublicLinkSecret` in @perfportal/core and stored only as its SHA-256.
 * The prefix differs from an API token's `pp_` so neither credential can be
 * mistaken for the other, by a reader or by a scanner.
 */
export const PUBLIC_LINK_SECRET_PATTERN = /^ppl_[A-Za-z0-9_-]{43}$/;

/**
 * Two years, plus a leap day, plus a day of clock slack between the browser
 * that computed a preset and the server that judges it. Every link expires;
 * there is no "never".
 */
export const PUBLIC_LINK_MAX_EXPIRY_DAYS = 732;

/** An expiry must be STRICTLY more than this far ahead of the server's now. */
export const PUBLIC_LINK_MIN_LEAD_MS = 60_000;

const DAY_MS = 86_400_000;

export const PublicLinkStateSchema = z.enum(['active', 'expired', 'revoked']);
export type PublicLinkState = z.infer<typeof PublicLinkStateSchema>;

/** A person named on a link, or null once their account is gone. */
const LinkPersonSchema = z.object({ name: z.string() }).nullable();

/**
 * One link, as the run's list and the create response describe it.
 *
 * `state` is derived when the link is read (`publicLinkState`), never stored,
 * so a link crosses its expiry without anything writing to it.
 */
export const PublicLinkSchema = z.object({
  id: z.guid(),
  state: PublicLinkStateSchema,
  createdAt: z.string().datetime(),
  createdBy: LinkPersonSchema,
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: LinkPersonSchema,
  lastUsedAt: z.string().datetime().nullable(),
});
export type PublicLink = z.infer<typeof PublicLinkSchema>;

/**
 * The body of POST /v1/runs/:id/public-links.
 *
 * The expiry is required, because every link expires. The window it must fall
 * in is judged against the SERVER's clock by `publicLinkExpiryProblem`, not
 * here: a schema refinement would read the clock of whichever process parsed
 * it. `.strict()` because a field the server silently ignores is one a caller
 * believes is doing something.
 */
export const CreatePublicLinkRequestSchema = z
  .object({
    expiresAt: z.string().datetime(),
  })
  .strict();
export type CreatePublicLinkRequest = z.infer<typeof CreatePublicLinkRequestSchema>;

/**
 * What a create returns — and the ONLY moment `secret` exists anywhere. Only
 * its hash is stored, so a reader who loses it creates a new link.
 */
export const CreatePublicLinkResponseSchema = z.object({
  link: PublicLinkSchema,
  secret: z.string(),
});
export type CreatePublicLinkResponse = z.infer<typeof CreatePublicLinkResponseSchema>;

/**
 * GET /v1/runs/:id/public-links, newest first.
 *
 * `enabled` is the org's switch, so a Member's dialog can say an admin has
 * turned public links off without that Member being able to read the
 * administration settings.
 */
export const PublicLinkListResponseSchema = z.object({
  enabled: z.boolean(),
  items: z.array(PublicLinkSchema),
});
export type PublicLinkListResponse = z.infer<typeof PublicLinkListResponseSchema>;

/**
 * GET /v1/public-link, the public page's first call: the URL carries only the
 * secret, so this is how the page learns which run it is reading.
 */
export const PublicLinkResolveResponseSchema = z.object({
  runId: z.guid(),
  expiresAt: z.string().datetime(),
});
export type PublicLinkResolveResponse = z.infer<typeof PublicLinkResolveResponseSchema>;

/**
 * The 401 codes a public-link credential is refused with, one per cause. The
 * order is the order the credential check tests them: a link that matches
 * nothing, then revoked (it never comes back, so that is the truest thing to
 * say), then the org switch (it may come back, which matters more to the
 * reader than a date), then expired.
 */
export const PUBLIC_LINK_REFUSAL_CODES = [
  'LINK_NOT_FOUND',
  'LINK_REVOKED',
  'PUBLIC_LINKS_DISABLED',
  'LINK_EXPIRED',
] as const;
export type PublicLinkRefusalCode = (typeof PUBLIC_LINK_REFUSAL_CODES)[number];

/**
 * A link's state at `now`.
 *
 * Revoked beats expired, because the two have different causes: "revoked"
 * says somebody stopped it, "expired" would say it ran out, which can be true
 * and misleading at once. Active only while the expiry is provably ahead, so
 * an expiry of exactly `now`, or one that does not parse, reads expired —
 * the comparison fails closed.
 */
export function publicLinkState(
  link: { revokedAt: string | null; expiresAt: string },
  now: Date,
): PublicLinkState {
  if (link.revokedAt !== null) return 'revoked';
  return Date.parse(link.expiresAt) > now.getTime() ? 'active' : 'expired';
}

/**
 * Why `expiresAt` cannot be a link's expiry at `now`, as the sentence an API
 * 400 carries — or null when it can.
 *
 * It must be strictly more than `PUBLIC_LINK_MIN_LEAD_MS` ahead and at most
 * `PUBLIC_LINK_MAX_EXPIRY_DAYS` ahead. An Invalid Date is refused by its own
 * branch: NaN fails every comparison, so two range checks alone would let it
 * through.
 */
export function publicLinkExpiryProblem(expiresAt: Date, now: Date): string | null {
  const leadMs = expiresAt.getTime() - now.getTime();
  if (Number.isNaN(leadMs)) return 'The expiry is not a valid instant.';
  if (leadMs <= PUBLIC_LINK_MIN_LEAD_MS) {
    return `The expiry must be more than ${PUBLIC_LINK_MIN_LEAD_MS / 1000} seconds from now.`;
  }
  if (leadMs > PUBLIC_LINK_MAX_EXPIRY_DAYS * DAY_MS) {
    return `The expiry must be at most ${PUBLIC_LINK_MAX_EXPIRY_DAYS} days from now.`;
  }
  return null;
}
