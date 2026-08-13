import { useId, useState } from 'react';
import type { ChartTableRow } from './types';

/**
 * The exact values a chart plots, as a real `<table>` — always in the DOM,
 * collapsed until asked for.
 *
 * ONE ARTIFACT, TWO JOBS (design §7). WCAG 2.2 AA requires a non-visual route
 * to the information a chart conveys; parity testing requires an assertable
 * one. Pixels are neither. Serving both from the same table means a test
 * cannot drift from what a screen-reader user actually receives — if the table
 * is wrong, the test and the user are wrong together, which is the only honest
 * coupling available.
 *
 * COLLAPSED WITH THE `hidden` ATTRIBUTE, not with a visually-hidden clip
 * rectangle, and the choice is deliberate:
 *
 *   - `hidden` plus a `<button aria-expanded>` is an ordinary disclosure. A
 *     screen-reader user is TOLD the table is collapsed and how to open it,
 *     which is better than eight always-announced tables of a hundred numbers
 *     each stacked under the charts.
 *   - It is honest in a test. jsdom applies no stylesheet, so a Tailwind
 *     `sr-only` class hides nothing there and `not.toBeVisible()` would pass
 *     or fail for reasons unrelated to the component. `hidden` is a property
 *     of the DOM, so the assertion means what it says.
 *
 * `textContent` still carries every value while collapsed — that is what makes
 * this the parity surface — and Playwright's `textContent()` reads hidden
 * elements too, so Task 10's specs never have to click a toggle to assert a
 * number.
 */
export default function DataTable({
  id,
  caption,
  columns,
  rows,
}: {
  /** The chart's id. The table is found as `chart-data-<id>` by every test. */
  id: string;
  caption: string;
  /** Header row INCLUDING the label column at index 0 — see `ChartTableRow`. */
  columns: readonly string[];
  rows: readonly ChartTableRow[];
}) {
  const [shown, setShown] = useState(false);
  // Distinguishes two DataTables that somehow share an id; the STABLE
  // `chart-data-<id>` is what tests and `aria-controls` use.
  const buttonId = useId();
  const regionId = `chart-data-${id}`;

  return (
    <>
      <button
        id={buttonId}
        type="button"
        aria-expanded={shown}
        aria-controls={regionId}
        onClick={() => setShown((was) => !was)}
        className="self-start rounded border border-[var(--color-border)] px-3 py-1 text-sm text-[var(--color-text-muted)]"
      >
        {shown ? 'Hide data table' : 'Show data table'}
      </button>

      <div id={regionId} data-testid={regionId} hidden={!shown} className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="pb-2 text-left text-sm text-[var(--color-text-muted)]">
            {caption} — every value plotted above, as text.
          </caption>
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              {columns.map((column) => (
                // scope="col" is what makes a cell comprehensible when a
                // screen reader announces it out of context: "OK, 12" rather
                // than "12".
                <th key={column} scope="col" className="py-1 pr-4 font-semibold">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              // Row labels are not guaranteed unique — two buckets can carry
              // the same formatted offset — so the index is part of the key.
              <tr key={`${row.label}-${rowIndex}`} className="border-b border-[var(--color-border)]">
                <th scope="row" className="py-1 pr-4 font-normal">
                  {row.label}
                </th>
                {row.values.map((value, i) => (
                  <td key={i} className="py-1 pr-4 tabular-nums">
                    {/* A gap is not a zero. A transform that has no
                        observation for a bucket sends null, and an em dash is
                        the honest rendering of it — `0` would assert a
                        measurement nobody took. */}
                    {value === null || value === undefined ? '—' : value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
