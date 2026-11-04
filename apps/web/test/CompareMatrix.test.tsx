import type { StatsResponse } from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { COMPARE_METRICS, type CompareMetric } from '../src/charts/transforms/compare';
import CompareMatrix from '../src/tables/CompareMatrix';
import { toCompareMatrix, type CompareStats } from '../src/tables/buildCompareMatrix';
import fixture from './fixtures/reference-run.json';

/**
 * The comparison table: summary rows then requests, the reference column
 * first, a change chip in every other column, and a pin per non-reference
 * column. The matrix is built by `toCompareMatrix` here, as the page builds
 * it, so these cases render real rows rather than a hand-written model.
 */

const REFERENCE = fixture.stats as unknown as StatsResponse;
const ALL_REQUESTS = REFERENCE.stats.filter((s) => s.scope === 'request').map((s) => s.name);

const asRun = (
  id: string,
  over?: (s: StatsResponse) => StatsResponse,
  exact = true,
  extra: Partial<Pick<CompareStats, 'peakUsers' | 'cpu'>> = {},
): CompareStats => ({
  id,
  label: id,
  exact,
  stats: over ? over(REFERENCE) : REFERENCE,
  peakUsers: null,
  cpu: null,
  ...extra,
});

const without =
  (names: readonly string[]) =>
  (s: StatsResponse): StatsResponse => ({
    ...s,
    stats: s.stats.filter((row) => !(row.scope === 'request' && names.includes(row.name))),
  });

/** `vitest.config.ts` does not set `globals`, so Testing Library's automatic
 *  cleanup never registers and every file has to call it. */
afterEach(cleanup);

const renderMatrix = (
  metric: CompareMetric = 'p95',
  runs: readonly CompareStats[] = [asRun('Run 1'), asRun('Run 2')],
  referenceRunId: string | null = 'Run 1',
  onReference: (id: string) => void = () => undefined,
) =>
  render(
    <CompareMatrix
      matrix={toCompareMatrix(runs, metric, referenceRunId)}
      metric={metric}
      onReference={onReference}
    />,
  );

const runHeaders = () => screen.getAllByTestId('compare-column');

describe('CompareMatrix — the reference', () => {
  it('reference header reads Reference', () => {
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2')], 'Run 2');
    const [first] = runHeaders();
    // First, because the reference column always leads.
    expect(first).toHaveTextContent('Run 2 (ms)');
    expect(within(first!).getByTestId('compare-reference')).toHaveTextContent('Reference');
    expect(screen.getByRole('columnheader', { name: 'Run 2 (ms) Reference' })).toBe(first);
  });

  it('a pin button names its run and makes it the reference', () => {
    const onReference = vi.fn();
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2')], 'Run 2', onReference);
    screen.getByRole('button', { name: 'Set Run 1 as reference' }).click();
    expect(onReference).toHaveBeenCalledWith('Run 1');
    expect(onReference).toHaveBeenCalledTimes(1);
  });

  it('the reference column has no pin button', () => {
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2'), asRun('Run 3')], 'Run 1');
    const [reference, ...others] = runHeaders();
    expect(within(reference!).queryByRole('button')).toBeNull();
    for (const header of others) expect(within(header).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Set Run 1 as reference' })).toBeNull();
  });

  /* The pin is inside the `<th>`, and a header left to compute its name from
     its contents takes the button's `aria-label` too — in Chromium. jsdom's
     name computation does NOT consult a descendant's `aria-label` (CLAUDE.md),
     so a name assertion alone cannot fail here: it was red-verified as
     passing with the fix removed. What can fail is the mechanism — the
     header is labelled by its label span, which the pin is not inside. */
  it('keeps the pin out of the column header’s name', () => {
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2')], 'Run 1');
    const header = runHeaders()[1]!;
    expect(screen.getByRole('columnheader', { name: 'Run 2 (ms)' })).toBe(header);
    const ids = (header.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(ids).toHaveLength(1);
    const label = document.getElementById(ids[0]!)!;
    expect(label).toHaveTextContent(/^Run 2 \(ms\)$/);
    expect(label.querySelector('button')).toBeNull();
    expect(within(header).getByRole('button', { name: 'Set Run 2 as reference' })).toBeInTheDocument();
  });
});

describe('CompareMatrix — change chips', () => {
  const chipsIn = (row: HTMLElement) => within(row).queryAllByTestId('compare-change');

  it('shows a chip in every non-reference cell, none in the reference’s', () => {
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2'), asRun('Run 3')], 'Run 1');
    const all = screen.getByRole('row', { name: /^All requests/ });
    const cells = within(all).getAllByRole('cell');
    expect(chipsIn(cells[0]!)).toHaveLength(0);
    expect(chipsIn(cells[1]!)).toHaveLength(1);
    expect(chipsIn(cells[2]!)).toHaveLength(1);
  });

  it('reads = for an unchanged figure, with no good or bad colour', () => {
    renderMatrix('p95');
    const chip = within(screen.getByRole('row', { name: /^All requests/ })).getByTestId('compare-change');
    expect(chip).toHaveTextContent(/^=$/);
    expect(chip.getAttribute('style') ?? '').not.toMatch(/--color-status-/);
  });

  it('a worse change carries the failed tone, its signed percentage and the word', () => {
    const slower = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) => ({ ...row, maxMs: row.maxMs * 2 })),
    });
    renderMatrix('max', [asRun('Run 1'), asRun('Run 2', slower)], 'Run 1');
    const chip = within(screen.getByRole('row', { name: /^All requests/ })).getByTestId('compare-change');
    expect(chip).toHaveTextContent('+100.0% worse');
    expect(chip.getAttribute('style')).toContain('var(--color-status-failed)');
  });

  it('neutral chip for users carries no good/bad colour', () => {
    renderMatrix(
      'users',
      [
        asRun('Run 1', undefined, true, { peakUsers: 10 }),
        asRun('Run 2', undefined, true, { peakUsers: 13 }),
      ],
      'Run 1',
    );
    const chip = within(screen.getByRole('row', { name: /^Max/ })).getByTestId('compare-change');
    expect(chip).toHaveTextContent('+30.0%');
    expect(chip.getAttribute('style') ?? '').not.toMatch(/--color-status-/);
    expect(chip).toHaveClass('text-muted');
    expect(chip).not.toHaveTextContent(/better|worse/);
  });
});

describe('CompareMatrix — units and rows', () => {
  it('carries the metric’s unit in every run column header', () => {
    renderMatrix('throughput');
    for (const h of runHeaders()) expect(h.querySelector('[id]')).toHaveTextContent(/\(\/s\)$/);
    expect(screen.queryByText(/\(ms\)/)).toBeNull();
  });

  it('labels no errors column with a rate, and prints the ratio as a percentage', () => {
    renderMatrix('errors');
    for (const h of runHeaders()) expect(h).not.toHaveTextContent('/s');
    const runRow = REFERENCE.stats.find((s) => s.scope === 'run')!;
    const ratio = within(screen.getByRole('row', { name: /^Ratio/ })).getAllByRole('cell')[0]!;
    expect(ratio).toHaveTextContent(`${(runRow.errorRate * 100).toFixed(2)}%`);
    const count = within(screen.getByRole('row', { name: /^Count/ })).getAllByRole('cell')[0]!;
    expect(count).toHaveTextContent(String(runRow.koCount));
  });

  it('renders a dash, never a zero, for a request a run did not make', () => {
    const dropped = ALL_REQUESTS[0]!;
    renderMatrix('p95', [asRun('Run 1'), asRun('Run 2', without([dropped]))], 'Run 1');
    const row = screen.getByRole('row', { name: new RegExp(`^${dropped}\\b`) });
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent(/^—$/);
  });

  it('keeps the dash definition out of the accessible name, and in the help', () => {
    renderMatrix();
    const table = screen.getByRole('table');
    expect(table).toHaveAccessibleName('Changes against the reference');
    expect(screen.getByText(/a dash means that run has no value for the row/i)).toBeInTheDocument();
  });

  /* THE OVERLAY'S DATA TABLE SHARES THIS PAGE. `CompareChart` names it
     `<metric label> across runs — every value this chart plots, as text.`,
     and Playwright matches a table's name as a SUBSTRING — so a name carrying
     the metric, "across" or "run" made one query resolve both tables. The
     sibling's name is spelled out here rather than imported, so a change to
     either side is a change this case sees. */
  it('shares no distinctive word with the overlay’s data table, for any metric', () => {
    for (const metric of COMPARE_METRICS) {
      const { unmount } = renderMatrix(metric.value);
      // The `<caption>` is what names the table (`TableFrame` gives it no
      // `aria-label`); the case above pins the computed name itself.
      const name = screen.getByRole('table').querySelector('caption')?.textContent ?? '';
      expect(name, metric.value).toBe('Changes against the reference');
      const sibling = `${metric.label} across runs — every value this chart plots, as text.`;
      const words = (text: string) =>
        new Set(text.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 3));
      const shared = [...words(name)].filter((w) =>
        [...words(sibling)].some((s) => s.includes(w) || w.includes(s)),
      );
      expect(shared, metric.value).toEqual([]);
      unmount();
    }
  });
});

describe('CompareMatrix — an estimated run’s column', () => {
  it('marks the estimated run’s header and its change, not the exact run’s', () => {
    renderMatrix('p95', [asRun('a'), asRun('b', undefined, false)], 'a');
    expect(screen.getByRole('columnheader', { name: 'a (ms) Reference' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'approximately b (ms)' })).toBeInTheDocument();
    const chip = within(screen.getByRole('row', { name: /^All requests/ })).getByTestId('compare-change');
    expect(chip.textContent).toContain('≈');
  });

  it('marks nothing when both runs are exact', () => {
    renderMatrix('p95', [asRun('a'), asRun('b')], 'a');
    for (const h of screen.getAllByRole('columnheader')) expect(h.textContent).not.toContain('≈');
  });
});
