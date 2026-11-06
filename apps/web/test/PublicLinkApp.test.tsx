import '@testing-library/jest-dom/vitest';
import { MutationObserver as QueryMutationObserver, QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_LINK_REFUSAL_CODES, type PublicLinkRefusalCode, type RunResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import App from '../src/App';
import { ProblemError } from '../src/api/fetch';
import { sessionQueryKey } from '../src/api/session';
import { createQueryClient } from '../src/queryClient';
import { formatInstant } from '../src/routes/format';
import { createPublicLinkQueryClient } from '../src/routes/share/publicQueryClient';
// Warmed here, statically: `App` reaches both through `lazy()`, and a first
// transform of the shell and the Summary inside a `findBy` window is time the
// assertion would spend waiting on the compiler rather than on the page.
import '../src/routes/share/PublicLinkApp';
import '../src/routes/RunSummary';

/**
 * ═══ THE PUBLIC RUN PAGE, THROUGH THE REAL APP, UNDER THE APP'S OWN CLIENT ═══
 *
 * Rendered through `App` at `/share/<secret>` with the app's `createQueryClient`
 * outside it — exactly how `main.tsx` mounts it — so three things are proven at
 * once that a component-level render could not see:
 *
 *   - the route sits outside `AuthGate`, so no session is ever asked for;
 *   - the page's own query client, not the app's, owns every read: the app's
 *     would end a session on a 401 and never show a link-state page;
 *   - `fetch` really goes out with the link and without the cookie, because
 *     `window.location` is put on the share path too (the credential follows
 *     the URL, `withCredential`).
 *
 * The fetch stub refuses `/auth/*` and `/v1/projects` and records them, and
 * every case asserts that record is empty: the public page has no session and
 * no project list to ask, and asking would send the cookie the link replaces.
 *
 * The Report and Logs tabs are stood in for by probes reading the presentation
 * they were rendered under; the real ones are covered by their own files. The
 * Summary is real.
 */

vi.mock('../src/routes/RunReport', async () => {
  const { useRunPresentation } = await import('../src/routes/presentation');
  return {
    default: function ReportProbe() {
      const presentation = useRunPresentation();
      return (
        <div
          data-testid="section-probe"
          data-section="report"
          data-kind={presentation.kind}
          data-secret={presentation.kind === 'public' ? presentation.secret : ''}
        />
      );
    },
  };
});
vi.mock('../src/routes/RunLogs', async () => {
  const { useRunPresentation } = await import('../src/routes/presentation');
  return {
    default: function LogsProbe() {
      const presentation = useRunPresentation();
      return (
        <div
          data-testid="section-probe"
          data-section="logs"
          data-kind={presentation.kind}
          data-secret={presentation.kind === 'public' ? presentation.secret : ''}
        />
      );
    },
  };
});

// Real charts draw on the Summary, and ECharts measures text through a 2D
// canvas context jsdom does not implement; answering null is what jsdom does
// anyway, without printing "Not implemented" on every call.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

const SECRET = 'ppl_Q7x_Kd-9mVb2LpN4rTzW8yHc6uJf3sEa1oGiX5nBkY0';
const SHARE = `/share/${SECRET}`;
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const EXPIRES_AT = '2026-11-13T09:30:00.000Z';

const RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  test: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout-smoke', name: 'Checkout smoke' },
  runNumber: 3,
  runnerJobId: '33333333-3333-4333-8333-333333333333',
  status: 'complete',
  verdict: 'passed',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
  toolAssertions: [],
};

interface Sent {
  readonly path: string;
  readonly authorization: string | null;
  readonly credentials: RequestCredentials | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ status, title: 'Refused', code, detail, remediation: 'stub' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/**
 * Answers the link, the run and the Summary's reads. `resolve` and `stats`
 * take over those two endpoints for a case; every other unknown path is a 404
 * problem, which a section renders as its own refusal and which is no 401.
 */
function stubFetch({
  resolve = () => json({ runId: RUN_ID, expiresAt: EXPIRES_AT }),
  stats = () => json(reference.stats),
}: {
  resolve?: () => Response | Promise<Response>;
  stats?: () => Response | Promise<Response>;
} = {}): { readonly sent: Sent[]; readonly forbidden: string[] } {
  const sent: Sent[] = [];
  const forbidden: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    sent.push({ path, authorization: new Headers(init?.headers).get('authorization'), credentials: init?.credentials });
    if (path.startsWith('/auth/') || path === '/v1/projects' || path.startsWith('/v1/projects/')) {
      forbidden.push(path);
      return Promise.reject(new Error(`the public page asked ${path}`));
    }
    if (path === '/v1/public-link') return Promise.resolve(resolve());
    if (path === `/v1/runs/${RUN_ID}`) return Promise.resolve(json(RUN));
    if (path.endsWith('/stats')) return Promise.resolve(stats());
    if (path.endsWith('/users')) return Promise.resolve(json(reference.users));
    if (path.endsWith('/series')) return Promise.resolve(json(reference.series));
    if (path.endsWith('/errors')) return Promise.resolve(json(reference.errors));
    if (path.endsWith('/trends')) return Promise.resolve(json({ runs: [] }));
    return Promise.resolve(problem(404, 'NOT_FOUND', 'stub'));
  });
  return { sent, forbidden };
}

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location" data-path={pathname} />;
}

/**
 * Every alert the page draws while it is watched, however briefly. A link
 * refusal is the link-state page's to say: an alert first ("This link could
 * not be opened", "Run totals could not be loaded") would be announced to a
 * screen reader for a page about to disappear.
 */
function watchAlerts(): { stop(): string[] } {
  const seen: string[] = [];
  const watcher = new MutationObserver(() => {
    for (const alert of document.querySelectorAll('[role="alert"]')) seen.push(alert.textContent ?? '');
  });
  watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    stop() {
      watcher.disconnect();
      return seen;
    },
  };
}

/** Mounts the app as `main.tsx` does, at `url`, with `window.location` there too. */
function mount(url: string): QueryClient {
  window.history.replaceState(null, '', url);
  const app = createQueryClient();
  render(
    <QueryClientProvider client={app}>
      <MemoryRouter initialEntries={[url]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return app;
}

beforeEach(() => {
  document.title = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const SENTENCE: Readonly<Record<PublicLinkRefusalCode, string>> = {
  LINK_NOT_FOUND: 'This link does not exist.',
  LINK_REVOKED: 'This link has been revoked.',
  PUBLIC_LINKS_DISABLED: 'Public links are turned off for this organisation.',
  LINK_EXPIRED: `This link expired on ${formatInstant(EXPIRES_AT)}.`,
};
const DETAIL: Readonly<Record<PublicLinkRefusalCode, string>> = {
  LINK_NOT_FOUND: 'This link does not exist.',
  LINK_REVOKED: 'This link has been revoked.',
  PUBLIC_LINKS_DISABLED: 'Public links are turned off for this organisation.',
  LINK_EXPIRED: `This link expired on ${EXPIRES_AT}.`,
};

describe('/share/:token — a link the API refuses', () => {
  it.each(PUBLIC_LINK_REFUSAL_CODES)('shows the %s page, and asks nothing of the session', async (code) => {
    const { sent, forbidden } = stubFetch({ resolve: () => problem(401, code, DETAIL[code]) });
    const alerts = watchAlerts();
    mount(SHARE);

    const heading = await screen.findByRole('heading', { level: 1, name: SENTENCE[code] });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText('Ask whoever sent it for a new link.')).toBeInTheDocument();
    expect(forbidden).toEqual([]);
    // The link is the only thing asked: a refused link names no run to read.
    expect(sent.map((request) => request.path)).toEqual(['/v1/public-link']);
    expect(screen.getByTestId('location')).toHaveAttribute('data-path', SHARE);
    expect(alerts.stop()).toEqual([]);
  });

  /** A segment that is no secret at all would get no credential from the fetch
   *  layer — the request would go out with the cookie instead — so the page
   *  asks nothing and says so. */
  it('says a malformed link does not exist, and makes no request at all', async () => {
    const { sent } = stubFetch();
    mount('/share/not-a-link');

    expect(await screen.findByRole('heading', { level: 1, name: 'This link does not exist.' })).toBeInTheDocument();
    expect(sent).toEqual([]);
  });
});

describe('/share/:token — a link the API resolves', () => {
  it('renders the Summary inside the run shell, under the read-only header', async () => {
    const { sent, forbidden } = stubFetch();
    mount(SHARE);

    // The Summary's own figures, inside the shell's section strip.
    expect(await screen.findByTestId('stat-total-requests')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();

    const header = screen.getByTestId('public-header');
    expect(header).toHaveTextContent('PerfPortal');
    expect(within(header).getByText(`Read-only link · expires ${formatInstant(EXPIRES_AT)}`)).toBeInTheDocument();
    // The brand is text: a link to the app would leave the share tree.
    expect(within(header).queryAllByRole('link')).toHaveLength(0);

    // None of the app's chrome: no rail, no palette, no account menu.
    expect(screen.queryByRole('navigation', { name: 'Projects' })).toBeNull();
    expect(screen.queryByText('Skip to content')).toBeNull();

    expect(forbidden).toEqual([]);
    const reads = sent.filter((request) => request.path.startsWith('/v1/'));
    expect(reads.length).toBeGreaterThan(2);
    for (const read of reads) {
      expect(read.authorization, read.path).toBe(`PublicLink ${SECRET}`);
      expect(read.credentials, read.path).toBe('omit');
    }
  });

  /** The Summary is the release decision as much as its figures: the shell
   *  draws the band and the lifecycle strip on the Summary alone, and knows the
   *  Summary by its path — a share path here. */
  it('draws the release decision and the run’s lifecycle on the public Summary', async () => {
    stubFetch();
    mount(SHARE);
    expect(await screen.findByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    expect(screen.getByTestId('run-lifecycle')).toBeInTheDocument();
  });

  it('titles the document with the run and its test', async () => {
    stubFetch();
    mount(SHARE);
    await screen.findByTestId('stat-total-requests');
    expect(document.title).toBe('Run 3 · Checkout smoke — PerfPortal');
  });

  /**
   * ═══ TASK 9's, PINNED NOW AS A KNOWN FAILURE ═══
   *
   * The brief's "three tabs, whose hrefs start with `/share/<secret>`" is true
   * only once `RunTabs` builds its links through `useRunPaths` (Task 9). Until
   * then the strip draws five tabs at app paths, so this is `it.fails`: it
   * passes while the claim is false, and FAILS the moment Task 9 makes it true
   * — at which point that task turns it into an `it`.
   */
  it.fails('draws three tabs, every one at a share path', async () => {
    stubFetch();
    mount(SHARE);
    const tabs = within(await screen.findByRole('navigation', { name: 'Run sections' })).getAllByRole('link');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Summary', 'Report', 'Logs']);
    for (const tab of tabs) expect(tab.getAttribute('href') ?? '').toMatch(new RegExp(`^${SHARE}(/|$|\\?)`));
  });

  it.each(['report', 'logs'] as const)('renders the %s section under the public presentation', async (section) => {
    const { forbidden } = stubFetch();
    mount(`${SHARE}/${section}`);

    const probe = await screen.findByTestId('section-probe');
    expect(probe).toHaveAttribute('data-section', section);
    expect(probe).toHaveAttribute('data-kind', 'public');
    expect(probe).toHaveAttribute('data-secret', SECRET);
    expect(within(screen.getByTestId('public-header')).getByText(/^Read-only link · expires /)).toBeInTheDocument();
    expect(forbidden).toEqual([]);
  });

  /** A section a link does not reach (Trends, Compare, a stale address) goes to
   *  the Summary, inside the share tree, never into the app. */
  it('sends a section the link does not reach to its Summary', async () => {
    stubFetch();
    mount(`${SHARE}/trends`);
    await screen.findByTestId('stat-total-requests');
    expect(screen.getByTestId('location')).toHaveAttribute('data-path', SHARE);
  });
});

describe('/share/:token — a refusal that arrives after the page rendered', () => {
  /** Review Focus 4: revoked while somebody is reading. The page is replaced
   *  by the revoked page; it is not a session that ended, so nothing goes to
   *  `/login` and nothing is written over the app's session. */
  it('replaces the page with the revoked page when a section’s read is refused', async () => {
    let refuse: () => void = () => {};
    const { forbidden } = stubFetch({
      stats: () =>
        new Promise<Response>((answer) => {
          refuse = () => answer(problem(401, 'LINK_REVOKED', 'This link has been revoked.'));
        }),
    });
    const app = mount(SHARE);

    // The page is on screen, waiting on its statistics.
    expect(await screen.findByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.queryByTestId('stat-total-requests')).toBeNull();

    const alerts = watchAlerts();
    refuse();

    expect(await screen.findByRole('heading', { level: 1, name: 'This link has been revoked.' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Run sections' })).toBeNull();
    expect(alerts.stop()).toEqual([]);
    expect(screen.getByTestId('location')).toHaveAttribute('data-path', SHARE);
    expect(app.getQueryData(sessionQueryKey)).toBeUndefined();
    expect(forbidden).toEqual([]);
  });

  /** A 401 this credential cannot produce (a session's own code) ends nothing:
   *  the page stays, the section says what it was told, and the app's session
   *  is left exactly as it was — the app's handler would have written `null`. */
  it('leaves the page in place for a 401 that is not a link refusal', async () => {
    const { forbidden } = stubFetch({ stats: () => problem(401, 'UNAUTHENTICATED', 'Sign in to read this run.') });
    const app = mount(SHARE);

    const totals = await screen.findByRole('region', { name: 'Run totals' });
    expect(await within(totals).findByRole('alert')).toHaveTextContent('Sign in to read this run.');
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    for (const code of PUBLIC_LINK_REFUSAL_CODES) {
      expect(screen.queryByRole('heading', { level: 1, name: SENTENCE[code] })).toBeNull();
    }
    expect(screen.getByTestId('location')).toHaveAttribute('data-path', SHARE);
    expect(app.getQueryData(sessionQueryKey)).toBeUndefined();
    expect(forbidden).toEqual([]);
  });
});

describe('createPublicLinkQueryClient', () => {
  const refusal = (status: number, code: string): ProblemError =>
    new ProblemError(status, { code, detail: `detail for ${code}`, remediation: 'stub' });

  it('reports a link refusal from a query, with its code and detail', async () => {
    const onRefusal = vi.fn();
    const client = createPublicLinkQueryClient(onRefusal);
    await client
      .fetchQuery({ queryKey: ['q'], queryFn: () => Promise.reject(refusal(401, 'LINK_EXPIRED')) })
      .catch(() => undefined);
    expect(onRefusal).toHaveBeenCalledExactlyOnceWith('LINK_EXPIRED', 'detail for LINK_EXPIRED');
  });

  it('reports a link refusal from a mutation', async () => {
    const onRefusal = vi.fn();
    const client = createPublicLinkQueryClient(onRefusal);
    const observer = new QueryMutationObserver(client, { mutationFn: () => Promise.reject(refusal(401, 'LINK_REVOKED')) });
    await observer.mutate().catch(() => undefined);
    expect(onRefusal).toHaveBeenCalledExactlyOnceWith('LINK_REVOKED', 'detail for LINK_REVOKED');
  });

  it.each([
    ['a 401 with a session’s code', refusal(401, 'UNAUTHENTICATED')],
    ['a link code on another status', refusal(403, 'LINK_REVOKED')],
    ['an error that is not a problem', new Error('LINK_REVOKED')],
  ])('ignores %s', async (_label, error) => {
    const onRefusal = vi.fn();
    const client = createPublicLinkQueryClient(onRefusal);
    await client.fetchQuery({ queryKey: ['q'], queryFn: () => Promise.reject(error) }).catch(() => undefined);
    const observer = new QueryMutationObserver(client, { mutationFn: () => Promise.reject(error) });
    await observer.mutate().catch(() => undefined);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  /** A refused link answers the same on every retry, so retrying only delays
   *  the page that says so. */
  it('does not retry a query', () => {
    expect(createPublicLinkQueryClient(() => undefined).getDefaultOptions().queries?.retry).toBe(false);
  });
});
