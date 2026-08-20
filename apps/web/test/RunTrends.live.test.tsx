import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunTrends from '../src/routes/RunTrends';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * `RunTrends`'s live branch (Task 11) — a running run has no statistics row
 * of its own yet, so there is nothing for `/trends` to plot a point from.
 *
 * Mounted the same way `RunTelemetry.test.tsx` mounts its own tab under a
 * stand-in for `RunShell`'s `<Outlet context={{...}} />`, with the `run`
 * query cache pre-seeded so `useRunTerminal`'s read resolves synchronously.
 */

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function renderTrends({ status }: { readonly status: RunProcessing['status'] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run: RunProcessing = { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` };
  client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(run), { status: 202 })));

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/trends`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  { window: null, durationMs: null, liveDurationMs: null, live: null } satisfies RunWindowContext
                }
              />
            }
          >
            <Route path="trends" element={<RunTrends />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunTrends — live', () => {
  it.each(['pending', 'parsing', 'running'] as const)(
    'states that trends are withheld while the run is %s',
    (status) => {
      renderTrends({ status });
      expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/trends/i);
    },
  );

  it('does not fetch /trends while the run is not terminal', () => {
    const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>(() =>
      Promise.resolve(new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run: RunProcessing = { id: RUN_ID, status: 'running', statusUrl: `/v1/runs/${RUN_ID}` };
    client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/trends`]}>
          <Routes>
            <Route
              path="/runs/:runId"
              element={
                <Outlet
                  context={
                    { window: null, durationMs: null, liveDurationMs: null, live: null } satisfies RunWindowContext
                  }
                />
              }
            >
              <Route path="trends" element={<RunTrends />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trends'))).toBe(false);
  });
});
