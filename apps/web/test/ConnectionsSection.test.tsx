import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConnectionsResponseSchema, AgentSummaryResponseSchema } from '@perfportal/contracts';
import type {
  AgentConnectionsResponse,
  AgentSummaryResponse,
  RunResponse,
  TelemetryResponse,
} from '@perfportal/contracts';
import { useProjectAccess } from '../src/access/useAccess';
import { agentConnectionsPath } from '../src/api/metricPaths';
import { runQueryKey } from '../src/api/run';
import { DEFAULT_AGENT_ROWS } from '../src/charts/transforms/agentDurations';
import ConnectionsSection from '../src/routes/report/ConnectionsSection';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import useIsCompact from '../src/useIsCompact';
import fixture from './fixtures/agent-run.json';
import { seedAccess } from './support/access';

/**
 * The Report's Connections section, drawn from the run's agent file (GE report
 * parity PR 3): GE's nine charts, a Remote filter that lives in the URL, and
 * the three ways a run can have no agent figures — each said differently,
 * because "no agent ran" (load-generator telemetry still might have) and "there
 * was an agent file and it could not be read" are different facts.
 *
 * Fetch answers from the captured agent run; nothing is hand-copied from it.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

// Parsed rather than cast: the JSON's tuples read as `number[][]`, and parsing
// also proves the captured bodies still satisfy today's contract.
const SUMMARY = AgentSummaryResponseSchema.parse(fixture.summary);
const RUN = SUMMARY.runId;
const ALL = AgentConnectionsResponseSchema.parse(fixture.connections);
const BY_REMOTE: Record<string, AgentConnectionsResponse> = Object.fromEntries(
  Object.entries(fixture.connectionsByRemote).map(([remote, body]) => [remote, AgentConnectionsResponseSchema.parse(body)]),
);
const REMOTES = SUMMARY.remotes;

/** GE's own titles, verbatim and in GE's order (spec §2). */
const TITLES = [
  'Connection Open and Close Rate',
  'TCP Connection By State',
  'TCP Connect Duration Percentiles',
  'TCP Connect Duration Distribution',
  'TCP Connection Percentiles Distribution',
  'TLS Handshake Duration Percentiles',
  'TLS Handshake Duration Distribution',
  'TLS Handshake Duration Percentiles Distribution',
  'Bandwidth Usage per second',
];

const COMPLETE_RUN: RunResponse = {
  id: RUN,
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

const NO_TELEMETRY: TelemetryResponse = { runId: RUN, available: false, bucketWidthMs: 1000, window: null, hosts: [] };

function ShellStandIn() {
  const projectAccess = useProjectAccess(COMPLETE_RUN.project.slug);
  return (
    <Outlet
      context={
        {
          window: null, durationMs: null, liveDurationMs: null, warmupMs: null, live: null, projectAccess,
        } satisfies RunWindowContext
      }
    />
  );
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderSection(
  options: {
    readonly summary?: AgentSummaryResponse;
    readonly connections?: AgentConnectionsResponse;
    readonly search?: string;
    readonly terminal?: boolean;
  } = {},
) {
  const summary = options.summary ?? SUMMARY;
  const terminal = options.terminal ?? true;
  const requested: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    requested.push(url);
    const path = url.split('?')[0]!;
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (path === `/v1/runs/${RUN}/agent`) return json(summary);
    if (path === `/v1/runs/${RUN}/agent/connections`) {
      if (options.connections !== undefined) return json(options.connections);
      const remote = new URL(url, 'http://x').searchParams.get('remote');
      return json(remote === null ? ALL : BY_REMOTE[remote]);
    }
    if (path === `/v1/runs/${RUN}/telemetry`) return json(NO_TELEMETRY);
    if (url === '/auth/get-session') return new Promise<Response>(() => {});
    return json({}, 500);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedAccess(client, { isAdmin: true });
  client.setQueryData(
    runQueryKey(RUN),
    terminal
      ? { state: 'ready' as const, run: COMPLETE_RUN }
      : { state: 'processing' as const, run: { id: RUN, status: 'running', statusUrl: `/v1/runs/${RUN}` } },
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN}/report${options.search ?? ''}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<ShellStandIn />}>
            <Route
              path="report"
              element={
                <>
                  <ConnectionsSection runId={RUN} />
                  <LocationProbe />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requested };
}

/** The nine charts exist from the first paint as "Loading…" figures; this waits for the drawn ones. */
async function waitForCharts() {
  await waitFor(() => expect(screen.getAllByRole('figure')).toHaveLength(TITLES.length));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
}

const connectionsRequests = (requested: readonly string[]) =>
  requested.filter((u) => u.includes('/agent/connections'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

describe('ConnectionsSection', () => {
  it("draws GE's nine charts, titled as GE titles them, under ids derived from GE's names", async () => {
    renderSection();
    await waitForCharts();
    const figures = screen.getAllByRole('figure');
    expect(figures.map((f) => within(f).getByRole('heading', { level: 3 }).textContent)).toEqual(TITLES);
    expect(figures.map((f) => f.getAttribute('data-testid'))).toEqual([
      'chart-agent-connection-rate',
      'chart-agent-tcp-states',
      'chart-agent-tcp-connect-percentiles',
      'chart-agent-tcp-connect-distribution',
      'chart-agent-tcp-connect-percentiles-distribution',
      'chart-agent-tls-percentiles',
      'chart-agent-tls-distribution',
      'chart-agent-tls-percentiles-distribution',
      'chart-agent-bandwidth',
    ]);
  });

  it('opens the over-time percentile menu on the eight rows GE shows by default', async () => {
    const user = userEvent.setup();
    renderSection();
    await waitForCharts();
    const trigger = screen.getByTestId('bands-agent-tcp-connect-percentiles');
    expect(trigger).toHaveAccessibleName(`Percentile bands, ${DEFAULT_AGENT_ROWS.length} selected`);
    await user.click(trigger);
    const checked = (await screen.findAllByRole('menuitemcheckbox'))
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.getAttribute('data-testid'));
    expect(checked).toEqual(DEFAULT_AGENT_ROWS.map((row) => `band-${row}-agent-tcp-connect-percentiles`));
  });

  it('filters by the chosen remote, in the URL and in the request', async () => {
    const user = userEvent.setup();
    const { requested } = renderSection({ search: '?from=1000&to=5000' });
    await waitForCharts();
    const second = REMOTES[1]!;
    await user.selectOptions(screen.getByLabelText('Remote'), second);
    await waitFor(() => {
      const p = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
      expect(p.get('remote')).toBe(second);
      expect(p.get('from')).toBe('1000');
    });
    await waitFor(() =>
      expect(connectionsRequests(requested).some((u) => u.startsWith(agentConnectionsPath(RUN, second)))).toBe(true),
    );
  });

  it('reads an unknown remote as every remote, and never sends it', async () => {
    const { requested } = renderSection({ search: '?remote=nope' });
    await waitForCharts();
    const select = screen.getByLabelText('Remote') as HTMLSelectElement;
    expect(select).toHaveValue('*');
    expect(select.selectedOptions[0]?.textContent).toBe('All remotes');
    expect(connectionsRequests(requested)).toEqual([agentConnectionsPath(RUN, '*')]);
  });

  it("falls back to load-generator telemetry when the run carries no agent file", async () => {
    const { requested } = renderSection({
      summary: { ...SUMMARY, available: false, reason: 'not_collected', header: null, remotes: [], hostnames: [] },
    });
    expect(await screen.findByText(/no generator telemetry recorded/i)).toBeInTheDocument();
    expect(document.querySelector('[data-testid^="chart-agent-"]')).toBeNull();
    expect(connectionsRequests(requested)).toEqual([]);
  });

  it('says the agent file could not be read, and does NOT fall back to telemetry', async () => {
    const detail = 'checksum mismatch: stored a1b2, read c3d4';
    const { requested } = renderSection({
      summary: { ...SUMMARY, available: false, reason: 'unreadable', detail, header: null, remotes: [], hostnames: [] },
    });
    expect(await screen.findByText("This run's agent file could not be read")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
    expect(screen.queryByText(/no generator telemetry recorded/i)).toBeNull();
    expect(requested.some((u) => u.includes('/telemetry'))).toBe(false);
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it("says the agent's HTTP collector was off, with the agent's own reason", async () => {
    const detail = 'gatling-http 3.14 not supported';
    const { requested } = renderSection({
      summary: {
        ...SUMMARY,
        header: { ...SUMMARY.header!, collects: { http: false, machine: true }, reasons: { http: detail } },
      },
    });
    expect(await screen.findByText('The agent did not collect HTTP figures')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
    expect(connectionsRequests(requested)).toEqual([]);
  });

  it('honours an unavailable answer from the connections read itself', async () => {
    const detail = 'gatling-http 3.14 not supported';
    renderSection({ connections: { ...ALL, available: false, reason: 'http_not_collected', detail, buckets: [] } });
    expect(await screen.findByText('The agent did not collect HTTP figures')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
  });

  it('withholds all nine charts while the run streams, and asks for nothing', async () => {
    const { requested } = renderSection({ terminal: false });
    const notices = await screen.findAllByTestId('live-notice-withheld');
    expect(notices.map((n) => n.querySelector('p')?.textContent)).toEqual(TITLES);
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);
  });

  it('offers the charts on a phone rather than drawing them', async () => {
    useIsCompactMock.mockReturnValue(true);
    const { requested } = renderSection();
    expect(await screen.findByRole('button', { name: 'Open the connection charts' })).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(connectionsRequests(requested)).toEqual([]);
  });
});
