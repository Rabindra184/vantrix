import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInjectorsResponseSchema } from '@perfportal/contracts';
import type { AgentInjectorsResponse, AgentSummaryResponse, Window } from '@perfportal/contracts';
import { agentInjectorsPath } from '../src/api/metricPaths';
import LoadGeneratorsSection, { LOAD_GENERATOR_CHARTS } from '../src/routes/report/LoadGeneratorsSection';
import useIsCompact from '../src/useIsCompact';
import fixture from './fixtures/agent-run.json';
import { AGENT_RUN, AGENT_SUMMARY, renderAgentSection, waitForDrawn } from './support/agentSection';

/**
 * The Report's Load generators section (GE report parity PR 3): GE's six
 * charts of the load generator's JVM and machine, from the run's agent file,
 * under a read-only field naming that machine. Unlike Connections and DNS it
 * needs no HTTP collector, so it still draws when that was off; and a machine
 * collector that was off (every macOS generator) costs CPU and kernel TCP their
 * charts, with the agent's own reason, while GC and memory still draw.
 *
 * Fetch answers from the captured agent run; nothing is hand-copied from it.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

const RUN = AGENT_RUN;
const SUMMARY = AGENT_SUMMARY;
const INJECTORS = AgentInjectorsResponseSchema.parse(fixture.injectors);

/** GE's own titles, verbatim and in GE's order (spec §2). */
const TITLES = [
  'GC Counts per Second',
  'GC Time per Second',
  'CPU usage in percent',
  'Memory Usage in MB',
  'TCP Connections Events per Second',
  'TCP Segment Events per Second',
];
const IDS = [
  'chart-agent-gc-count',
  'chart-agent-gc-time',
  'chart-agent-cpu',
  'chart-agent-memory',
  'chart-agent-tcp-events',
  'chart-agent-tcp-segments',
];
/** The three charts the machine collector alone feeds. */
const MACHINE_ONLY = ['chart-agent-cpu', 'chart-agent-tcp-events', 'chart-agent-tcp-segments'];

/** A run whose machine collector was off: the summary's header and the injectors body agree. */
const MACHINE_REASON = 'macOS: /proc is not available, so CPU, RAM and kernel TCP were not read';
const MACHINE_OFF_SUMMARY: AgentSummaryResponse = {
  ...SUMMARY,
  header: { ...SUMMARY.header!, collects: { http: true, machine: false }, reasons: { machine: MACHINE_REASON } },
};
const MACHINE_OFF_INJECTORS: AgentInjectorsResponse = {
  ...INJECTORS,
  machine: { available: false, reason: MACHINE_REASON },
  buckets: INJECTORS.buckets.map((b) => ({
    ...b,
    cpuUserPct: null,
    cpuSysPct: null,
    ramTotalBytes: null,
    ramUsedBytes: null,
    tcpEvents: null,
    tcpSegments: null,
  })),
};

function renderSection(
  options: {
    readonly summary?: AgentSummaryResponse;
    readonly holdSummary?: boolean;
    readonly injectors?: AgentInjectorsResponse;
    readonly terminal?: boolean;
    readonly window?: Window | null;
  } = {},
) {
  return renderAgentSection(<LoadGeneratorsSection runId={RUN} />, {
    ...options,
    figures: (path) => (path.endsWith('/agent/injectors') ? (options.injectors ?? INJECTORS) : undefined),
  });
}

const waitForCharts = (except: readonly string[] = []) => waitForDrawn(TITLES.length, except);
const injectorRequests = (requested: readonly string[]) => requested.filter((u) => u.includes('/agent/injectors'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

describe('LoadGeneratorsSection', () => {
  it("draws GE's six load-generator charts, titled as GE titles them", async () => {
    renderSection();
    await waitForCharts();
    const figures = screen.getAllByRole('figure');
    expect(figures.map((f) => within(f).getByRole('heading', { level: 3 }).textContent)).toEqual(TITLES);
    expect(figures.map((f) => f.getAttribute('data-testid'))).toEqual(IDS);
  });

  it('names the load generator in a read-only field, never a one-option choice', async () => {
    renderSection();
    await waitForCharts();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('term')).toHaveTextContent('Load generator');
    expect(screen.getByRole('definition')).toHaveTextContent(SUMMARY.injector.host!);
  });

  it('says "Unknown host" when the agent could not tell its own hostname', async () => {
    renderSection({ summary: { ...SUMMARY, injector: { host: null, sharedWithPerfPortal: false } } });
    await waitForCharts();
    expect(screen.getByRole('definition')).toHaveTextContent('Unknown host');
  });

  it("says, beside the field, when the machine was PerfPortal's own", async () => {
    renderSection({ summary: { ...SUMMARY, injector: { ...SUMMARY.injector, sharedWithPerfPortal: true } } });
    await waitForCharts();
    expect(screen.getByText(/shared/)).toHaveTextContent("PerfPortal's database, API and worker");
    // What it shares is the MACHINE's figures; heap and GC are the load generator's own JVM.
    expect(screen.getByText(/shared/)).toHaveTextContent('CPU, RAM and kernel TCP figures');
  });

  it('says nothing about sharing when the machine was not shared', async () => {
    renderSection();
    await waitForCharts();
    expect(SUMMARY.injector.sharedWithPerfPortal).toBe(false);
    expect(screen.queryByText(/shared/)).toBeNull();
  });

  it("gives the agent's reason on CPU and both TCP charts when the machine was not read, while GC and memory draw", async () => {
    renderSection({ summary: MACHINE_OFF_SUMMARY, injectors: MACHINE_OFF_INJECTORS });
    await waitForCharts(MACHINE_ONLY);
    for (const id of MACHINE_ONLY) {
      expect(within(screen.getByTestId(id)).getByRole('status')).toHaveTextContent(MACHINE_REASON);
    }
    for (const id of ['chart-agent-gc-count', 'chart-agent-gc-time', 'chart-agent-memory']) {
      expect(within(screen.getByTestId(id)).queryByRole('status')).toBeNull();
    }
    // Memory still draws heap and Netty, and says which two of its seven were not read, and why.
    const about = within(screen.getByTestId('chart-agent-memory')).getByRole('button', { name: 'About Memory Usage in MB' });
    expect(about).toHaveAccessibleDescription(/RAM total, RAM used/);
    expect(about).toHaveAccessibleDescription(new RegExp(MACHINE_REASON));
  });

  it('keeps the load-generator telemetry for a run with no agent file', async () => {
    const { requested } = renderSection({
      summary: { ...SUMMARY, available: false, reason: 'not_collected', header: null, remotes: [], hostnames: [] },
    });
    expect(await screen.findByText(/no generator telemetry recorded/i)).toBeInTheDocument();
    expect(requested.some((u) => u.includes('/telemetry'))).toBe(true);
    expect(document.querySelector('[data-testid^="chart-agent-"]')).toBeNull();
    expect(injectorRequests(requested)).toEqual([]);
    expect(LOAD_GENERATOR_CHARTS).toEqual(['telemetry-cpu', 'telemetry-memory', 'telemetry-connection-events', 'telemetry-segment-events']);
  });

  it('says the agent file could not be read, and does NOT fall back to telemetry', async () => {
    const detail = 'checksum mismatch: stored a1b2, read c3d4';
    const { requested } = renderSection({
      summary: { ...SUMMARY, available: false, reason: 'unreadable', detail, header: null },
    });
    expect(await screen.findByText("This run's agent file could not be read")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
    expect(requested.some((u) => u.includes('/telemetry'))).toBe(false);
  });

  it("still draws when the agent's HTTP collector was off: the load generator needs none", async () => {
    const { requested } = renderSection({
      summary: {
        ...SUMMARY,
        header: { ...SUMMARY.header!, collects: { http: false, machine: true }, reasons: { http: 'gatling-http 3.14' } },
      },
    });
    await waitForCharts();
    expect(screen.queryByText('The agent did not collect HTTP figures')).toBeNull();
    expect(injectorRequests(requested)).toEqual([agentInjectorsPath(RUN)]);
  });

  it('withholds all six charts while the run streams, and asks for nothing', async () => {
    const { requested } = renderSection({ terminal: false });
    const notices = await screen.findAllByTestId('live-notice-withheld');
    expect(notices.map((n) => n.querySelector('p')?.textContent)).toEqual(TITLES);
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);
  });

  it('shows one neutral loading state until the summary answers, not six charts', async () => {
    renderSection({ holdSummary: true });
    expect(await screen.findByText("Loading this run's load-generator figures…")).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(screen.queryByText('Load generator')).toBeNull();
  });

  /** One mounted instance through the run finishing: see `ConnectionsSection.test.tsx`. */
  it('survives the run finishing under it, and asks for its figures only then', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requested, finish } = renderSection({ terminal: false });
    expect(await screen.findAllByTestId('live-notice-withheld')).toHaveLength(TITLES.length);
    const before = requested.length;
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);

    await finish();
    await waitForCharts();
    expect(requested.findIndex((u) => u.includes('/agent'))).toBeGreaterThanOrEqual(before);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/rendered (more|fewer) hooks/i);
    errors.mockRestore();
  });

  it('draws the charts on a phone once asked, and only then asks for them', async () => {
    const user = userEvent.setup();
    useIsCompactMock.mockReturnValue(true);
    const { requested } = renderSection();
    const open = await screen.findByRole('button', { name: 'Open the load-generator charts' });
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(injectorRequests(requested)).toEqual([]);
    await user.click(open);
    await waitForCharts();
    expect(injectorRequests(requested)).toEqual([agentInjectorsPath(RUN)]);
  });

  it("asks for the shell's window", async () => {
    const window: Window = { fromMs: 1000, toMs: 3000, bucketWidthMs: 1000 };
    const { requested } = renderSection({ window });
    await waitFor(() => expect(injectorRequests(requested)).toEqual([agentInjectorsPath(RUN, window)]));
    const url = new URL(injectorRequests(requested)[0]!, 'http://x');
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('3000');
  });
});
