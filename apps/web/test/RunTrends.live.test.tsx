import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing, RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunTrends from '../src/routes/RunTrends';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

/**
 * `RunTrends`'s live branch (Task 11) — a running run has no statistics row
 * of its own yet, so there is nothing for `/trends` to plot a point from.
 *
 * Mounted the same way `RunTelemetry.test.tsx` mounts its own tab under a
 * stand-in for `RunShell`'s `<Outlet context={{...}} />`, with the `run`
 * query cache pre-seeded so `useRunTerminal`'s read resolves synchronously.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

afterEach(() => {
  cleanup();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';

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

/**
 * Exposes `client` (so a test can drive `setQueryData` on the SAME mounted
 * tree, the way a real poll does) rather than only the render `utils` —
 * `RunDetail.live.test.tsx`'s `mountRun`/`rerenderAs` uses the identical
 * shape for the identical reason: a status TRANSITION on one instance is a
 * different thing from mounting two separate instances in two different
 * states, and only the former can catch a hook-order bug.
 */
function renderTrends(body: ReturnType<typeof processing> | { state: 'ready'; run: RunResponse }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), body);
  // `current` is what the fetch stub answers with — a MUTABLE reference, not
  // the `body` parameter closed over at call time, because `runQueryKey` has
  // no `staleTime` (`pollIntervalFor` needs it refetchable) and mounting this
  // component fires a background refetch immediately. Without this, that
  // refetch resolves with the ORIGINAL body some time after `rerenderAs` has
  // already written the NEW one, and "whichever write resolves last" wins —
  // silently reverting the transition this test exists to prove survives.
  // `RunDetail.live.test.tsx`'s `mountRun`/`rerenderAs` solves the identical
  // race the identical way (updating its mock's resolved value alongside the
  // cache write).
  let current = body;
  vi.stubGlobal('fetch', async (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/trends')) {
      return new Response(JSON.stringify(EMPTY_TRENDS), { status: 200 });
    }
    // Reads `current` AFTER a microtask, not at call time — the un-`staleTime`'d
    // `runQueryKey` query fires a background refetch on MOUNT, and that call
    // happens before a same-tick `rerenderAs` gets a chance to reassign
    // `current`. Deferring the read is what lets the reassignment (synchronous,
    // and therefore ordered before any microtask this function itself queues)
    // land first, so this in-flight fetch resolves with the run's LATEST body
    // instead of the one that existed when it was called.
    await Promise.resolve();
    const status = current.state === 'ready' ? 200 : 202;
    return new Response(JSON.stringify(current.run), { status });
  });

  const utils = render(
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

  return {
    ...utils,
    client,
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

describe('RunTrends — live', () => {
  it.each(['pending', 'parsing', 'running'] as const)(
    'states that trends are withheld while the run is %s',
    (status) => {
      renderTrends(processing(status));
      expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/trends/i);
    },
  );

  it('does not fetch /trends while the run is not terminal', () => {
    const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === `/v1/runs/${RUN_ID}`) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: RUN_ID, status: 'running', statusUrl: `/v1/runs/${RUN_ID}` }), {
            status: 202,
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(runQueryKey(RUN_ID), processing('running'));
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

  /**
   * THE CRASH THIS FIX ROUND CLOSES. `terminal` flips false -> true on an
   * ALREADY-MOUNTED instance exactly like this — `RunDetail`'s poll writes
   * the shared `runQueryKey` cache entry, this component re-renders, and
   * before the fix that re-render called `useQuery` for the first time
   * (having skipped it on every earlier render, past the `!terminal` early
   * return) — "Rendered more hooks than during the previous render." A test
   * that only mounted `running` and `complete` SEPARATELY could not catch
   * this: the bug is in the TRANSITION between two mounts of the same fiber,
   * not in either state alone.
   */
  it('survives a running run finishing while the reader is on this tab', async () => {
    const { rerenderAs } = renderTrends(processing('running'));
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/trends/i);

    await expect(rerenderAs({ state: 'ready', run: COMPLETE_RUN })).resolves.toBeUndefined();

    // Past the withheld notice now — the real (empty) trends content.
    await waitFor(() => expect(screen.queryByTestId('live-notice-withheld')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Trends' })).toBeInTheDocument();
  });

  /**
   * THE SAME BUG'S OTHER TRIGGER: `wanted` (`!compact || shown`) flipping in
   * place when a phone reader presses "Show it anyway", not only `terminal`
   * flipping. Both transitions used to change how many hooks a render
   * called; this covers the one `terminal` alone would not.
   */
  it('survives pressing "Show it anyway" on a narrow viewport', async () => {
    useIsCompactMock.mockReturnValue(true);
    const user = userEvent.setup();
    renderTrends({ state: 'ready', run: COMPLETE_RUN });

    const show = await screen.findByTestId('desktop-only-show');
    await expect(user.click(show)).resolves.toBeUndefined();

    expect(screen.queryByTestId('desktop-only')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Trends' })).toBeInTheDocument();
  });
});
