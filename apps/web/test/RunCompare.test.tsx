import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing, RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunCompare from '../src/routes/RunCompare';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * MINOR 5. `/runs/:runId/compare` is a sixth `<Outlet/>` child under
 * `RunShell` that the five-tab audit missed — reachable only by a
 * hand-typed URL (`RunTrends`'s own "Compare these runs" link only ever
 * renders once IT has cleared its own `!terminal` return), but reachable
 * now that `RunShell` mounts for every run status. Before this fix,
 * `trendsQuery` fired with no `terminal` gate at all — the same class of
 * defect the five tabs were audited for, just on a sixth route nobody had
 * looked at yet.
 *
 * Mounted the same way `RunTrends.live.test.tsx` mounts its own tab, under a
 * stand-in for `RunShell`'s `<Outlet context={{...}} />` with the `run`
 * query cache pre-seeded so `useRunTerminal`'s read resolves synchronously.
 */

const RUN_ID = '00000000-0000-4000-8000-000000000002';

const COMPLETE_RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

const EMPTY_TRENDS = { runId: RUN_ID, simulation: COMPLETE_RUN.simulation, cohortSize: 1, runs: [] };

function processing(status: RunProcessing['status']) {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

function renderCompare(body: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), body);

  const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>((input) => {
    const url = String(input);
    if (url.includes('/trends')) {
      return Promise.resolve(new Response(JSON.stringify(EMPTY_TRENDS), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body.run), { status: body.state === 'ready' ? 200 : 202 }),
    );
  });
  vi.stubGlobal('fetch', fetchSpy);

  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/compare`]}>
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
            <Route path="compare" element={<RunCompare />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...utils, fetchSpy };
}

afterEach(cleanup);

describe('RunCompare — terminal gate (MINOR 5)', () => {
  it.each(['pending', 'parsing', 'running'] as const)(
    'withholds the comparison while the run is %s, the same wording RunTrends uses',
    (status) => {
      renderCompare(processing(status));
      expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/compare/i);
    },
  );

  it('does not fetch /trends while the run this page compares FROM is not terminal', () => {
    const { fetchSpy } = renderCompare(processing('running'));
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trends'))).toBe(false);
  });

  it('fetches /trends once the run is terminal', async () => {
    const { fetchSpy } = renderCompare({ state: 'ready', run: COMPLETE_RUN });
    await screen.findByText(/nothing to compare yet/i);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trends'))).toBe(true);
  });
});
