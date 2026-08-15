/** Where an authenticated session with nowhere particular to go ends up. */
export const DEFAULT_ROUTE = '/runs';

/**
 * A run's four tabs, plus Compare, which is reached from Trends rather than
 * from the strip. Spelled once here because `App.tsx` declares them,
 * `RunTabs` links to them and the e2e suite navigates to them — three places
 * that must agree about a string, which is two more than can be kept in step
 * by hand.
 */
export function runPath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}
export function runChartsPath(runId: string): string {
  return `${runPath(runId)}/charts`;
}
export function runErrorsPath(runId: string): string {
  return `${runPath(runId)}/errors`;
}
export function runTrendsPath(runId: string): string {
  return `${runPath(runId)}/trends`;
}

/**
 * Compare, optionally carrying the selection.
 *
 * The selection is in the QUERY rather than the path because it is state a
 * reader edits in place — toggling a run must not push a new history entry
 * per click — and because a comparison is a thing people paste into tickets.
 */
export function runComparePath(runId: string, runs?: readonly string[]): string {
  const base = `${runPath(runId)}/compare`;
  return runs === undefined || runs.length === 0
    ? base
    : `${base}?runs=${encodeURIComponent(runs.join(','))}`;
}

/** The no-organisation explanation. Its own URL on purpose (see NoOrg.tsx). */
export const NO_ORG_ROUTE = '/no-organisation';

/** One project's runs. Spelled once because App.tsx declares it, RunHeader
 *  links to it and the e2e suite navigates to it. */
export function projectPath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}

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
 * Validates a `?next=` before anything navigates to it, and returns a
 * destination that is guaranteed to resolve to THIS origin.
 *
 * An open redirect on a login page is a phishing primitive, not a cosmetic
 * bug: the victim clicks a link on our genuine domain, authenticates for
 * real, and is then handed to `https://evil.example` by our own code —
 * arriving with every trust signal the attacker wanted to borrow.
 *
 * **Origin comparison is the actual control here**, not the string checks.
 * An earlier version of this function reasoned only about the string, which
 * is the wrong layer: the browser reasons about the PARSED url, and the
 * WHATWG parser strips every ASCII tab (0x09), LF (0x0A) and CR (0x0D) from
 * its input before parsing. So `"/\t/evil.example"` — a string that starts
 * with exactly one slash and passes every check below — parses as
 * `//evil.example` and resolves to `http://evil.example/`. It arrives here
 * intact as `?next=%2F%09%2Fevil.example`, because `useSearchParams().get()`
 * percent-decodes for you. No amount of string matching finds every spelling
 * of that; resolving it the way the browser will, and comparing origins,
 * finds all of them at once.
 *
 * The string checks are kept as belt and braces, and because they document
 * what an attacker actually types:
 *
 * - must start with a single `/` — `https://evil.example` and `evil.example`
 *   are both rejected;
 * - not `//evil.example`, which is a protocol-relative URL and resolves
 *   off-site;
 * - not `/\evil.example`, because browsers normalise a backslash to a
 *   forward slash in the authority position, making it another spelling of
 *   the protocol-relative case.
 *
 * The RE-SERIALISED path is returned, never the caller's own string: parsing
 * has already normalised away the control characters that made it dangerous,
 * so no later consumer can re-introduce the ambiguity by handling the raw
 * value differently.
 *
 * Anything suspect falls back to the default route rather than erroring: the
 * user asked to sign in, and a hostile `next` is no reason to refuse them.
 */
export function safeNext(next: string | null): string {
  if (!next) return DEFAULT_ROUTE;
  if (!next.startsWith('/')) return DEFAULT_ROUTE;
  if (next.startsWith('//') || next.startsWith('/\\')) return DEFAULT_ROUTE;

  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return DEFAULT_ROUTE;
  }
  if (url.origin !== window.location.origin) return DEFAULT_ROUTE;

  return `${url.pathname}${url.search}${url.hash}`;
}
