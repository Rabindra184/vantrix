import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ActivityResponseSchema } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthGate from '../src/AuthGate';
import { activityQueryKey, activityQueryOptions, browserTimeZone } from '../src/api/activity';
import { sessionQueryKey } from '../src/api/session';
import { NO_ORG_ROUTE } from '../src/routes/paths';

afterEach(cleanup);

/**
 * `AuthGate` renders on the way into every authenticated route and had no test
 * of its own. The two states below are the ones a reader meets when nothing
 * else on the page exists yet — no rail, no header, no content — so what these
 * render IS the page, and how loudly they announce themselves is the whole of
 * their accessibility surface.
 *
 * Driven through `fetch` rather than by exporting the two inner components:
 * they are internal on purpose, and a test that reached past `AuthGate` to
 * render them directly would stop proving that the GATE ever chooses them.
 *
 * Every request is RECORDED, and anything that is neither the session nor the
 * membership probe answers 404: the probe moved from the run list's first page
 * to `GET /v1/activity`, and a stub that answered every non-session URL alike
 * would go on passing whichever endpoint the gate asked.
 */
let requests: URL[] = [];

function renderGate({
  session,
  probe,
  child = <p>page content stand-in</p>,
}: {
  session: () => unknown;
  probe?: () => unknown;
  /** What the gate lets through. A stand-in by default; see the latch cases for one that asks too. */
  child?: ReactNode;
}) {
  requests = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    if (url.pathname === '/auth/get-session') return session() as Promise<Response>;
    if (url.pathname === '/v1/activity') {
      return (probe?.() ?? new Promise<Response>(() => {})) as Promise<Response>;
    }
    return Promise.resolve(
      new Response(JSON.stringify({ code: 'NOT_FOUND', detail: 'No such route.', remediation: 'None.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route element={<AuthGate />}>
            <Route path="/runs" element={child} />
          </Route>
          <Route path={NO_ORG_ROUTE} element={<p>no organisation stand-in</p>} />
          <Route path="/login" element={<p>login stand-in</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Never settles, so the gate stays on whichever step is waiting for it. */
const never = () => new Promise<Response>(() => {});

/**
 * `getSession` CASTS its body rather than parsing it with a schema, so a
 * minimal object is honest here — this is not the "a fixture missing a
 * required field exercises the fallback" trap that file-level schemas create,
 * and it was checked rather than assumed.
 */
const signedIn = () =>
  Promise.resolve(
    new Response(JSON.stringify({ session: { id: 's1' }, user: { id: 'u1', name: 'Ada' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/** A problem document, as the API's perimeter sends every refusal. */
const problem = (status: number, body: { code: string; detail: string; remediation: string }) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    }),
  );

/**
 * The outage page's detail and remediation come from the MEMBERSHIP probe, not
 * the session: a session failure carries only a JS error message, because
 * reading Better Auth's error shape is the login form's job (`AuthGate`'s own
 * comment). Getting that backwards is what the first draft of this file did.
 */
const probeOutage = problem(500, {
  code: 'INTERNAL',
  detail: 'The API did not answer.',
  remediation: 'Check that the worker and database are running.',
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A real activity answer, through the real schema, so the gate's success path parses. */
const ACTIVITY = ActivityResponseSchema.parse({
  window: { from: '2026-09-30T00:00:00.000Z', to: '2026-10-06T12:00:00.000Z', tz: 'UTC' },
  days: ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map(
    (date) => ({ date, total: 0, successful: 0, needsAttention: 0 }),
  ),
  runCount: 0,
  passRate: null,
  running: 0,
  byProject: [],
  attention: [],
  attentionTotal: 0,
  lastRun: null,
});

describe('AuthGate — the cold start', () => {
  /**
   * Waiting is not an error. An assertive region here would interrupt whatever
   * a screen-reader user was doing, on every cold navigation into the app, to
   * tell them nothing has gone wrong.
   */
  it('announces the session check politely, never as an alert', async () => {
    renderGate({ session: never });
    expect(await screen.findByRole('status')).toHaveTextContent('Checking your session');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AuthGate — the outage page', () => {
  /**
   * ═══ AN ASSERTIVE LIVE REGION MUST NOT WRAP A LANDMARK ═══
   *
   * An explicit `role` OVERRIDES an element's implicit one outright, so
   * `<main role="alert">` is a page with no main landmark at all — a
   * screen-reader user loses the one navigation target that gets them to the
   * content, on the page where they have the least other structure to work
   * with. The component's own docstring states this as a general rule and
   * nothing checked it.
   *
   * Asserted as the PAIR, because either half alone is satisfied by the
   * defect: a document can carry a `main` and an `alert` while they are the
   * same element.
   */
  it('keeps the main landmark, with the alert inside it rather than over it', async () => {
    renderGate({ session: signedIn, probe: probeOutage });
    // AWAITED ON THE ALERT, NOT ON `main`: `Bootstrapping` renders a `<main>`
    // too, so waiting for the landmark resolves on the page BEFORE this one and
    // the alert has not been drawn yet. Same shape as the skeleton locator that
    // picked up another route's table, one spec over.
    const alert = await screen.findByRole('alert');
    const main = screen.getByRole('main');
    expect(alert).not.toBe(main);
    expect(main).toContainElement(alert);
  });

  /**
   * AND IT MUST NOT WRAP THE HEADING EITHER. A heading inside an assertive
   * region is announced as an interruption instead of being read as the title
   * of the page, and it stops being a heading a reader can navigate to.
   */
  it('leaves the page title outside the live region', async () => {
    renderGate({ session: signedIn, probe: probeOutage });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('PerfPortal is not answering');
    expect(screen.getByRole('alert')).not.toContainElement(heading);
  });

  /**
   * THE REGION WRAPS THE THING THAT CHANGED, which is the server's own two
   * sentences and nothing else. This is the positive half: a component that
   * satisfied both exclusions by announcing nothing at all would pass them and
   * tell the reader nothing.
   */
  it('announces the server’s own detail and remediation, and only those', async () => {
    renderGate({ session: signedIn, probe: probeOutage });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The API did not answer.')).toBeInTheDocument();
    expect(
      within(alert).getByText('Check that the worker and database are running.'),
    ).toBeInTheDocument();
  });

  /**
   * A pending session must not be mistaken for a broken one: the gate holds
   * the outage page back until a request has actually failed.
   */
  it('does not render the outage page while the session is still in flight', async () => {
    renderGate({ session: never });
    await screen.findByRole('status');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

describe('AuthGate — the membership probe', () => {
  /**
   * The probe is the home page's own question, asked under the home page's own
   * query key, so the landing page renders from the gate's answer rather than
   * asking again. Its URL is the claim: a gate that went on asking the run
   * list would still pass every case below that only reads what was rendered.
   */
  it('asks GET /v1/activity, and nothing else beyond the session', async () => {
    renderGate({ session: signedIn, probe: never });
    await screen.findByRole('status');
    await waitFor(() => expect(requests.some((u) => u.pathname === '/v1/activity')).toBe(true));
    const probes = requests.filter((u) => u.pathname !== '/auth/get-session');
    expect(probes.map((u) => `${u.pathname}${u.search}`).every((p) => p.startsWith('/v1/activity'))).toBe(
      true,
    );
  });

  /**
   * Authenticated, but a member of no organisation: the API's perimeter
   * answers 403 before any route runs, and the gate sends the reader to the
   * page that explains it — never to /login, which would loop.
   */
  it('sends a user with no organisation to the no-org page on a 403', async () => {
    renderGate({
      session: signedIn,
      probe: problem(403, {
        code: 'FORBIDDEN',
        detail: 'This user belongs to no organisation.',
        remediation: 'Ask an administrator to add you to one.',
      }),
    });
    expect(await screen.findByText('no organisation stand-in')).toBeInTheDocument();
    expect(screen.queryByText('page content stand-in')).toBeNull();
  });

  /**
   * ═══ A 400 IS THE GATE PASSED, NOT AN OUTAGE ═══
   *
   * The run-list probe could not answer 400; the activity probe can —
   * `INVALID_TIMEZONE`, when this browser's zone is one the server's ICU
   * rejects. A 400 comes from a ROUTE, and a route runs only after the auth
   * middleware has accepted the session and its membership (a 401 or 403 is
   * the middleware's, before any route). So the reader is in: the app renders,
   * and the home page's attention card — reading the same query — shows the
   * refusal in its own error state. Treated as an outage it would lock every
   * reader in that zone out of the whole product over one card.
   */
  it('renders the app on a 400, not the not-answering page', async () => {
    renderGate({
      session: signedIn,
      probe: problem(400, {
        code: 'INVALID_TIMEZONE',
        detail: 'The time zone "Mars/Olympus" is not one this server knows.',
        remediation: 'Send an IANA zone such as Europe/London.',
      }),
    });
    expect(await screen.findByText('page content stand-in')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'PerfPortal is not answering' })).toBeNull();
  });

  /**
   * ═══ ONCE THE GATE HAS PASSED, ONLY THE PERIMETER CAN TAKE IT BACK ═══
   *
   * The probe is now the HOME PAGE's query, and the home page polls it every
   * thirty seconds while something is running; the run-list probe it replaced
   * was asked once. So a later read of it failing is ordinary — one missed
   * poll, a dropped connection — and it must not swap whatever page the reader
   * is on for "PerfPortal is not answering": the session and the membership
   * were settled by the read that succeeded, and nothing about a 502 unsettles
   * them. The home page keeps its last good answer on screen meanwhile.
   *
   * A 401 or a 403 on a later read DOES still act — the session expired, or
   * the user was removed from the organisation — because those are answers to
   * the gate's own two questions.
   */
  it('keeps the app on screen when a later read of the probe fails', async () => {
    let calls = 0;
    const { client } = renderGate({
      session: signedIn,
      probe: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(json(ACTIVITY)) : probeOutage();
      },
    });
    expect(await screen.findByText('page content stand-in')).toBeInTheDocument();

    await client.refetchQueries({ queryKey: ['activity'] });
    await waitFor(() => expect(calls).toBe(2));
    // The refetch really did fail (the paired fact), and the page stayed.
    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: activityQueryKey(browserTimeZone()) })?.state.status).toBe('error'),
    );
    expect(screen.getByText('page content stand-in')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'PerfPortal is not answering' })).toBeNull();
  });

  it('still sends the reader to the no-org page when a later read answers 403', async () => {
    let calls = 0;
    const { client } = renderGate({
      session: signedIn,
      probe: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(json(ACTIVITY))
          : problem(403, {
              code: 'FORBIDDEN',
              detail: 'This user belongs to no organisation.',
              remediation: 'Ask an administrator to add you to one.',
            })();
      },
    });
    expect(await screen.findByText('page content stand-in')).toBeInTheDocument();
    await client.refetchQueries({ queryKey: ['activity'] });
    expect(await screen.findByText('no organisation stand-in')).toBeInTheDocument();
  });
});

describe('AuthGate — a 401 at any time', () => {
  /**
   * The session ended between the two questions (first load) or while the
   * reader was on a page (a later read). Either way the answer is the sign-in
   * page carrying where they were, and nothing the gate has latched outranks
   * it.
   */
  it('sends a first-load 401 to the sign-in page', async () => {
    renderGate({
      session: signedIn,
      probe: problem(401, {
        code: 'UNAUTHENTICATED',
        detail: 'The session has expired.',
        remediation: 'Sign in again.',
      }),
    });
    expect(await screen.findByText('login stand-in')).toBeInTheDocument();
    expect(screen.queryByText('page content stand-in')).toBeNull();
  });

  it('sends a later 401 to the sign-in page too, after the gate has passed', async () => {
    let calls = 0;
    const { client } = renderGate({
      session: signedIn,
      probe: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(json(ACTIVITY))
          : problem(401, {
              code: 'UNAUTHENTICATED',
              detail: 'The session has expired.',
              remediation: 'Sign in again.',
            })();
      },
    });
    expect(await screen.findByText('page content stand-in')).toBeInTheDocument();
    await client.refetchQueries({ queryKey: ['activity'] });
    expect(await screen.findByText('login stand-in')).toBeInTheDocument();
  });
});

/**
 * ═══ A PAGE THAT ASKS THE SAME QUESTION, UNDER THE SAME KEY ═══
 *
 * The cases above let a stand-in through, and a stand-in asks nothing — which
 * is exactly how a first-load 400 shipped looping for ever: the home page
 * mounts a SECOND observer on the probe's key, TanStack re-fetches an errored
 * query with no data when an observer mounts (`retryOnMount`), that fetch
 * puts the query back to `pending`, and a gate that read `pending` as "still
 * deciding" swapped the page for "Checking your session…" — unmounting it,
 * until the 400 came back, the page remounted, and asked again. Measured at one
 * request per tick, without end.
 *
 * So these let through a page that asks what the home page asks, and count.
 */
let observerMounts = 0;

function AsksForActivity() {
  const tz = browserTimeZone();
  // The home page's own options, so this asks exactly what the home page asks.
  const activity = useQuery(activityQueryOptions(tz));
  useEffect(() => {
    observerMounts += 1;
  }, []);
  return <p>activity observer: {activity.status}</p>;
}

/** Real time, a little at a time: the loop advanced one request per tick. */
async function ticks(n: number) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const probeRequests = () => requests.filter((u) => u.pathname === '/v1/activity').length;
const BOOTSTRAPPING = 'Checking your session…';

describe('AuthGate — the gate latches once it has its answer', () => {
  const invalidZone = problem(400, {
    code: 'INVALID_TIMEZONE',
    detail: 'The time zone "Mars/Olympus" is not one this server knows.',
    remediation: 'Send an IANA zone such as Europe/London.',
  });

  it('lets a page that asks the same question through a 400, once, without looping', async () => {
    observerMounts = 0;
    renderGate({ session: signedIn, probe: invalidZone, child: <AsksForActivity /> });
    // Ticks, not a `findBy`: a looping gate shows the page for a moment on
    // every other tick, so polling for it would succeed by luck. The COUNT is
    // what tells the two apart.
    await ticks(10);

    // The gate's question, and at most the page's own mount asking it again.
    expect(probeRequests()).toBeLessThanOrEqual(2);
    // Mounted ONCE: the gate never took the page away to show the bootstrap.
    expect(observerMounts).toBe(1);
    expect(screen.queryByText(BOOTSTRAPPING)).toBeNull();
    expect(screen.getByText('activity observer: error')).toBeInTheDocument();
  });

  /**
   * The page takes the gate's answer rather than asking again — which a shared
   * KEY alone did not buy: with no `staleTime` the second observer found the
   * entry stale on mount and refetched. Counted, because the screen is the same
   * either way.
   */
  it('lets the page take the probe’s answer on a cold load, asking once', async () => {
    observerMounts = 0;
    renderGate({ session: signedIn, probe: () => Promise.resolve(json(ACTIVITY)), child: <AsksForActivity /> });
    expect(await screen.findByText('activity observer: success')).toBeInTheDocument();
    await ticks(5);
    expect(probeRequests()).toBe(1);
    expect(observerMounts).toBe(1);
  });

  /**
   * A new zone mid-session — the reader's OS moves time zone — is a new key,
   * and a fresh entry is `pending` with no data. A gate that read that as
   * "still deciding" would take the page away for the length of a request
   * (and, on a 400, for ever). Latched, the page stays and reports its own
   * loading state.
   */
  it('keeps the page when the zone changes mid-session and the new key is still pending', async () => {
    observerMounts = 0;
    let first = true;
    const { client } = renderGate({
      session: signedIn,
      probe: () => {
        if (first) {
          first = false;
          return Promise.resolve(json(ACTIVITY));
        }
        return never();
      },
      child: <AsksForActivity />,
    });
    expect(await screen.findByText('activity observer: success')).toBeInTheDocument();

    // Any zone but this machine's own, so the key really changes.
    const zone = browserTimeZone() === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...resolved.call(this), timeZone: zone };
      });
    try {
      // A new session object makes the gate render again, and read the zone.
      act(() => {
        client.setQueryData(sessionQueryKey, { session: { id: 's2' }, user: { id: 'u1', name: 'Ada' } });
      });
      // The precondition: the gate really is asking under the new key now.
      await waitFor(() => expect(requests.some((u) => u.searchParams.get('tz') === zone)).toBe(true));
      await ticks(3);
      expect(screen.queryByText(BOOTSTRAPPING)).toBeNull();
      expect(screen.getByText(/^activity observer:/)).toBeInTheDocument();
      expect(observerMounts).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
