/** Where an authenticated session with nowhere particular to go ends up. */
export const DEFAULT_ROUTE = '/runs';
/**
 * The create-a-project page.
 *
 * `_new`, NOT `new`, and the underscore is the whole point. React Router
 * ranks a static segment above a dynamic one, so `/projects/new` beside
 * `/projects/:slug` does not merely risk a clash — it PERMANENTLY shadows a
 * project whose slug is `new`, which `PROJECT_SLUG_PATTERN` happily accepts
 * (`pnpm bootstrap new …` already creates one). That project's rail row, its
 * bookmarks and `projectPath('new')` would all land on this form instead,
 * with the project itself reachable by nothing.
 *
 * The slug grammar forbids `_`, so this segment cannot collide with any
 * project that exists now or could ever be created — which fixes the
 * already-created case a reserved-word list could not, and needs no list to
 * keep in step. `paths.test.ts` holds that line for every future sibling.
 */
export const NEW_PROJECT_ROUTE = '/projects/_new';

/**
 * A run's sections. Spelled once here because `App.tsx` declares them,
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
 * `load-generators`, not `telemetry`. The URL is the reader's, and "load
 * generators" is what Gatling calls this section and what the question in the
 * reader's head sounds like — "was the generator the bottleneck?". The endpoint
 * keeps the engineering name.
 */
export function runTelemetryPath(runId: string): string {
  return `${runPath(runId)}/load-generators`;
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

/**
 * One project — which is now its TESTS, not its runs.
 *
 * ═══ THIS URL CHANGED WHAT IT SHOWS, DELIBERATELY ═══
 *
 * It rendered the project's run list for its whole life. The hierarchy is
 * `Organization → Project → Test → Run`, and a project's own page is one rung
 * above the runs: a reader arriving at a project wants to know which tests it
 * has and how each is doing, not the interleaved stream of every run of every
 * test in start order. The stream is still one click away at
 * `projectRunsPath`, and every deep link to a RUN is untouched.
 *
 * The path itself is unchanged, so a bookmark still resolves and still lands
 * on the project it named. That is why the run list moved to a child segment
 * rather than this page moving to `/projects/:slug/tests`: a bookmark that
 * shows the same project one rung up is a small surprise; one that 404s, or
 * silently redirects to a list of every project, is a broken link.
 */
export function projectPath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}

/**
 * Every run in one project, across all of its tests — what `projectPath` used
 * to be.
 *
 * Worth keeping as its own page rather than folding into the test list: "what
 * ran here recently, whatever it was" is a real question with a real answer,
 * and it is the only view that can show a run whose test is null — one still
 * pending, or one that failed before the worker could read its simulation
 * class. Those runs belong to no test and appear on no test's page.
 */
export function projectRunsPath(slug: string): string {
  return `${projectPath(slug)}/runs`;
}

/**
 * One test's own page: its run history.
 *
 * The test's SLUG, not its id. A slug is unique per project (see
 * `@@unique([projectId, slug])`), which is exactly the scope this URL already
 * carries, and it survives being read aloud and pasted into a ticket. The id
 * is what the API filters runs by — `GET /v1/runs?project=&test=` resolves one
 * to the other server-side, and refuses a `test` with no `project` for the
 * same reason this path cannot express one.
 */
export function projectTestPath(slug: string, testSlug: string): string {
  return `${projectPath(slug)}/tests/${encodeURIComponent(testSlug)}`;
}

export function projectNewRunnerRunPath(slug: string): string {
  return `${projectPath(slug)}/run/new`;
}

export function projectSetupPath(slug: string): string {
  return `${projectPath(slug)}/setup`;
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
