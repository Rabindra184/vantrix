import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunTally from '../src/routes/RunTally';

afterEach(cleanup);

/**
 * ═══ THE TALLY IS ONE LINE OF COUNTS (clean UI, PR 3) ═══
 *
 * It was a card: a scope line repeating the heading's run total, a "How
 * counts work" disclosure, and a description under each of four counts. It
 * keeps the counts and their labels; what each count includes, that a run can
 * be in two, and that they cover this page only ride behind one ⓘ.
 */
const RUN = {
  tool: 'gatling',
  startedAt: '2026-08-15T10:00:00.000Z',
  toolStartedAt: '2026-08-15T10:00:00.000Z',
  project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
  simulation: 'example.ParitySimulation',
};

/** One SLA failure, one in flight, one passed, one with no verdict — so each
 *  count is 1 except Unjudged, which the pending run (no verdict) joins. */
const FOUR: RunListResponse['items'] = [
  { ...RUN, id: '11111111-1111-4111-8111-111111111111', status: 'complete', verdict: 'failed' },
  { ...RUN, id: '22222222-2222-4222-8222-222222222222', status: 'pending', verdict: null },
  { ...RUN, id: '33333333-3333-4333-8333-333333333333', status: 'complete', verdict: 'passed' },
  { ...RUN, id: '44444444-4444-4444-8444-444444444444', status: 'complete', verdict: null },
];

describe('RunTally', () => {
  it('counts the page in four labelled numbers, zeros included', () => {
    render(<RunTally items={FOUR} />);
    const counts = [
      ['needs-attention', 'Needs attention', 1],
      ['in-flight', 'In flight', 1],
      ['passed-gates', 'Passed gates', 1],
      ['unjudged', 'Unjudged', 2],
    ] as const;
    for (const [id, label, n] of counts) {
      expect(screen.getByTestId(`health-${id}`)).toHaveTextContent(new RegExp(`^${n}\\s*${label}$`));
    }

    cleanup();
    render(<RunTally items={[]} />);
    for (const [id, label] of counts) {
      expect(screen.getByTestId(`health-${id}`)).toHaveTextContent(new RegExp(`^0\\s*${label}$`));
    }
  });

  it('scopes the counts without repeating the run total, and carries no descriptions', () => {
    render(<RunTally items={FOUR} />);
    expect(screen.getByRole('region', { name: 'Run health on this page' })).toBeInTheDocument();
    expect(screen.getByTestId('health-scope')).toHaveTextContent(/^On this page$/);
    expect(screen.queryByText(/Pending, parsing, or live/)).toBeNull();
    expect(screen.queryByText('How counts work')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('puts what each count includes behind one info', () => {
    render(<RunTally items={FOUR} />);
    const info = screen.getByRole('button', { name: 'About these counts' });
    expect(info).toHaveAccessibleDescription(/simulation assertion failed/i);
    expect(info).toHaveAccessibleDescription(/pending, parsing or live/i);
    expect(info).toHaveAccessibleDescription(/more than one/i);
    expect(info).toHaveAccessibleDescription(/this page only/i);
  });
});
