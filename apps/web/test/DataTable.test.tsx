import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import DataTable, { formatCell } from '../src/charts/DataTable.js';

/**
 * The data table is the PARITY SURFACE (design §7): the numbers a chart plots,
 * in the DOM, always — visually hidden until a reader asks for them, but never
 * absent. One artifact doing two jobs honestly: WCAG 2.2 AA needs a non-visual
 * route to the same information, and parity testing needs an assertable one.
 * Sharing the artifact is what stops a test drifting from what a screen-reader
 * user actually receives.
 *
 * This runs in jsdom (routed there by `environmentMatchGlobs` in
 * vitest.config.ts, on the `.test.tsx` extension). ECharts is deliberately NOT
 * exercised here — `getBoundingClientRect` returns zeros in jsdom, so a chart
 * renders 0×0 and any assertion about it is theatre. The table is plain React
 * and tests cleanly; the drawing is proven in a real browser in Task 10.
 */

afterEach(cleanup);

describe('DataTable', () => {
  it('renders every plotted value, and the toggle reveals it', async () => {
    const user = userEvent.setup();
    render(<DataTable id="demo" caption="Demo" columns={['t', 'ok']} rows={[{ label: '0', values: [12] }]} />);

    const table = screen.getByTestId('chart-data-demo');

    // ALWAYS in the DOM. This is the assertion that makes the table a parity
    // surface rather than a progressive enhancement: a test — or a Playwright
    // spec — reads these numbers without clicking anything.
    expect(table.textContent).toContain('12');
    expect(table).not.toBeVisible();

    await user.click(screen.getByRole('button', { name: /show data table/i }));
    expect(table).toBeVisible();

    // And back, so the control is a real disclosure rather than one-way.
    await user.click(screen.getByRole('button', { name: /hide data table/i }));
    expect(table).not.toBeVisible();
  });

  it('carries every row and every value, not just the first', () => {
    render(
      <DataTable
        id="many"
        caption="Many"
        columns={['t', 'ok', 'ko']}
        rows={[
          { label: '0', values: [12, 1] },
          { label: '1000', values: [34, 2] },
          { label: '2000', values: [56, 3] },
        ]}
      />,
    );

    const text = screen.getByTestId('chart-data-many').textContent ?? '';
    for (const value of ['0', '12', '1', '1000', '34', '2', '2000', '56', '3']) {
      expect(text).toContain(value);
    }
  });

  it('is a real table: a caption, and a header cell scoped to each column', () => {
    render(
      <DataTable
        id="semantic"
        caption="Requests per second"
        columns={['Time', 'All', 'OK']}
        rows={[{ label: '0', values: [1, 2] }]}
      />,
    );

    const table = screen.getByTestId('chart-data-semantic').querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelector('caption')?.textContent).toContain('Requests per second');

    // <th scope="col"> is what tells a screen reader that "OK" names the third
    // column's cells rather than merely preceding them.
    const headers = [...table!.querySelectorAll('th[scope="col"]')].map((th) => th.textContent);
    expect(headers).toEqual(['Time', 'All', 'OK']);
  });

  it('tells assistive tech whether the table is expanded', async () => {
    const user = userEvent.setup();
    render(<DataTable id="aria" caption="Aria" columns={['t']} rows={[]} />);

    const button = screen.getByRole('button', { name: /show data table/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'chart-data-aria');

    await user.click(button);
    expect(screen.getByRole('button', { name: /hide data table/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  /**
   * THE DISPLAY HALF OF THE PRECISION SPLIT (Task 7 deferred this here).
   *
   * The transforms keep every digit — `toDistribution` passes `okPercent`
   * through exactly as the API computed it, because rounding is recoverable
   * from an exact number and precision is not. What that produced on screen was
   * a cell reading `24.916201117318437`, which is the parity tolerance's two
   * decimals with fifteen digits of noise after them. The rounding belongs
   * where the rendering happens, and only there.
   */
  describe('formatCell', () => {
    it('rounds a long percentage to the two decimals it is compared at', () => {
      expect(formatCell(24.916201117318437)).toBe('24.92');
      expect(formatCell(0.11173184357541899)).toBe('0.11');
    });

    it('leaves an integer exactly as it is, with no grouping separator', () => {
      // These cells are compared against numbers the API writes plain. A
      // locale-dependent `1,000` would make what a parity spec reads depend on
      // where it ran.
      expect(formatCell(0)).toBe('0');
      expect(formatCell(12)).toBe('12');
      expect(formatCell(1000)).toBe('1000');
      expect(formatCell(1234567)).toBe('1234567');
    });

    it('does not trail a decimal the value does not have', () => {
      expect(formatCell(0.5)).toBe('0.5');
      expect(formatCell(1.1)).toBe('1.1');
    });

    it('never displays a non-zero value as zero', () => {
      // The same failure the em dash prevents, in the other direction: `0`
      // asserts "none happened". One KO in ten million requests is not none,
      // and a reader has to be able to tell it from a bin that is genuinely
      // empty.
      expect(formatCell(0.00001)).not.toBe('0');
      expect(Number(formatCell(0.00001))).toBeCloseTo(0.00001, 10);
      expect(formatCell(0)).toBe('0');
    });

    it('passes a string through — a transform that formatted its own is not second-guessed', () => {
      // `percent()` in transforms/indicators.ts emits exactly this.
      expect(formatCell('97.3%')).toBe('97.3%');
    });
  });

  it('keeps the unrounded value in the DOM beside the rounded one', () => {
    // Rounding for display is only honest if nothing is thrown away. The exact
    // number stays on the cell, so a parity spec can assert against the API's
    // own value and a reader still gets a number they can read.
    render(
      <DataTable
        id="precision"
        caption="Precision"
        columns={['Bin', 'OK %']}
        rows={[{ label: '28', values: [24.916201117318437] }]}
      />,
    );

    const cell = screen.getByTestId('chart-data-precision').querySelector('td')!;
    expect(cell.textContent).toBe('24.92');
    expect(cell.getAttribute('data-value')).toBe('24.916201117318437');
  });

  it('carries no value for a gap, so an absent measurement cannot be read as one', () => {
    render(
      <DataTable
        id="gap"
        caption="Gap"
        columns={['t', 'ok']}
        // `null` is what a transform sends for a bucket it has no observation
        // for — see ChartData.
        rows={[{ label: '0', values: [null as unknown as number] }]}
      />,
    );

    const cell = screen.getByTestId('chart-data-gap').querySelector('td')!;
    expect(cell.textContent).toBe('—');
    expect(cell.hasAttribute('data-value')).toBe(false);
  });

  it('renders a table with no rows rather than vanishing, so the surface is always there', () => {
    // A chart with no data still ships its (empty) table: Task 10's e2e suite
    // asserts one `chart-data-<id>` per chart on the page, and a pending run
    // has no series at all.
    render(<DataTable id="empty" caption="Empty" columns={['t', 'ok']} rows={[]} />);
    const table = screen.getByTestId('chart-data-empty');
    expect(table.querySelector('table')).not.toBeNull();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
  });
});
