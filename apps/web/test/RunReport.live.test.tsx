import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveDelta,
  RunProcessing,
  SeriesResponse,
  UsersResponse,
} from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import { seriesQuery, usersQuery } from '../src/api/metrics';
import type { LiveRunState } from '../src/api/live';
import RunReport from '../src/routes/RunReport';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

/**
 * `RunReport`'s live branch — what the Charts tab's live branch (Task 9) became
 * when its charts moved into the Report's sections.
 *
 * Mounted the same way `RunSummary.live.test.tsx` mounts its own page —
 * a stand-in `<Outlet context={{...}} />` for `RunShell`, plus a pre-seeded
 * `run` query cache so the assertions below need no `await` beyond a click.
 *
 * `users`/`series` are seeded DIRECTLY into the query cache under the exact
 * keys `useLiveRun`'s `applyDelta` writes while a run streams — this file has
 * no real socket behind it, so the live branch's "read the cache, do not
 * fetch" contract has to be exercised by seeding what the socket would have
 * written, the same way `RunDetail.live.test.tsx` seeds `run` instead of
 * mocking a fetch that resolves asynchronously.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

afterEach(() => {
  cleanup();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function liveWith(overrides: Partial<LiveDelta['summary']> = {}): LiveRunState {
  return {
    connected: true,
    unauthorized: false,
    partial: false,
    lastDelta: {
      runId: RUN_ID,
      seq: 1,
      summary: {
        count: 0,
        okCount: 0,
        koCount: 0,
        errorRate: 0,
        percentiles: {},
        maxUsers: 0,
        durationMs: 30_000,
        ...overrides,
      },
      responseTime: { widthMs: 1000, replaces: true, buckets: [] },
      users: { widthMs: 1000, buckets: [] },
      errors: { rows: [] },
      // Required by `LiveDeltaSchema` since the live-SLA merge; empty because
      // nothing in this file asserts on the banner. `RunShell.test.tsx` owns
      // that, since `RunShell` is where `SlaBanner` renders.
      sla: { evaluated: 0, notJudged: 0, rulesUnavailable: false, breaching: [] },
    },
  };
}

const EMPTY_USERS: UsersResponse = { runId: RUN_ID, window: null, scenarios: [], total: [] };
const EMPTY_SERIES: SeriesResponse = {
  runId: RUN_ID,
  scope: 'run',
  name: '',
  family: 'response_time',
  bucketWidthMs: 1000,
  startedSplitAvailable: true,
  groupSeriesAvailable: false,
  window: null,
  buckets: [],
};

function renderCharts({
  live,
  status = 'running',
}: {
  readonly live: LiveRunState | null;
  readonly status?: RunProcessing['status'];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run: RunProcessing = { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` };
  client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
  // The two caches `useLiveRun`'s `applyDelta` would have written directly —
  // this SAME key (`window` is always `null` for a live view) is what the
  // component's own `users`/`series` queries read despite `enabled: false`.
  client.setQueryData(usersQuery(RUN_ID, null).queryKey, EMPTY_USERS);
  client.setQueryData(seriesQuery(RUN_ID, 'run', '', 'response_time', null).queryKey, EMPTY_SERIES);
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(run), { status: 202 })));

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/report`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  { window: null, durationMs: null, liveDurationMs: null, warmupMs: null, live } satisfies RunWindowContext
                }
              />
            }
          >
            <Route path="report" element={<RunReport />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunReport — live', () => {
  it('draws the live figures and states the five that are withheld', async () => {
    renderCharts({ live: liveWith({ count: 1200 }) });

    // Requests opens first: the two charts a live run has a source for. Each
    // renders a `<figure>` even from an empty payload, which is what proves
    // this branch reads `series.data` rather than skipping the charts.
    const requests = screen.getByTestId('section-requests');
    expect(within(requests).getAllByRole('figure').map((f) => f.getAttribute('data-testid'))).toEqual([
      'chart-requests-and-responses',
      'chart-percentiles',
    ]);

    // The other five Requests figures are STATED, never left as a gap — and
    // Errors per second is among them now: it lives in this section.
    const withheld = within(requests).getAllByTestId('live-notice-withheld').map((n) => n.textContent ?? '');
    expect(withheld).toHaveLength(5);
    for (const subject of [
      'Response time distribution',
      'Response time percentiles distribution',
      'Errors per second',
      'Response time ranges',
      'Number of requests',
    ]) {
      expect(withheld.filter((text) => text.includes(subject))).toHaveLength(1);
    }

    // Virtual users reads the cache the live delta writes, so it draws too —
    // in GE's order, the ended-per-second chart included.
    await userEvent.click(screen.getByRole('button', { name: 'Virtual users' }));
    const users = screen.getByTestId('section-virtual-users');
    expect(within(users).getAllByRole('figure').map((f) => f.getAttribute('data-testid'))).toEqual([
      'chart-user-start-rate',
      'chart-user-end-rate',
      'chart-concurrent-users',
    ]);
  });

  it('shows the waiting panel before any delta has arrived', () => {
    renderCharts({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  /**
   * Closes `RunDetail.live.test.tsx`'s "Task 9: gates the live charts and
   * their withheld notices behind DesktopOnly" `it.todo` — §22.6 applies to
   * the live branch exactly as it does to the terminal 8-chart grid.
   */
  it('gates the live charts behind DesktopOnly on a narrow viewport', () => {
    useIsCompactMock.mockReturnValue(true);
    renderCharts({ live: liveWith({ count: 1200 }) });
    expect(screen.getByTestId('desktop-only')).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(screen.queryByTestId('live-notice-withheld')).toBeNull();
  });

  /**
   * TEST GAP CLOSER (whole-branch review). No per-tab fetch spy existed
   * before this fix round — the no-fetch-while-live rule was pinned only in
   * `RunShell.test.tsx` and `RunTrends.live.test.tsx`, and `RunTelemetry.tsx`
   * (CRITICAL 1) turned out to be exactly the one section no spy was watching.
   * This is the Report's own: every section's queries are gated on `terminal`,
   * so none of them should reach `fetch` while the run is live — and the spy
   * opens EVERY section first, because a shut section builds nothing and so
   * proves nothing about whether its gate holds.
   */
  it('does not fetch any metric while the run is not terminal, in any section', async () => {
    const fetchSpy = vi.fn<(input: RequestInfo) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id: RUN_ID, status: 'running', statusUrl: `/v1/runs/${RUN_ID}` }),
          { status: 202 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run: RunProcessing = { id: RUN_ID, status: 'running', statusUrl: `/v1/runs/${RUN_ID}` };
    client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
    client.setQueryData(usersQuery(RUN_ID, null).queryKey, EMPTY_USERS);
    client.setQueryData(seriesQuery(RUN_ID, 'run', '', 'response_time', null).queryKey, EMPTY_SERIES);

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/report`]}>
          <Routes>
            <Route
              path="/runs/:runId"
              element={
                <Outlet
                  context={
                    {
                      window: null, durationMs: null, liveDurationMs: null, warmupMs: null,
                      live: liveWith({ count: 1200 }),
                    } satisfies RunWindowContext
                  }
                />
              }
            >
              <Route path="report" element={<RunReport />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    for (const title of ['Groups', 'Virtual users', 'Connections', 'Load generators']) {
      await userEvent.click(screen.getByRole('button', { name: title }));
    }
    // Every section really is open, so the assertions below are about built
    // bodies and not about shut ones.
    for (const title of ['Requests', 'Groups', 'Virtual users', 'Connections', 'Load generators']) {
      expect(screen.getByRole('button', { name: title })).toHaveAttribute('aria-expanded', 'true');
    }

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    for (const path of ['/stats', '/users', '/distribution', '/series', '/errors', '/telemetry']) {
      expect(urls.some((u) => u.includes(path)), path).toBe(false);
    }
  });
});
