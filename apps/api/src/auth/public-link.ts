import {
  PUBLIC_LINK_SECRET_PATTERN,
  publicLinkState,
  type PublicLinkRefusalCode,
} from '@perfportal/contracts';
import { hashPublicLinkSecret } from '@perfportal/core';
import type { PublicLinkRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { TOKEN_TOUCH_INTERVAL_MS, type Tenant } from './auth.guard.js';

/**
 * ═══ A PUBLIC LINK'S SECRET, AS A REQUEST CREDENTIAL ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md,
 * sections 4.3 and 5.1)
 *
 * The public page sends `Authorization: PublicLink <secret>` on every request
 * and never a cookie. `AuthMiddleware` tests this scheme FIRST, ahead of a
 * bearer token and a session, so a signed-in sharer opening their own link
 * sees exactly what a stranger sees.
 *
 * The tenant it answers is pinned to ONE run (`publicLink.runIds`) and holds
 * no scope. What it may reach is decided by `AccessGuard`, which denies it
 * everything but a `@LinkReadable` read of that run and the `@PublicLinkOnly`
 * resolve route — default-deny, decided before anything else about the route.
 */

/** The scheme name, exactly as sent. Case-sensitive, as `Bearer ` is beside it. */
export const PUBLIC_LINK_SCHEME = 'PublicLink';

/**
 * A link tenant's `tokenId` is `link:<link id>`. It has no `session:` prefix,
 * so `SessionOnlyGuard` refuses it wherever that guard stands — every write —
 * and `AccessGuard` never mistakes it for a session.
 */
export const PUBLIC_LINK_TOKEN_ID_PREFIX = 'link:';

/** The one thing every refusal tells the reader to do. */
const REMEDIATION = 'Ask whoever sent this link for a new one.';

/**
 * Why a link credential was refused. NOT an `HttpException`: the middleware
 * renders it as a 401 with ITS OWN code, detail and remediation, where every
 * `HttpException` on the authentication path becomes `UNAUTHENTICATED` with
 * the bearer-or-session advice — the right answer for those two credentials
 * and the wrong one for a link, whose reader has no token and no account.
 *
 * Distinguishing the four causes leaks nothing: the secret is unguessable, so
 * whoever holds one was given it.
 *
 * Built only through the four factories below, one per code, so the expired
 * refusal cannot be made without the instant its sentence names.
 */
export class PublicLinkRefusal extends Error {
  override readonly name = 'PublicLinkRefusal';
  readonly remediation = REMEDIATION;

  private constructor(
    readonly code: PublicLinkRefusalCode,
    readonly detail: string,
  ) {
    super(detail);
  }

  static notFound(): PublicLinkRefusal {
    return new PublicLinkRefusal('LINK_NOT_FOUND', 'This link does not exist.');
  }

  static revoked(): PublicLinkRefusal {
    return new PublicLinkRefusal('LINK_REVOKED', 'This link has been revoked.');
  }

  static disabled(): PublicLinkRefusal {
    return new PublicLinkRefusal('PUBLIC_LINKS_DISABLED', 'Public links are turned off for this organisation.');
  }

  /**
   * The instant as ISO 8601: zone-free, so it names one moment whoever reads
   * it. The public page words the date for its own reader.
   */
  static expired(expiresAt: Date): PublicLinkRefusal {
    return new PublicLinkRefusal('LINK_EXPIRED', `This link expired on ${expiresAt.toISOString()}.`);
  }
}

/**
 * Whether this Authorization header names the PublicLink scheme at all —
 * `PublicLink` alone included, which is how a header sent as "PublicLink "
 * arrives once Node has trimmed it. Such a header is the link's to answer,
 * malformed or not: it is refused LINK_NOT_FOUND, never handed to the session
 * branch to be refused in a bearer-or-session voice.
 */
export function carriesPublicLink(header: string | undefined): boolean {
  return header === PUBLIC_LINK_SCHEME || (header?.startsWith(`${PUBLIC_LINK_SCHEME} `) ?? false);
}

/**
 * The link credential check. Throws `PublicLinkRefusal` for a credential that
 * does not work; any other throw (the database unreachable) is an outage, and
 * the middleware answers it 500 as it does for the other two credentials.
 *
 * ═══ THE ORDER: NOT FOUND, REVOKED, DISABLED, EXPIRED ═══
 *
 *   1. The value after the scheme, trimmed, must match
 *      `PUBLIC_LINK_SECRET_PATTERN` before anything is hashed or read: a
 *      malformed value is LINK_NOT_FOUND, never a query and never a 500.
 *   2. Its SHA-256 is looked up through the unique index. No row:
 *      LINK_NOT_FOUND. The repository returns EVERY state, so the next three
 *      checks say which one stopped the link.
 *   3. Revoked. A revoked link never comes back, so that is the truest thing
 *      to say about it, whatever else is true.
 *   4. The org's switch. A disabled link may come back, which matters more
 *      to its reader than the date it expires.
 *   5. Expired, by `publicLinkState`'s own comparison — an expiry of exactly
 *      now is expired — so the run's list and this check agree about a link
 *      in the same millisecond.
 *
 * Nothing is cached between requests: a revoke, an expiry and the switch all
 * take effect on the next one.
 */
export async function authenticatePublicLink(req: Request, links: PublicLinkRepository): Promise<Tenant> {
  const header = req.headers.authorization ?? '';
  const secret = header.slice(PUBLIC_LINK_SCHEME.length).trim();
  if (!PUBLIC_LINK_SECRET_PATTERN.test(secret)) throw PublicLinkRefusal.notFound();

  const record = await links.findForCredential(hashPublicLinkSecret(secret));
  if (record === null) throw PublicLinkRefusal.notFound();
  if (record.revokedAt !== null) throw PublicLinkRefusal.revoked();
  if (!record.publicLinksEnabled) throw PublicLinkRefusal.disabled();

  const now = new Date();
  // Revocation was answered above, so only the expiry decides here.
  if (publicLinkState({ revokedAt: null, expiresAt: record.expiresAt.toISOString() }, now) !== 'active') {
    throw PublicLinkRefusal.expired(record.expiresAt);
  }

  // The once-a-minute throttle API tokens use. `touch` repeats it in SQL, so a
  // stale read here costs a no-op statement, never a second write.
  const isStale = !record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() >= TOKEN_TOUCH_INTERVAL_MS;
  if (isStale) {
    // Bookkeeping only — a failure here must never fail a link that works.
    try {
      await links.touch(record.linkId);
    } catch (err) {
      console.warn(`failed to update last_used_at for public link ${record.linkId}`, err);
    }
  }

  return {
    orgId: record.orgId,
    projectId: record.projectId,
    tokenId: `${PUBLIC_LINK_TOKEN_ID_PREFIX}${record.linkId}`,
    scopes: [],
    publicLink: { linkId: record.linkId, runIds: [record.runId], expiresAt: record.expiresAt },
  };
}
