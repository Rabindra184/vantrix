import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assertion, RunResponse } from '@perfportal/contracts';
import RunDecisionBand from '../src/routes/RunDecisionBand';
import { runSummaryJson } from '../src/routes/runExport';

afterEach(cleanup);

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'failed',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

const ASSERTIONS: readonly Assertion[] = [
  {
    ruleId: '22222222-2222-4222-8222-222222222222',
    outcome: 'failed',
    actualValue: 1830,
    message: 'p99 breached its threshold.',
    rule: {
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p99',
      comparator: 'lte',
      threshold: 750,
    },
  },
];

function renderBand() {
  return render(
    <MemoryRouter>
      <RunDecisionBand
        identity={RUN}
        status={RUN.status}
        verdict={RUN.verdict}
        assertions={ASSERTIONS}
      />
    </MemoryRouter>,
  );
}

describe('RunDecisionBand', () => {
  it('keeps compare as a real link and exposes export as a run action', () => {
    renderBand();
    expect(screen.getByRole('link', { name: 'Compare previous' })).toHaveAttribute(
      'href',
      `/runs/${RUN.id}/compare`,
    );
    expect(screen.getByRole('button', { name: 'Export run' })).toBeInTheDocument();
  });

  it('exports the run summary the decision band is showing', async () => {
    const held: { blob: Blob | null } = { blob: null };
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        held.blob = blob;
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: () => {} });

    renderBand();
    fireEvent.click(screen.getByRole('button', { name: 'Export run' }));

    if (held.blob === null) throw new Error('Export run produced no blob');
    const payload = JSON.parse(await held.blob.text()) as {
      run: { id: string; status: string; verdict: string };
      assertions: readonly { ruleId: string; outcome: string }[];
    };
    expect(payload.run).toMatchObject({ id: RUN.id, status: 'complete', verdict: 'failed' });
    expect(payload.assertions).toHaveLength(1);
    expect(payload.assertions[0]).toMatchObject({ ruleId: ASSERTIONS[0]?.ruleId, outcome: 'failed' });
  });
});

describe('runSummaryJson', () => {
  it('includes export time, run identity and assertions without inventing metrics', () => {
    const json = runSummaryJson({
      identity: RUN,
      status: RUN.status,
      verdict: RUN.verdict,
      assertions: ASSERTIONS,
      exportedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(JSON.parse(json)).toMatchObject({
      exportedAt: '2026-08-21T00:00:00.000Z',
      run: { id: RUN.id, simulation: RUN.simulation, status: RUN.status, verdict: RUN.verdict },
      assertions: [{ ruleId: ASSERTIONS[0]?.ruleId, outcome: 'failed' }],
    });
  });
});
