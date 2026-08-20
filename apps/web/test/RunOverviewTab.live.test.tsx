import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, RunProcessing } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import type { LiveRunState } from '../src/api/live';
import { RunOverviewTab } from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * `RunOverviewTab`'s live branch (Task 8).
 *
 * `RunDetail.live.test.tsx` already proves the "no delta yet" WaitingPanel
 * path (Task 7 fix round 1) and left several `it.todo`s naming this task for
 * everything past it — `LiveSummary`'s tiles reading straight off the delta,
 * the "still streaming" hint dropping once frozen, and the withheld
 * statistics notice. This file covers those, against the REAL tab rather
 * than a placeholder, the same way `RunTelemetry.test.tsx` mounts its own tab
 * under a stand-in for `RunShell`'s `<Outlet context={{...}} />` — this tab
 * reads both `run` (its own query, seeded below) and `live` (through
 * `useOutletContext`), so it needs a parent route providing the second and a
 * pre-populated cache for the first, not a real `RunShell`.
 */

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/** A `LiveRunState` carrying a `lastDelta` built from the given summary
 *  overrides — everything else defaulted to an honest, empty measurement. */
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

/**
 * `RunOverviewTab` under a stand-in shell, its own `run` query pre-seeded so
 * the assertions below need no `await` — `useQuery` reads pre-populated
 * cache data synchronously on first paint, the same approach
 * `RunDetail.live.test.tsx`'s `mountRun` uses for the identical reason.
 * `fetch` is stubbed to answer the SAME body, so the un-`staleTime`'d
 * background revalidation every mount fires resolves to something
 * consistent rather than to a network error.
 */
function renderOverview({
  live,
  status = 'running',
}: {
  readonly live: LiveRunState | null;
  readonly status?: RunProcessing['status'];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run: RunProcessing = { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` };
  client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(run), { status: 202 })));

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
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
            <Route index element={<RunOverviewTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunOverviewTab — live', () => {
  it('shows the live tiles while a run streams', () => {
    renderOverview({ live: liveWith({ count: 1200, errorRate: 0.02, maxUsers: 8 }) });
    // `formatCount` writes plain, ungrouped digits (StatisticsTable.tsx's own
    // docstring) — never a locale-grouped "1,200".
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('1200');
    expect(screen.getByTestId('live-stat-error-rate')).toHaveTextContent('2.00%');
    expect(screen.getByTestId('live-stat-peak-users')).toHaveTextContent('8');
  });

  it('states that the statistics table is withheld, rather than omitting it', () => {
    // Silent absence is what the withheld-notice pattern exists to replace: the
    // table needs per-endpoint rows the live wire excludes entirely, on any
    // path, so there is no live version of it at any viewport width.
    renderOverview({ live: liveWith({ count: 1 }) });
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/statistics/i);
  });

  it('shows the waiting panel for a pending run with no delta', () => {
    renderOverview({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByTestId('live-stat-total-requests')).toBeNull();
  });

  /**
   * The gap-closer `RunDetail.live.test.tsx` left as two `it.todo`s for this
   * task: `LiveSummary` stays on screen, unblanked, once the run leaves
   * `running` — `frozen` is read straight off `run.data.run.status`, not off
   * `live.connected`, so a socket drop mid-finalize cannot blank tiles that
   * are still the honest last-known numbers.
   */
  it('drops the "still streaming" hint once the run has frozen, without blanking the tiles', () => {
    // Scoped to the Duration tile's own `<div>` — `LiveNotice`'s own withheld
    // sentence ("this run is still streaming") also matches `/still
    // streaming/i` unscoped, and the testid lands on the `<dd>` (`StatTile`'s
    // own docstring), not on the hint beside it.
    renderOverview({ live: liveWith({ count: 500 }), status: 'parsing' });
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('500');
    const durationTile = screen.getByTestId('live-stat-duration').closest('div');
    expect(durationTile).toHaveTextContent(/when streaming stopped/i);
    expect(durationTile).not.toHaveTextContent(/still streaming/i);
  });

  it('keeps the "still streaming" hint while the run is running', () => {
    renderOverview({ live: liveWith({ count: 500 }), status: 'running' });
    const durationTile = screen.getByTestId('live-stat-duration').closest('div');
    expect(durationTile).toHaveTextContent(/still streaming/i);
    expect(durationTile).not.toHaveTextContent(/when streaming stopped/i);
  });
});
