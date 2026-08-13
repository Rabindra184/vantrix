import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RequestStatistics from '../src/tables/RequestStatistics';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as { stats: Parameters<typeof RequestStatistics>[0]['rows'] };
const row = stats.stats.find((r) => r.scope === 'request' && r.name === 'Catalog/List Products')!;

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — each `it` below renders, and without this a later `getByTestId` finds one
// element per render still sitting in the document.
afterEach(cleanup);

describe('RequestStatistics', () => {
  it('renders the payload’s own percentile columns, not a hard-coded set', () => {
    render(<RequestStatistics row={row} rows={stats.stats} />);
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
    render(<RequestStatistics row={row} rows={stats.stats} />);
    const total = screen.getByTestId('request-stat-count');
    expect(total).toHaveAttribute('data-value', String(row.count));
  });

  it('carries the unrounded value beside the rounded display', () => {
    render(<RequestStatistics row={row} rows={stats.stats} />);
    // Rounding is a DISPLAY decision; the payload's value stays assertable.
    const mean = screen.getByTestId('request-stat-meanMs');
    expect(mean).toHaveAttribute('data-value', String(row.meanMs));
    expect(mean).toHaveTextContent(String(Math.round(row.meanMs)));
  });
});
