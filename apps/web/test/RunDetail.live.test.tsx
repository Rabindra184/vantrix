import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, SeriesResponse, UsersResponse, ErrorsResponse } from '@perfportal/contracts';
import { errorsQuery, seriesQuery, usersQuery } from '../src/api/metrics';
import { fetchRun } from '../src/api/run';
import { useLiveRun } from '../src/api/live';
import useIsCompact from '../src/useIsCompact';
import RunDetail, { Live } from '../src/routes/RunDetail';

/**
 * `RunDetail`'s branch decision for a non-`ready` run (part 2b §4.1, §4.3,
 * §4.4), and the `Live` page it now sometimes renders instead of
 * `Processing`.
 *
 * TWO FILES' WORTH OF CONCERN, ONE FILE. The first `describe` below drives
 * `RunDetail` itself, with `fetchRun` and `useLiveRun` both mocked, to prove
 * the BRANCH is chosen correctly — which of `Processing`/`Live`, and with
 * `useLiveRun` called with the RIGHT `enabled` boolean for every combination
 * of status and viewport. The second drives the exported `Live` component
 * directly, with a real `QueryClient` pre-populated the way `useLiveRun`'s
 * own `applyDelta` populates it, to prove what it draws from a real delta —
 * the tile values, the live charts, the three withheld notices, and what
 * §22.6 gates behind `DesktopOnly`.
 */

vi.mock('../src/api/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run.js')>()),
  fetchRun: vi.fn(),
}));
vi.mock('../src/api/live.js', () => ({ useLiveRun: vi.fn() }));
vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));

const fetchRunMock = vi.mocked(fetchRun);
const useLiveRunMock = vi.mocked(useLiveRun);
const useIsCompactMock = vi.mocked(useIsCompact);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function processingBody(status: 'pending' | 'parsing' | 'running') {
  return { state: 'processing' as const, run: { id: RUN_ID, status, statusUrl: `/v1/runs/${RUN_ID}` } };
}

function deltaFixture(overrides: Partial<LiveDelta> = {}): LiveDelta {
  return {
    runId: RUN_ID,
    seq: 3,
    summary: {
      count: 240,
      okCount: 228,
      koCount: 12,
      errorRate: 0.05,
      percentiles: { p50: 110, p95: 420 },
      maxUsers: 8,
      durationMs: 42_000,
    },
    responseTime: { widthMs: 1000, replaces: false, buckets: [] },
    users: { widthMs: 1000, buckets: [] },
    errors: { rows: [{ message: 'boom', count: 12 }] },
    ...overrides,
  };
}

function liveState(overrides: Partial<{ connected: boolean; lastDelta: LiveDelta | null; unauthorized: boolean }> = {}) {
  return { connected: true, lastDelta: null, unauthorized: false, ...overrides };
}

function renderDetail() {
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

afterEach(() => {
  cleanup();
  fetchRunMock.mockReset();
  useLiveRunMock.mockReset();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

describe('RunDetail — choosing Processing vs. the live page', () => {
  it('renders the live page once a delta has arrived for a running run', async () => {
    fetchRunMock.mockResolvedValue(processingBody('running'));
    useLiveRunMock.mockReturnValue(liveState({ lastDelta: deltaFixture() }));

    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Run in progress' })).toBeInTheDocument();
    expect(screen.getByText(/updating as the run streams/i)).toBeInTheDocument();
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();
    // Four withheld sections (Task 9 C2 added the errors-over-time chart's),
    // and only four.
    expect(screen.getAllByTestId('live-notice-withheld')).toHaveLength(4);
  });

  it('keeps the ordinary Processing screen while running with no delta yet', async () => {
    fetchRunMock.mockResolvedValue(processingBody('running'));
    useLiveRunMock.mockReturnValue(liveState({ connected: false, lastDelta: null }));

    renderDetail();

    expect(await screen.findByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByText(/updating as the run streams/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-notice-withheld')).not.toBeInTheDocument();
  });

  it('keeps the ordinary Processing screen for a run never live this session', async () => {
    fetchRunMock.mockResolvedValue(processingBody('pending'));
    useLiveRunMock.mockReturnValue(liveState({ connected: false, lastDelta: null }));

    renderDetail();

    expect(await screen.findByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByTestId('live-notice-withheld')).not.toBeInTheDocument();
  });

  /**
   * Design §4.4: the run has stopped streaming (status left `running`) but
   * the socket already delivered a delta this session, so the dashboard
   * stays up under a banner rather than reverting to a bare spinner at the
   * exact moment nothing has gone wrong.
   */
  it('freezes the dashboard under a finalizing banner once streaming stops', async () => {
    fetchRunMock.mockResolvedValue(processingBody('parsing'));
    useLiveRunMock.mockReturnValue(liveState({ connected: false, lastDelta: deltaFixture() }));

    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Run finished' })).toBeInTheDocument();
    expect(screen.getByTestId('live-notice-finalizing')).toBeInTheDocument();
    expect(screen.getByTestId('live-notice-finalizing')).toHaveTextContent(/finalizing/i);
    // The dashboard itself is still there, not blanked.
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('240');
  });

  /**
   * The exact expression design §4.1 names: `run.status === 'running' &&
   * !useIsCompact()`. Table-driven so the four combinations this boolean can
   * take are all pinned in one place, rather than trusted to hold by
   * induction from the one or two cases a narrower test would cover.
   */
  it.each([
    { status: 'running' as const, compact: false, expected: true },
    { status: 'running' as const, compact: true, expected: false },
    { status: 'pending' as const, compact: false, expected: false },
    { status: 'parsing' as const, compact: false, expected: false },
  ])('gates the socket on running && !compact ($status, compact=$compact) -> $expected', async ({
    status,
    compact,
    expected,
  }) => {
    fetchRunMock.mockResolvedValue(processingBody(status));
    useIsCompactMock.mockReturnValue(compact);
    useLiveRunMock.mockReturnValue(liveState({ connected: false, lastDelta: null }));

    renderDetail();
    await screen.findByText(/still processing/i);

    expect(useLiveRunMock).toHaveBeenCalledWith(RUN_ID, expected);
  });
});

/* ======================================================================== *
 * `Live`, rendered directly against a real QueryClient
 * ======================================================================== */

const USERS: UsersResponse = {
  runId: RUN_ID,
  window: null,
  scenarios: [
    { scenario: 'Checkout', buckets: [{ startOffsetMs: 0, started: 3, ended: 1, maxConcurrent: 3 }] },
  ],
  total: [{ startOffsetMs: 0, started: 3, ended: 1, maxConcurrent: 3 }],
};

const SERIES: SeriesResponse = {
  runId: RUN_ID,
  scope: 'run',
  name: '',
  family: 'response_time',
  bucketWidthMs: 1000,
  startedSplitAvailable: true,
  groupSeriesAvailable: false,
  window: null,
  buckets: [
    {
      startOffsetMs: 0,
      startedCount: 5,
      endedCount: 5,
      okCount: 4,
      koCount: 1,
      startedOkCount: 4,
      startedKoCount: 1,
      minMs: 10,
      maxMs: 500,
      meanMs: 120,
      percentiles: { p50: 100 },
      percentilesOk: { p50: 95 },
      percentilesKo: { p50: 500 },
    },
  ],
};

const ERRORS: ErrorsResponse = { runId: RUN_ID, errors: [{ message: 'boom', count: 12 }] };

function clientWithLiveCache(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(usersQuery(RUN_ID).queryKey, USERS);
  client.setQueryData(seriesQuery(RUN_ID, 'run', '', 'response_time').queryKey, SERIES);
  client.setQueryData(errorsQuery(RUN_ID).queryKey, ERRORS);
  return client;
}

function renderLive(
  overrides: Partial<{
    status: 'running' | 'pending' | 'parsing';
    compact: boolean;
    capReached: boolean;
    onRetry: () => void;
  }> = {},
) {
  const client = clientWithLiveCache();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Live
          status={overrides.status ?? 'running'}
          runId={RUN_ID}
          live={liveState({ lastDelta: deltaFixture() })}
          compact={overrides.compact ?? false}
          capReached={overrides.capReached ?? false}
          onRetry={overrides.onRetry ?? (() => undefined)}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Live — the live page itself', () => {
  afterEach(cleanup);

  it('reads its headline tiles straight off the delta summary, not a StatRow', () => {
    const delta = deltaFixture();
    renderLive();

    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent(String(delta.summary.count));
    expect(screen.getByTestId('live-stat-error-rate')).toHaveTextContent(
      `${(delta.summary.errorRate * 100).toFixed(2)}%`,
    );
    expect(screen.getByTestId('live-stat-peak-users')).toHaveTextContent(String(delta.summary.maxUsers));
    expect(screen.getByTestId('live-stat-p95')).toHaveTextContent(`${delta.summary.percentiles.p95} ms`);
    // p99 was never configured on this fixture's percentiles — a dash, not a
    // fabricated zero (the same "null, not zeroed" rule RunStats follows).
    expect(screen.getByTestId('live-stat-p99')).toHaveTextContent('—');
  });

  it('draws the live charts from whatever the socket already wrote to the cache', () => {
    renderLive();

    for (const id of ['concurrent-users', 'user-start-rate', 'percentiles', 'requests-per-second', 'responses-per-second']) {
      expect(screen.getByTestId(`chart-${id}`)).toBeInTheDocument();
    }
  });

  it('shows exactly four withheld sections, and the errors table live-fed beside them', () => {
    renderLive();

    expect(screen.getAllByTestId('live-notice-withheld')).toHaveLength(4);
    // Task 9 C2: errors-over-time is withheld (a different endpoint than the
    // table below, which the errors table itself proves is still live-fed).
    expect(screen.getByText('Errors per second')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /errors/i })).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('gates the charts and the three withheld notices behind DesktopOnly on a narrow viewport', () => {
    renderLive({ compact: true });

    // The charts never mounted at all.
    for (const id of ['concurrent-users', 'percentiles']) {
      expect(screen.queryByTestId(`chart-${id}`)).not.toBeInTheDocument();
    }
    // DesktopOnly's own notice replaces them (two instances: the charts
    // region and the statistics region each carry their own) -- unchanged by
    // Task 9 C2, since the new notice joined the SAME "Live charts" region
    // rather than opening a third.
    expect(screen.getAllByTestId('desktop-only')).toHaveLength(2);
    // The errors table is NOT gated — matching RunErrorsTab, which never
    // gates it either, and §22.6's own "error summary" exemption.
    expect(screen.getByRole('table', { name: /errors/i })).toBeInTheDocument();
    // And the tiles are never withheld.
    expect(screen.getByTestId('live-stat-total-requests')).toBeInTheDocument();
  });

  it('shows the finalizing banner only once status has left running', () => {
    const { rerender } = render(
      <QueryClientProvider client={clientWithLiveCache()}>
        <MemoryRouter>
          <Live status="running" runId={RUN_ID} live={liveState({ lastDelta: deltaFixture() })} compact={false} capReached={false} onRetry={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();

    rerender(
      <QueryClientProvider client={clientWithLiveCache()}>
        <MemoryRouter>
          <Live status="parsing" runId={RUN_ID} live={liveState({ lastDelta: deltaFixture() })} compact={false} capReached={false} onRetry={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-notice-finalizing')).toBeInTheDocument();
  });

  /**
   * TASK 9 C3. The "Duration So Far" tile used to say "still streaming"
   * unconditionally -- including directly under `live-notice-finalizing`'s
   * own banner, which on the same render says streaming has stopped. The
   * hint now reads `frozen`, the same flag the banner is gated on, so the
   * two can never disagree about whether this run is still live.
   */
  it('drops the "still streaming" hint once the run has frozen', () => {
    // `StatTile`'s `data-testid` lands on the `<dd>` holding the VALUE only
    // (its own docstring) -- the hint is a sibling `<p>`, so the tile's own
    // bordered container (the label's closest `div`) is what a query for the
    // hint text has to scope to. `screen.getByText('still streaming', ...)`
    // unscoped would also match the withheld-notice bodies, which use the
    // same phrase for an unrelated reason.
    const { rerender } = render(
      <QueryClientProvider client={clientWithLiveCache()}>
        <MemoryRouter>
          <Live status="running" runId={RUN_ID} live={liveState({ lastDelta: deltaFixture() })} compact={false} capReached={false} onRetry={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Duration So Far').closest('div')).toHaveTextContent(/still streaming/i);

    rerender(
      <QueryClientProvider client={clientWithLiveCache()}>
        <MemoryRouter>
          <Live status="parsing" runId={RUN_ID} live={liveState({ lastDelta: deltaFixture() })} compact={false} capReached={false} onRetry={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const tile = screen.getByText('Duration So Far').closest('div');
    expect(tile).not.toHaveTextContent(/still streaming/i);
    expect(tile).toHaveTextContent(/stopped/i);
  });

  /**
   * `Live` shipped with NEITHER the cap message NOR the Retry button
   * `Processing` has had since the parity shell — so a run that stopped
   * streaming and then took longer than POLL_CAP_MS to finalize left the
   * reader on a page that had silently stopped polling while its own banner
   * promised to refresh itself.
   */
  it('says polling stopped, and offers a retry, once the cap is reached on a frozen run', async () => {
    const onRetry = vi.fn();
    renderLive({ status: 'parsing', capReached: true, onRetry });

    expect(screen.getByTestId('live-notice-capped')).toHaveTextContent(/stopped checking automatically/i);
    // The promise the finalizing banner makes ("will refresh … once they are
    // ready") is false once polling has stopped, so the two are exclusive.
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();
    // The dashboard is still there — the cap is a statement about requests,
    // not a reason to blank what already arrived.
    expect(screen.getByTestId('live-stat-total-requests')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * `pollIntervalFor` exempts a `running` run from the cap entirely, so while
   * this run streams the page IS still polling — saying otherwise would be the
   * "appears to be working while making no requests" failure inverted.
   */
  it('says nothing about the cap while the run is still streaming', () => {
    renderLive({ status: 'running', capReached: true });

    expect(screen.queryByTestId('live-notice-capped')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check again/i })).not.toBeInTheDocument();
    expect(screen.getByText(/updating as the run streams/i)).toBeInTheDocument();
  });

  // Defensive: `RunDetail` only ever renders `Live` once `lastDelta` is
  // non-null, but a future caller mistake should render nothing rather than
  // throw on `delta.summary`.
  it('renders nothing if handed a null lastDelta', () => {
    const { container } = render(
      <QueryClientProvider client={clientWithLiveCache()}>
        <MemoryRouter>
          <Live status="running" runId={RUN_ID} live={liveState({ lastDelta: null })} compact={false} capReached={false} onRetry={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
