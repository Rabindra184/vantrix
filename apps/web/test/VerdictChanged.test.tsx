import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSlaMeasured, type VerdictChange } from '@perfportal/contracts';
import { VerdictChanged } from '../src/routes/VerdictChanged';

afterEach(cleanup);

const CHANGE: VerdictChange = {
  rule: { scope: 'run', targetName: null, family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 800 },
  oldOutcome: 'failed',
  newOutcome: 'passed',
  oldValue: 812.4,
  newValue: 790,
  oldVerdict: 'failed',
  newVerdict: 'passed',
  changedAt: '2026-10-16T09:00:00.000Z',
};

describe('VerdictChanged', () => {
  it('renders nothing when no verdict changed', () => {
    const { container } = render(<VerdictChanged changes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the verdict changed, and its info names both outcomes and both values', () => {
    render(<VerdictChanged changes={[CHANGE]} />);
    expect(screen.getByText('Verdict changed by exact statistics')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'About the verdict change' });
    // Values through the same formatter the gates table uses, so the two
    // surfaces print one number one way — computed, not written down.
    // A substring, not a RegExp built from the formatted value: a value
    // carrying a regex metacharacter (the decimal point among them) would
    // otherwise match more than it says.
    const description = trigger.getAttribute('aria-describedby');
    const text = description === null ? '' : (document.getElementById(description)?.textContent ?? '');
    expect(text).toContain(formatSlaMeasured('p95', 812.4, 800));
    expect(text).toContain(formatSlaMeasured('p95', 790, 800));
    expect(trigger).toHaveAccessibleDescription(/failed/);
    expect(trigger).toHaveAccessibleDescription(/passed/);
    // The rule, in the words the rules page uses.
    expect(trigger).toHaveAccessibleDescription(/whole run/i);
  });

  /**
   * ═══ A ROW EXISTS FOR EVERY CHANGED OUTCOME, NOT ONLY A CHANGED VERDICT ═══
   *
   * One rule can move from passed to failed while another rule already failed
   * the run, so the run's verdict reads failed before and after. Saying "the
   * verdict changed" there would be false in the largest text on the page.
   */
  it('says an outcome changed, not the verdict, when the run verdict held', () => {
    render(
      <VerdictChanged
        changes={[{ ...CHANGE, oldOutcome: 'passed', newOutcome: 'failed', oldVerdict: 'failed', newVerdict: 'failed' }]}
      />,
    );
    expect(screen.getByTestId('verdict-changed')).toHaveTextContent("An SLA rule's outcome changed with exact statistics");
    expect(screen.queryByText('Verdict changed by exact statistics')).toBeNull();
    // The same info either way.
    expect(screen.getByRole('button', { name: 'About the verdict change' })).toHaveAccessibleDescription(/whole run/i);
  });

  it('says the verdict changed when any one change moved it, beside one that did not', () => {
    render(
      <VerdictChanged
        changes={[
          { ...CHANGE, oldVerdict: 'failed', newVerdict: 'failed' },
          CHANGE,
        ]}
      />,
    );
    expect(screen.getByTestId('verdict-changed')).toHaveTextContent('Verdict changed by exact statistics');
  });

  it('prints no number for a side that had nothing to measure', () => {
    render(<VerdictChanged changes={[{ ...CHANGE, oldOutcome: 'not_applicable', oldValue: null }]} />);
    const trigger = screen.getByRole('button', { name: 'About the verdict change' });
    expect(trigger).toHaveAccessibleDescription(/not applicable/);
    expect(trigger).not.toHaveAccessibleDescription(/null|NaN|undefined/);
  });
});
