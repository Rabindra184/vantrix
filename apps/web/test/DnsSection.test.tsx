import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDnsResponseSchema } from '@perfportal/contracts';
import type { AgentDnsResponse, AgentSummaryResponse, Window } from '@perfportal/contracts';
import { agentDnsPath } from '../src/api/metricPaths';
import { DEFAULT_AGENT_ROWS } from '../src/charts/transforms/agentDurations';
import DnsSection from '../src/routes/report/DnsSection';
import useIsCompact from '../src/useIsCompact';
import fixture from './fixtures/agent-run.json';
import { AGENT_RUN, AGENT_SUMMARY, locationParams, renderAgentSection, waitForDrawn } from './support/agentSection';

/**
 * The Report's DNS section (GE report parity PR 3): GE's four DNS charts from
 * the run's agent file, a Hostname filter that lives in the URL, and — unlike
 * Connections and Load generators — NO telemetry fallback: the Go telemetry
 * agent records no lookups, so a run with no agent file says so.
 *
 * Fetch answers from the captured agent run; nothing is hand-copied from it.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

const RUN = AGENT_RUN;
const SUMMARY = AGENT_SUMMARY;
// Parsed rather than cast: the JSON's tuples read as `number[][]`.
const DNS = AgentDnsResponseSchema.parse(fixture.dns);
const HOSTNAMES = SUMMARY.hostnames;
/** The fixture resolved one hostname; a select needs two, so a second is added. */
const TWO_HOSTNAMES: AgentSummaryResponse = { ...SUMMARY, hostnames: [...HOSTNAMES, 'payments.example.test'].sort() };

/** GE's own titles, verbatim (spec §2), in the order this section draws them. */
const TITLES = [
  'DNS Resolution per Second',
  'DNS Resolution Duration Percentiles',
  'DNS Resolution Duration Distribution',
  'DNS Resolution Duration Percentiles Distribution',
];

function renderSection(
  options: {
    readonly summary?: AgentSummaryResponse;
    readonly holdSummary?: boolean;
    readonly dns?: AgentDnsResponse;
    readonly search?: string;
    readonly terminal?: boolean;
    readonly window?: Window | null;
  } = {},
) {
  return renderAgentSection(<DnsSection runId={RUN} />, {
    ...options,
    figures: (path, params) => {
      if (!path.endsWith('/agent/dns')) return undefined;
      if (options.dns !== undefined) return options.dns;
      // One captured body: every hostname answers with it, under its own name.
      return { ...DNS, hostname: params.get('hostname') ?? '*' };
    },
  });
}

const waitForCharts = () => waitForDrawn(TITLES.length);
const dnsRequests = (requested: readonly string[]) => requested.filter((u) => u.includes('/agent/dns'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

describe('DnsSection', () => {
  it("draws GE's four DNS charts, titled as GE titles them", async () => {
    renderSection();
    await waitForCharts();
    const figures = screen.getAllByRole('figure');
    expect(figures.map((f) => within(f).getByRole('heading', { level: 3 }).textContent)).toEqual(TITLES);
    expect(figures.map((f) => f.getAttribute('data-testid'))).toEqual([
      'chart-agent-dns-rate',
      'chart-agent-dns-percentiles',
      'chart-agent-dns-distribution',
      'chart-agent-dns-percentiles-distribution',
    ]);
  });

  it('names the one hostname the run resolved rather than offering a choice that changes nothing', async () => {
    renderSection();
    await waitForCharts();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('term')).toHaveTextContent('Hostname');
    expect(screen.getByRole('definition')).toHaveTextContent(HOSTNAMES[0]!);
  });

  it('offers every hostname and all of them together when there are two', async () => {
    renderSection({ summary: TWO_HOSTNAMES });
    await waitForCharts();
    const options = within(screen.getByRole('combobox', { name: 'Hostname' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All hostnames', ...TWO_HOSTNAMES.hostnames]);
  });

  it('filters by the chosen hostname, in the URL and in the request', async () => {
    const user = userEvent.setup();
    const { requested } = renderSection({ summary: TWO_HOSTNAMES, search: '?from=1000&to=3000' });
    await waitForCharts();
    const second = TWO_HOSTNAMES.hostnames[1]!;
    await user.selectOptions(screen.getByLabelText('Hostname'), second);
    await waitFor(() => {
      const p = locationParams();
      expect(p.get('hostname')).toBe(second);
      expect(p.get('from')).toBe('1000');
    });
    await waitFor(() => expect(dnsRequests(requested).some((u) => u.startsWith(agentDnsPath(RUN, second)))).toBe(true));
  });

  it('reads an unknown hostname as every hostname, and never sends it', async () => {
    const { requested } = renderSection({ summary: TWO_HOSTNAMES, search: '?hostname=nope' });
    await waitForCharts();
    expect(screen.getByLabelText('Hostname')).toHaveValue('*');
    expect(dnsRequests(requested)).toEqual([agentDnsPath(RUN, '*')]);
  });

  it('draws no hostname control for a run that resolved none', async () => {
    renderSection({ summary: { ...SUMMARY, hostnames: [] } });
    await waitForCharts();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Hostname')).toBeNull();
  });

  it('says there is no agent data for a run with no agent file, and falls back to nothing', async () => {
    const { requested } = renderSection({
      summary: { ...SUMMARY, available: false, reason: 'not_collected', header: null, remotes: [], hostnames: [] },
    });
    expect(await screen.findByText('No agent data for this run')).toBeInTheDocument();
    expect(screen.getByText(/collects DNS resolution figures/)).toBeInTheDocument();
    expect(requested.some((u) => u.includes('/telemetry'))).toBe(false);
    expect(dnsRequests(requested)).toEqual([]);
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
  });

  it("says the agent's HTTP collector was off, with the agent's own reason, and asks for nothing", async () => {
    const detail = 'gatling-http 3.14 not supported';
    const { requested } = renderSection({
      summary: { ...SUMMARY, header: { ...SUMMARY.header!, collects: { http: false, machine: true }, reasons: { http: detail } } },
    });
    expect(await screen.findByText('The agent did not collect HTTP figures')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
    expect(dnsRequests(requested)).toEqual([]);
  });

  it('honours an http_not_collected answer from the DNS read itself', async () => {
    const detail = 'gatling-http 3.14 not supported';
    renderSection({ dns: { ...DNS, available: false, reason: 'http_not_collected', detail, buckets: [] } });
    expect(await screen.findByText('The agent did not collect HTTP figures')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
  });

  it('says the agent file could not be read', async () => {
    const detail = 'checksum mismatch: stored a1b2, read c3d4';
    renderSection({ summary: { ...SUMMARY, available: false, reason: 'unreadable', detail, header: null } });
    expect(await screen.findByText("This run's agent file could not be read")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(detail))).toBeInTheDocument();
  });

  it('withholds all four charts while the run streams, and asks for nothing', async () => {
    const { requested } = renderSection({ terminal: false });
    const notices = await screen.findAllByTestId('live-notice-withheld');
    expect(notices.map((n) => n.querySelector('p')?.textContent)).toEqual(TITLES);
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);
  });

  it('shows one neutral loading state until the summary answers, not four charts', async () => {
    renderSection({ holdSummary: true });
    expect(await screen.findByText("Loading this run's agent figures…")).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(screen.queryByText(TITLES[0]!)).toBeNull();
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
    const open = await screen.findByRole('button', { name: 'Open the DNS charts' });
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(dnsRequests(requested)).toEqual([]);
    await user.click(open);
    await waitForCharts();
    expect(dnsRequests(requested)).toEqual([agentDnsPath(RUN, '*')]);
  });

  it("asks for the shell's window", async () => {
    const window: Window = { fromMs: 1000, toMs: 3000, bucketWidthMs: 1000 };
    const { requested } = renderSection({ window });
    await waitFor(() => expect(dnsRequests(requested)).toEqual([agentDnsPath(RUN, '*', window)]));
    const url = new URL(dnsRequests(requested)[0]!, 'http://x');
    expect(url.searchParams.get('from')).toBe('1000');
    expect(url.searchParams.get('to')).toBe('3000');
  });

  it('names every control after its chart', async () => {
    renderSection();
    await waitForCharts();
    const groups = [`${TITLES[1]}: Percentile rows`, `${TITLES[1]}: Outcome`, `${TITLES[3]}: Outcome`];
    for (const name of groups) expect(screen.getByRole('group', { name })).toBeInTheDocument();
    expect(screen.getAllByRole('group')).toHaveLength(groups.length);
    expect(
      screen.getByRole('button', { name: `${TITLES[1]}: Percentile rows, ${DEFAULT_AGENT_ROWS.length} selected` }),
    ).toBeInTheDocument();
  });
});
