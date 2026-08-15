import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ProblemError } from './api/fetch';
import { fetchRuns, runsQueryKey } from './api/runs';
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
 *   2. `GET /v1/runs` — does that session's user belong to an organisation?
 *
 * The second is not redundant. A user with no `org_member` row has a
 * completely valid Better Auth session, so `getSession()` reports a happy,
 * signed-in user and nothing else in that response distinguishes them. The
 * 403 comes from the API's own perimeter (apps/api/src/auth/auth.middleware.ts),
 * which is the only component that knows about membership.
 *
 * The branch is on the numeric `status`, never on the `code` string: status
 * is the contract (spec §7), while a code is a label the API is free to make
 * more specific later.
 *
 * The probe is issued under the run list's own query key via its own
 * fetcher, so Task 6's list renders from this cached result rather than
 * repeating the request.
 */
export default function AuthGate() {
  const location = useLocation();
  // pathname + search + hash, not just the first two: a fragment is part of
  // the destination the user asked for, and the day a chart deep-link uses
  // one, dropping it here would silently return them to the wrong place with
  // nothing to show that anything was lost.
  const intended = `${location.pathname}${location.search}${location.hash}`;

  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  const runs = useQuery({
    // `runsQueryKey()` with no cursor is the run list's FIRST page, by
    // construction (`['runs', null, null]`) — so this probe's result is what
    // RunList renders on first paint rather than a second loading state.
    // Wrapped in an arrow, not passed as `queryFn: fetchRuns`: TanStack
    // hands the query function a QueryFunctionContext, which `fetchRuns`
    // would now read as its `cursor`.
    queryKey: runsQueryKey(),
    queryFn: () => fetchRuns(),
    // Never probe without a session: an unauthenticated probe would answer
    // 401 and land in the same place, having paid a request to learn what
    // step 1 already knew.
    enabled: session.data != null,
  });

  if (session.isPending) return <Bootstrapping />;

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

  if (runs.isPending) return <Bootstrapping />;

  if (runs.isError) {
    const error = runs.error;
    if (error instanceof ProblemError) {
      // The session expired between the two calls — rare, but the only way
      // to reach a 401 here.
      if (error.status === 401) return <Navigate to={loginPathFor(intended)} replace />;
      // Authenticated, but a member of no organisation. NOT a redirect to
      // /login: that is the infinite loop this whole branch exists to
      // prevent (design §5.1).
      if (error.status === 403) return <Navigate to={NO_ORG_ROUTE} replace />;
      // Anything else is the API failing, and a failing API must never
      // present itself as "please sign in". Surface what the server said,
      // including the remediation it is required to send, and stay put.
      return <Unavailable detail={error.detail} remediation={error.remediation} />;
    }
    // Not a ProblemError, so not a rejected response at all: apiFetch
    // guarantees every non-2xx rejects as one. This is a 2xx the contract
    // schema refused, or the network never completing.
    return <Unavailable detail={error.message} />;
  }

  return <Outlet />;
}

function Bootstrapping() {
  return (
    <p role="status" className="p-6">
      Checking your session…
    </p>
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
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">PerfPortal is not answering</h1>
      <div role="alert" className="flex flex-col gap-4">
        <p>{detail}</p>
        {remediation !== undefined && (
          <p className="text-muted">{remediation}</p>
        )}
      </div>
    </main>
  );
}
