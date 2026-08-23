import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestSummary } from '@perfportal/contracts';
import ProjectTests from '../src/routes/ProjectTests';

// `vitest.config.ts` sets no `globals`, so Testing Library's automatic
// cleanup never registers and every `render` here would otherwise stack in the
// same `document.body` — see CLAUDE.md on the flake that caused.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * `/projects/:slug` — a project's TESTS, the rung between a project and its
 * runs.
 *
 * WHAT THIS FILE PINS THAT THE E2E SPEC CANNOT CHEAPLY: the shapes a real
 * database rarely produces on demand. A test whose runs have all been deleted
 * (`runCount: 0` with a live row, which `ON DELETE SET NULL` makes reachable),
 * a project with no tests at all, and a list that arrives before
 * `GET /v1/projects` does — each is one line of fixture here and a seeding
 * exercise there.
 */

// `latestRun` is REQUIRED by `ProjectSummarySchema`, and leaving it off does
// not produce a missing name — it makes the whole `GET /v1/projects` parse
// throw, so the query errors and the heading silently falls back to the slug.
// A fixture that omits it therefore passes the fallback case and fails the
// real one, for a reason nothing on screen explains.
const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'checkout',
  name: 'Checkout',
  latestRun: null,
};

const CHECKOUT_SMOKE: TestSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'example-checkoutsimulation',
  name: 'Checkout smoke',
  simulationClass: 'example.CheckoutSimulation',
  description: 'The happy path, hourly.',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  runCount: 12,
  latestRun: {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'complete',
    verdict: 'passed',
  },
};

/** A test whose runs have all been deleted — a real row, not a half-load. */
const ABANDONED: TestSummary = {
  id: '44444444-4444-4444-8444-444444444444',
  slug: 'example-oldsimulation',
  name: 'example.OldSimulation',
  simulationClass: 'example.OldSimulation',
  description: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  runCount: 0,
  latestRun: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `tests` is what varies per case; the project list is the same everywhere and
 * is what the heading resolves its name from.
 *
 * `projects: null` withholds `GET /v1/projects` entirely — a pending promise,
 * not an error — which is the first-paint state the heading's slug fallback
 * exists for.
 */
function stubFetch({
  tests,
  projects = [PROJECT],
  testsStatus = 200,
}: {
  tests: unknown;
  projects?: unknown[] | null;
  testsStatus?: number;
}) {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/v1/projects') {
      return projects === null
        ? new Promise<Response>(() => {})
        : Promise.resolve(jsonResponse({ items: projects }));
    }
    if (url.pathname === '/v1/projects/checkout/tests') {
      return Promise.resolve(jsonResponse(tests, testsStatus));
    }
    throw new Error(`unhandled request in ProjectTests.test.tsx: ${url.pathname}${url.search}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/checkout']}>
        <Routes>
          <Route path="/projects/:slug" element={<ProjectTests />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectTests', () => {
  it('names the project from the project list, not from the tests', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Checkout' })).toBeInTheDocument();
  });

  /**
   * The slug is a real name for the project, not a placeholder, so the page is
   * readable before `GET /v1/projects` lands — the same fallback `ProjectRuns`
   * has always documented for its own `<h1>`.
   */
  it('falls back to the slug while the project list is still in flight', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] }, projects: null });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'checkout' })).toBeInTheDocument();
  });

  it('links each test to its own page, by slug', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    const link = await screen.findByRole('link', { name: 'View test Checkout smoke' });
    expect(link).toHaveAttribute('href', '/projects/checkout/tests/example-checkoutsimulation');
  });

  /**
   * ═══ THE NAME AND THE CLASS ARE BOTH SHOWN, AND THAT IS THE POINT ═══
   *
   * They are identical until somebody renames a test, and diverge for good
   * afterwards. The class is what a reader matches against their own
   * simulation source; the name is what their org calls it. A list showing
   * only the name would leave a renamed test unmatchable to the code that
   * produces it.
   */
  it('shows the simulation class alongside the name it was renamed to', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    const row = await screen.findByTestId('test-row');
    expect(within(row).getByText('example.CheckoutSimulation')).toBeInTheDocument();
    // The EXACT name, not a substring: the row holds a second link whose name
    // also contains "Checkout smoke" (the latest run), and a loose match
    // resolves both — the strict-mode error that would then fail this case
    // says "found multiple", which is not what it is about.
    expect(within(row).getByRole('link', { name: 'View test Checkout smoke' })).toBeInTheDocument();
  });

  it('links the latest run, so a reader reaches it without opening the test', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    const link = await screen.findByRole('link', {
      name: 'View the latest run of Checkout smoke',
    });
    expect(link).toHaveAttribute('href', '/runs/33333333-3333-4333-8333-333333333333');
  });

  /**
   * `ON DELETE SET NULL` keeps a test alive when its runs go, so this row is
   * reachable rather than hypothetical. An empty cell reads as a value that
   * failed to arrive; the words say the absence is real.
   */
  it('says a test with no runs has none, rather than leaving the cell blank', async () => {
    stubFetch({ tests: { tests: [ABANDONED] } });
    renderPage();
    const row = await screen.findByTestId('test-row');
    expect(within(row).getByText('No runs')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /latest run/ })).toBeNull();
  });

  it('counts the tests, and says "test" in the singular', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    expect(await screen.findByText('1 test')).toBeInTheDocument();
  });

  /**
   * A project with no tests gets a sentence explaining how one comes to exist
   * — there is no create endpoint, and there cannot be: the simulation class
   * belongs to the tool, so a test appears only when a run of it is parsed.
   * A reader offered no explanation would look for a "New test" button that
   * will never be there.
   */
  it('explains how a test comes to exist when the project has none', async () => {
    stubFetch({ tests: { tests: [] } });
    renderPage();
    expect(await screen.findByText('No tests yet')).toBeInTheDocument();
    expect(screen.getByText(/finishes parsing a run of it/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /** The server's own words, including the remediation every /v1 error carries. */
  it('shows what the server said when the list fails', async () => {
    stubFetch({
      tests: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No project "checkout" in this organisation.',
        code: 'NOT_FOUND',
        remediation: 'Check the slug in the address bar.',
      },
      testsStatus: 404,
    });
    renderPage();
    expect(await screen.findByText('The tests could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('No project "checkout" in this organisation.')).toBeInTheDocument();
    expect(screen.getByText('Check the slug in the address bar.')).toBeInTheDocument();
  });

  /**
   * The way DOWN is the row; the way ACROSS is this. The run list is the only
   * view that can show a run belonging to no test, so a project page with no
   * route to it would hide those runs entirely.
   */
  it('offers the project run list, which is the only place a testless run appears', async () => {
    stubFetch({ tests: { tests: [CHECKOUT_SMOKE] } });
    renderPage();
    // "Project runs", NOT "All runs": `ProjectRail` puts an "All runs" row —
    // the ORG-wide list — into every authenticated document, and this link
    // shipped carrying the same accessible name. jsdom cannot see that
    // collision (it renders one component at a time), so the guard is
    // `project-tests.spec.ts`; what this case holds is WHICH component owns
    // which name, so a rename back fails here with the cause attached.
    const link = await screen.findByRole('link', { name: 'Project runs' });
    expect(link).toHaveAttribute('href', '/projects/checkout/runs');
  });
});
