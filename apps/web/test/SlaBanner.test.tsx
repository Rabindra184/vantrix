import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LiveDelta } from '@perfportal/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import SlaBanner from '../src/routes/SlaBanner';

afterEach(cleanup);

const BREACH = {
  ruleId: 'a',
  description: 'p95 ≤ 100 — actual 900',
  actualValue: 900,
  sinceOffsetMs: 62_000,
};

/**
 * A wire `sla` field, with every count at its quietest value. Cases override
 * only the number they are about -- typed as `LiveDelta['sla']` so that adding
 * a field to `LiveSlaSchema` breaks this file at compile time rather than
 * leaving every case here silently asserting against a shape the component no
 * longer receives.
 */
function sla(overrides: Partial<LiveDelta['sla']> = {}): LiveDelta['sla'] {
  return { evaluated: 7, notJudged: 0, rulesUnavailable: false, breaching: [], ...overrides };
}

/**
 * The design decision this component exists to express: a breach is a
 * CONDITION, not an EVENT. See `SlaBanner.tsx`'s own docstring for why that
 * means no dismissal state and no "shown once" flag — this file's third case
 * is what pins that a re-render carrying the identical data still renders,
 * rather than only rendering on the transition into breaching.
 */
describe('SlaBanner', () => {
  it('names each breaching rule and how long it has been breaching', () => {
    render(<SlaBanner sla={sla({ breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/p95/);
    expect(screen.getByRole('status')).toHaveTextContent(/1m 2s/);
  });

  it('renders nothing when no rule is breaching', () => {
    const { container } = render(<SlaBanner sla={sla()} />);
    expect(container).toBeEmptyDOMElement();
  });

  // A condition you can look at, not an event you might miss -- so it must
  // survive a re-render rather than firing once.
  it('still renders when the same breach arrives again', () => {
    const value = sla({ breaching: [BREACH] });
    const { rerender } = render(<SlaBanner sla={value} />);
    rerender(<SlaBanner sla={value} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

/**
 * Whole-branch review, C1. `evaluated` is `passed + failed` — an honest
 * number under a sentence that called it "SLA rules", so a project with seven
 * rules whose percentile rules were still below the live evidence floor read
 * "1 of 1 SLA rules currently breaching" at second 30 and "1 of 7" at minute
 * 3, with nothing accounting for the six that moved.
 */
describe('SlaBanner — what the denominator counts', () => {
  it('says the denominator is the rules that were CHECKED', () => {
    render(<SlaBanner sla={sla({ evaluated: 1, breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/1 of 1 checked SLA rule/);
  });

  it('states the rules that have not been checked, rather than leaving them to be inferred', () => {
    render(<SlaBanner sla={sla({ evaluated: 1, notJudged: 6, breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/6 further rules have not been checked yet/);
  });

  it('says nothing about unchecked rules when there are none', () => {
    render(<SlaBanner sla={sla({ evaluated: 7, notJudged: 0, breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).not.toHaveTextContent(/not been checked/);
  });

  it('reads as one rule, singular, when exactly one is unchecked', () => {
    render(<SlaBanner sla={sla({ evaluated: 1, notJudged: 1, breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/1 further rule has not been checked yet/);
  });
});

/**
 * The other half of C1. "All checked and fine", "nothing has enough data yet"
 * and "the rules failed to load" all rendered as nothing. The last is not
 * transient — a run's rules are read once, at claim, and never retried — so a
 * failed load means this run is watched by nobody for its whole life, and an
 * empty banner is the one thing this component must not say about it.
 */
describe('SlaBanner — rules that could not be loaded', () => {
  it('renders even with nothing breaching, because "nothing breaching" is not what it knows', () => {
    render(<SlaBanner sla={sla({ evaluated: 0, rulesUnavailable: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/could not be loaded/);
  });

  // Nothing was checked, so there is no fraction to report — a "0 of 0" would
  // be a claim about rules this run never saw.
  it('does not report a breach count it does not have', () => {
    render(<SlaBanner sla={sla({ evaluated: 0, rulesUnavailable: true })} />);
    expect(screen.getByRole('status')).not.toHaveTextContent(/breaching/);
  });
});

/**
 * `frozen` (review's optional finding, taken): once streaming stops the
 * fold owner releases the run and nothing evaluates it again, so "currently
 * breaching" is the last known state, not a live one — the same distinction
 * `LiveSummary`'s own Duration tile makes (TASK 9 C3) for the same reason.
 * Defaulted to `false`, which is why the cases above never pass it.
 */
describe('SlaBanner — frozen', () => {
  const breaching = sla({ breaching: [BREACH] });

  it('says the breach is current while the run is still streaming', () => {
    render(<SlaBanner sla={breaching} frozen={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/currently breaching/);
  });

  it('says the breach is as of when streaming stopped, once frozen', () => {
    render(<SlaBanner sla={breaching} frozen />);
    expect(screen.getByRole('status')).toHaveTextContent(/breaching when streaming stopped/);
    // Not both tenses on the same render.
    expect(screen.getByRole('status')).not.toHaveTextContent(/currently breaching/);
  });
});
