import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { RunnerJobListResponse } from '@perfportal/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import RunnerStatusLine from '../src/routes/RunnerStatusLine';

afterEach(cleanup);

/**
 * ═══ ONE LINE OF STATUS, THE CAVEAT BEHIND ONE ⓘ (clean UI, PR 4) ═══
 *
 * Add results and New on-prem run each printed the runner's state as a
 * headline, a two-sentence explanation and a footnote, and said the caveat —
 * that all of it is inferred from this project's jobs — twice. Both pages draw
 * this one line now: the headline, one short fact, and the caveat behind an ⓘ.
 */
function job(status: string, agedMs: number) {
  const at = new Date(Date.now() - agedMs).toISOString();
  return { job: { id: '00000000-0000-4000-8000-0000000000c1', status, createdAt: at, updatedAt: at } };
}
const settled = (...items: ReturnType<typeof job>[]) => ({
  isPending: false,
  isError: false,
  data: { items } as unknown as RunnerJobListResponse,
});

/** The visible words: the hidden copy of the ⓘ's caveat and the decorative
 *  dot are excluded. */
const visibleText = (): string => {
  const line = screen.getByTestId('runner-status').cloneNode(true) as HTMLElement;
  line.querySelectorAll('[hidden], .sr-only').forEach((node) => node.remove());
  return (line.textContent ?? '').replace('●', '').replace(/\s+/g, ' ').trim();
};

/** What a screen reader reads: nothing `aria-hidden` (the dot and the "·"),
 *  nothing `hidden` (the ⓘ's copy), the visually hidden separator included. */
const spokenText = (): string => {
  const line = screen.getByTestId('runner-status').cloneNode(true) as HTMLElement;
  line.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((node) => node.remove());
  line.querySelectorAll('button').forEach((node) => node.remove());
  return (line.textContent ?? '').replace(/\s+/g, ' ').trim();
};

describe('RunnerStatusLine', () => {
  it('says Checking… while the job list loads', () => {
    render(<RunnerStatusLine query={{ isPending: true, isError: false, data: undefined }} />);
    expect(screen.getByTestId('runner-status')).toHaveTextContent(/^Checking…$/);
  });

  it('reports a failed list as unavailable, not as a runner state', () => {
    render(<RunnerStatusLine query={{ isPending: false, isError: true, data: undefined }} />);
    expect(visibleText()).toMatch(/^Status unavailable\s*·\s*The job list could not be loaded$/);
    expect(screen.queryByRole('button', { name: 'About runner status' })).toBeNull();
  });

  it.each([
    ['unknown', [], 'Runner availability unknown', 'No run queued from this project yet'],
    ['busy', [job('running', 5_000)], 'A runner is working', 'A new run waits behind 1 job'],
    ['waiting', [job('queued', 10_000)], 'Waiting to be claimed', '1 job queued, none claimed yet'],
    ['idle', [job('complete', 20 * 60_000)], 'No job in flight', 'Last job finished 20 minutes ago'],
  ] as const)('states the headline and one short fact when %s', (_kind, items, headline, fact) => {
    render(<RunnerStatusLine query={settled(...items)} />);
    expect(visibleText()).toBe(`${headline} · ${fact}`);
  });

  /** PR 4 cleanup: the "·" is decoration, so a screen reader heard the
   *  headline and the fact as one run-on phrase. */
  it('separates the headline from the fact for a screen reader', () => {
    render(<RunnerStatusLine query={settled()} />);
    expect(spokenText()).toBe('Runner availability unknown, No run queued from this project yet');
  });

  it('keeps a stalled runner’s action on screen', () => {
    render(<RunnerStatusLine query={settled(job('queued', 12 * 60_000))} />);
    const action = screen.getByText(/Check a runner is running and pointed at this instance/);
    expect(action).toBeVisible();
    expect(action.closest('[hidden]')).toBeNull();
    expect(visibleText()).toMatch(/^Nothing is claiming work · Queued 12 minutes ago, unclaimed\./);
  });

  it('puts the caveat behind one info', () => {
    render(<RunnerStatusLine query={settled()} />);
    const tip = screen.getByRole('button', { name: 'About runner status' });
    expect(tip).toHaveAccessibleDescription(/inferred from this project's jobs/i);
    expect(tip).toHaveAccessibleDescription(/not told when a runner connects/i);
    expect(tip).toHaveAccessibleDescription(/one job at a time/i);
    // PR 4 cleanup: nothing else on Add results says a runner is something
    // you deploy, or which permission its token needs.
    expect(tip).toHaveAccessibleDescription(/process deployed beside this instance/i);
    expect(tip).toHaveAccessibleDescription(/On-prem runner permission/);
  });
});
