import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse, StatsResponse, TrendsResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import { RunOverviewTab } from '../src/routes/RunDetail';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

/**
 * THE STAT TILES' "vs previous" DELTAS, AND THE ONE STATE THEY MUST NOT
 * APPEAR IN.
 *
 * `/stats` is WINDOW-SCOPED and `/trends` is not. There is no windowed
 * cohort endpoint, so under a time brush the two answer different questions
 * — a tenth of this run against the whole of the previous one — and the
 * tiles read as a catastrophic regression produced entirely by dragging the
 * brush. All six move together, which is what makes it convincing.
 *
 * Both directions are asserted. "No deltas under a brush" alone is satisfied
 * by a page that never renders deltas at all, so the unbrushed case pins
 * that they DO appear, off the same fixture, with the same mount.
 *
 * `RunOverviewTab` under a stand-in for `RunShell`'s `<Outlet context/>`,
 * the same harness `RunTelemetry.test.tsx` and `RunOverviewTab.live.test.tsx`
 * use and for the same reason: this tab reads its window and live state from
 * the shell, and the shell's own brush cannot be driven in jsdom.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
vi.mocked(useIsCompact).mockReturnValue(false);

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const STATS = reference.stats as StatsResponse;
const RUN_ROW = STATS.stats.find((row) => row.scope === 'run')!;

const READY_RUN: RunResponse = {
  id: RUN_ID,
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'passed',
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
 * A cohort of two: this run, and one strictly older whose mean is exactly
 * half of it. The expectation below is computed from that relationship
 * rather than written down.
 */
const TRENDS: TrendsResponse = {
  runId: RUN_ID,
  simulation: READY_RUN.simulation ?? null,
  test: { id: '99999999-9999-4999-8999-999999999999', slug: 'example-paritysimulation', name: 'example.ParitySimulation' },
  cohortSize: 2,
  runs: [
    {
      id: RUN_ID,
      startedAt: READY_RUN.startedAt ?? '2026-08-14T10:43:49.546Z',
      toolStartedAt: READY_RUN.toolStartedAt ?? null,
      durationMs: READY_RUN.durationMs ?? null,
      verdict: 'passed',
      count: RUN_ROW.count,
      okCount: RUN_ROW.okCount,
      koCount: RUN_ROW.koCount,
      errorRate: RUN_ROW.errorRate,
      minMs: RUN_ROW.minMs,
      maxMs: RUN_ROW.maxMs,
      meanMs: RUN_ROW.meanMs,
      throughputRps: RUN_ROW.throughputRps,
      percentiles: RUN_ROW.percentiles,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      startedAt: '2026-08-01T00:00:00.000Z',
      toolStartedAt: '2026-08-01T00:00:00.000Z',
      durationMs: READY_RUN.durationMs ?? null,
      verdict: 'passed',
      count: RUN_ROW.count,
      okCount: RUN_ROW.okCount,
      koCount: RUN_ROW.koCount,
      errorRate: RUN_ROW.errorRate,
      minMs: RUN_ROW.minMs,
      maxMs: RUN_ROW.maxMs,
      // Half this run's mean, so the tile must read +100.0%.
      meanMs: RUN_ROW.meanMs / 2,
      throughputRps: RUN_ROW.throughputRps,
      percentiles: RUN_ROW.percentiles,
    },
  ],
};

function renderOverview(window: RunWindowContext['window']) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes('/trends') ? TRENDS : STATS;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: READY_RUN });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={
                  {
                    window,
                    durationMs: READY_RUN.durationMs ?? null,
                    liveDurationMs: null,
                    live: null,
                  } satisfies RunWindowContext
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
  return { urls };
}

describe('RunOverviewTab — the baseline the stat tiles compare against', () => {
  it('compares against the previous cohort run when the whole run is on screen', async () => {
    renderOverview(null);
    // Derived from the fixture: the baseline's mean is half this run's, so
    // the only honest delta is +100.0%.
    const tile = await screen.findByTestId('stat-mean-response');
    await waitFor(() => expect(tile.parentElement).toHaveTextContent('+100.0% vs previous'));
  });

  it('withholds every delta under a time brush, rather than comparing a window to a whole run', async () => {
    const { urls } = renderOverview({ fromMs: 0, toMs: 6_000, bucketWidthMs: 1_000 });

    // The tiles still render — they are never withheld (§22.6) — so waiting
    // on one is what makes the absence below a real observation rather than
    // an assertion against an empty document.
    await screen.findByTestId('stat-mean-response');
    await waitFor(() => expect(urls.some((url) => url.includes('/stats'))).toBe(true));

    expect(screen.queryByText(/vs previous/)).toBeNull();
    // And the cohort payload is not fetched at all: a reader who cannot be
    // shown the comparison should not pay for it either.
    expect(urls.some((url) => url.includes('/trends'))).toBe(false);
  });
});
