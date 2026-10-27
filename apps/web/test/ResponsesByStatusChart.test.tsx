import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStatusResponseSchema } from '@perfportal/contracts';
import ResponsesByStatusChart, { RESPONSES_BY_STATUS } from '../src/charts/ResponsesByStatusChart';
import fixture from './fixtures/agent-run.json';
import { AGENT_RUN, renderAgentSection } from './support/agentSection';

/**
 * The status chart's OWN gate, pinned alone. `RunReport` withholds it while a
 * run streams and never mounts it, so the page-level cases cannot tell
 * whether the chart's own `enabled: terminal` is there: both paths ask for
 * nothing. This mounts the chart over a running run directly — the shape a
 * future caller that forgets the page's branch would give it — and requires
 * that `/agent/status`, which answers 200 or an error and never a 202 run
 * body, is asked for only once the run has finished, on the same instance.
 */

const STATUS = AgentStatusResponseSchema.parse(fixture.status);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const statusRequests = (requested: readonly string[]) => requested.filter((u) => u.includes('/agent/status'));

describe('ResponsesByStatusChart', () => {
  it('asks for nothing while the run streams, and for its figures once it finishes', async () => {
    const { requested, finish } = renderAgentSection(
      <ResponsesByStatusChart runId={AGENT_RUN} domainMs={undefined} windowSelected={false} />,
      { terminal: false, figures: (path) => (path.endsWith('/agent/status') ? STATUS : undefined) },
    );
    // The run's own read has answered 202, and still nothing has been asked of the agent file.
    await waitFor(() => expect(requested.some((u) => new URL(u, 'http://x').pathname === `/v1/runs/${AGENT_RUN}`)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusRequests(requested)).toEqual([]);

    await finish();
    await waitFor(() => expect(statusRequests(requested)).toHaveLength(1));
    expect(await screen.findByRole('heading', { name: RESPONSES_BY_STATUS.title })).toBeInTheDocument();
  });
});
