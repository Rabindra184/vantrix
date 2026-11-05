import '@testing-library/jest-dom/vitest';
import { displayPath } from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ReportFilterControl from '../src/routes/report/ReportFilterControl';

/**
 * The Report's section filter control: the 0 / 1 / many rule
 * (`ConnectionsSection.test.tsx` and `DnsSection.test.tsx` pin it for a
 * remote and a hostname), and the two things the Requests pickers add to it —
 * a label for a stored value that is not what a reader reads (`labelOf`), and
 * a Request picker that exists before it can be used (`disabledReason`).
 */

afterEach(() => cleanup());

const noop = () => undefined;

function control(over: Partial<Parameters<typeof ReportFilterControl>[0]> = {}) {
  return render(
    <ReportFilterControl
      label="Group"
      allLabel="All groups"
      values={['Cart', 'Catalog/Recommendations', '']}
      value="*"
      onChange={noop}
      named={null}
      verb="recorded"
      {...over}
    />,
  );
}

describe('ReportFilterControl', () => {
  it('with disabledReason renders a disabled select described by the reason', () => {
    control({ label: 'Request', allLabel: 'All requests', values: [], disabledReason: 'Pick a group first.' });
    // Drawn although there is nothing to choose yet: the reader sees where the
    // choice will be, and why it is not available.
    const select = screen.getByRole('combobox', { name: 'Request' });
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription('Pick a group first.');
    const reason = screen.getByText('Pick a group first.');
    expect(reason).toBeVisible();
    expect(select.getAttribute('aria-describedby')).toBe(reason.id);
    expect(within(select).getByRole('option', { name: 'All requests' })).toBeInTheDocument();
  });

  it('without disabledReason the select is enabled and described by nothing', () => {
    control();
    const select = screen.getByRole('combobox', { name: 'Group' });
    expect(select).toBeEnabled();
    expect(select).not.toHaveAttribute('aria-describedby');
  });

  it('with labelOf, each option reads its label and keeps its stored value', () => {
    control({ labelOf: displayPath });
    const select = screen.getByRole('combobox', { name: 'Group' });
    const none = within(select).getByRole('option', { name: '(no group)' });
    expect(none).toHaveValue('');
    expect(within(select).getByRole('option', { name: 'Catalog / Recommendations' })).toHaveValue(
      'Catalog/Recommendations',
    );
    expect(within(select).getByRole('option', { name: 'All groups' })).toHaveValue('*');
  });

  it('with labelOf, the read-only field for one value reads its label', () => {
    control({ values: [''], labelOf: displayPath });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('(no group)')).toBeVisible();
  });

  it('with labelOf, the value a link asked for is named by its label', () => {
    control({ named: '', labelOf: displayPath });
    expect(screen.getByTestId('filter-unknown')).toHaveTextContent(
      'This link named (no group), which this run never recorded; showing all groups.',
    );
  });

  it('without labelOf, options read the stored value as before', () => {
    control();
    const select = screen.getByRole('combobox', { name: 'Group' });
    expect(within(select).getByRole('option', { name: 'Catalog/Recommendations' })).toHaveValue(
      'Catalog/Recommendations',
    );
  });
});
