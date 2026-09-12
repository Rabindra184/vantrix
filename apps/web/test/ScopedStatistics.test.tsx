import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ScopedStatistics from '../src/tables/ScopedStatistics';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as { stats: Parameters<typeof ScopedStatistics>[0]['rows'] };
const row = stats.stats.find((r) => r.scope === 'request' && r.name === 'Catalog/List Products')!;

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — each `it` below renders, and without this a later `getByTestId` finds one
// element per render still sitting in the document.
afterEach(cleanup);

describe('ScopedStatistics', () => {
  it('renders the payload’s own percentile columns, not a hard-coded set', () => {
    render(<ScopedStatistics row={row} rows={stats.stats} />);
    // Derived from the payload: a project configured with different
    // percentiles must move this table with it.
    //
    // Matched by DIGITS, not by the raw key: the shared column model (like
    // the run's own table, §13.2 ⑤ / §A.5) renders "50th", never "p50" — the
    // "p" is the payload's spelling for `StatRow.percentiles`, not a heading.
    for (const key of Object.keys(row.percentiles)) {
      const digits = key.replace(/^p/, '');
      expect(screen.getByRole('columnheader', { name: new RegExp(digits, 'i') })).toBeInTheDocument();
    }
  });

  it('renders counts against their own headings', () => {
    render(<ScopedStatistics row={row} rows={stats.stats} />);
    const total = screen.getByTestId('request-stat-count');
    expect(total).toHaveAttribute('data-value', String(row.count));
  });

  it('carries the unrounded value beside the rounded display', () => {
    render(<ScopedStatistics row={row} rows={stats.stats} />);
    // Rounding is a DISPLAY decision; the payload's value stays assertable.
    const mean = screen.getByTestId('request-stat-meanMs');
    expect(mean).toHaveAttribute('data-value', String(row.meanMs));
    expect(mean).toHaveTextContent(String(Math.round(row.meanMs)));
  });
});

/**
 * ═══ THE UNIT IS A HEADING HERE TOO (review M11) ═══
 *
 * This table repeats the run table's columns for ONE row, and repeated them
 * without the group heading row that carries the unit — so `Min`, `95th` and
 * `Max` were bare numbers on the page a reader reaches by drilling into the
 * table that did say so.
 *
 * The spans are asserted as a PARTITION of the leaf headings rather than
 * against written-down counts: a project configuring more percentiles widens
 * the response-time span, and the failure worth catching is a span that stops
 * matching the columns underneath it, which misaligns the whole header.
 */
describe('ScopedStatistics — the unit', () => {
  const span = (name: string): number =>
    Number(screen.getByRole('columnheader', { name }).getAttribute('colspan'));

  it('states milliseconds in a group heading over the time columns', () => {
    render(<ScopedStatistics row={row} rows={stats.stats} />);

    const leaves = screen.getAllByRole('columnheader').length - 2;
    expect(span('Executions') + span('Response Time (ms)')).toBe(leaves);

    // Every configured percentile is a response-time column, so the span can
    // never be smaller than the payload's own percentile count.
    expect(span('Response Time (ms)')).toBeGreaterThanOrEqual(
      Object.keys(row.percentiles).length,
    );
  });
});
