import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
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
import { RunChartsTab } from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

/**
 * `RunChartsTab`'s live branch (Task 9).
 *
 * Mounted the same way `RunOverviewTab.live.test.tsx` mounts its own tab —
 * a stand-in `<Outlet context={{...}} />` for `RunShell`, plus a pre-seeded
 * `run` query cache so the assertions below need no `await`.
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
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/charts`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  { window: null, durationMs: null, liveDurationMs: null, live } satisfies RunWindowContext
                }
              />
            }
          >
            <Route path="charts" element={<RunChartsTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunChartsTab — live', () => {
  it('draws the five live figures and states the two that are withheld', () => {
    renderCharts({ live: liveWith({ count: 1200 }) });

    // Five real figures — the same invariant the e2e suite proves with an
    // SVG count per figure (CLAUDE.md): `ConcurrentUsersChart`,
    // `UserStartRateChart`, `PercentilesChart`, `RequestRateChart` and
    // `ResponseRateChart` each render a `<figure>` even from an empty
    // payload, which is what proves this branch actually reads `users.data`/
    // `series.data` rather than skipping the charts entirely.
    expect(screen.getAllByRole('figure')).toHaveLength(5);

    // Errors per second is NOT here — its real chart lives on the Errors
    // tab, and a withheld notice belongs where its section belongs.
    const withheld = screen.getAllByTestId('live-notice-withheld').map((n) => n.textContent ?? '');
    expect(withheld).toHaveLength(2);
    expect(withheld.join(' ')).toMatch(/distribution/i);
    expect(withheld.join(' ')).not.toMatch(/errors per second/i);
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
});
