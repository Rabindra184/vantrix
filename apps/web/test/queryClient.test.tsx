import '@testing-library/jest-dom/vitest';
import { QueryClientProvider, useMutation, useQuery, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { z } from 'zod';
import { ActivityResponseSchema } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthGate from '../src/AuthGate';
import { ProblemError, apiFetch, apiFetchNoContent } from '../src/api/fetch';
import { sessionQueryKey } from '../src/api/session';
import { createQueryClient } from '../src/queryClient';
import { loginPathFor } from '../src/routes/paths';

/**
 * `createQueryClient` is the app's one query client, and what it adds to
 * today's is the rule that a 401 from ANY query or mutation ends the session:
 * the reader goes to sign-in once, carrying where they were (review focus 4).
 *
 * Driven through the REAL `AuthGate`, with a child page that asks its own
 * question, because the client only clears the session; turning a cleared
 * session into `/login?next=…` is the gate's, and a test of the client alone
 * would prove a cache write and nothing a reader sees.
 *
 * Every request is recorded, and anything not named below answers 404, as
 * `AuthGate.test.tsx` does it.
 */
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients = [];
  vi.unstubAllGlobals();
});

let clients: QueryClient[] = [];
let requests: { path: string; method: string }[] = [];
/** Every location the router showed, one entry per navigation (keyed on `location.key`). */
let visited: string[] = [];

/** Deep, with a query and a fragment: all three are part of where the reader was. */
const PAGE = '/runs?q=checkout#errors';

function Where() {
  const location = useLocation();
  const here = `${location.pathname}${location.search}${location.hash}`;
  // `location.key`, never `here`: a second navigation to the SAME address is
  // still a second navigation, and a log keyed on the string would hide it.
  useEffect(() => {
    visited.push(here);
  }, [location.key]);
  return <output data-testid="where">{here}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderApp({ child, other }: { child: ReactNode; other: Record<string, () => Promise<Response>> }) {
  requests = [];
  visited = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
    if (url.pathname === '/auth/get-session') return (other['/auth/get-session'] ?? signedIn)();
    if (url.pathname === '/v1/activity') return Promise.resolve(json(ACTIVITY));
    const answer = other[url.pathname];
    if (answer !== undefined) return answer();
    return problem(404, 'NOT_FOUND')();
  });
  const client = createQueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[PAGE]}>
        <Where />
        <Routes>
          <Route element={<AuthGate />}>
            <Route path="/runs" element={child} />
          </Route>
          <Route path="/login" element={<p>login stand-in</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const count = (path: string) => requests.filter((r) => r.path === path).length;

/** `getSession` casts its body rather than parsing it, so a minimal one is honest here. */
const signedIn = () =>
  Promise.resolve(json({ session: { id: 's1' }, user: { id: 'u1', name: 'Ada' } }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A problem document, as the API's perimeter sends every refusal. */
const problem = (status: number, code: string) => () =>
  Promise.resolve(
    new Response(JSON.stringify({ code, detail: `Refused with ${String(status)}.`, remediation: 'None.' }), {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    }),
  );

/** A real activity answer, through the real schema, so the gate's probe passes. */
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

const READ_KEY = ['child', 'read'] as const;
const LATE_KEY = ['child', 'late'] as const;

/** A page that asks its own question, and says so when it is refused. */
function Reads() {
  const read = useQuery({ queryKey: READ_KEY, queryFn: () => apiFetch(z.unknown(), '/v1/child-read') });
  return (
    <>
      <p>page content stand-in</p>
      {read.error instanceof ProblemError && <p>refused: {read.error.status}</p>}
    </>
  );
}

/** A page that asks twice, the second answer arriving whenever the case lets it. */
function ReadsTwice() {
  useQuery({ queryKey: READ_KEY, queryFn: () => apiFetch(z.unknown(), '/v1/child-read') });
  useQuery({ queryKey: LATE_KEY, queryFn: () => apiFetch(z.unknown(), '/v1/child-late') });
  return <p>page content stand-in</p>;
}

/** A page whose only request is a write. */
function Saves() {
  const save = useMutation({ mutationFn: () => apiFetchNoContent('/v1/child-save', { method: 'POST' }) });
  return (
    <button type="button" onClick={() => save.mutate()}>
      Save
    </button>
  );
}

/** Where a reader sent to sign-in should land: the login page, carrying `PAGE`. */
const LOGIN = loginPathFor(PAGE);

describe('createQueryClient — a 401 ends the session', () => {
  it('sends the reader to sign-in from a query, carrying where they were, after one request', async () => {
    const client = renderApp({ child: <Reads />, other: { '/v1/child-read': problem(401, 'UNAUTHENTICATED') } });

    await waitFor(() => expect(where()).toBe(LOGIN));
    expect(screen.getByText('login stand-in')).toBeInTheDocument();
    // The paired fact: `next` is the page, whole, and not some other address
    // that merely happens to encode to a plausible string.
    expect(new URLSearchParams(LOGIN.slice(LOGIN.indexOf('?'))).get('next')).toBe(PAGE);
    expect(client.getQueryData(sessionQueryKey)).toBeNull();
    // The child asked, was refused, and was not asked again: no retry, and no
    // remount that refetched it before the redirect landed.
    expect(count('/v1/child-read')).toBe(1);
  });

  it('sends the reader to sign-in from a mutation too', async () => {
    const user = userEvent.setup();
    renderApp({ child: <Saves />, other: { '/v1/child-save': problem(401, 'UNAUTHENTICATED') } });

    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(where()).toBe(LOGIN));
    expect(requests.filter((r) => r.path === '/v1/child-save')).toEqual([{ path: '/v1/child-save', method: 'POST' }]);
  });

  it('navigates once: a second 401 arriving after the redirect does not navigate again', async () => {
    let releaseLate: (response: Response) => void = () => {};
    const late = new Promise<Response>((resolve) => {
      releaseLate = resolve;
    });
    const client = renderApp({
      child: <ReadsTwice />,
      other: { '/v1/child-read': problem(401, 'UNAUTHENTICATED'), '/v1/child-late': () => late },
    });

    await waitFor(() => expect(where()).toBe(LOGIN));
    // The late question really was asked while the page was up, so its answer
    // is a 401 genuinely arriving after the redirect, not one never sent.
    expect(count('/v1/child-late')).toBe(1);

    await act(async () => {
      releaseLate(await problem(401, 'UNAUTHENTICATED')());
    });
    // The second 401 reached the cache (its query errored, and the cache's
    // handler runs on that same error) before anything is asserted about it.
    await waitFor(() => expect(client.getQueryState(LATE_KEY)?.status).toBe('error'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(where()).toBe(LOGIN);
    expect(visited).toEqual([PAGE, LOGIN]);
  });
});

describe('createQueryClient — what is not a 401 is left alone', () => {
  it('leaves a 403 to the page that asked', async () => {
    const client = renderApp({ child: <Reads />, other: { '/v1/child-read': problem(403, 'ROLE_REQUIRED') } });

    // A barrier BOTH outcomes reach, so a wrongly-ended session fails on the
    // assertions below, naming the address, rather than as a timeout.
    await waitFor(() =>
      expect(screen.queryByText('refused: 403') ?? screen.queryByText('login stand-in')).not.toBeNull(),
    );
    expect(where()).toBe(PAGE);
    expect(screen.getByText('refused: 403')).toBeInTheDocument();
    expect(client.getQueryData(sessionQueryKey)).not.toBeNull();
  });

  /**
   * `/auth/*` answers in Better Auth's own shape, which `getSession` throws as
   * an `AuthError` — never a `ProblemError`. A failing session read is an
   * outage (AuthGate's own comment), not a signal to sign the reader out, and
   * it is answered here with a 401 on purpose: the status a handler keyed on
   * "anything that looks like a 401" would take.
   */
  it('leaves a failed session read to the gate, which shows its outage page as today', async () => {
    const client = renderApp({
      child: <Reads />,
      other: {
        '/auth/get-session': () =>
          Promise.resolve(json({ code: 'UNAUTHORIZED', message: 'Better Auth could not read the session.' }, 401)),
      },
    });

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'PerfPortal is not answering' }) ?? screen.queryByText('login stand-in'),
      ).not.toBeNull(),
    );
    expect(where()).toBe(PAGE);
    expect(screen.getByRole('heading', { name: 'PerfPortal is not answering' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Better Auth could not read the session.');
    // The cache still holds the session read's own failure, not a `null`
    // written over it.
    expect(client.getQueryState(sessionQueryKey)?.status).toBe('error');
  });
});
