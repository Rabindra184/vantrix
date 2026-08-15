import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse } from '@perfportal/contracts';
import RunShell from '../src/routes/RunShell';

afterEach(cleanup);

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
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

const EMPTY_USERS = { runId: RUN.id, scenarios: [], total: [] };

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunShell run={RUN} />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * `RunShell` is what actually feeds `RunTabs` its `errorCount`, and nothing
 * before this test rendered it: `RunTabs.test.tsx` only ever exercised the
 * prop directly, never the `errors.data?.errors.length ?? 0` expression that
 * used to compute it — which is exactly the line that collapsed "not yet
 * known" and "genuinely none" into the same `Errors (0)`.
 */
describe('RunShell', () => {
  it('renders a bare Errors tab before the errors payload has resolved, not Errors (0)', () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));

    renderShell();

    expect(screen.getByRole('link', { name: 'Errors' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Errors \(/ })).not.toBeInTheDocument();
  });

  it('shows the resolved distinct-message count once the errors payload arrives', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/errors')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              runId: RUN.id,
              errors: [
                { message: 'boom', count: 15 },
                { message: 'bang', count: 9 },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 }));
    });

    renderShell();

    expect(await screen.findByRole('link', { name: 'Errors (2)' })).toBeInTheDocument();
  });

  it('renders a bare Errors tab when the errors fetch fails, not a confident zero', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/errors')) {
        return Promise.resolve(new Response('{}', { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 }));
    });

    renderShell();

    // No `Errors (…)` of any kind ever appears — including the specific
    // wrong answer `?? 0` used to produce, and produce permanently, since a
    // failed fetch never resolves `errors.data`.
    await screen.findByRole('link', { name: 'Errors' });
    expect(screen.queryByRole('link', { name: 'Errors (0)' })).not.toBeInTheDocument();
  });
});
