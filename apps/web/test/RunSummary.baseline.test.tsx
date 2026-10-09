import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResponse, StatsResponse, TrendsResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import RunSummary from '../src/routes/RunSummary';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import { UNKNOWN_ACCESS } from './support/access';
import useIsCompact from '../src/useIsCompact';

/**
 * THE STAT TILES' "vs previous" DELTAS, AND THE ONE STATE THEY MUST NOT
 * APPEAR IN.
 *
 * `/stats` can be WINDOW-SCOPED and `/trends` never is. There is no windowed
 * cohort endpoint, so a view that narrowed the first and compared it with the
 * second measured a tenth of this run against the whole of the previous one —
 * and the tiles read as a catastrophic regression produced entirely by dragging
 * the brush. All of them moved together, which is what made it convincing.
 *
 * THE OLD ANSWER WAS TO WITHHOLD THE DELTAS UNDER A WINDOW. The Summary's answer
 * is that it never has one: GE's Summary stays the whole run with a window in
 * its URL (measured), so every query here passes `null` and the comparison is
 * always whole-run against whole-run. The last case asserts that, from the other
 * side — a window in the shell's context changes nothing about what is asked or
 * shown.
 *
 * Both directions are asserted. "No deltas" alone would be satisfied by a page
 * that never renders deltas at all, so the first cases pin that they DO appear,
 * off the same fixture, with the same mount.
 *
 * `RunSummary` under a stand-in for `RunShell`'s `<Outlet context/>`, the same
 * harness `RunTelemetry.test.tsx` and `RunSummary.live.test.tsx` use and for the
 * same reason: this page reads its window and live state from the shell, and the
 * shell's own brush cannot be driven in jsdom.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
vi.mocked(useIsCompact).mockReturnValue(false);

// The page draws real charts, and ECharts measures text through a 2D canvas
// context that jsdom does not implement — it answers null and prints "Not
// implemented" on every call. Answering null ourselves is what jsdom does
// anyway, without the noise.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

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
 * A cohort of two: this run, and one strictly older whose error rate is exactly
 * half of it. The expectation below is computed from that relationship rather
 * than written down. (The error rate, because it is one of the four tiles the
 * Summary has: the mean this used to halve has no tile any more.)
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
      // Half this run's error rate, so the tile must read +100.0%.
      errorRate: RUN_ROW.errorRate / 2,
      minMs: RUN_ROW.minMs,
      maxMs: RUN_ROW.maxMs,
      meanMs: RUN_ROW.meanMs,
      throughputRps: RUN_ROW.throughputRps,
      percentiles: RUN_ROW.percentiles,
    },
  ],
};

function renderSummary(window: RunWindowContext['window']) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url, 'http://x').pathname;
    // Every endpoint the Summary reads answers with ITS OWN body, so the page
    // renders whole rather than falling back to an error panel per section.
    const body = path.endsWith('/trends')
      ? TRENDS
      : path.endsWith('/users')
        ? reference.users
        : path.endsWith('/series')
          ? reference.series
          : path.endsWith('/errors')
            ? reference.errors
            : STATS;
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
                    liveDurationMs: null, warmupMs: null,
                    live: null,
                    projectAccess: UNKNOWN_ACCESS,
                  } satisfies RunWindowContext
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
  return { urls };
}

describe('RunSummary — the baseline the stat tiles compare against', () => {
  it('compares against the previous cohort run', async () => {
    renderSummary(null);
    // Derived from the fixture: the baseline's error rate is half this run's,
    // so the only honest delta is +100.0%.
    const tile = await screen.findByTestId('stat-error-rate');
    await waitFor(() => expect(tile.parentElement).toHaveTextContent('+100.0% vs previous'));
  });

  /**
   * ═══ THE SEAM: THE NOTE MUST NAME THE RUN THE DELTAS WERE COMPUTED FROM ═══
   *
   * `RunStats` is handed `baseline` and `current` by two separate calls in
   * `RunSummary`, so a unit fixture that supplies both proves only that the note
   * renders what it is given. What it cannot prove is that the run the note
   * NAMES is the run the tiles were computed AGAINST — and a note pointing at
   * the wrong member of the cohort would be worse than no note, because it
   * reads as evidence.
   *
   * The href is the assertion for exactly that reason: a link built from this
   * run rather than its baseline renders identically and says something false.
   */
  it('names the run the deltas are measured against, and links to it', async () => {
    renderSummary(null);

    // The delta first, so the link below is being checked against a comparison
    // that demonstrably happened.
    const tile = await screen.findByTestId('stat-error-rate');
    await waitFor(() => expect(tile.parentElement).toHaveTextContent('+100.0% vs previous'));

    // The tile's own delta carries the link now (clean UI, PR 2).
    const link = within(tile.parentElement!).getByRole('link');
    expect(link).toHaveAttribute('href', `/runs/${TRENDS.runs[1]!.id}`);
    expect(link).not.toHaveAttribute('href', `/runs/${RUN_ID}`);
  });

  /**
   * THE OLD CLAIM, FROM THE OTHER SIDE. This case used to assert that a time
   * brush WITHHELD every delta — "rather than comparing a window to a whole
   * run" — and that `/trends` was not fetched at all. The Summary has no window
   * to withhold them under: whatever the shell carries, it asks for the whole
   * run, so the comparison is whole run against whole run and is as honest under
   * a brush as without one. What must not happen is the window leaking into the
   * page — a narrowed `/stats` set against the un-narrowed `/trends` is exactly
   * the "-84% regression produced by dragging the brush" this file was written
   * to prevent.
   */
  it('still compares the whole run when the shell carries a window, because it never asks for a narrowed one', async () => {
    const { urls } = renderSummary({ fromMs: 0, toMs: 6_000, bucketWidthMs: 1_000 });

    const tile = await screen.findByTestId('stat-error-rate');
    await waitFor(() => expect(tile.parentElement).toHaveTextContent('+100.0% vs previous'));

    // The comparison happened, and neither side of it was narrowed.
    expect(urls.some((url) => url.includes('/trends'))).toBe(true);
    const stats = urls.filter((url) => new URL(url, 'http://x').pathname.endsWith('/stats'));
    expect(stats.length).toBeGreaterThan(0);
    for (const url of stats) expect(url).not.toMatch(/[?&](from|to)=/);
  });
});
