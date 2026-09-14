import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthGate from '../src/AuthGate';

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
 */
function renderGate({ session, runs }: { session: () => unknown; runs?: () => unknown }) {
  vi.stubGlobal('fetch', (input: RequestInfo) =>
    String(input).includes('/auth/get-session')
      ? (session() as Promise<Response>)
      : ((runs?.() ?? new Promise<Response>(() => {})) as Promise<Response>),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route element={<AuthGate />}>
            <Route path="/runs" element={<p>page content stand-in</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

/**
 * The outage page's detail and remediation come from the RUNS probe, not the
 * session: a session failure carries only a JS error message, because reading
 * Better Auth's error shape is the login form's job (`AuthGate`'s own
 * comment). Getting that backwards is what the first draft of this file did.
 */
const runsOutage = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        code: 'INTERNAL',
        detail: 'The API did not answer.',
        remediation: 'Check that the worker and database are running.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    ),
  );

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
    renderGate({ session: signedIn, runs: runsOutage });
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
    renderGate({ session: signedIn, runs: runsOutage });
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
    renderGate({ session: signedIn, runs: runsOutage });
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
