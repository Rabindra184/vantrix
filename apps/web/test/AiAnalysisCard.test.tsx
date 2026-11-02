import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PENDING_REQUEUE_AFTER_MS,
  type AiAnalysisContent,
  type AiAnalysisResponse,
  type ProjectRole,
} from '@perfportal/contracts';
import { projectAccess } from '../src/access/useAccess';
import { aiAnalysisQueryKey, fetchAiAnalysis, requestAiAnalysis } from '../src/api/aiAnalysis';
import { formatInstant } from '../src/routes/format';
import AiAnalysisCard from '../src/routes/AiAnalysisCard';

/**
 * ═══ THE AI RUN ANALYSIS CARD ═══
 *
 * Both of the card's requests are mocked at the module, so no case reaches a
 * network and each one states what the API answered. Whether the reader may
 * ask for an analysis is decided the way the page decides it — `projectAccess`
 * over a role, read for `run:analyze` — so "a viewer sees nothing" is the
 * access table's answer, not a boolean this file made up.
 */
vi.mock('../src/api/aiAnalysis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/aiAnalysis.js')>()),
  fetchAiAnalysis: vi.fn(),
  requestAiAnalysis: vi.fn(),
}));

const fetchMock = vi.mocked(fetchAiAnalysis);
const requestMock = vi.mocked(requestAiAnalysis);

const RUN = '11111111-2222-4333-8444-555555555555';

const CONTENT: AiAnalysisContent = {
  health: {
    headline: 'The run held its SLA.',
    bullets: ['p95 stayed at 658 ms against an 800 ms gate.'],
  },
  insights: {
    headline: 'One request carried the tail.',
    errors: ['24 of 895 requests failed, all on Search.'],
    assertions: [],
    injectionProfile: ['Users ramped to 60 over the first 30 s.'],
    responseTimes: ['Search answered in 1,940 ms at p95.'],
  },
  recommendations: { headline: 'Look at Search first.', bullets: ['Profile the Search endpoint.'] },
};

const GENERATED_AT = '2026-11-02T10:00:00.000Z';

function available(overrides: Partial<Extract<AiAnalysisResponse, { available: true }>>): AiAnalysisResponse {
  return {
    available: true,
    state: 'none',
    content: null,
    failureReason: null,
    generatedAt: null,
    model: null,
    stale: false,
    requestedAt: null,
    ...overrides,
  };
}

const READY = available({
  state: 'ready',
  content: CONTENT,
  generatedAt: GENERATED_AT,
  model: 'claude-opus-5-5',
  requestedAt: '2026-11-02T09:59:00.000Z',
});

const canAnalyze = (role: ProjectRole): boolean =>
  projectAccess(false, [{ slug: 'checkout', role }], 'checkout').can('run:analyze');

function renderCard(role: ProjectRole = 'member'): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiAnalysisCard runId={RUN} canAnalyze={canAnalyze(role)} />
    </QueryClientProvider>,
  );
  return client;
}

/** Waits for the read to settle, then for React to draw what it answered. */
async function answered(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.getQueryState(aiAnalysisQueryKey(RUN))?.status).toBe('success'));
  await act(async () => {});
}

beforeEach(() => {
  fetchMock.mockReset();
  requestMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AiAnalysisCard', () => {
  it('renders nothing when unavailable', async () => {
    fetchMock.mockResolvedValue({ available: false, reason: 'org_disabled' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <AiAnalysisCard runId={RUN} canAnalyze />
      </QueryClientProvider>,
    );
    // Answered, so the empty card is its decision and not a read still waiting.
    await answered(client);
    expect(fetchMock).toHaveBeenCalledWith(RUN);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: 'AI run analysis' })).toBeNull();
  });

  it('offers Analyze with AI to a member and nothing to a viewer', async () => {
    fetchMock.mockResolvedValue(available({ state: 'none' }));
    renderCard('member');
    expect(await screen.findByRole('heading', { level: 2, name: 'AI run analysis' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Analyze with AI' })).toBeVisible();
    cleanup();

    // The access table, not this file, says a viewer may not generate one.
    expect(canAnalyze('viewer')).toBe(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <AiAnalysisCard runId={RUN} canAnalyze={canAnalyze('viewer')} />
      </QueryClientProvider>,
    );
    await answered(client);
    expect(container).toBeEmptyDOMElement();
  });

  it('polls while pending and renders the sections when ready', async () => {
    vi.useFakeTimers();
    const pending = available({ state: 'pending', requestedAt: new Date().toISOString() });
    fetchMock.mockResolvedValue(available({ state: 'none' }));
    requestMock.mockResolvedValue(pending);
    renderCard('member');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    fetchMock.mockResolvedValue(pending);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with AI' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(requestMock).toHaveBeenCalledWith(RUN);
    expect(screen.getByRole('status')).toHaveTextContent('Analysing this run…');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    // Still pending on the next read: still polling, still saying so.
    const before = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByRole('status')).toHaveTextContent('Analysing this run…');

    fetchMock.mockResolvedValue(READY);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // The live region is mounted only while pending.
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.trim()),
    ).toEqual(['Health', 'Insights', 'Recommendations']);
    for (const name of ['Health', 'Insights', 'Recommendations']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByText('The run held its SLA.')).toBeVisible();
    expect(screen.getByText('Profile the Search endpoint.')).toBeVisible();
    expect(screen.getByText(`Generated on ${formatInstant(GENERATED_AT)}`)).toBeVisible();

    // The ⓘ names the model and claims only what the check established.
    const info = screen.getByRole('button', { name: 'About this analysis' });
    const description = info.getAttribute('aria-describedby');
    const caveat = document.getElementById(description!)!.textContent ?? '';
    expect(caveat).toContain('claude-opus-5-5');
    expect(caveat).toMatch(/every number .* checked .* this run/i);
    expect(caveat).not.toMatch(/\bcorrect\b|\baccurate\b|\bverified analysis\b/i);

    // Ready: polling stops.
    const settled = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(fetchMock.mock.calls.length).toBe(settled);
  });

  it('omits an Insights sub-section that has no bullets', async () => {
    fetchMock.mockResolvedValue(READY);
    renderCard();
    const insights = await screen.findByRole('region', { name: 'Insights' });
    expect(within(insights).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Errors',
      'Injection profile',
      'Response times',
    ]);
    // A sub-section with nothing to say gets no heading, not an empty list.
    expect(within(insights).queryByRole('heading', { name: 'Assertions' })).toBeNull();
    expect(within(insights).getByText('One request carried the tail.')).toBeVisible();
  });

  it('collapses a section', async () => {
    fetchMock.mockResolvedValue(READY);
    renderCard();
    const toggle = await screen.findByRole('button', { name: 'Health' });
    const region = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(region).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(region).not.toBeVisible();
    expect(screen.queryByText('The run held its SLA.')).toBeNull();
    // The others are untouched: each section opens and closes on its own.
    expect(screen.getByRole('button', { name: 'Insights' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.getByText('The run held its SLA.')).toBeVisible();
  });

  it('offers Generate again when stale', async () => {
    fetchMock.mockResolvedValue({ ...READY, stale: true } as AiAnalysisResponse);
    requestMock.mockResolvedValue(available({ state: 'pending', requestedAt: new Date().toISOString() }));
    renderCard('member');
    expect(await screen.findByText('This run’s figures changed after this analysis was written.')).toBeVisible();
    // The analysis it describes is still shown — stale is a caveat, not a removal.
    expect(screen.getByText('The run held its SLA.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Analysing this run…');
    expect(requestMock).toHaveBeenCalledWith(RUN);
    cleanup();

    // A viewer is told, and offered nothing to press.
    renderCard('viewer');
    expect(await screen.findByText('This run’s figures changed after this analysis was written.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Generate again' })).toBeNull();
    // Not stale: no line and no button.
    cleanup();
    fetchMock.mockResolvedValue(READY);
    renderCard('member');
    await screen.findByText('The run held its SLA.');
    expect(screen.queryByText(/figures changed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate again' })).toBeNull();
  });

  it('shows the failure and Try again', async () => {
    fetchMock.mockResolvedValue(available({ state: 'failed', failureReason: 'numbers_not_in_facts: 42, 1,940' }));
    requestMock.mockResolvedValue(available({ state: 'pending', requestedAt: new Date().toISOString() }));
    renderCard('member');
    const card = await screen.findByRole('region', { name: 'AI run analysis' });
    expect(within(card).getByText('The analysis cited figures this run does not contain, so it was not kept.')).toBeVisible();
    // Never the worker's code, and never the figures it listed.
    expect(card).not.toHaveTextContent('numbers_not_in_facts');
    expect(card).not.toHaveTextContent('1,940');
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Analysing this run…');
    cleanup();

    renderCard('viewer');
    expect(await screen.findByText(/cited figures this run does not contain/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it.each([
    ['provider_error', 'The AI provider could not be reached, or did not answer in time.'],
    ['refused', 'The model declined to analyse this run.'],
    ['invalid_output', 'The model’s answer was not a usable analysis, so it was not kept.'],
    ['internal_error', 'PerfPortal could not finish writing the analysis.'],
    ['estimated', 'This run’s statistics predate exact statistics, so it was not analysed.'],
    ['something_new_the_worker_writes', 'The analysis could not be written.'],
  ])('says %s in one plain sentence', async (reason, sentence) => {
    fetchMock.mockResolvedValue(available({ state: 'failed', failureReason: reason }));
    renderCard('viewer');
    const card = await screen.findByRole('region', { name: 'AI run analysis' });
    expect(within(card).getByText(sentence)).toBeVisible();
    expect(card).not.toHaveTextContent(reason);
  });

  it('offers Try again on a pending analysis nothing is working on', async () => {
    const abandoned = new Date(Date.now() - AI_PENDING_REQUEUE_AFTER_MS - 60_000).toISOString();
    fetchMock.mockResolvedValue(available({ state: 'pending', requestedAt: abandoned }));
    requestMock.mockResolvedValue(available({ state: 'pending', requestedAt: new Date().toISOString() }));
    renderCard('member');
    expect(await screen.findByRole('status')).toHaveTextContent('Analysing this run…');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // The fresh pending row is trusted again: the offer goes.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(requestMock).toHaveBeenCalledWith(RUN);
    expect(screen.getByRole('status')).toHaveTextContent('Analysing this run…');
    cleanup();

    renderCard('viewer');
    expect(await screen.findByRole('status')).toHaveTextContent('Analysing this run…');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers Try again once a pending analysis outlives the window while the page is open', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(available({ state: 'pending', requestedAt: new Date().toISOString() }));
    renderCard('member');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_PENDING_REQUEUE_AFTER_MS + 1_000); });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    // And nothing will change on its own any more, so it stops asking.
    const calls = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  /** An older API omits `requestedAt`, and a row may carry none: an unknown
   *  age is not an abandoned row, so the card keeps polling and offers nothing. */
  it.each([
    ['absent, from an API that predates the field', undefined],
    ['null', null],
  ])('keeps polling a pending analysis whose age is %s, and offers no Try again', async (_label, requestedAt) => {
    vi.useFakeTimers();
    const body = available({ state: 'pending' });
    if (requestedAt === undefined) delete (body as { requestedAt?: unknown }).requestedAt;
    else (body as { requestedAt: string | null }).requestedAt = requestedAt;
    fetchMock.mockResolvedValue(body);
    renderCard('member');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByRole('status')).toHaveTextContent('Analysing this run…');
    const before = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_PENDING_REQUEUE_AFTER_MS + 9_000); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before + 3);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('relays the API’s refusal when a request is turned down', async () => {
    const { ProblemError } = await import('../src/api/fetch');
    fetchMock.mockResolvedValue(available({ state: 'none' }));
    requestMock.mockRejectedValue(
      new ProblemError(409, {
        code: 'AI_ANALYSIS_UNAVAILABLE',
        detail: 'Run x cannot be analysed: org_disabled.',
        remediation: 'An admin turns AI run analysis on for this organisation under Administration.',
      }),
    );
    renderCard('member');
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with AI' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An admin turns AI run analysis on for this organisation under Administration.');
    // The detail names the reason as a code; the reader gets the sentence.
    expect(alert).not.toHaveTextContent('org_disabled');
  });
});
