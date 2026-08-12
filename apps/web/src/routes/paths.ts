/** Where an authenticated session with nowhere particular to go ends up. */
export const DEFAULT_ROUTE = '/runs';

/** The no-organisation explanation. Its own URL on purpose (see NoOrg.tsx). */
export const NO_ORG_ROUTE = '/no-organisation';

/**
 * `/login`, carrying the destination the user was actually trying to reach.
 *
 * In the URL rather than in router state, deliberately: React Router's
 * location state does not survive a document load, so a user who reloads the
 * login page — or arrives at it through one — would silently lose the
 * destination and land on the default instead.
 */
export function loginPathFor(intended: string): string {
  return `/login?next=${encodeURIComponent(intended)}`;
}

/**
 * Validates a `?next=` before anything navigates to it.
 *
 * An open redirect on a login page is a phishing primitive, not a cosmetic
 * bug: the victim clicks a link on our genuine domain, authenticates for
 * real, and is then handed to `https://evil.example` by our own code —
 * arriving with every trust signal the attacker wanted to borrow. So only a
 * same-site absolute path is accepted:
 *
 * - must start with a single `/` — `https://evil.example` and `evil.example`
 *   are both rejected;
 * - not `//evil.example`, which is a protocol-relative URL and resolves
 *   off-site;
 * - not `/\evil.example`, because browsers normalise a backslash to a
 *   forward slash in the authority position, making it another spelling of
 *   the protocol-relative case.
 *
 * Anything else falls back to the default route rather than erroring: the
 * user asked to sign in, and a hostile `next` is no reason to refuse them.
 */
export function safeNext(next: string | null): string {
  if (!next) return DEFAULT_ROUTE;
  if (!next.startsWith('/')) return DEFAULT_ROUTE;
  if (next.startsWith('//') || next.startsWith('/\\')) return DEFAULT_ROUTE;
  return next;
}
