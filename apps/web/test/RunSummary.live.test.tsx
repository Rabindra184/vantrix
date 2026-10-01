import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assertion, LiveDelta, LiveErrorRow, RunProcessing, RunResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import { errorsQuery } from '../src/api/metrics';
import type { LiveRunState } from '../src/api/live';
import RunSummary from '../src/routes/RunSummary';
import type { RunWindowContext } from '../src/routes/useRunWindow';

/**
 * `RunSummary`'s live branch — what the Overview tab's live branch (Task 8) and
 * the Errors tab's (Task 10) became when the two pages folded into the Summary.
 *
 * `RunDetail.live.test.tsx` already proves the "no delta yet" WaitingPanel path
 * and left several cases for this page: `LiveSummary`'s tiles reading straight
 * off the delta, the tiles surviving a run that has left `running`, and the live
 * errors table. This file covers those against the REAL page rather than a
 * placeholder, the same way `RunTelemetry.test.tsx` mounts its own tab under a
 * stand-in for `RunShell`'s `<Outlet context={{...}} />` — this page reads both
 * `run` (its own query, seeded below) and `live` (through `useOutletContext`),
 * so it needs a parent route providing the second and a pre-populated cache for
 * the first, not a real `RunShell`.
 *
 * WHAT DIED WITH THE OVERVIEW. The statistics table is in the Report, so the
 * withheld "Statistics" notice this file used to pin is gone with it; and the
 * live Duration tile — with the three cases about which span it showed — left
 * when the live row was cut to the same four tiles as the finished one.
 * Duration is `RunHeader`'s chip, which can only show it once it stops changing.
 * The Errors tab's own "Errors per second is withheld" case moved with its
 * chart: `RunReport.live.test.tsx` states all five withheld Requests figures.
 */

// The finished page draws real charts (the flip case below), and ECharts
// measures text through a 2D canvas context that jsdom does not implement — it
// answers null and prints "Not implemented" on every call. Answering null
// ourselves is what jsdom does anyway, without the noise.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/** A `LiveRunState` carrying a `lastDelta` built from the given summary
 *  overrides — everything else defaulted to an honest, empty measurement. */
function liveWith(overrides: Partial<LiveDelta['summary']> = {}, errors: LiveErrorRow[] = []): LiveRunState {
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
      errors: { rows: errors },
      // Required by `LiveDeltaSchema` since the live-SLA merge; empty because
      // nothing in this file asserts on the banner. `RunShell.test.tsx` owns
      // that, since `RunShell` is where `SlaBanner` renders.
      sla: { evaluated: 0, notJudged: 0, rulesUnavailable: false, breaching: [] },
    } satisfies LiveDelta,
  };
}

/**
 * `RunSummary` under a stand-in shell, its own `run` query pre-seeded so the
 * assertions below need no `await` — `useQuery` reads pre-populated cache data
 * synchronously on first paint, the same approach `RunDetail.live.test.tsx`'s
 * `mountRun` uses for the identical reason. `fetch` is stubbed to answer the
 * SAME body, so the un-`staleTime`'d background revalidation every mount fires
 * resolves to something consistent rather than to a network error.
 *
 * The errors table is seeded under the SAME cache key `useLiveRun`'s
 * `applyDelta` writes (`errorsResponseFrom`, `api/live.ts`, a field-for-field
 * copy of `delta.errors.rows`) — this file has no real socket behind it, so the
 * "table reads the cache, never fetches while live" contract is exercised by
 * seeding what the socket would have written.
 */
function renderSummary({
  live,
  status = 'running',
}: {
  readonly live: LiveRunState | null;
  readonly status?: RunProcessing['status'];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run: RunProcessing = { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` };
  client.setQueryData(runQueryKey(RUN_ID), { state: 'processing', run });
  if (live?.lastDelta) {
    client.setQueryData(errorsQuery(RUN_ID).queryKey, { runId: RUN_ID, errors: live.lastDelta.errors.rows });
  }
  const fetchSpy = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(run), { status: 202 })),
  );
  vi.stubGlobal('fetch', fetchSpy);

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
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
            <Route index element={<RunSummary />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, fetchSpy };
}

describe('RunSummary — live', () => {
  it('shows GE’s four live tiles, in GE’s order, while a run streams', () => {
    renderSummary({
      live: liveWith({ count: 1200, okCount: 1176, koCount: 24, errorRate: 0.02, maxUsers: 8, percentiles: { p95: 450 } }),
    });
    // `formatCount` writes plain, ungrouped digits (StatisticsTable.tsx's own
    // docstring) — never a locale-grouped "1,200".
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('1200');
    expect(screen.getByTestId('live-stat-error-rate')).toHaveTextContent('2.00%');
    expect(screen.getByTestId('live-stat-peak-users')).toHaveTextContent('8');
    expect(screen.getByTestId('live-stat-p95')).toHaveTextContent('450 ms');

    const ids = [
      ...document.querySelectorAll('section[aria-label="Run totals so far"] dd[data-testid^="live-stat-"]'),
    ].map((dd) => dd.getAttribute('data-testid'));
    expect(ids).toEqual(['live-stat-error-rate', 'live-stat-total-requests', 'live-stat-peak-users', 'live-stat-p95']);
  });

  /**
   * `RunDetail.live.test.tsx` left this as a todo for the page that wires it
   * in: `LiveSummary` stays on screen, unblanked, once the run leaves
   * `running` — read straight off `run.data.run.status` and the delta, not off
   * `live.connected`, so a socket drop mid-finalize cannot blank tiles that are
   * still the honest last-known numbers. The socket is DOWN here on purpose:
   * that is the state in which a tile read off the connection would vanish.
   */
  it('keeps the tiles on screen, unblanked, once the run has left running', () => {
    renderSummary({ live: { ...liveWith({ count: 500 }), connected: false }, status: 'parsing' });
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('500');
  });

  it('shows the waiting panel for a pending run with no delta, and no table either', () => {
    renderSummary({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByTestId('live-stat-total-requests')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /**
   * THE TABLE STAYS LIVE. Once a delta has arrived, `errors` reads straight off
   * it — `useLiveRun`'s `applyDelta` writes this SAME `errorsQuery` cache key
   * directly — so `TableSection` needs no live branch of its own. (The chart
   * that sat above it on the Errors tab has no live source at all, which is why
   * it is in the Report now and stated there, not here.)
   */
  it('keeps the errors table live, off the cache the delta writes', () => {
    renderSummary({ live: liveWith({}, [{ message: 'timeout', count: 3 }]) });

    const table = screen.getByRole('table', { name: /errors/i });
    expect(within(table).getByText('timeout')).toBeInTheDocument();
  });

  /**
   * ═══ THE LIVE ROW IS A TWIN, AND TWINS DRIFT — review N01 ═══
   *
   * `LiveSummary` shows the same four quantities as `RunStats` for a run that
   * is still going. N01's vocabulary pass renamed the terminal row first and
   * left this one saying "871 OK, 24 KO" — so the live and finished views of
   * ONE run disagreed about what its own numbers are called, for the minutes
   * that matter most. Caught by an adversarial read of the branch, not by any
   * test: every case here reaches these tiles by `data-testid`, which is
   * exactly what makes a label change invisible to them.
   *
   * Asserted as the CLAIM — this row speaks the product's words, not the
   * tool's — so the sentence stays rewritable while the vocabulary does not
   * regress. `RunStats.test.tsx` carries the identical case for the terminal
   * row; either one failing alone is the twins drifting apart again.
   */
  it('speaks the same vocabulary as the finished run’s totals', () => {
    renderSummary({ live: liveWith({ count: 1200, okCount: 1176, koCount: 24, errorRate: 0.02, maxUsers: 8 }) });
    const section = document.querySelector('section[aria-label="Run totals so far"]')!;
    const text = section.textContent ?? '';

    expect(text).toMatch(/successful/i);
    expect(text).toMatch(/failed/i);
    // As WORDS — Gatling's spellings, which no parity requirement binds here.
    expect(text).not.toMatch(/\bOK\b/);
    expect(text).not.toMatch(/\bKO\b/);
    // And the percentile is named the way a gate names it.
    const labels = [...section.querySelectorAll('dt')].map((d) => (d.textContent ?? '').trim());
    expect(labels).toContain('p95');
  });

  /**
   * TEST GAP CLOSER (whole-branch review). No per-page fetch spy existed before
   * this fix round — the no-fetch-while-live rule was pinned only in
   * `RunShell.test.tsx` and `RunTrends.live.test.tsx`, and `RunTelemetry.tsx`
   * (CRITICAL 1) turned out to be exactly the one tab no spy was watching.
   * This is the Summary's own, and it covers both pages that folded into it:
   * every metric query is gated on `enabled: terminal` — `stats`, `users`,
   * `series` and `trends` for the tiles and the charts, `errors` for the table
   * (which stays live off the seeded cache alone) — so none of them should reach
   * `fetch` while this page renders its live branch.
   */
  it('does not fetch any metric while the run is not terminal', () => {
    const { fetchSpy } = renderSummary({ live: liveWith({ count: 1 }, [{ message: 'timeout', count: 3 }]) });

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    for (const path of ['/stats', '/series', '/users', '/trends', '/errors']) {
      expect(urls.some((u) => u.includes(path)), path).toBe(false);
    }
  });

  /**
   * ═══ ONE INSTANCE, FROM STREAMING TO FINISHED ═══
   *
   * The route does not remount when a run finishes — only the run's state
   * changes — so this page renders its live branch and then its finished one as
   * the SAME component instance. Two things have to survive that, and neither
   * is reachable by a case that mounts one state at a time:
   *
   *   Hook order. A hook that only some states reach is "Rendered more hooks
   *   than during the previous render" — the `trends` query was the one that
   *   sat beyond the live branch's return when this was written.
   *
   *   The platform bar opening. It is shut and "not reported yet" while live,
   *   and a run that finishes with a FAILED gate must open it: `defaultOpen` is
   *   read once at mount, so `PlatformGatesBar` keys its two branches, and a
   *   wrapper here that held the instance across the flip would undo that on
   *   exactly the run somebody was watching for it.
   */
  it('opens the platform bar when a streaming run finishes with a failed gate, without a hook-order crash', async () => {
    const failedGate: Assertion = {
      ruleId: '22222222-2222-4222-8222-222222222222',
      outcome: 'failed',
      actualValue: 1830,
      message: 'p99 breached its threshold.',
      rule: { scope: 'run', targetName: null, family: 'response_time', metric: 'p99', comparator: 'lte', threshold: 750 },
    };
    const finished: RunResponse = {
      id: RUN_ID,
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      status: 'complete',
      verdict: 'failed',
      tool: 'gatling',
      toolVersion: '3.15.1',
      simulation: 'example.ParitySimulation',
      description: null,
      durationMs: 63161,
      startedAt: '2026-08-14T10:43:49.546Z',
      toolStartedAt: '2026-08-07T05:30:02.171Z',
      assertions: [failedGate],
      toolAssertions: [],
    };

    const { client } = renderSummary({ live: liveWith({ count: 1200, errorRate: 0.02 }) });
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('live-stat-p95')).toBeInTheDocument();

    // The mount's own background revalidation of the run is still in flight and
    // answers "processing" — settle it first, or it lands AFTER the flip below
    // and puts the page back to streaming.
    await waitFor(() => expect(client.isFetching()).toBe(0));

    // Finished now: the metrics are real, so answer them from the fixture.
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://x').pathname;
      const body = path.endsWith('/users')
        ? reference.users
        : path.endsWith('/series')
          ? reference.series
          : path.endsWith('/stats')
            ? reference.stats
            : path.endsWith('/errors')
              ? reference.errors
              : { runs: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    await act(async () => {
      client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: finished });
    });

    // The finished tiles replaced the live ones, and the bar opened itself.
    expect(await screen.findByTestId('stat-p95')).toBeInTheDocument();
    expect(screen.queryByTestId('live-stat-p95')).toBeNull();
    expect(screen.getByRole('button', { name: 'Platform gates' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('gate-card')).toHaveLength(1);
  });
});
