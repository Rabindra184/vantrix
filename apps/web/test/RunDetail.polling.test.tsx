import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_CAP_MS, POLL_INTERVAL_MS, fetchRun } from '../src/api/run.js';
import RunDetail from '../src/routes/RunDetail.js';

/**
 * The polling cap's WIRING — the `useEffect` in `RunDetail` that flips
 * `capReached` from false to true — driven through a real mount.
 *
 * Historically this was the hole `apps/web/test/run-detail.test.ts` documented
 * at length and could not close on its own; that file rendered `Processing`
 * directly with `capReached` passed in as a prop, covering the cap's COPY but
 * never the thing that sets the flag. `Processing` (and that whole file) is
 * gone now (Task 7): `RunDetail` renders `RunShell` for every state, and BOTH
 * halves of the cap's own copy — "checks again every few seconds…" before it,
 * "stopped checking automatically…" plus the retry button after — live in
 * `LiveStatusStrip` (fix round 1), which `RunShell` mounts unconditionally on
 * which tab is open. This file can see both without nesting any tab route at
 * all: `LiveStatusStrip` sits beside the `<Outlet/>`, not inside it.
 *
 * ONE COMPONENT OWNS BOTH SENTENCES DELIBERATELY (fix round 1). A first
 * attempt put the "checks again" half in `WaitingPanel` instead, mounted by a
 * tab under the `<Outlet/>` — which cannot see `capReached` (no tab's outlet
 * context carries it) and so kept promising "there is nothing to do" directly
 * under `LiveStatusStrip`'s OWN capped block once the cap had, in fact, fired.
 * Putting both in `LiveStatusStrip` makes them structurally exclusive, which
 * is exactly what this file's first case pins across the whole transition.
 *
 * `apps/web/test/run.test.ts` covers `pollIntervalFor` as a pure function, so
 * it covers the cap's DECISION but never the thing that feeds it.
 *
 * What makes THIS closeable is the jsdom environment routed to this file by
 * `environmentMatchGlobs` in vitest.config.ts, plus fake timers: the two real
 * minutes the cap needs cost nothing when the clock is ours.
 */

// `vi.mock` factories are hoisted above every `const` in this file, so a bare
// `const RUN_ID` referenced inside one is a temporal-dead-zone ReferenceError
// at factory-evaluation time. `vi.hoisted` is what lifts the value with it.
const { RUN_ID } = vi.hoisted(() => ({ RUN_ID: '00000000-0000-4000-8000-000000000001' }));

/**
 * A run that NEVER settles, so elapsed time is the only thing that can stop
 * the polling — exactly the case POLL_CAP_MS exists for.
 *
 * The specifier is `'../src/api/run.js'` while `RunDetail.tsx` imports
 * `'../api/run'` (no extension). Those are different strings but the same
 * module: Vite resolves both to `apps/web/src/api/run.ts`, and `vi.mock` keys
 * on the RESOLVED id. That is not assumed here — the first assertion below
 * proves the mock is in effect by requiring that this spy was actually the
 * function the component called. Without that check a mock that silently
 * failed to apply would let `fetchRun` reach the network, and the test would
 * pass or fail for reasons having nothing to do with the cap.
 */
vi.mock('../src/api/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run.js')>()),
  fetchRun: vi.fn(async () => ({
    state: 'processing' as const,
    run: { id: RUN_ID, status: 'pending' as const, statusUrl: `/v1/runs/${RUN_ID}` },
  })),
}));

/**
 * The socket is out of scope here and must not open: jsdom 30's own
 * `WebSocket` makes a REAL network connection (CLAUDE.md's jsdom/undici
 * warning, one layer down), and the `running` case below would otherwise
 * dial one on every mount. `lastDelta: null` also keeps `RunDetail` on the
 * `Processing` branch, so what this file asserts stays what it has always
 * asserted — the cap's copy and the requests it does or does not make.
 */
vi.mock('../src/api/live.js', () => ({
  useLiveRun: vi.fn(() => ({ connected: false, lastDelta: null, unauthorized: false, partial: false })),
}));

const fetchRunMock = vi.mocked(fetchRun);

function renderDetail() {
  // `retry: false` so a mistake in the mock surfaces as one failed query
  // rather than three retries the fake clock has to be advanced through.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Let every pending promise and every due timer run inside React's act(). */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function processingBody(status: 'pending' | 'parsing' | 'running') {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

beforeEach(() => {
  fetchRunMock.mockClear();
  // The IMPLEMENTATION too, not just the calls: `mockClear` leaves whatever a
  // previous test installed in place, and the live-run case below swaps in one
  // whose answer changes mid-test.
  fetchRunMock.mockImplementation(async () => processingBody('pending'));
  vi.useFakeTimers();
});

afterEach(() => {
  // Unmount BEFORE the clock goes real: cleanup runs the effect teardown that
  // clears the cap timer, and that teardown belongs to the fake clock.
  cleanup();
  vi.useRealTimers();
});

describe('RunDetail — the polling cap, through a real mount', () => {
  it('stops polling and says so once the cap elapses', async () => {
    renderDetail();
    await advance(0);

    // THE MOCK IS IN EFFECT. If `vi.mock` had not intercepted the specifier
    // the component imports, the real `fetchRun` would have run and this spy
    // would show zero calls — so this is the guard that makes everything
    // below meaningful, not a redundant sanity check.
    expect(fetchRunMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchRunMock).toHaveBeenCalledWith(RUN_ID);

    // Before the cap the page is still asking on its own, and says so —
    // `LiveStatusStrip`'s own copy now (fix round 1), not `Processing`'s.
    expect(screen.queryByText(/stopped checking automatically/i)).toBeNull();
    expect(screen.getByText(/checks again every few seconds/i)).not.toBeNull();

    // It really is polling — otherwise "polling stops" below would be
    // vacuously true of a page that never polled at all.
    const beforeCap = fetchRunMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchRunMock.mock.calls.length).toBeGreaterThan(beforeCap);

    await advance(POLL_CAP_MS + 1);

    // The cap's UI, reached through the component's own timer rather than
    // handed in as a prop. The promise from the OTHER branch must be GONE,
    // not merely joined — `LiveStatusStrip` makes the two mutually exclusive
    // by construction (its own docstring), pinned here across a REAL
    // transition rather than only in two separate `LiveStatusStrip.test.tsx`
    // cases.
    expect(screen.getByText(/stopped checking automatically/i)).not.toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).not.toBeNull();
    expect(screen.queryByText(/checks again every few seconds/i)).toBeNull();

    // And the requests have actually stopped, which is the point of the cap.
    // A page that said "stopped checking" while still checking would be
    // exactly as wrong as one that kept checking silently.
    const atCap = fetchRunMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(fetchRunMock.mock.calls.length).toBe(atCap);
  });

  /**
   * The reset half of the same effect. `[runId]` says this component instance
   * can outlive the run it was showing — two `/runs/:runId` locations in a row
   * with no unmount — and without `setCapReached(false)` the second run paints
   * "stopped checking automatically" immediately and never polls once.
   *
   * Driven through a real router navigation rather than a re-render with new
   * props: `createMemoryRouter` + `router.navigate` changes the location the
   * way a clicked <Link> does, and because both locations match the SAME route
   * the element is reconciled rather than remounted — which is the only way to
   * reach the branch this test is about.
   */
  it('a second run opened after the first hit the cap starts uncapped', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: '/runs/:runId', element: <RunDetail /> }], {
      initialEntries: [`/runs/${RUN_ID}`],
    });

    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await advance(POLL_CAP_MS + 1);
    expect(screen.getByText(/stopped checking automatically/i)).not.toBeNull();

    const second = '00000000-0000-4000-8000-000000000002';
    await act(async () => {
      await router.navigate(`/runs/${second}`);
    });
    await advance(0);

    expect(screen.queryByText(/stopped checking automatically/i)).toBeNull();
    expect(screen.getByText(/checks again every few seconds/i)).not.toBeNull();
    expect(fetchRunMock).toHaveBeenCalledWith(second);
  });

  /**
   * A SOAK RUN IS NOT A STUCK RUN, and the cap could not tell them apart.
   *
   * Two minutes was a parse wait; part 2b hung the live page off the same
   * `processing` branch. For any run longer than that — every run this
   * feature exists for — polling stopped while the run was still streaming,
   * so `run.data` froze at `status: 'running'` forever and the page never
   * reached the finalizing banner or the finished report at all.
   *
   * The second half is why this test does not stop at the flip: the cap
   * TIMER has to restart when streaming stops. A cap that merely stayed
   * armed through a two-hour run would fire in its third minute and leave
   * polling already dead at the one moment REST finally has something new
   * to say.
   */
  it('never caps a streaming run, and starts the cap clock over when it stops streaming', async () => {
    let status: 'running' | 'parsing' = 'running';
    fetchRunMock.mockImplementation(async () => processingBody(status));

    renderDetail();
    await advance(0);

    await advance(POLL_CAP_MS + 1);
    // Well past the cap and still asking — the defect was that this stopped.
    expect(screen.queryByText(/stopped checking automatically/i)).toBeNull();
    const pastCap = fetchRunMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchRunMock.mock.calls.length).toBeGreaterThan(pastCap);

    // The run stops streaming. One poll picks that up.
    status = 'parsing';
    await advance(POLL_INTERVAL_MS);

    // The cap clock started over HERE, not hours ago: the finalizing page
    // gets its own full window to reach the finished report.
    const atFlip = fetchRunMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchRunMock.mock.calls.length).toBeGreaterThan(atFlip);
    expect(screen.queryByText(/stopped checking automatically/i)).toBeNull();

    // And it still ends: a run that stopped streaming and never finalized is
    // exactly the stuck run the cap was written for.
    await advance(POLL_CAP_MS + 1);
    expect(screen.getByText(/stopped checking automatically/i)).not.toBeNull();
    const atCap = fetchRunMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(fetchRunMock.mock.calls.length).toBe(atCap);
  });
});
