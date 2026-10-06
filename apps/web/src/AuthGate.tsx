import { useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertMark } from './components/States';
import { ActivityIcon } from './components/icons';
import { ProblemError } from './api/fetch';
import { activityQueryOptions, browserTimeZone } from './api/activity';
import { getSession, sessionQueryKey } from './api/session';
import { NO_ORG_ROUTE, loginPathFor } from './routes/paths';

/**
 * The session bootstrap, asked once on load, whose answer decides `/login`
 * versus the shell (design §4). Letting each route discover its own 401
 * instead would produce a redirect race on first paint.
 *
 * It takes TWO questions to decide, not one:
 *
 *   1. `/auth/get-session` — is there a session at all?
 *   2. `GET /v1/activity` — does that session's user belong to an organisation?
 *
 * The second is not redundant. A user with no `org_member` row has a
 * completely valid Better Auth session, so `getSession()` reports a happy,
 * signed-in user and nothing else in that response distinguishes them. The
 * 403 comes from the API's own perimeter (apps/api/src/auth/auth.middleware.ts),
 * which is the only component that knows about membership — so ANY `/v1` read
 * would do as the probe, and the choice of which is a choice about caching.
 *
 * The branch is on the numeric `status`, never on the `code` string: status
 * is the contract (spec §7), while a code is a label the API is free to make
 * more specific later.
 *
 * ═══ THE PROBE IS THE HOME PAGE'S OWN QUESTION ═══
 *
 * It was the run list's first page, back when `/` redirected to the run list
 * and that list was the landing page. The landing page is the portfolio home
 * now, so the probe asks what Home asks, through Home's own options
 * (`activityQueryOptions`: the key, the fetcher, and a `staleTime` long enough
 * that the page mounting a moment later takes this answer instead of asking
 * again) — and the page renders from it on first paint. The run list, in
 * turn, now asks for its own first page, so a cold load of `/runs` draws its
 * skeleton where it used to arrive already filled.
 *
 * ═══ AND A 400 MEANS THE GATE PASSED ═══
 *
 * The run-list probe could not answer 400. This one can: `INVALID_TIMEZONE`,
 * when the browser reports a zone the server's ICU does not know. A 400 is the
 * HANDLER's answer (`apps/api/src/activity/days.ts`), and a handler runs only
 * after the perimeter has accepted the session AND its membership — a 401 or
 * 403 is the perimeter's own, sent before any handler — so a 400 settles
 * exactly the two questions this gate asks. The app renders, and the home
 * page's attention card, reading the same query, shows the refusal in its own
 * error state. Treating it as an outage would lock every reader in that zone
 * out of the whole product over one card.
 */
export default function AuthGate() {
  const location = useLocation();
  // pathname + search + hash, not just the first two: a fragment is part of
  // the destination the user asked for, and the day a chart deep-link uses
  // one, dropping it here would silently return them to the wrong place with
  // nothing to show that anything was lost.
  const intended = `${location.pathname}${location.search}${location.hash}`;

  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  // Computed per render rather than once at import: it is cheap, and a module
  // that read the zone at import would freeze it there (CLAUDE.md records the
  // same trap for a module-scope `Intl.DateTimeFormat`). Home computes it the
  // same way, so the two name one query.
  const tz = browserTimeZone();
  const membership = useQuery({
    // The home page's own options — key, fetcher AND `staleTime` — so the page
    // mounting on this entry a moment later draws from it instead of asking
    // again (see `activityQueryOptions`).
    ...activityQueryOptions(tz),
    // Never probe without a session: an unauthenticated probe would answer
    // 401 and land in the same place, having paid a request to learn what
    // step 1 already knew.
    enabled: session.data != null,
  });

  /* ═══ THE GATE LATCHES ONCE IT HAS ITS ANSWER ═══
   *
   * Answered means the probe came back with data, or with a 400 (see the
   * docstring: a handler's refusal is the gate passed). From then on, for the
   * life of this component, the gate never shows the bootstrap again and never
   * shows the outage page: only the perimeter's own two answers, a 401 and a
   * 403, can take the reader out — and those win at ANY time, latched or not.
   *
   * Reading `isPending` afresh on every render is what looped. After a 400 the
   * entry is an error with no data; the home page mounts a second observer on
   * it; TanStack re-fetches an errored entry on mount (`retryOnMount`), which
   * resets it to `pending`; and a gate that took `pending` for "still deciding"
   * swapped the page for "Checking your session…", unmounting it until the 400
   * came back, when the page remounted and asked again — one request a tick,
   * without end. A new zone mid-session (the reader's OS moves time zone) is a
   * new key and a fresh `pending` entry too, and the latch covers it the same
   * way: the page reports its own loading state.
   *
   * STATE SET DURING RENDER, NOT A REF AND NOT AN EFFECT. An effect would latch
   * only after the commit, by which time the page's own effects (a child's run
   * before its parent's) have already started the re-fetch; whether the gate
   * then saw `pending` before its latch landed would depend on TanStack's
   * notification scheduling, which is no property to build a guard on. A ref
   * written in render would latch in time, but a render React discards
   * (concurrent rendering, StrictMode's double render) cannot take a ref write
   * back; a state update made during a render is discarded with it. It is
   * React's own pattern for state derived from what a render sees (`HomeTests`
   * resets its paging the same way), and `answered` is folded in directly, so
   * the very render that first sees the answer already acts on it. */
  const [passed, setPassed] = useState(false);
  const problem = membership.error instanceof ProblemError ? membership.error : null;
  const answered = membership.data !== undefined || problem?.status === 400;
  if (answered && !passed) setPassed(true);
  const latched = passed || answered;

  if (session.isPending) return latched ? <Outlet /> : <Bootstrapping />;

  if (session.isError) {
    // `/auth/get-session` failing is NOT "logged out" — session.ts throws
    // only when Better Auth answers non-2xx, and it signals no session with
    // a 200 whose body is null. Redirecting to /login here would present an
    // outage as a credentials problem. The message is rendered as an opaque
    // string; reading Better Auth's error SHAPE is the login form's job
    // alone (design §5), and this component never imports AuthError.
    return <Unavailable detail={session.error.message} />;
  }

  if (session.data === null) return <Navigate to={loginPathFor(intended)} replace />;

  // The perimeter's two answers, which win whatever the gate has latched.
  // The session expired between the two calls, or since the gate passed.
  if (problem?.status === 401) return <Navigate to={loginPathFor(intended)} replace />;
  // Authenticated, but a member of no organisation (or no longer one). NOT a
  // redirect to /login: that is the infinite loop this whole branch exists to
  // prevent (design §5.1).
  if (problem?.status === 403) return <Navigate to={NO_ORG_ROUTE} replace />;

  // ═══ ONCE PASSED, ONLY THE PERIMETER CAN TAKE IT BACK ═══
  //
  // A LATER read failing — the home page polls this query every thirty
  // seconds while something is running, and any page refetches it on window
  // focus — is not an outage of the session or the membership: the read that
  // answered already settled both, and only the 401 and 403 above answer
  // either question again. Swapping the reader's page for "PerfPortal is not
  // answering" over one missed poll would be the outage page lying in the
  // other direction. And a re-fetch that puts the entry back to `pending` is
  // not "still deciding" — see the latch above.
  if (latched) return <Outlet />;

  if (membership.isPending) return <Bootstrapping />;

  if (membership.isError) {
    // Anything else is the API failing, and a failing API must never present
    // itself as "please sign in". Surface what the server said, including the
    // remediation it is required to send, and stay put.
    if (problem !== null) return <Unavailable detail={problem.detail} remediation={problem.remediation} />;
    // Not a ProblemError, so not a rejected response at all: apiFetch
    // guarantees every non-2xx rejects as one. This is a 2xx the contract
    // schema refused, or the network never completing.
    return <Unavailable detail={membership.error.message} />;
  }

  return <Outlet />;
}

/**
 * The very first thing the app paints, before it knows whether there is a
 * session.
 *
 * It gets the brand mark rather than a bare sentence, and the reason is not
 * decoration: this is the ONE render where the reader has no rail, no header
 * and no content to tell them what they opened. A line of grey text on an
 * empty page is indistinguishable from a page that failed to load — which is
 * what it looks like for the whole of a cold API call.
 *
 * `role="status"` and not `role="alert"`: waiting is not an error, and an
 * assertive region would interrupt whatever a screen-reader user was doing to
 * announce it.
 */
function Bootstrapping() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-mark text-on-brand shadow-raised">
        <ActivityIcon className="h-6 w-6" />
      </span>
      <p role="status" className="text-[0.8125rem] text-muted">
        Checking your session…
      </p>
    </main>
  );
}

/**
 * The outage page.
 *
 * `role="alert"` sits on the message, NOT on the `<main>`. An explicit role
 * overrides an element's implicit one outright, so `<main role="alert">` is a
 * page with no main landmark at all — and it makes the heading part of an
 * assertive live region, which is announced as an interruption rather than
 * read as the title of a page. The rule, generally: an assertive live region
 * must never wrap a heading or a landmark. It wraps the thing that changed.
 */
function Unavailable({ detail, remediation }: { detail: string; remediation?: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-4 sm:p-6">
      <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-xl border border-default bg-surface p-6 text-center shadow-panel sm:p-8">
        <AlertMark />
        <h1 className="text-xl font-semibold tracking-tight">PerfPortal is not answering</h1>
        {/* The live region wraps ONLY the two sentences that arrived from the
            server — never the heading, never the <main>. See this component's
            docstring. */}
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-[0.8125rem] leading-relaxed">{detail}</p>
          {remediation !== undefined && (
            <p className="text-[0.8125rem] leading-relaxed text-muted">{remediation}</p>
          )}
        </div>
      </div>
    </main>
  );
}
