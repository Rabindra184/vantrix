import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RunLifecycle from '../src/routes/RunLifecycle';
import { lifecycleSteps } from '../src/routes/lifecycle';

afterEach(cleanup);

/**
 * ═══ THE LIFECYCLE STRIP ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * The derivation is `lifecycle.test.ts`'s; these pin how the strip SAYS it:
 * a named region, an ordered list, no heading (the Overview's outline is
 * asserted as an exact list, and shell chrome must not add to it), words and
 * a hidden glyph rather than colour alone, Step times outside the summary,
 * and the phone's one line.
 */
const UPLOAD = lifecycleSteps({
  identity: {
    startedAt: '2026-08-14T10:43:49.546Z',
    toolStartedAt: '2026-08-07T05:30:02.171Z',
    activityMs: 62_136,
    durationMs: 63_161,
    parsingStartedAt: '2026-08-14T10:43:50.000Z',
    ingestedAt: '2026-08-14T10:43:52.000Z',
  },
  status: 'complete',
  verdict: 'failed',
  assertions: [],
});

const STREAMING = lifecycleSteps({
  identity: { startedAt: '2026-09-19T16:39:56.406Z', streamUpdatedAt: '2026-09-19T16:40:38.406Z' },
  status: 'running',
  verdict: undefined,
  assertions: undefined,
});

function region() {
  return screen.getByRole('region', { name: 'Run lifecycle' });
}

function items() {
  return within(within(region()).getByRole('list')).getAllByRole('listitem');
}

async function inKolkata(body: () => void): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('RunLifecycle', () => {
  it('is a named region holding an ordered list, with no heading', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    expect(within(region()).getByRole('list').tagName).toBe('OL');
    expect(items()).toHaveLength(4);
    expect(within(region()).queryAllByRole('heading')).toHaveLength(0);
  });

  it('says each step in words, with its glyph hidden from a screen reader', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    expect(items().map((li) => li.textContent)).toEqual([
      expect.stringContaining('Load test · 62s'),
      expect.stringContaining('Received'),
      expect.stringContaining('Processed · 2s'),
      expect.stringContaining('Verdict: Failed'),
    ]);
    for (const li of items()) {
      expect(li.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('keeps the list outside the Step times disclosure', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    const list = within(region()).getByRole('list');
    const details = screen.getByTestId('lifecycle-times');
    expect(details.tagName).toBe('DETAILS');
    expect(details.contains(list)).toBe(false);
  });

  it('shows a warm-up beside the load test’s duration in Step times', () => {
    const steps = lifecycleSteps({
      identity: {
        startedAt: '2026-08-14T10:43:49.546Z',
        toolStartedAt: '2026-08-14T10:30:00.000Z',
        durationMs: 300_000,
        activityMs: 240_000,
        warmupMs: 60_000,
      },
      status: 'complete',
      verdict: 'passed',
      assertions: [],
    });
    render(<RunLifecycle steps={steps} compact={false} />);
    expect(screen.getByTestId('lifecycle-times-load-test')).toHaveTextContent('240s · after a 60s warm-up');
  });

  it('times every step to the second, with the zone once in the caption', async () => {
    await inKolkata(() => {
      render(<RunLifecycle steps={UPLOAD} compact={false} />);
      const details = screen.getByTestId('lifecycle-times');
      expect(details.querySelector('caption')?.textContent).toMatch(/GMT\+5:30/);
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('16:13:50');
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('16:13:52');
      expect(screen.getByTestId('lifecycle-times-received')).toHaveTextContent(/after the test ended/);
      // The load test ran a week before the bundle arrived: its row is on the
      // caption's day and carries no date; every later row carries its own.
      expect(screen.getByTestId('lifecycle-times-load-test')).not.toHaveTextContent('2026');
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('2026');
    });
  });

  /** One line on a phone, and not the verdict: the decision band's 36 px word
   *  sits directly below it, and review M02 removed exactly that kind of
   *  restatement from the phone. The fold had 10 px to spare, and has 7.6 now. */
  it('shows a finished run’s load test on a phone, not its processing', () => {
    render(<RunLifecycle steps={UPLOAD} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Load test · 62s');
    expect(within(region()).getByRole('list')).not.toHaveTextContent('Processed');
    expect(within(region()).getByRole('list')).not.toHaveTextContent('Verdict:');
    expect(screen.getByTestId('lifecycle-times')).toBeInTheDocument();
  });

  it('shows a streaming load test on a phone while the run is live', () => {
    render(<RunLifecycle steps={STREAMING} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Load test · streaming · 42s');
  });

  it('shows the step in progress on a phone, ahead of a finished load test', () => {
    const steps = lifecycleSteps({
      identity: {
        startedAt: '2026-09-19T16:39:56.406Z',
        streamUpdatedAt: '2026-09-19T16:40:26.406Z',
        parsingStartedAt: '2026-09-19T16:40:27.406Z',
      },
      status: 'parsing',
      verdict: undefined,
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent(/Processing since \d{2}:\d{2}:\d{2}/);
  });

  /** The whole-branch review's finding: the band's Execution row is gone, so
   *  on a phone this line is the only place left to say a test was cut short. */
  it('says an incomplete run’s load test stopped early on a phone', () => {
    const steps = lifecycleSteps({
      identity: { startedAt: '2026-09-19T16:39:56.406Z' },
      status: 'incomplete',
      verdict: 'not_evaluated',
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent(/stopped early/i);
    expect(items()[0]).not.toHaveTextContent(/nothing retained/i);
  });

  it('puts a processed incomplete run’s early stop ahead of its processing on a phone', () => {
    const steps = lifecycleSteps({
      identity: {
        startedAt: '2026-09-19T16:39:56.406Z',
        toolStartedAt: '2026-09-19T16:39:57.406Z',
        activityMs: 36_028,
        durationMs: 36_500,
        streamUpdatedAt: '2026-09-19T16:40:33.906Z',
        parsingStartedAt: '2026-09-19T16:45:33.906Z',
        ingestedAt: '2026-09-19T16:45:35.906Z',
      },
      status: 'incomplete',
      verdict: 'passed',
      assertions: [],
    });
    render(<RunLifecycle steps={steps} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Load test stopped early · 36s');
    expect(items()[0]).not.toHaveTextContent('Processed');
  });

  /** Was the decision band's Execution sentence; the strip says it now. */
  it('says an incomplete run’s load test stopped early, not that processing failed', () => {
    const steps = lifecycleSteps({
      identity: { startedAt: '2026-09-19T16:39:56.406Z' },
      status: 'incomplete',
      verdict: 'not_evaluated',
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact={false} />);
    expect(region()).toHaveTextContent(/stopped early/i);
    expect(region()).not.toHaveTextContent(/processing failed/i);
  });

  /** The other half of that pair, kept from the band: a failed run never
   *  says "stopped early". Defensive — see `lifecycle.ts`. */
  it('says a failed run’s processing failed, never that it stopped early', () => {
    const steps = lifecycleSteps({
      identity: { startedAt: '2026-09-19T16:39:56.406Z' },
      status: 'failed',
      verdict: null,
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact={false} />);
    expect(region()).toHaveTextContent(/processing failed/i);
    expect(region()).not.toHaveTextContent(/stopped early/i);
  });
});
