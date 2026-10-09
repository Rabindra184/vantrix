import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ProblemError } from './api/fetch';
import { sessionQueryKey } from './api/session';

/**
 * The app's one query client.
 *
 * ═══ A 401 FROM ANY QUERY OR MUTATION ENDS THE SESSION ═══
 *
 * To a browser, the API answers 401 only when its session is gone: missing,
 * expired, ended while a request was in flight, or the account disabled
 * (`auth.middleware.ts`, `sessionEnded`). No page can do anything useful with
 * that answer but send the reader to sign in. Left to each page, a page's own
 * 401 was drawn in place as one more refusal, and the reader reached the
 * sign-in page only when the gate happened to ask again (a window focus, say).
 *
 * So both caches carry one handler, and it does ONE thing: it writes `null`
 * over the session, which is what `/auth/get-session` answers when there is
 * no session. The rest is `AuthGate`'s: it already turns a `null` session into
 * `<Navigate to="/login?next=<where they were>" replace>`, ahead of its latch.
 * Navigating from here instead would mean a second spelling of the gate's
 * `?next=`, outside the router that owns the location.
 *
 * ONCE, AND NEVER A LOOP. The gate's redirect takes the reader to `/login`,
 * which sits outside the gate (`App.tsx`), so the gate unmounts and nothing is
 * left to read the session again: a second 401 still arriving from a request
 * already in flight writes `null` over `null` and navigates nowhere. And the
 * cleared session cannot outlive the next sign-in, because `Login` clears the
 * whole cache before it navigates away.
 *
 * ═══ AND NEVER FOR A MUTATION THE CACHE NO LONGER HOLDS ═══
 *
 * That clear is also how a stale 401 could end the NEW session. `clear()`
 * cancels the queries it drops — silently, and a silent cancellation never
 * reaches the cache's `onError` — but it drops mutations WITHOUT cancelling
 * them: the request goes on, and when it fails the mutation still calls its
 * cache's handler. A write sent under the old session that answers 401 after
 * the reader has signed in again would write `null` over the session they
 * just made and send them back to sign-in. So the mutation handler acts only
 * on a mutation still in the cache; one `clear()` dropped belongs to a
 * session already gone.
 *
 * WHAT IT LEAVES ALONE:
 *
 *   - Every other status. A 403 refuses one action to a session that is still
 *     good (a role it lacks, an admin's page), and the page that asked says
 *     so itself; a 5xx is an outage.
 *   - `/auth/*` failures. `getSession` throws Better Auth's own `AuthError`,
 *     never a `ProblemError`, and a failed session read is an outage the gate
 *     shows as one — reading it as "signed out" would present the server
 *     failing as a credentials problem.
 *   - Requests that never pass through a query or a mutation.
 *     `BundleUpload` sends its XHR (`uploadBundle`) from a plain event handler,
 *     so its 401 is shown inline as the server's own sentence, and the live
 *     socket reports its own 4401 close through `useLiveRun`. The package
 *     upload is the other XHR, and it is NOT outside:
 *     `ProjectPackages` runs `uploadPackageContent` inside a `useMutation`,
 *     and it rejects with a `ProblemError` from `problemFrom`, so its 401 ends
 *     the session here like any other.
 */
export function createQueryClient(): QueryClient {
  const endSessionOn401 = (error: unknown): void => {
    if (error instanceof ProblemError && error.status === 401) client.setQueryData(sessionQueryKey, null);
  };
  const mutationCache: MutationCache = new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) => {
      // Dropped by `clear()` (a re-sign-in) while still in flight: its 401 is
      // about the session that ended, not the one the cache holds now.
      if (!mutationCache.getAll().some((held) => held === mutation)) return;
      endSessionOn401(error);
    },
  });
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: endSessionOn401 }),
    mutationCache,
    defaultOptions: {
      queries: {
        // TanStack Query retries a failed query three times by default, with
        // backoff. Every rejection this shell acts on is a deliberate verdict
        // the server will repeat — a 401 with no cookie, a 403 with no
        // organisation — so retrying only delays the redirect by seconds
        // while the user looks at a loading state. A route that genuinely
        // wants retries (polling a pending run, Task 7) can ask per-query.
        retry: false,
      },
    },
  });
  return client;
}
