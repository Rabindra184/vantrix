import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResponse } from '@perfportal/contracts';
import RunHeader from '../src/routes/RunHeader';

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, each `render` call below leaves its `<header>` mounted
// alongside the next one, and two headings collide.
afterEach(cleanup);

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
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

describe('RunHeader', () => {
  it('names the run by its fully-qualified simulation', () => {
    render(<RunHeader run={RUN} peakUsers={42} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('example.ParitySimulation');
  });

  it('falls back to the short id when the tool reported no simulation', () => {
    render(<RunHeader run={{ ...RUN, simulation: null }} peakUsers={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Run a66548b7');
  });

  /** Zero is a measurement; a run with no user buckets had none taken. */
  it('omits peak users entirely when there are none', () => {
    render(<RunHeader run={RUN} peakUsers={null} />);
    expect(screen.queryByText(/peak users/)).toBeNull();
  });

  it('says the start is ingest time when the tool reported none', () => {
    render(<RunHeader run={{ ...RUN, toolStartedAt: null }} peakUsers={null} />);
    expect(screen.getByText(/ingest time/)).toBeInTheDocument();
  });
});
