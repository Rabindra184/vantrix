import { CAPTION, ROW, SCROLLER, TABLE, TD_NUM, TH, THEAD, TH_NUM, TH_ROW } from '../components/tableStyles';
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
/**
 * A plotted value, FORMATTED FOR READING — the display half of the split Task 7
 * deferred here on purpose.
 *
 * The transforms keep full precision, and that is right: rounding is
 * recoverable from an exact number and precision is not, so
 * `toDistribution` hands over `okPercent` exactly as the API computed it
 * (`0.11173184357541899`). What a reader — or a screen reader, reading a
 * hundred bins aloud — receives from that is seventeen significant digits of a
 * percentage whose parity tolerance is two decimal places (Appendix A §A.9
 * F-8). Seventeen digits is not more information; it is the same information
 * with the useful part buried.
 *
 * So the ROUNDING LIVES HERE, in the one place that renders, and the exact
 * value stays in the DOM beside it as `data-value` (see the cell below). Both
 * facts remain assertable: a parity spec comparing against Gatling's displayed
 * two decimals reads the text, one comparing against the API's own number reads
 * the attribute, and neither has to reach back into a transform.
 *
 * The rules, in order:
 *   - a string passes through untouched. Several transforms format their own
 *     (`percent()` in `indicators.ts` emits `'97.3%'`), and a value already
 *     chosen for display is not this function's to second-guess.
 *   - an integer renders as itself, with NO grouping separators. A count of
 *     `1000` is written `1000`, not `1,000`: these cells are the parity
 *     surface, compared against numbers the API and Gatling both write plain,
 *     and a locale-dependent separator would make what a test reads depend on
 *     where it ran.
 *   - anything else rounds to two decimals — the tolerance the percentage
 *     charts are actually compared at, and finer than any of these charts can
 *     draw.
 *   - EXCEPT a non-zero value that two decimals would flatten to `0`. That is
 *     the same failure the em dash below exists to prevent, in the other
 *     direction: `0` asserts "none happened", and one KO in ten million
 *     requests (`0.00001%`) is not none. Two significant digits is what keeps
 *     it distinguishable from zero.
 */
export function formatCell(value: string | number): string {
  if (typeof value === 'string') return value;
  // NaN/Infinity should not reach a cell; if one does, showing it is how it
  // gets noticed and fixed, and `toFixed` would render it unhelpfully anyway.
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);

  // `Number(...)` back off the fixed string, so 0.50 renders as `0.5` rather
  // than trailing a decimal the value does not have.
  const rounded = Number(value.toFixed(2));
  if (rounded !== 0) return String(rounded);
  return value.toPrecision(2);
}

export default function DataTable({
  id,
  caption,
  columns,
  rows,
  shown,
}: {
  /** The chart's id. The table is found as `chart-data-<id>` by every test. */
  id: string;
  caption: string;
  /** Header row INCLUDING the label column at index 0 — see `ChartTableRow`. */
  columns: readonly string[];
  rows: readonly ChartTableRow[];
  /**
   * CONTROLLED, because the plot and this table are two views of one thing and
   * only one of them is drawn at a time. `Chart` owns the choice; it is the
   * only component that can hide the canvas, and a second copy of the state
   * here would let the two disagree.
   */
  shown: boolean;
}) {
  const regionId = `chart-data-${id}`;

  return (
    <>
      {/* THE BUTTON THAT OPENS THIS NOW LIVES IN THE CARD'S HEADER, in
          `ChartActions` — see that file for why, and for why it is still an
          `aria-expanded` disclosure even though the plot visually goes away.

          What used to stand here was a full-width `ghost` text button reading
          "Show data table", carrying a long comment explaining that it could
          NOT be an icon: `Chart` renders this inside its `<figure>`, and the
          e2e suite proved a chart had drawn by counting `<svg>` elements
          within that figure, so any icon in the card corrupted the count. That
          constraint is gone — `plot()` in the e2e helpers scopes those
          assertions to `[data-chart-canvas]` — and with it the reason this
          control had to be text, and had to be here rather than in the header.

          `hidden` on the region and `SCROLLER` inside it, not both on one
          element: `hidden` sets `display: none`, and a `display:none` scroll
          container reports zero scroll width, so a collapsed table that is
          later revealed would start un-scrollable in some engines. */}
      <div id={regionId} data-testid={regionId} hidden={!shown}>
        {/* The caption, visibly, OUTSIDE the scroll box. A `<caption>` is as
            wide as its table and a 60-bucket data table is far wider than a
            phone, so left inside `overflow-x-auto` this sentence scrolls away
            with the columns instead of wrapping. `aria-hidden` because the
            real `<caption>` below is what assistive tech reads — the same
            two-copies-one-source arrangement `TableFrame` documents at
            length for the four full-width tables. */}
        <p aria-hidden="true" className={CAPTION}>
          {caption} — every value this chart plots, as text.
        </p>
        <div className={SCROLLER} tabIndex={0} role="region" aria-label={`${caption} data table`}>
        <table className={TABLE}>
          <caption className="sr-only">
            {caption} — every value this chart plots, as text.
          </caption>
          <thead className={THEAD}>
            <tr className={ROW}>
              {columns.map((column, index) => (
                // scope="col" is what makes a cell comprehensible when a
                // screen reader announces it out of context: "OK, 12" rather
                // than "12".
                //
                // The FIRST column is the row label (an elapsed offset, a
                // request name) and is `TH_ROW`/left below; every other column
                // is a `TD_NUM` value, so its heading right-aligns to match.
                <th key={column} scope="col" className={index === 0 ? TH : TH_NUM}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              // Row labels are not guaranteed unique — two buckets can carry
              // the same formatted offset — so the index is part of the key.
              <tr key={`${row.label}-${rowIndex}`} className={ROW}>
                <th scope="row" className={TH_ROW}>
                  {row.label}
                </th>
                {row.values.map((value, i) => (
                  <td
                    key={i}
                    className={TD_NUM}
                    // THE UNROUNDED VALUE, kept in the DOM next to the rounded
                    // one. `formatCell` above trims a percentage to the two
                    // decimals it is compared at; this is what makes that a
                    // display decision rather than a loss. Omitted for a gap —
                    // there is no value to carry — so `data-value` present and
                    // `data-value` absent mean exactly what the cell shows.
                    data-value={value === null || value === undefined ? undefined : String(value)}
                  >
                    {/* A gap is not a zero. A transform that has no
                        observation for a bucket sends null, and an em dash is
                        the honest rendering of it — `0` would assert a
                        measurement nobody took. */}
                    {value === null || value === undefined ? '—' : formatCell(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}
