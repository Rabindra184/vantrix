import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventsResponse, RunResponse } from '@perfportal/contracts';
import { fetchRun, runQueryKey, type RunDetail } from '../src/api/run';
import { fetchRunEvents, RUN_EVENTS_POLL_MS } from '../src/api/runEvents';
import RunLogs from '../src/routes/RunLogs';

vi.mock('../src/api/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run.js')>()),
  fetchRun: vi.fn(),
}));
vi.mock('../src/api/runEvents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/runEvents.js')>()),
  fetchRunEvents: vi.fn(),
}));

const fetchRunMock = vi.mocked(fetchRun);
const fetchEventsMock = vi.mocked(fetchRunEvents);

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';
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
  startedAt: '2026-09-29T11:40:00.000Z',
  toolStartedAt: '2026-09-29T11:41:20.000Z',
  assertions: [],
};
const READY: RunDetail = { state: 'ready', run: COMPLETE_RUN };
const LIVE: RunDetail = { state: 'processing', run: { id: RUN, status: 'running', statusUrl: `/v1/runs/${RUN}` } };

/** 11:41:11Z plus `ms` — 17:11:11 in Asia/Kolkata, Gatling Enterprise's own clock. */
const at = (ms: number): string => new Date(Date.UTC(2026, 8, 29, 11, 41, 11) + ms).toISOString();

const EVENTS: RunEventsResponse = {
  runId: RUN,
  recorded: true,
  events: [
    { at: at(113), source: 'perfportal', message: 'Start requested.', phase: null },
    { at: at(225), source: 'perfportal', message: "Starting the simulation: 'example.ParitySimulation'", phase: null },
    { at: at(234), source: 'perfportal', message: "Using package: 'checkout load' (1.8 MiB)", phase: null },
    { at: at(38_379), source: 'runner', message: null, phase: 'Deploying' },
  ],
};

let current: RunDetail = READY;

function renderLogs(detail: RunDetail): QueryClient {
  current = detail;
  fetchRunMock.mockImplementation(async () => current);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(runQueryKey(RUN), detail);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN}/logs`]}>
        <Routes>
          <Route path="/runs/:runId/logs" element={<RunLogs />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  fetchRunMock.mockReset();
  fetchEventsMock.mockReset();
});

describe('RunLogs — the panel', () => {
  // THIS MACHINE'S OWN ZONE IS Asia/Kolkata, so the pin is asserted to have
  // taken before anything else, and the file is also run under TZ=UTC.
  const original = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Asia/Kolkata'; });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  beforeEach(() => {
    expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
  });

  it('prints each event as one line: the reader’s time to the millisecond, its source, its message', async () => {
    fetchEventsMock.mockResolvedValue(EVENTS);
    renderLogs(READY);
    const lines = await screen.findAllByTestId('run-log-line');
    expect(lines.slice(0, 3).map((line) => line.textContent)).toEqual([
      '[17:11:11.113 GMT+5:30] [perfportal] Start requested.',
      "[17:11:11.225 GMT+5:30] [perfportal] Starting the simulation: 'example.ParitySimulation'",
      "[17:11:11.234 GMT+5:30] [perfportal] Using package: 'checkout load' (1.8 MiB)",
    ]);
  });

  it('draws a phase as a separator row, not a message', async () => {
    fetchEventsMock.mockResolvedValue(EVENTS);
    renderLogs(READY);
    const lines = await screen.findAllByTestId('run-log-line');
    const phase = lines[3]!;
    expect(phase).toHaveAttribute('data-phase', 'Deploying');
    expect(phase.textContent?.startsWith('[17:11:49.379 GMT+5:30] ---| Deploying |')).toBe(true);
    expect(phase.textContent).not.toContain('[runner]');
  });

  it('highlights the quoted values and the numbers', async () => {
    fetchEventsMock.mockResolvedValue(EVENTS);
    renderLogs(READY);
    const lines = await screen.findAllByTestId('run-log-line');
    const values = [...lines[2]!.querySelectorAll('[data-kind="value"]')].map((node) => node.textContent);
    expect(values).toEqual(["'checkout load'", '1.8']);
  });

  it('is a log region a screen reader follows, named for what it holds', async () => {
    fetchEventsMock.mockResolvedValue(EVENTS);
    renderLogs(READY);
    const log = await screen.findByRole('log', { name: 'Run events' });
    expect(log.querySelectorAll('[data-testid="run-log-line"]')).toHaveLength(4);
  });

  it('says so when a runner run recorded no events', async () => {
    fetchEventsMock.mockResolvedValue({ runId: RUN, recorded: true, events: [] });
    renderLogs(READY);
    expect(await screen.findByText(
      'No events were recorded for this run — it ran before PerfPortal began recording them.',
    )).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('explains a run no runner produced, reached by a typed URL', async () => {
    fetchEventsMock.mockResolvedValue({ runId: RUN, recorded: false, events: [] });
    renderLogs(READY);
    expect(await screen.findByText(/on-prem runner/)).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('says the events could not be loaded, as an alert', async () => {
    fetchEventsMock.mockRejectedValue(new Error('network down'));
    renderLogs(READY);
    expect(await screen.findByRole('alert')).toHaveTextContent(/events could not be loaded/i);
  });
});

describe('RunLogs — following a live run', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it('re-reads every 2s while the run is live, once more when it finishes, then stops', async () => {
    fetchEventsMock.mockResolvedValue(EVENTS);
    const client = renderLogs(LIVE);
    await advance(0);
    const first = fetchEventsMock.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    await advance(RUN_EVENTS_POLL_MS);
    expect(fetchEventsMock.mock.calls.length).toBeGreaterThan(first);

    const beforeFinish = fetchEventsMock.mock.calls.length;
    current = READY;
    await act(async () => { client.setQueryData(runQueryKey(RUN), READY); });
    await advance(0);
    expect(fetchEventsMock.mock.calls.length).toBe(beforeFinish + 1);

    await advance(RUN_EVENTS_POLL_MS * 3);
    expect(fetchEventsMock.mock.calls.length).toBe(beforeFinish + 1);
  });
});
