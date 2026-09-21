import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LiveDelta } from '@perfportal/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import SlaBanner from '../src/routes/SlaBanner';

afterEach(cleanup);

/**
 * A breach as an OLD worker published it: a message and no `rule`.
 *
 * The `description` is the evaluator's real output, copied from
 * `packages/sla`'s own `describe` rather than invented. It used to read
 * `p95 ≤ 100 — actual 900`, which is a sentence nothing in this product
 * writes — and a fixture that cannot tell the two vocabularies apart is
 * exactly why the banner went four branches printing the schema aloud.
 */
const BREACH = {
  ruleId: 'a',
  description: 'p95 of the run (response_time) ≤ 100 — actual 900',
  actualValue: 900,
  sinceOffsetMs: 62_000,
};

/**
 * The same breach as a CURRENT worker publishes it, carrying the six fields
 * `describeSlaOutcome` renders from. Measured against a real error-rate rule,
 * the pair is:
 *
 *   before  error_rate of the run (response_time) ≤ 0.01 — actual 0.0223463687150838
 *   after   Whole-run error rate 2.2346% exceeds the 1% limit.
 *
 * An error rate is the shape worth pinning: the raw form is not merely
 * unreadable but FALSE twice over — `0.01` is a fraction where every other
 * surface shows a percentage, and `(response_time)` states something untrue
 * about the quantity it qualifies.
 */
const STRUCTURED_BREACH = {
  ruleId: 'b',
  description: 'error_rate of the run (response_time) ≤ 0.01 — actual 0.0223463687150838',
  actualValue: 0.0223463687150838,
  sinceOffsetMs: 62_000,
  rule: {
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'error_rate',
    comparator: 'lte',
    threshold: 0.01,
  },
} as const;

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

/**
 * The live banner and the run page's gates table describe one rule with one
 * vocabulary — `review.md`'s copy row 1, whose third surface this is.
 *
 * ASSERTED AS A PAIR, because "renders something about an error rate" passes
 * perfectly against the schema-read-aloud form this replaces: the raw string
 * also contains `error_rate`. What separates them is the absence of the
 * stored spelling and the presence of the reader's one.
 */
describe('SlaBanner vocabulary', () => {
  it('describes a breach the way the run page does, not the way the schema stores it', () => {
    render(<SlaBanner sla={sla({ breaching: [STRUCTURED_BREACH] })} />);
    const banner = screen.getByRole('status');

    expect(banner).toHaveTextContent('Whole-run error rate 2.2346% exceeds the 1% limit.');

    // The three tells of the stored form, each its own mistake: the schema's
    // own field name, the family parenthesis that is false for an error rate,
    // and the fraction where the product shows a percentage.
    expect(banner).not.toHaveTextContent(/error_rate/);
    expect(banner).not.toHaveTextContent(/response_time/);
    expect(banner).not.toHaveTextContent(/0\.0223463687150838/);
  });

  it('still names how long the rule has been breaching', () => {
    render(<SlaBanner sla={sla({ breaching: [STRUCTURED_BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Breaching since 1m 2s into the run.');
  });

  /**
   * `rule` is optional on the wire so a rolling deploy degrades instead of
   * blanking the page — `LiveBreachSchema` argues that at length. This is the
   * only state in which the evaluator's raw message is still the right thing
   * to show, so it has to keep working AND keep its separator: run together,
   * the line reads `… actual 900 Breaching since 1m 2s into the run`.
   */
  it('falls back to the evaluator’s own message for a delta that predates the fields', () => {
    render(<SlaBanner sla={sla({ breaching: [BREACH] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'p95 of the run (response_time) ≤ 100 — actual 900 — breaching since 1m 2s into the run',
    );
  });
});
