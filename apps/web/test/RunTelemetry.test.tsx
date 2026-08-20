import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunProcessing, RunResponse, TelemetryResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import RunTelemetry from '../src/routes/RunTelemetry';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

const COMPLETE_RUN: RunResponse = {
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

/**
 * `RunTelemetry` reads its window through `useOutletContext` (`useRunWindow.ts`
 * — "the window travels down, it is not re-parsed per tab"), so it has to be
 * mounted under something that provides one, the way `RunShell`'s real
 * `<Outlet context={{ window }} />` does. This stands in for that shell with
 * the one value every test here needs: no window selected.
 *
 * `status` seeds the SAME `runQueryKey` cache `useRunTerminal`'s own read
 * consumes, defaulting to `'complete'` — every case here before Task 11
 * implicitly assumed a terminal run (there was no run-detail concept in this
 * component at all), and that default keeps them all asserting the same
 * thing they always did.
 */
function renderRunTelemetry(
  response: TelemetryResponse,
  options: { readonly status?: RunProcessing['status'] | 'complete' } = {},
) {
  const status = options.status ?? 'complete';
  const detail =
    status === 'complete'
      ? { state: 'ready' as const, run: COMPLETE_RUN }
      : { state: 'processing' as const, run: { id: RUN, status, statusUrl: `/v1/runs/${RUN}` } };

  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/telemetry')) {
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }
    if (url === `/v1/runs/${RUN}`) {
      return Promise.resolve(
        new Response(JSON.stringify(detail.run), { status: detail.state === 'ready' ? 200 : 202 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN), detail);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN}/load-generators`]}>
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
            <Route path="load-generators" element={<RunTelemetry />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, a leftover tree from an earlier render collides with the next.
afterEach(() => {
  cleanup();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

type Point = TelemetryResponse['hosts'][number]['points'][number];

function point(overrides: Partial<Point> = {}): Point {
  return {
    startOffsetMs: 0,
    cpuTotalPct: 10,
    cpuUserPct: 6,
    cpuSystemPct: 4,
    memUsedBytes: 1024 * 1024,
    memTotalBytes: 4 * 1024 * 1024,
    rxBytesPerSec: 100,
    txBytesPerSec: 200,
    inSegsPerSec: 5,
    outSegsPerSec: 6,
    retransSegsPerSec: 0,
    inErrsPerSec: 0,
    activeOpensPerSec: 1,
    passiveOpensPerSec: 0,
    tcpStates: { ESTABLISHED: 3 },
    ...overrides,
  };
}

function host(name: string, clockSkewMs: number, cpuTotalPct: number): TelemetryResponse['hosts'][number] {
  return { host: name, clockSkewMs, points: [point({ cpuTotalPct })] };
}

/**
 * `chart-data-telemetry-cpu`'s wrapper `<div>` exists in BOTH states this
 * page can be in — `Payload`'s own loading branch renders `Undrawn`, which
 * carries the same testid with an empty table — so `findByTestId` alone
 * settles on the FIRST render and proves nothing about which state that was.
 * Waiting for the one real value only the resolved chart draws is what
 * actually waits for the fetch.
 */
async function waitForResolvedCpu(expectedValue: number) {
  await waitFor(() => {
    expect(screen.getByTestId('chart-data-telemetry-cpu')).toHaveTextContent(String(expectedValue));
  });
}

describe('RunTelemetry', () => {
  it('renders the empty state and no figure when the agent never reported', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: false,
      bucketWidthMs: 1000,
      window: null,
      hosts: [],
    });

    // The exact phrase Task 11's e2e suite matches — see RunTelemetry.tsx.
    expect(await screen.findByText(/no telemetry was recorded for this run/i)).toBeInTheDocument();

    // Not a chart with nothing in it: NO figure on the page at all, which is
    // the whole reason `available: false` gets a dedicated branch rather than
    // six charts each explaining themselves.
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it('says telemetry arrives when the run finishes, not that the agent was silent', async () => {
    // `available: false` is already what the endpoint answers for a run with
    // a null `toolStartedAt` — every non-terminal run. The existing copy
    // blames the agent, which is wrong here: nothing has failed, the window
    // does not exist yet.
    renderRunTelemetry(
      { runId: RUN, available: false, bucketWidthMs: 1000, window: null, hosts: [] },
      { status: 'running' },
    );
    expect(await screen.findByText(/once the run finishes/i)).toBeInTheDocument();
    expect(screen.queryByText(/no load generator reported/i)).toBeNull();
  });

  it('renders a "Load generator" combobox for two hosts, defaulting to the first', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 11), host('gen-2', 0, 99)],
    });

    await screen.findByRole('combobox', { name: /load generator/i });

    const cpuTable = screen.getByTestId('chart-data-telemetry-cpu');
    expect(cpuTable).toHaveTextContent('11');
    expect(cpuTable).not.toHaveTextContent('99');
  });

  it('switches every chart to the second host once it is selected', async () => {
    const user = userEvent.setup();
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 11), host('gen-2', 0, 99)],
    });

    const select = await screen.findByRole('combobox', { name: /load generator/i });
    await user.selectOptions(select, 'gen-2');

    const cpuTable = screen.getByTestId('chart-data-telemetry-cpu');
    expect(cpuTable).toHaveTextContent('99');
    expect(cpuTable).not.toHaveTextContent('11');
  });

  it('hides the host select when there is exactly one load generator', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 10)],
    });

    await waitForResolvedCpu(10);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('warns past the clock-skew threshold, naming the generator behind the server', async () => {
    // Positive: the docstring's "behind" branch. `CLOCK_SKEW_WARN_MS` is
    // 5_000; this is comfortably past it.
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 6_000, 10)],
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/gen-1/);
    expect(banner).toHaveTextContent(/behind/i);
  });

  it('warns of a large NEGATIVE skew as the generator being ahead of the server', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', -6_000, 10)],
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/ahead of/i);
  });

  it('says nothing for a skew under the threshold', async () => {
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 200, 10)],
    });

    // Wait for the chart data to land before asserting an absence, so this
    // is not passing because the fetch simply had not resolved yet — every
    // chart's OWN loading placeholder also carries `role="status"`
    // ("Loading…"), so a query taken before resolution would find those
    // instead and pass for the wrong reason.
    await waitForResolvedCpu(10);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  /**
   * THE HOOK-ORDER BUG THIS FIX ROUND CLOSES (pre-existing, not introduced by
   * Task 11 — `useRunTerminal` was correctly placed above this gate). The
   * `compact && !shown` early return used to sit ABOVE `useQuery`/
   * `useState(selectedHost)`, so a phone reader pressing "Show it anyway"
   * flipped `shown` false -> true on the SAME mounted instance and the
   * following render called two hooks the previous one never reached —
   * "Rendered more hooks than during the previous render." A test that only
   * mounted compact and non-compact SEPARATELY could not catch this: the bug
   * is in the transition between two renders of the same fiber.
   */
  it('survives pressing "Show it anyway" on a narrow viewport', async () => {
    useIsCompactMock.mockReturnValue(true);
    const user = userEvent.setup();
    renderRunTelemetry({
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 10)],
    });

    const show = await screen.findByTestId('desktop-only-show');
    await expect(user.click(show)).resolves.toBeUndefined();

    expect(screen.queryByTestId('desktop-only')).not.toBeInTheDocument();
    await waitForResolvedCpu(10);
  });

  /**
   * CRITICAL 1, and its own regression test. `RunTelemetry` was the one tab
   * whose query was never gated on `terminal` — `telemetryQuery` carries
   * `staleTime: Infinity` (`api/metrics.ts`), so a live run's honest
   * `available: false` used to be fetched, cached FOREVER under
   * `telemetryQueryKey`, and then silently relabelled as "no load generator
   * reported" the moment the run went terminal, with nothing ever
   * refetching it. No per-tab fetch spy existed anywhere in the repo before
   * this fix round — the no-fetch-while-live rule was pinned only in
   * `RunShell.test.tsx` and `RunTrends.live.test.tsx` — which is exactly why
   * this specific bug shipped with no test failing red for it. This case is
   * the regression test for that whole class, on the one tab that actually
   * had it wrong.
   */
  it('does not fetch /telemetry while the run is not terminal', () => {
    const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>((input) => {
      const url = String(input);
      if (url === `/v1/runs/${RUN}`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: RUN, status: 'running', statusUrl: `/v1/runs/${RUN}` }),
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(runQueryKey(RUN), {
      state: 'processing',
      run: { id: RUN, status: 'running', statusUrl: `/v1/runs/${RUN}` },
    });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN}/load-generators`]}>
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
              <Route path="load-generators" element={<RunTelemetry />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/telemetry'))).toBe(false);
  });

  /**
   * THE TRANSITION THIS FIX ROUND'S GAP LEFT UNGUARDED. Every hook in
   * `RunTelemetry` sits above its `!terminal` early return today, but
   * nothing PINS that shape — every other case in this file mounts a
   * single, fixed state, so moving the return above even one hook (e.g.
   * `useState(selectedHost)`) would still pass all of them and only break
   * on an already-mounted instance whose `terminal` flips false -> true,
   * "Rendered more hooks than during the previous render."
   * `RunTrends.live.test.tsx`'s "survives a running run finishing while the
   * reader is on this tab" is the identical guard for that tab; this is
   * `RunTelemetry`'s own.
   *
   * It doubles as CRITICAL 1's own regression test for the TRANSITION
   * itself, not just the running state alone: `enabled: terminal` means
   * `/telemetry` never fires while running, so the flip has to trigger a
   * FRESH fetch rather than surface a stale `available: false` cached from
   * before the fix existed — a bare "does not throw" would miss that
   * regression precisely because the old caching bug never threw either.
   */
  it('survives a running run finishing while the reader is on this tab', async () => {
    const readyTelemetry: TelemetryResponse = {
      runId: RUN,
      available: true,
      bucketWidthMs: 1000,
      window: null,
      hosts: [host('gen-1', 0, 42)],
    };

    // `current` is what the `/v1/runs/:id` stub answers with — a MUTABLE
    // reference, not a value closed over at call time, for the same reason
    // `RunTrends.live.test.tsx`'s `renderTrends` documents: `runQueryKey`
    // carries no `staleTime`, so mounting fires a background refetch
    // immediately, and reading `current` only after a microtask is what lets
    // the synchronous cache write below land first instead of losing to that
    // stale in-flight response resolving after it.
    let current: { state: 'processing'; run: { id: string; status: RunProcessing['status']; statusUrl: string } } | {
      state: 'ready';
      run: RunResponse;
    } = { state: 'processing', run: { id: RUN, status: 'running', statusUrl: `/v1/runs/${RUN}` } };

    const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.includes('/telemetry')) {
        return new Response(JSON.stringify(readyTelemetry), { status: 200 });
      }
      if (url === `/v1/runs/${RUN}`) {
        await Promise.resolve();
        return new Response(JSON.stringify(current.run), { status: current.state === 'ready' ? 200 : 202 });
      }
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(runQueryKey(RUN), current);

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN}/load-generators`]}>
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
              <Route path="load-generators" element={<RunTelemetry />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/once the run finishes/i)).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/telemetry'))).toBe(false);

    current = { state: 'ready', run: COMPLETE_RUN };
    await act(async () => {
      client.setQueryData(runQueryKey(RUN), current);
    });

    // Past the "wait" wording now, and — CRITICAL 1's own regression — a
    // FRESH fetch actually landed, not a stale `available: false` cached
    // from the running state.
    await waitFor(() => expect(screen.queryByText(/once the run finishes/i)).toBeNull());
    await waitForResolvedCpu(42);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/telemetry'))).toBe(true);
  });
});
