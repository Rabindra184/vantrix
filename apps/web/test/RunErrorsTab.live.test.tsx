import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, LiveErrorRow, RunProcessing } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import { errorsQuery } from '../src/api/metrics';
import type { LiveRunState } from '../src/api/live';
import { RunErrorsTab } from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * `RunErrorsTab`'s live branch (Task 10).
 *
 * Mounted the same way `RunOverviewTab.live.test.tsx` and
 * `RunChartsTab.live.test.tsx` mount their own tabs — a stand-in
 * `<Outlet context={{...}} />` for `RunShell`, plus a pre-seeded `run` query
 * cache so the assertions below need no `await`.
 *
 * `errors` is seeded directly into the query cache under the exact key
 * `useLiveRun`'s `applyDelta` writes (`errorsResponseFrom`, `api/live.ts`,
 * a field-for-field copy of `delta.errors.rows`) — this file has no real
 * socket behind it, so the "table reads the cache, never fetches while live"
 * contract is exercised by seeding what the socket would have written.
 */

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function liveWith(overrides: { errors?: LiveErrorRow[] } = {}): LiveRunState {
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
      },
      responseTime: { widthMs: 1000, replaces: true, buckets: [] },
      users: { widthMs: 1000, buckets: [] },
      errors: { rows: overrides.errors ?? [] },
      // Required by `LiveDeltaSchema` since the live-SLA merge; empty because
      // nothing in this file asserts on the banner. `RunShell.test.tsx` owns
      // that, since `RunShell` is where `SlaBanner` renders.
      sla: { evaluated: 0, notJudged: 0, rulesUnavailable: false, breaching: [] },
    } satisfies LiveDelta,
  };
}

function renderErrors({
  live,
  status = 'running',
}: {
  readonly live: LiveRunState | null;
  readonly status?: RunProcessing['status'];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run: RunProcessing = { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` };
  client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
  // The SAME cache key `applyDelta` writes — seeded here because this file
  // mounts the tab alone, with no socket behind it.
  if (live?.lastDelta) {
    client.setQueryData(errorsQuery(RUN_ID).queryKey, {
      runId: RUN_ID,
      errors: live.lastDelta.errors.rows,
    });
  }
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(run), { status: 202 })));

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}/errors`]}>
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
            <Route path="errors" element={<RunErrorsTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunErrorsTab — live', () => {
  it('keeps the errors table live and states that the chart is not', () => {
    // The table is fed by delta.errors.rows through the shared errorsQuery
    // key; the chart's endpoint is not on the live wire at all.
    renderErrors({ live: liveWith({ errors: [{ message: 'timeout', count: 3 }] }) });

    const table = screen.getByRole('table', { name: /errors/i });
    expect(table).toBeInTheDocument();
    expect(within(table).getByText('timeout')).toBeInTheDocument();

    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/errors per second/i);
    // No chart figure — the notice replaces it entirely, in its position.
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it('shows the waiting panel before any delta has arrived', () => {
    renderErrors({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /**
   * TEST GAP CLOSER (whole-branch review). No per-tab fetch spy existed
   * before this fix round — the no-fetch-while-live rule was pinned only in
   * `RunShell.test.tsx` and `RunTrends.live.test.tsx`, and `RunTelemetry.tsx`
   * (CRITICAL 1) turned out to be exactly the one tab no spy was watching.
   * This is Errors' own: both `errors` and `errors/series` are gated on
   * `enabled: terminal` — the table stays live off the seeded cache alone
   * (see this file's own docstring), so neither REST call should fire.
   */
  it('does not fetch /errors or /errors/series while the run is not terminal', () => {
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
    const live = liveWith({ errors: [{ message: 'timeout', count: 3 }] });
    client.setQueryData(errorsQuery(RUN_ID).queryKey, { runId: RUN_ID, errors: live.lastDelta!.errors.rows });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN_ID}/errors`]}>
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
              <Route path="errors" element={<RunErrorsTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/errors'))).toBe(false);
  });
});
