import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentConnectionsResponseSchema } from '@perfportal/contracts';
import type { AgentConnectionsResponse, AgentSummaryResponse, Window } from '@perfportal/contracts';
import { agentConnectionsPath } from '../src/api/metricPaths';
import { DEFAULT_AGENT_ROWS } from '../src/charts/transforms/agentDurations';
import ConnectionsSection from '../src/routes/report/ConnectionsSection';
import useIsCompact from '../src/useIsCompact';
import fixture from './fixtures/agent-run.json';
import { AGENT_RUN, AGENT_SUMMARY, locationParams, renderAgentSection, waitForDrawn } from './support/agentSection';

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

const SUMMARY = AGENT_SUMMARY;
const RUN = AGENT_RUN;
// Parsed rather than cast: the JSON's tuples read as `number[][]`.
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

function renderSection(
  options: {
    readonly summary?: AgentSummaryResponse;
    /** The summary read never answers: the section's state before it does. */
    readonly holdSummary?: boolean;
    readonly failSummary?: boolean;
    readonly connections?: AgentConnectionsResponse;
    readonly search?: string;
    readonly terminal?: boolean;
    readonly window?: Window | null;
  } = {},
) {
  return renderAgentSection(<ConnectionsSection runId={RUN} />, {
    ...options,
    figures: (path, params) => {
      if (!path.endsWith('/agent/connections')) return undefined;
      if (options.connections !== undefined) return options.connections;
      const remote = params.get('remote');
      return remote === null ? ALL : BY_REMOTE[remote];
    },
  });
}

/**
 * Waits for the nine charts to have DRAWN — every one of them does on the
 * fixture's every-remote read, which carries connects and handshakes of the
 * default outcome. See `waitForDrawn` for why counting figures is not enough.
 */
const waitForCharts = () => waitForDrawn(TITLES.length);

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
    expect(trigger).toHaveAccessibleName(
      `TCP Connect Duration Percentiles: Percentile bands, ${DEFAULT_AGENT_ROWS.length} selected`,
    );
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
      const p = locationParams();
      expect(p.get('remote')).toBe(second);
      expect(p.get('from')).toBe('1000');
    });
    await waitFor(() =>
      expect(connectionsRequests(requested).some((u) => u.startsWith(agentConnectionsPath(RUN, second)))).toBe(true),
    );
  });

  it("keeps the reader's percentile bands and outcomes through a remote change", async () => {
    const user = userEvent.setup();
    const { requested } = renderSection();
    await waitForCharts();
    const curve = 'agent-tcp-connect-percentiles-distribution';
    // 99.9% on, and the KO curve: neither is the default.
    await user.click(screen.getByTestId('bands-agent-tcp-connect-percentiles'));
    await user.click(await screen.findByTestId('band-p99_9-agent-tcp-connect-percentiles'));
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId(`outcome-ko-${curve}`));
    const chosen = `TCP Connect Duration Percentiles: Percentile bands, ${DEFAULT_AGENT_ROWS.length + 1} selected`;
    expect(screen.getByTestId('bands-agent-tcp-connect-percentiles')).toHaveAccessibleName(chosen);

    await user.selectOptions(screen.getByLabelText('Remote'), REMOTES[1]!);
    // The new remote's read, answered: the charts were unmounted and drawn again.
    await waitFor(() =>
      expect(connectionsRequests(requested).some((u) => u.startsWith(agentConnectionsPath(RUN, REMOTES[1]!)))).toBe(true),
    );
    // The KO curve is empty (the fixture failed nothing), so it explains itself rather than drawing.
    await waitForDrawn(TITLES.length, [`chart-${curve}`]);
    expect(screen.getByTestId('bands-agent-tcp-connect-percentiles')).toHaveAccessibleName(chosen);
    expect(screen.getByTestId(`outcome-ko-${curve}`)).toHaveAttribute('aria-pressed', 'true');
    // And only the block chosen in: TLS keeps its own defaults.
    expect(screen.getByTestId('bands-agent-tls-percentiles')).toHaveAccessibleName(
      `TLS Handshake Duration Percentiles: Percentile bands, ${DEFAULT_AGENT_ROWS.length} selected`,
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
    // Its own subject, so DNS and Load generators beside it do not say the identical sentence.
    expect(screen.getByText(new RegExp(detail))).toHaveTextContent("This run's connection figures cannot be drawn.");
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
  /**
   * THE TRANSITION, ON ONE MOUNTED INSTANCE. Every case above mounts one fixed
   * state, so a hook moved below the `!terminal` return would pass all of them
   * and break only here — "Rendered more hooks than during the previous
   * render", which this repository has shipped twice. It also proves the
   * summary is asked for fresh at the flip, not served from anything a live
   * run filled: the first `/agent` request comes after it.
   */
  it('survives the run finishing under it, and asks for its figures only then', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requested, finish } = renderSection({ terminal: false });
    expect(await screen.findAllByTestId('live-notice-withheld')).toHaveLength(TITLES.length);
    const before = requested.length;
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);

    await finish();
    await waitForCharts();
    const firstAgent = requested.findIndex((u) => u.includes('/agent'));
    expect(firstAgent).toBeGreaterThanOrEqual(before);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/rendered (more|fewer) hooks/i);
    errors.mockRestore();
  });

  it('draws the charts on a phone once asked, and only then asks for them', async () => {
    const user = userEvent.setup();
    useIsCompactMock.mockReturnValue(true);
    const { requested } = renderSection();
    const open = await screen.findByRole('button', { name: 'Open the connection charts' });
    expect(connectionsRequests(requested)).toEqual([]);
    await user.click(open);
    await waitForCharts();
    expect(connectionsRequests(requested)).toEqual([agentConnectionsPath(RUN, '*')]);
  });

  it('shows one neutral loading state until the summary answers, not nine charts', async () => {
    renderSection({ holdSummary: true });
    expect(await screen.findByText("Loading this run's connection figures…")).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it('names a single remote rather than offering a choice that changes nothing', async () => {
    renderSection({ summary: { ...SUMMARY, remotes: [REMOTES[0]!] } });
    await waitForCharts();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('term')).toHaveTextContent('Remote');
    expect(screen.getByRole('definition')).toHaveTextContent(REMOTES[0]!);
  });

  it('draws no remote control for a run with no remote', async () => {
    renderSection({ summary: { ...SUMMARY, remotes: [] } });
    await waitForCharts();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Remote')).toBeNull();
  });

  it('offers a choice between two remotes and every remote together', async () => {
    renderSection();
    await waitForCharts();
    const options = within(screen.getByRole('combobox', { name: 'Remote' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All remotes', ...REMOTES]);
  });

  it("names every control after its chart, so no two in the section share a name", async () => {
    renderSection();
    await waitForCharts();
    const durations = [
      { overTime: TITLES[2]!, curve: TITLES[4]! },
      { overTime: TITLES[5]!, curve: TITLES[7]! },
    ];
    const groups = durations.flatMap((d) => [`${d.overTime}: Percentile bands`, `${d.overTime}: Outcome`, `${d.curve}: Outcome`]);
    // `getByRole` throws on a second match, so each finding exactly one is the uniqueness.
    for (const name of groups) expect(screen.getByRole('group', { name })).toBeInTheDocument();
    expect(screen.getAllByRole('group')).toHaveLength(groups.length);
    for (const d of durations) {
      expect(
        screen.getByRole('button', { name: `${d.overTime}: Percentile bands, ${DEFAULT_AGENT_ROWS.length} selected` }),
      ).toBeInTheDocument();
    }
    // One word for one control: the trigger reads "Bands · N", the response-time
    // chart's menu is "Percentile bands", and these say the same.
    expect(screen.queryAllByRole('group', { name: /percentile rows/i })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /percentile rows/i })).toEqual([]);
  });

  it("asks for the shell's window", async () => {
    const window: Window = { fromMs: 1000, toMs: 3000, bucketWidthMs: 1000 };
    const { requested } = renderSection({ window });
    await waitFor(() => expect(connectionsRequests(requested)).toEqual([agentConnectionsPath(RUN, '*', window)]));
    const url = new URL(connectionsRequests(requested)[0]!, 'http://x');
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('3000');
  });

  it("gives the agent's own reason TCP states were not read", async () => {
    const reason = 'macOS: kernel TCP states are not readable';
    renderSection({
      summary: {
        ...SUMMARY,
        header: { ...SUMMARY.header!, collects: { http: true, machine: false }, reasons: { machine: reason } },
      },
      connections: { ...ALL, buckets: ALL.buckets.map((b) => ({ ...b, states: null })) },
    });
    // Queried inside the wait: the drawn chart REPLACES the loading figure, so a
    // node taken before the read answers is a detached one.
    await waitFor(() =>
      expect(within(screen.getByTestId('chart-agent-tcp-states')).getByRole('status')).toHaveTextContent(
        // Framed as a sentence: the agent's reason alone is a lower-case fragment.
        `The agent did not collect machine figures: ${reason}.`,
      ),
    );
  });

  it('says an empty chart is about the chosen remote, never the run', async () => {
    // The fixture's plain-HTTP remote: no TLS handshake to it, thirty to the other.
    const quiet = REMOTES.find((r) => BY_REMOTE[r]!.tlsHandshake.totals.ok + BY_REMOTE[r]!.tlsHandshake.totals.ko === 0)!;
    expect(ALL.tlsHandshake.totals.ok).toBeGreaterThan(0);
    renderSection({ search: `?remote=${encodeURIComponent(quiet)}` });
    const tls = ['chart-agent-tls-percentiles', 'chart-agent-tls-distribution', 'chart-agent-tls-percentiles-distribution'];
    await waitForDrawn(TITLES.length, tls);
    for (const id of tls) {
      const said = within(screen.getByTestId(id)).getByRole('status');
      expect(said, id).toHaveTextContent(/this remote/);
      expect(said, id).not.toHaveTextContent(/this run/);
    }
  });

  it("says once that no connection outside Gatling's warm-up was recorded", async () => {
    renderSection({ summary: { ...SUMMARY, remotes: [] }, connections: { ...ALL, buckets: [] } });
    expect(await screen.findByText("No connection outside Gatling's warm-up was recorded.")).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Remote' })).toBeNull();
  });

  it('says when the link named a remote this run never contacted', async () => {
    renderSection({ search: '?remote=elsewhere%2F10.0.0.1%3A443' });
    await waitForCharts();
    expect(screen.getByTestId('filter-unknown')).toHaveTextContent(
      'This link named elsewhere/10.0.0.1:443, which this run never contacted; showing all remotes.',
    );
    cleanup();
    vi.unstubAllGlobals();
    renderSection({ search: `?remote=${encodeURIComponent(REMOTES[1]!)}` });
    await waitForCharts();
    expect(screen.queryByTestId('filter-unknown')).toBeNull();
  });

  it('says once that the summary could not be read, and asks for no figures', async () => {
    const { requested } = renderSection({ failSummary: true });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This run's connection figures could not be loaded");
    expect(alert).toHaveTextContent('The agent summary could not be read.');
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(connectionsRequests(requested)).toEqual([]);
  });
});
