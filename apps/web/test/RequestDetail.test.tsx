import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RequestDetail, { requestRow } from '../src/routes/RequestDetail';
import fixture from './fixtures/reference-run.json';

// ═══ WITHOUT THIS THE FILE LEAKS DOM BETWEEN CASES ═══
//
// `vitest.config.ts` does not set `globals`, so Testing Library's automatic
// cleanup never registers — every file has to call it itself, and this one
// did not. Each `render` appends to the same `document.body`, so a query in
// one test can resolve an element another test mounted.
//
// It is INTERMITTENT rather than always wrong, which is what made it hard to
// see: an earlier test's `useQuery` can resolve after that test has ended and
// commit into its still-attached container, so whether the stale node exists
// depends on timing. CLAUDE.md carried the resulting failure as "one
// occurrence, mechanism undiagnosed"; this is the mechanism.
afterEach(cleanup);


const stats = fixture.stats as Parameters<typeof requestRow>[0];

describe('requestRow', () => {
  it('finds a nested request by its full path', () => {
    const row = requestRow(stats, 'Catalog/List Products');
    expect(row?.name).toBe('Catalog/List Products');
    expect(row?.scope).toBe('request');
  });

  it('does not match a group of the same name', () => {
    // `Catalog` is a GROUP. A request lookup that fell back to a group row
    // would render group_cumulated numbers under a request heading.
    expect(requestRow(stats, 'Catalog')).toBeUndefined();
  });

  it('is undefined for a name the run never recorded', () => {
    expect(requestRow(stats, 'Nope/Not Here')).toBeUndefined();
  });
});

describe('RequestDetail', () => {
  it('heads the page with the request name from the URL', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Catalog/List Products');
  });

  it('asks for series and distribution at REQUEST scope, with the name', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // BOTH parameters on every scoped call. `?name=X` without `scope` is
    // silently ignored and answers with the RUN's totals — a 200 carrying the
    // wrong subject, which no status check would catch.
    const scoped = urls.filter((u) => u.includes('/series') || u.includes('/distribution'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const url of scoped) {
      expect(url).toContain('scope=request');
      expect(url).toContain(`name=${encodeURIComponent('Catalog/List Products')}`);
    }
  });

  it('asks for errors at request scope, so the table is this request’s', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const errors = urls.filter((u) => u.includes('/errors'));
    expect(errors).toHaveLength(1);
    // Asserting BOTH is the point. `name` alone is the silently-ignored form:
    // it answers 200 with the run's totals, which looks like a working page
    // showing a request with implausibly many errors.
    expect(errors[0]).toContain('scope=request');
    expect(errors[0]).toContain(`name=${encodeURIComponent('Catalog/List Products')}`);
  });

  it('renders the row it found, and says so when there is none', async () => {
    // Both branches, because a swapped prop or a mistyped scope check would
    // leave one of them rendering plausible nonsense.
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      // `/stats` is the only endpoint this page fetches UNSCOPED — every
      // other endpoint's URL carries `scope=request&name=...` and never
      // contains this substring — so answering it alone is enough to isolate
      // the branch under test from the page's four other queries.
      if (url.includes('/stats')) {
        return Promise.resolve(new Response(JSON.stringify(fixture.stats), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // FOUND: the fixture's own row for a request that exists reaches the
    // table — a table cell carries ITS count, not a placeholder.
    const found = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const row = requestRow(stats, 'Catalog/List Products')!;
    const cell = await screen.findByTestId('request-stat-count');
    expect(cell).toHaveAttribute('data-value', String(row.count));
    found.unmount();

    // NOT FOUND: a name the run never recorded gets the status sentence,
    // naming it — not a table of some other request's numbers.
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Nope%2FNot%20Here']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText('This run recorded no request named Nope/Not Here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('request-stat-count')).not.toBeInTheDocument();
  });
});

/**
 * REVIEW M08 — THE DETAIL PAGE DROPPED THE EXPERIMENT'S IDENTITY.
 *
 * Search opened with "Back to this run" and the word "Search". The run, its
 * project, its test, its environment and its timestamp all disappeared — so
 * two Search pages from different runs were indistinguishable, and a
 * screenshot of one said nothing about where it came from.
 *
 * It costs no extra request: the run is read under the same cache key the run
 * page itself already uses.
 */
describe('RequestDetail — it says which experiment this is', () => {
  const RUN = {
    state: 'ready' as const,
    run: {
      id: 'r1',
      project: { id: 'p1', slug: 'checkout', name: 'Checkout' },
      test: { id: 't1', slug: 'checkout-smoke', name: 'Checkout smoke' },
      status: 'complete',
      verdict: null,
      tool: 'gatling',
      simulation: 'example.ParitySimulation',
      environment: 'staging',
      branch: 'main',
      durationMs: 63161,
      startedAt: '2026-08-14T10:43:49.546Z',
      toolStartedAt: null,
      assertions: [],
    },
  };

  function renderWithRun() {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(RUN.run), { status: 200 })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['run', 'r1'], RUN);
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Search']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('names the project, environment and start time', async () => {
    renderWithRun();
    const context = await screen.findByTestId('detail-run-context');
    expect(context).toHaveTextContent('Checkout');
    expect(context).toHaveTextContent(/staging/i);
    expect(context).toHaveTextContent(/2026/);
  });

  it('links the project rather than only naming it', async () => {
    renderWithRun();
    const context = await screen.findByTestId('detail-run-context');
    expect(within(context).getByRole('link', { name: 'Checkout' })).toHaveAttribute(
      'href',
      '/projects/checkout',
    );
  });
});
