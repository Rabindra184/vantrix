import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing, RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunCompare from '../src/routes/RunCompare';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * MINOR 5. `/runs/:runId/compare` is a sixth `<Outlet/>` child under
 * `RunShell`, and it has to follow the same terminal gate as the rest of the
 * run sections. Before this fix, `trendsQuery` fired with no `terminal` gate
 * at all — the same class of defect the other sections were audited for, just
 * on the compare route.
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

// `test` is REQUIRED by TrendsResponseSchema, and `apiFetch` parses through
// it — a fixture missing it fails validation and the component renders its
// error state, which is why leaving it out made two cases fail looking for
// prose that was never reached.
const EMPTY_TRENDS = {
  runId: RUN_ID,
  simulation: COMPLETE_RUN.simulation,
  test: { id: '99999999-9999-4999-8999-999999999999', slug: 'example-paritysimulation', name: 'example.ParitySimulation' },
  cohortSize: 1,
  runs: [],
};

function processing(status: RunProcessing['status']) {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

function renderCompare(body: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), body);

  // `current` is what the `/v1/runs/:id` stub answers with — a MUTABLE
  // reference, not the `body` parameter closed over at call time, because
  // `runQueryKey` has no `staleTime` (`pollIntervalFor` needs it
  // refetchable) and mounting this component fires a background refetch
  // immediately. Without this, that refetch resolves with the ORIGINAL body
  // some time after `rerenderAs` has already written the NEW one, and
  // "whichever write resolves last" wins — silently reverting the
  // transition `rerenderAs` exists to prove survives.
  // `RunTrends.live.test.tsx`'s `renderTrends` solves the identical race the
  // identical way.
  let current = body;
  const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>(async (input) => {
    const url = String(input);
    if (url.includes('/trends')) {
      return new Response(JSON.stringify(EMPTY_TRENDS), { status: 200 });
    }
    // Reads `current` AFTER a microtask, not at call time — see the comment
    // above on why the read has to be deferred for a same-tick `rerenderAs`
    // to win the race.
    await Promise.resolve();
    return new Response(JSON.stringify(current.run), { status: current.state === 'ready' ? 200 : 202 });
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

  return {
    ...utils,
    client,
    fetchSpy,
    /** Re-seeds the SAME client's cache and flushes the resulting re-render —
     *  exactly what `RunDetail`'s own poll does when a run's status changes. */
    async rerenderAs(nextBody: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse }) {
      current = nextBody;
      await act(async () => {
        client.setQueryData(runQueryKey(RUN_ID), nextBody);
      });
    },
  };
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

  /**
   * THE TRANSITION THIS FIX ROUND'S GAP LEFT UNGUARDED. Every hook in
   * `RunCompare` sits above its `!terminal` early return today, but nothing
   * PINS that shape — each case above mounts a single, fixed state, so
   * moving the return above even one hook (e.g. `useQueries` for
   * `seriesResults`) would still pass all of them and only break on an
   * already-mounted instance whose `terminal` flips false -> true,
   * "Rendered more hooks than during the previous render."
   * `RunTrends.live.test.tsx`'s "survives a running run finishing while the
   * reader is on this tab" is the identical guard for that tab; this is
   * `RunCompare`'s own — the compare route needs the same hook-order guard.
   */
  it('survives a running run finishing while the reader is on this tab', async () => {
    const { rerenderAs } = renderCompare(processing('running'));
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/compare/i);

    await expect(rerenderAs({ state: 'ready', run: COMPLETE_RUN })).resolves.toBeUndefined();

    // Past the withheld notice now — the real (empty-cohort) content.
    await waitFor(() => expect(screen.queryByTestId('live-notice-withheld')).toBeNull());
    expect(await screen.findByText(/nothing to compare yet/i)).toBeInTheDocument();
  });
});
