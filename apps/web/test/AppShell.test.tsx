import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/AppShell';

afterEach(cleanup);

/**
 * A sentinel child route rather than the real run list. The property under
 * test is that the rail's failure does not reach `<main>`; a sentinel proves
 * it with ONE request in flight instead of two, so a red test names its own
 * cause instead of implicating the run list's own fetching.
 */
function renderShell() {
  vi.stubGlobal('fetch', (input: RequestInfo) =>
    Promise.resolve(
      String(input).includes('/v1/projects')
        ? new Response(
            JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
            { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
          )
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/runs" element={<p>page content stand-in</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell', () => {
  it('renders the page even when the rail cannot load its projects', async () => {
    renderShell();
    expect(await screen.findByText('Projects could not be loaded.')).toBeInTheDocument();
    // The point of the test: main is unaffected by the rail's failure.
    // Scoped to <main> itself, not just present anywhere in the document —
    // recorded here as a deferred item whose justification was false: nothing
    // on this branch previously asserted DOM order, so a sentinel rendered
    // inside the rail (a real regression) would have passed this assertion
    // just as easily as one rendered where it belongs.
    expect(within(screen.getByRole('main')).getByText('page content stand-in')).toBeInTheDocument();
  });

  it('renders the rail and exactly one Sign out control', async () => {
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
    // Count, not visibility. jsdom applies no CSS, so a second copy hidden by
    // a `lg:` class is fully present here — which makes this the cheapest
    // place to catch the duplication that would break auth.spec.ts.
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });
});
