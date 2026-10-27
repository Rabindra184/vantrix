import '@testing-library/jest-dom/vitest';
import { useQuery } from '@tanstack/react-query';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInjectorsResponseSchema } from '@perfportal/contracts';
import { agentInjectorsQuery } from '../src/api/agent';
import AgentSectionGate, { agentFileFacts, useAgentSection } from '../src/routes/report/AgentSectionGate';
import useIsCompact from '../src/useIsCompact';
import fixture from './fixtures/agent-run.json';
import { AGENT_RUN, AGENT_SUMMARY, renderAgentSection } from './support/agentSection';

/**
 * The gate every agent section of the Report draws through
 * (`AgentSectionGate`), tested through a stand-in section rather than one of
 * the three real ones, so a state is pinned once, at the helper, whatever a
 * section later draws inside it. The sections' own files test the same states
 * as their readers meet them.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

const INJECTORS = AgentInjectorsResponseSchema.parse(fixture.injectors);
const SLOTS = [
  { id: 'stand-in-a', title: 'Stand-in A' },
  { id: 'stand-in-b', title: 'Stand-in B' },
];

function StandIn({
  needsHttp,
  fallback,
  ownEnabled,
}: {
  readonly needsHttp: boolean;
  readonly fallback?: boolean;
  /** An `enabled` the section's own options carry, which the gate must never override. */
  readonly ownEnabled?: boolean;
}) {
  const section = useAgentSection(AGENT_RUN, { needsHttp });
  const options = agentInjectorsQuery(AGENT_RUN, section.window);
  const figures = useQuery(
    section.figureQuery(ownEnabled === undefined ? options : { ...options, enabled: ownEnabled }),
  );
  return (
    <AgentSectionGate
      section={section}
      slots={SLOTS}
      what="Two stand-in charts"
      action="Open the stand-in charts"
      subject="stand-in figures"
      noAgentFile={fallback === true ? <p>The stand-in fallback</p> : undefined}
      figures={figures.data}
    >
      {(summary) => <p>Drawn for {summary.injector.host}</p>}
    </AgentSectionGate>
  );
}

function renderGate(
  props: { readonly needsHttp?: boolean; readonly fallback?: boolean; readonly ownEnabled?: boolean } = {},
  options: Partial<Parameters<typeof renderAgentSection>[1]> = {},
) {
  return renderAgentSection(
    <StandIn needsHttp={props.needsHttp ?? true} fallback={props.fallback} ownEnabled={props.ownEnabled} />,
    {
      figures: (path) => (path.endsWith('/agent/injectors') ? INJECTORS : undefined),
      ...options,
    },
  );
}

const figureRequests = (requested: readonly string[]) => requested.filter((u) => u.includes('/agent/injectors'));
const host = AGENT_SUMMARY.injector.host;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

describe('AgentSectionGate', () => {
  it('draws its children once the summary says the figures exist', async () => {
    const { requested } = renderGate();
    expect(await screen.findByText(`Drawn for ${host}`)).toBeInTheDocument();
    expect(figureRequests(requested)).toHaveLength(1);
  });

  it('says once that the summary could not be read, with the server’s own words', async () => {
    const { requested } = renderGate({}, { failSummary: true });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This run's stand-in figures could not be loaded");
    expect(alert).toHaveTextContent('The agent summary could not be read. Retry the request.');
    expect(screen.queryByText(/Drawn for/)).toBeNull();
    expect(screen.queryByText('Stand-in A')).toBeNull();
    expect(figureRequests(requested)).toEqual([]);
  });

  it('shows one neutral loading state until the summary answers, not the section’s titles', async () => {
    renderGate({}, { holdSummary: true });
    expect(await screen.findByText("Loading this run's stand-in figures…")).toBeInTheDocument();
    expect(screen.queryByText('Stand-in A')).toBeNull();
    expect(screen.queryAllByTestId('live-notice-withheld')).toHaveLength(0);
  });

  it('withholds a notice per chart while the run streams', async () => {
    const { requested } = renderGate({}, { terminal: false });
    const notices = await screen.findAllByTestId('live-notice-withheld');
    expect(notices.map((n) => n.querySelector('p')?.textContent)).toEqual(SLOTS.map((s) => s.title));
    expect(requested.filter((u) => u.includes('/agent'))).toEqual([]);
  });

  it("draws the section's fallback for a run with no agent file, and the notice when it has none", async () => {
    const noFile = { ...AGENT_SUMMARY, available: false, reason: 'not_collected' as const, header: null, remotes: [], hostnames: [] };
    renderGate({ fallback: true }, { summary: noFile });
    expect(await screen.findByText('The stand-in fallback')).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    renderGate({ fallback: false }, { summary: noFile });
    expect(await screen.findByText('No agent data for this run')).toBeInTheDocument();
    expect(screen.getByText(/collects stand-in figures/)).toBeInTheDocument();
  });

  it('does not fall back for an unreadable file, even when the section has a fallback', async () => {
    const detail = 'checksum mismatch';
    renderGate(
      { fallback: true },
      { summary: { ...AGENT_SUMMARY, available: false, reason: 'unreadable', detail, header: null } },
    );
    expect(await screen.findByText("This run's agent file could not be read")).toBeInTheDocument();
    expect(screen.queryByText('The stand-in fallback')).toBeNull();
  });

  it('counts an HTTP collector that was off only for a section that needs it', async () => {
    const httpOff = {
      ...AGENT_SUMMARY,
      header: { ...AGENT_SUMMARY.header!, collects: { http: false, machine: true }, reasons: { http: 'off here' } },
    };
    const needs = renderGate({ needsHttp: true }, { summary: httpOff });
    expect(await screen.findByText('The agent did not collect HTTP figures')).toBeInTheDocument();
    expect(figureRequests(needs.requested)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    const free = renderGate({ needsHttp: false }, { summary: httpOff });
    expect(await screen.findByText(`Drawn for ${host}`)).toBeInTheDocument();
    expect(figureRequests(free.requested)).toHaveLength(1);
  });

  it("honours the figure read's own unavailable answer", async () => {
    renderGate({}, { figures: () => ({ ...INJECTORS, available: false, reason: 'unreadable', detail: 'gone', buckets: [] }) });
    expect(await screen.findByText("This run's agent file could not be read")).toBeInTheDocument();
    expect(screen.queryByText(/Drawn for/)).toBeNull();
  });

  it('offers a phone the charts and asks for its figures only once pressed', async () => {
    const user = userEvent.setup();
    useIsCompactMock.mockReturnValue(true);
    const { requested } = renderGate();
    const open = await screen.findByRole('button', { name: 'Open the stand-in charts' });
    expect(figureRequests(requested)).toEqual([]);
    await user.click(open);
    expect(await screen.findByText(`Drawn for ${host}`)).toBeInTheDocument();
    expect(figureRequests(requested)).toHaveLength(1);
  });

  it("gates the figure query, and never past an enabled the section's own options carry", async () => {
    // Held off by the gate while the run streams, whatever the options say.
    const live = renderGate({ ownEnabled: true }, { terminal: false });
    expect(await screen.findAllByTestId('live-notice-withheld')).toHaveLength(SLOTS.length);
    expect(figureRequests(live.requested)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    // Collected and drawn here, and still not asked for: the options said no.
    const held = renderGate({ ownEnabled: false });
    expect(await screen.findByText(`Drawn for ${host}`)).toBeInTheDocument();
    expect(figureRequests(held.requested)).toEqual([]);
  });
});

describe("the agent file's own notice", () => {
  // The harness's run started its tool here (support/agentSection.tsx).
  const toolStartedAtMs = Date.parse('2026-08-07T05:30:02.171Z');

  it('says nothing above a clean file', async () => {
    renderGate();
    expect(await screen.findByText(`Drawn for ${host}`)).toBeInTheDocument();
    expect(screen.queryByTestId('agent-file-notice')).toBeNull();
    expect(agentFileFacts(AGENT_SUMMARY, toolStartedAtMs)).toEqual([]);
  });

  it('says a capped file is missing its later events, above the figures and not as a live region', async () => {
    renderGate({}, { summary: { ...AGENT_SUMMARY, capped: true } });
    const notice = await screen.findByTestId('agent-file-notice');
    expect(notice).toHaveTextContent('The agent file reached its size cap, so events after that point are missing.');
    expect(notice).not.toHaveAttribute('role');
    expect(notice).not.toHaveAttribute('aria-live');
    // Above what it qualifies.
    const drawn = screen.getByText(`Drawn for ${host}`);
    expect(notice.compareDocumentPosition(drawn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says where the agent stopped, as an offset from the run's tool start", async () => {
    const at = toolStartedAtMs + 42_000;
    renderGate({}, { summary: { ...AGENT_SUMMARY, agentError: { at, where: 'sampler', message: 'disk full' } } });
    expect(await screen.findByTestId('agent-file-notice')).toHaveTextContent(
      'The agent stopped collecting 42s into the run: disk full.',
    );
  });

  it('says "part-way through" when the tool start is not known, never a guessed time', () => {
    const summary = { ...AGENT_SUMMARY, agentError: { at: 5, where: 'sampler', message: 'disk full' } };
    expect(agentFileFacts(summary, null)).toEqual(['The agent stopped collecting part-way through: disk full.']);
    // An instant before the tool start is no offset into the run either.
    expect(agentFileFacts(summary, 10)).toEqual(['The agent stopped collecting part-way through: disk full.']);
  });

  it('counts the lines it skipped, one sentence per fact', async () => {
    renderGate({}, { summary: { ...AGENT_SUMMARY, malformedLines: 3, capped: true } });
    const notice = await screen.findByTestId('agent-file-notice');
    expect(notice).toHaveTextContent('3 lines of the agent file could not be read and were skipped.');
    expect(notice.querySelectorAll('p')).toHaveLength(2);
    expect(agentFileFacts({ ...AGENT_SUMMARY, malformedLines: 1 }, null)).toEqual([
      '1 line of the agent file could not be read and was skipped.',
    ]);
  });
});
