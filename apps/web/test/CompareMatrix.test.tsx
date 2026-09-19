import type { StatsResponse } from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import CompareMatrix from '../src/tables/CompareMatrix';
import type { CompareStats } from '../src/tables/buildCompareMatrix';
import fixture from './fixtures/reference-run.json';

/**
 * review.md's copy table, row 7 — "Every request… a dash means…" → "Put unit
 * in the table header; missing-data definition in help".
 *
 * THIS COMPONENT HAD NO TEST FILE. `buildCompareMatrix.test.ts` covers the
 * transform, which is pure and well pinned; nothing rendered the table, so
 * neither half of row 7 could have been noticed by the suite. That is the
 * "grep for components with no test file before looking for untested
 * BEHAVIOUR" lesson, met one table over.
 */

const REFERENCE = fixture.stats as unknown as StatsResponse;
const ALL_REQUESTS = REFERENCE.stats.filter((s) => s.scope === 'request').map((s) => s.name);

const asRun = (id: string, over?: (s: StatsResponse) => StatsResponse): CompareStats => ({
  id,
  label: id,
  stats: over ? over(REFERENCE) : REFERENCE,
});

/** A copy of the payload with some request rows removed — the same helper the
 *  transform's own suite uses, so both describe one absence the same way. */
const without =
  (names: readonly string[]) =>
  (s: StatsResponse): StatsResponse => ({
    ...s,
    stats: s.stats.filter((row) => !(row.scope === 'request' && names.includes(row.name))),
  });

/** `vitest.config.ts` does not set `globals`, so Testing Library's automatic
 *  cleanup never registers and every file has to call it. CLAUDE.md records
 *  four files that did not and the intermittent cross-test leak it produced. */
afterEach(cleanup);

const renderMatrix = (
  metric: 'p95' | 'throughput' = 'p95',
  metricLabel = '95th percentile',
  runs: readonly CompareStats[] = [asRun('a'), asRun('b')],
) =>
  render(
    <CompareMatrix runs={runs} metric={metric} metricLabel={metricLabel} currentRunId="a" />,
  );

describe('CompareMatrix — review.md copy row 7', () => {
  /* Clause one. Asserted on EVERY run column rather than the first: a unit
     appended to one header and not the rest reads as a property of that run,
     which is worse than stating it nowhere. */
  it('carries the unit in every run column header, not in prose', () => {
    renderMatrix();
    const headers = screen.getAllByRole('columnheader');
    const runHeaders = headers.filter((h) => /^[ab] /.test(h.textContent ?? ''));
    expect(runHeaders).toHaveLength(2);
    for (const h of runHeaders) expect(h).toHaveTextContent(/\(ms\)$/);
  });

  /* The unit is the METRIC's, not a constant. A header hard-coded to `(ms)`
     satisfies the case above and mislabels every throughput and error-rate
     comparison in the product — the same class of defect review.md 1 found
     in the SLA actuals, one table over. */
  it('takes the unit from the metric, so a rate is not labelled in milliseconds', () => {
    renderMatrix('throughput', 'Throughput');
    const runHeaders = screen
      .getAllByRole('columnheader')
      .filter((h) => /^[ab] /.test(h.textContent ?? ''));
    expect(runHeaders).toHaveLength(2);
    for (const h of runHeaders) expect(h).toHaveTextContent(/\(\/s\)$/);
    expect(screen.queryByText(/\(ms\)/)).toBeNull();
  });

  /* Clause two, and the half that matters most for the reader this table is
     hardest on. The definition used to BE the accessible name, so a screen
     reader announced the whole paragraph before the first number, every
     visit. Asserted as a pair: the name is short AND the definition is still
     reachable — dropping the explanation entirely would satisfy the first
     assertion perfectly and lose the thing row 7 says to keep. */
  it('keeps the dash definition out of the accessible name and in the help', () => {
    renderMatrix();
    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName('Per-request 95th percentile across the selected runs');
    expect(table.querySelector('caption')?.textContent ?? '').not.toMatch(/a dash means/i);

    // Still available — `<details>` keeps its children in the DOM under
    // jsdom, which is exactly why this asserts presence and the disclosure's
    // own behaviour is the browser's business.
    expect(screen.getByText(/a dash means the request did not run in that one/i)).toBeInTheDocument();
  });

  /* The claim the definition is ABOUT, so the prose and the product cannot
     drift apart: a request one run never made is a dash, never a zero. The
     transform's own comment gives the reason — a zero would sort to the top
     of a column of durations as though it were the fastest thing here. */
  it('renders a dash, never a zero, for a request a run did not make', () => {
    const dropped = ALL_REQUESTS[0]!;
    renderMatrix('p95', '95th percentile', [asRun('a', without([dropped])), asRun('b')]);
    const row = screen.getByRole('row', { name: new RegExp(`^${dropped}\\b`) });
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('—');
    expect(cells[0]).not.toHaveTextContent('0');
  });
});
