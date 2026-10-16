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
    expect(trigger).toHaveAccessibleDescription(new RegExp(formatSlaMeasured('p95', 812.4, 800)));
    expect(trigger).toHaveAccessibleDescription(new RegExp(formatSlaMeasured('p95', 790, 800)));
    expect(trigger).toHaveAccessibleDescription(/failed/);
    expect(trigger).toHaveAccessibleDescription(/passed/);
    // The rule, in the words the rules page uses.
    expect(trigger).toHaveAccessibleDescription(/whole run/i);
  });

  it('prints no number for a side that had nothing to measure', () => {
    render(<VerdictChanged changes={[{ ...CHANGE, oldOutcome: 'not_applicable', oldValue: null }]} />);
    const trigger = screen.getByRole('button', { name: 'About the verdict change' });
    expect(trigger).toHaveAccessibleDescription(/not applicable/);
    expect(trigger).not.toHaveAccessibleDescription(/null|NaN|undefined/);
  });
});
