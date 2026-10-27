import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { expect, vi } from 'vitest';
import { AgentSummaryResponseSchema } from '@perfportal/contracts';
import type { AgentSummaryResponse, RunResponse, TelemetryResponse, Window } from '@perfportal/contracts';
import { useProjectAccess } from '../../src/access/useAccess';
import { runQueryKey } from '../../src/api/run';
import type { RunWindowContext } from '../../src/routes/useRunWindow';
import fixture from '../fixtures/agent-run.json';
import { seedAccess } from './access';

/**
 * ═══ MOUNTING ONE OF THE REPORT'S AGENT SECTIONS ═══
 *
 * Connections, DNS and Load generators all read the same run, the same
 * summary and the same shell outlet, and are all tested through the same
 * transitions (the run finishing under a mounted section; a phone reader
 * pressing the button). One harness, so the three files cannot drift into
 * testing those transitions three different ways.
 *
 * Fetch answers from the captured agent run (`fixtures/agent-run.json`); a
 * test supplies only the figure read it is about, through `figures`.
 */

// Parsed rather than cast: the JSON's tuples read as `number[][]`, and parsing
// also proves the captured body still satisfies today's contract.
export const AGENT_SUMMARY = AgentSummaryResponseSchema.parse(fixture.summary);
export const AGENT_RUN = AGENT_SUMMARY.runId;

const COMPLETE_RUN: RunResponse = {
  id: AGENT_RUN,
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

const NO_TELEMETRY: TelemetryResponse = { runId: AGENT_RUN, available: false, bucketWidthMs: 1000, window: null, hosts: [] };

const RUNNING = {
  state: 'processing' as const,
  run: { id: AGENT_RUN, status: 'running' as const, statusUrl: `/v1/runs/${AGENT_RUN}` },
};
const READY = { state: 'ready' as const, run: COMPLETE_RUN };

/** `RunShell`'s outlet as a section meets it; `window` is the brush's selection. */
function ShellStandIn({ window }: { readonly window: Window | null }) {
  const projectAccess = useProjectAccess(COMPLETE_RUN.project.slug);
  return (
    <Outlet
      context={
        {
          window, durationMs: null, liveDurationMs: null, warmupMs: null, live: null, projectAccess,
        } satisfies RunWindowContext
      }
    />
  );
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

export interface AgentSectionOptions {
  readonly summary?: AgentSummaryResponse;
  /** The summary read never answers: the section's state before it does. */
  readonly holdSummary?: boolean;
  /** The summary read fails (a 500 with a problem body). */
  readonly failSummary?: boolean;
  /**
   * The section's own figure read: its body for a path under
   * `/v1/runs/:id/agent/…`, or undefined for a path it does not answer.
   */
  readonly figures: (path: string, params: URLSearchParams) => unknown;
  readonly search?: string;
  readonly terminal?: boolean;
  readonly window?: Window | null;
}

export function renderAgentSection(section: ReactElement, options: AgentSectionOptions) {
  const summary = options.summary ?? AGENT_SUMMARY;
  const requested: string[] = [];
  // What `/v1/runs/:id` answers, MUTABLE: the run query has no staleTime, so
  // mounting refetches it, and the transition case changes the answer.
  let current: typeof RUNNING | typeof READY = options.terminal === false ? RUNNING : READY;
  vi.stubGlobal('fetch', async (input: RequestInfo) => {
    const url = String(input);
    requested.push(url);
    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === `/v1/runs/${AGENT_RUN}`) {
      await Promise.resolve();
      return json(current.run, current.state === 'ready' ? 200 : 202);
    }
    if (path === `/v1/runs/${AGENT_RUN}/agent`) {
      if (options.holdSummary === true) return new Promise<Response>(() => {});
      if (options.failSummary === true) {
        return json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            code: 'INTERNAL',
            detail: 'The agent summary could not be read.',
            remediation: 'Retry the request.',
            traceId: 't',
          },
          500,
        );
      }
      return json(summary);
    }
    if (path.startsWith(`/v1/runs/${AGENT_RUN}/agent/`)) {
      const body = options.figures(path, parsed.searchParams);
      if (body !== undefined) return json(body);
    }
    if (path === `/v1/runs/${AGENT_RUN}/telemetry`) return json(NO_TELEMETRY);
    if (url === '/auth/get-session') return new Promise<Response>(() => {});
    return json({}, 500);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedAccess(client, { isAdmin: true });
  client.setQueryData(runQueryKey(AGENT_RUN), current);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${AGENT_RUN}/report${options.search ?? ''}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<ShellStandIn window={options.window ?? null} />}>
            <Route
              path="report"
              element={
                <>
                  {section}
                  <LocationProbe />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  /** The run finishes, on the same client and the same mounted section. */
  const finish = async () => {
    current = READY;
    await act(async () => {
      client.setQueryData(runQueryKey(AGENT_RUN), READY);
    });
  };
  return { requested, finish };
}

/** The search string the section has written, as parameters. */
export function locationParams(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location').textContent ?? '');
}

/**
 * Waits for `count` charts to have DRAWN. Counting figures is not enough: a
 * pending or failed read renders `Undrawn` figures under the same ids and
 * titles. Only a drawn chart holds a plotting surface (`data-chart-canvas`).
 * `except` names figures expected NOT to draw — a chart whose payload says why
 * it is empty — which must still be present, with no canvas.
 */
export async function waitForDrawn(count: number, except: readonly string[] = []) {
  await waitFor(() => {
    const figures = screen.getAllByRole('figure');
    expect(figures).toHaveLength(count);
    for (const f of figures) {
      const id = f.getAttribute('data-testid') ?? '';
      const canvas = f.querySelector('[data-chart-canvas]');
      if (except.includes(id)) expect(canvas, id).toBeNull();
      else expect(canvas, id).not.toBeNull();
    }
  });
}
