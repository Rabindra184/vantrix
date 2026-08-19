import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SlaBanner from '../src/routes/SlaBanner';

afterEach(cleanup);

/**
 * The design decision this component exists to express: a breach is a
 * CONDITION, not an EVENT. See `SlaBanner.tsx`'s own docstring for why that
 * means no dismissal state and no "shown once" flag — this file's third case
 * is what pins that a re-render carrying the identical data still renders,
 * rather than only rendering on the transition into breaching.
 */
describe('SlaBanner', () => {
  it('names each breaching rule and how long it has been breaching', () => {
    render(
      <SlaBanner
        sla={{
          evaluated: 7,
          breaching: [
            { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 },
          ],
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/p95/);
    expect(screen.getByRole('status')).toHaveTextContent(/1m 2s/);
  });

  it('renders nothing when no rule is breaching', () => {
    const { container } = render(<SlaBanner sla={{ evaluated: 7, breaching: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  // A condition you can look at, not an event you might miss -- so it must
  // survive a re-render rather than firing once.
  it('still renders when the same breach arrives again', () => {
    const sla = {
      evaluated: 7,
      breaching: [
        { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 },
      ],
    };
    const { rerender } = render(<SlaBanner sla={sla} />);
    rerender(<SlaBanner sla={sla} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

/**
 * `frozen` (review's optional finding, taken): once streaming stops the
 * fold owner releases the run and nothing evaluates it again, so "currently
 * breaching" is the last known state, not a live one — the same distinction
 * `LiveSummary`'s own Duration tile makes (TASK 9 C3) for the same reason.
 * Defaulted to `false`, which is why the three tests above never pass it.
 */
describe('SlaBanner — frozen', () => {
  const sla = {
    evaluated: 7,
    breaching: [
      { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 },
    ],
  };

  it('says the breach is current while the run is still streaming', () => {
    render(<SlaBanner sla={sla} frozen={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/currently breaching/);
  });

  it('says the breach is as of when streaming stopped, once frozen', () => {
    render(<SlaBanner sla={sla} frozen />);
    expect(screen.getByRole('status')).toHaveTextContent(/breaching when streaming stopped/);
    // Not both tenses on the same render.
    expect(screen.getByRole('status')).not.toHaveTextContent(/currently breaching/);
  });
});
