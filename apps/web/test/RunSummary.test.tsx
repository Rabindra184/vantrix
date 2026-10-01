// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assertion, RunResponse, ToolAssertion, UsersResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import { runQueryKey } from '../src/api/run';
import RunSummary from '../src/routes/RunSummary';
import { peakConcurrentUsers } from '../src/routes/runUsers';
import { useWholeRunDomainFromShell, type RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

// Real charts draw here, and ECharts measures text through a 2D canvas context
// that jsdom does not implement — it answers null and prints "Not implemented"
// on every call. Answering null ourselves is what jsdom does anyway, without
// the noise.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(useIsCompact).mockReturnValue(false);
});

const RUN_ID = '00000000-0000-4000-8000-000000000001';

const GLOBAL_ASSERTION: ToolAssertion = {
  expression: 'Global: max of response time is less than 30000.0',
  assertion: {
    path: { kind: 'global' },
    target: { kind: 'responseTime', stat: 'max' },
    condition: { kind: 'lt', value: 30000 },
  },
  actualValue: 2643,
  outcome: 'passed',
};

function readyRun({
  status = 'complete',
  durationMs = 63161,
  assertions = [],
  toolAssertions = [],
}: {
  status?: RunResponse['status'];
  durationMs?: number | null;
  assertions?: readonly Assertion[];
  toolAssertions?: readonly ToolAssertion[];
} = {}): RunResponse {
  return {
    id: RUN_ID,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    status,
    verdict: status === 'incomplete' ? 'not_evaluated' : 'passed',
    tool: 'gatling',
    toolVersion: '3.15.1',
    simulation: 'example.ParitySimulation',
    description: null,
    durationMs,
    startedAt: '2026-08-14T10:43:49.546Z',
    toolStartedAt: '2026-08-07T05:30:02.171Z',
    assertions: [...assertions],
    toolAssertions: [...toolAssertions],
  };
}

/** Answers each endpoint from the captured fixture; anything else is a 404,
 *  which `Payload` renders as an undrawn slot — still a figure with its id.
 *  `/trends` answers an empty cohort: nothing here is about a baseline. */
function stubFetch(statsBody: unknown): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const path = new URL(url, 'http://x').pathname;
    const body = path.endsWith('/users')
      ? reference.users
      : path.endsWith('/series')
        ? reference.series
        : path.endsWith('/stats')
          ? statsBody
          : path.endsWith('/errors')
            ? reference.errors
            : path.endsWith('/trends')
              ? { runs: [] }
              : null;
    return Promise.resolve(
      body === null
        ? new Response(JSON.stringify({ status: 404, title: 'Not Found', code: 'NOT_FOUND', detail: 'stub', remediation: 'stub' }), {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return seen;
}

function renderSummary({
  url = `/runs/${RUN_ID}`,
  window = null,
  status,
  durationMs,
  statsBody = reference.stats,
  assertions,
  toolAssertions,
}: {
  url?: string;
  window?: RunWindowContext['window'];
  status?: RunResponse['status'];
  durationMs?: number | null;
  /** What `/stats` answers. */
  statsBody?: unknown;
  assertions?: readonly Assertion[];
  toolAssertions?: readonly ToolAssertion[];
} = {}) {
  const seen = stubFetch(statsBody);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run = readyRun({ status, durationMs, assertions, toolAssertions });
  client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:runId"
            element={
              <Outlet
                context={{ window, durationMs: run.durationMs ?? null, liveDurationMs: null, warmupMs: null, live: null } satisfies RunWindowContext}
              />
            }
          >
            <Route index element={<RunSummary />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return seen;
}

describe('RunSummary — always the whole run', () => {
  it('asks for nothing narrowed, whatever window the URL carries', async () => {
    const seen = renderSummary({
      url: `/runs/${RUN_ID}?from=10000&to=20000`,
      window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 },
    });
    await screen.findByTestId('stat-p95');
    const metric = seen.filter((u) => /\/v1\/runs\//.test(u));
    expect(metric.length).toBeGreaterThan(2);
    for (const url of metric) expect(url).not.toMatch(/[?&](from|to)=/);
  });

  it('leads with GE’s four numbers, in GE’s order', async () => {
    renderSummary();
    await screen.findByTestId('stat-p95');
    const ids = [...document.querySelectorAll('section[aria-label="Run totals"] dd[data-testid^="stat-"]')].map((d) => d.getAttribute('data-testid'));
    expect(ids).toEqual(['stat-error-rate', 'stat-total-requests', 'stat-peak-users', 'stat-p95']);
    // Peak users comes from `/users`, a second request: awaiting the p95 tile
    // proves `/stats` arrived, not that this did.
    await waitFor(() =>
      expect(screen.getByTestId('stat-peak-users')).toHaveTextContent(String(peakConcurrentUsers(reference.users as UsersResponse))),
    );
  });

  it('reads as Platform gates, Simulation assertions, Over time, Errors', async () => {
    renderSummary({ toolAssertions: [GLOBAL_ASSERTION] });
    await screen.findByTestId('stat-p95');
    await screen.findByRole('heading', { level: 2, name: 'Errors' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim())).toEqual([
      'Platform gates',
      'Simulation assertions',
      'Over time',
      'Errors',
    ]);
  });

  it('draws GE’s two charts, side by side', async () => {
    renderSummary();
    await screen.findByTestId('chart-requests-and-responses');
    const charts = [...document.querySelectorAll('figure[data-testid^="chart-"]')].map((f) => f.getAttribute('data-testid'));
    expect(charts).toEqual(['chart-requests-and-responses', 'chart-percentiles']);
  });

  it('mounts no full chart on a phone, where the sparklines stand in', async () => {
    vi.mocked(useIsCompact).mockReturnValue(true);
    renderSummary();
    await screen.findByTestId('stat-p95');
    expect(screen.queryByTestId('chart-requests-and-responses')).toBeNull();
    expect(await screen.findByTestId('chart-requests-per-second')).toBeVisible(); // the sparkline
  });

  it('says an incomplete run kept nothing, and that no gate ran', async () => {
    renderSummary({ status: 'incomplete', durationMs: null, statsBody: { ...reference.stats, stats: [] }, assertions: [] });
    expect(await screen.findByText('No statistics were retained for this run')).toBeVisible();
    expect(within(screen.getByTestId('section-platform-gates')).getByText('not evaluated — the run left nothing to judge')).toBeVisible();
  });

  it('narrows the errors table to the request a link names', async () => {
    const seen = renderSummary({ url: `/runs/${RUN_ID}?request=Search` });
    await screen.findByRole('heading', { level: 2, name: 'Errors' });
    expect(seen.some((u) => u.includes('/errors?scope=request&name=Search'))).toBe(true);
  });

  // jsdom lays nothing out, so no chart case can see the axis. This reads the
  // domain the Summary's charts are handed, which is the whole decision: the
  // Report's `useTimeDomainFromShell` narrows to the window and this does not.
  it('draws its charts on the run’s own span, whatever the window', () => {
    let domain: readonly [number, number] | undefined;
    function Probe() {
      domain = useWholeRunDomainFromShell();
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/r']}>
        <Routes>
          <Route
            path="/r"
            element={<Outlet context={{ window: { fromMs: 10_000, toMs: 20_000, bucketWidthMs: 1_000 }, durationMs: 63161, liveDurationMs: null, warmupMs: null, live: null } satisfies RunWindowContext} />}
          >
            <Route index element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(domain).toEqual([0, 63161]);
  });
});
