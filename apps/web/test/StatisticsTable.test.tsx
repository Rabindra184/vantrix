import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import StatisticsTable, {
  clampPercentile,
  percentileColumnLabel,
} from '../src/tables/StatisticsTable.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑤ the statistics table itself — Appendix A G-11…G-13 and G-16 — rendered
 * in jsdom against `fixtures/reference-run.json`, the payload captured from the
 * live API for the real Gatling reference run.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The brief's three example tests were
 * MEASURED against wrong implementations rather than assumed to discriminate
 * (the standing rule, 10 for 10 across this plan's earlier tasks):
 *
 * - **"starts with groups collapsed" passes, on its first assertion, for a
 *   table that renders NO ROWS AT ALL.** Measured against a component that
 *   returns `null`: `queryByText('Recommendations')` is satisfied, and the test
 *   fails only later, on the missing expand button — which reads as a missing
 *   FEATURE rather than as an empty table. So the half that NAMES the behaviour
 *   cannot fail; only the click rescues it, and only once a button exists.
 * - **"drives its percentile columns off the payload" is half live and half
 *   vacuous, and which half is which turns on the column LABEL.** Measured
 *   against two wrong implementations: a hard-coded `p50/p75/p95/p99` list is
 *   caught by the FIRST assertion (no `99.9` header exists at all), whatever
 *   the labels; but a list that renders the payload's keys ALONGSIDE a
 *   hard-coded four — which is what a "default percentiles" constant produces —
 *   passes that first assertion, and is caught only by the second,
 *   `queryByRole('columnheader', { name: /^95th$/ })` returning null. That
 *   second assertion is null for EVERY implementation if the heading is
 *   Gatling's own `95th pct`: relabelled, the union mutation goes green. The
 *   columns are therefore labelled as §13.2 ⑤ and §A.5 name them — `50th`,
 *   `95th` — and the test below FIRST proves the default payload renders a
 *   `95th` header, so the negative is known to be live.
 * - "links each row to its detail page" is the one that discriminates as
 *   written: no href, a wrong href and an unencoded href all fail it. It still
 *   says nothing about the other nine rows, or about groups, which link to a
 *   different section.
 *
 * All three are kept verbatim. Each is followed by the assertions that can
 * fail — an exact visible row set rather than a single absence, an exact column
 * list in both directions, and every row's link rather than one.
 *
 * THE OTHER THING THIS FILE EXISTS FOR: the run-scope row. `buildTree`
 * deliberately excludes it (Gatling agrees structurally — "All Requests" sits
 * alone in `container_statistics_head`), so the table has to render it
 * explicitly. Forget to, and every test the brief wrote still passes while the
 * table silently has no totals row at all.
 */

const stats = fixture.stats as unknown as StatsResponse;
const RUN_ID = stats.runId;

/** The reference run's nine root rows, in payload order. */
const ROOT_PATHS = [
  'Cart',
  'Catalog',
  'Add To Cart',
  'List Products',
  'Place Order',
  'Product Detail',
  'Related Items',
  'Search',
  'View Cart',
];

/** Every row the table can show, with `Catalog` expanded. */
const ALL_PATHS = [
  'Cart',
  'Catalog',
  'Catalog/Recommendations',
  'Add To Cart',
  'List Products',
  'Place Order',
  'Product Detail',
  'Related Items',
  'Search',
  'View Cart',
];

function renderTable(payload: StatsResponse = stats) {
  return render(
    <MemoryRouter>
      <StatisticsTable stats={payload} runId={RUN_ID} />
    </MemoryRouter>,
  );
}

/** The payload with every row's `percentiles` replaced. */
const withPercentiles = (percentiles: Record<string, number>): StatsResponse => ({
  ...stats,
  stats: stats.stats.map((r) => ({ ...r, percentiles })),
});

/** The sortable body rows — NOT the run-scope totals row, which is not one. */
const bodyRows = (): HTMLElement[] => screen.queryAllByTestId('stat-row');
const totalRow = (): HTMLElement => screen.getByTestId('stat-row-total');
const pathsOf = (rows: readonly HTMLElement[]): (string | null)[] =>
  rows.map((r) => r.getAttribute('data-path'));

const rowAt = (path: string): HTMLElement => {
  const hit = bodyRows().find((r) => r.getAttribute('data-path') === path);
  if (hit === undefined) throw new Error(`no rendered row at path ${JSON.stringify(path)}`);
  return hit;
};

/** A cell by the column it belongs to — `count`, `minMs`, `p99`, `name`… */
const cellIn = (row: HTMLElement, column: string): HTMLElement => {
  const cell = row.querySelector(`[data-column="${column}"]`);
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`row ${row.getAttribute('data-path')} has no ${column} cell`);
  }
  return cell;
};

/** What a reader sees in a cell. */
const textIn = (row: HTMLElement, column: string): string => cellIn(row, column).textContent ?? '';

/** The exact number the cell carries beside its rounded text, or NaN for a gap. */
const valueIn = (row: HTMLElement, column: string): number =>
  Number(cellIn(row, column).getAttribute('data-value'));

const headers = (): string[] =>
  screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');

const expandCatalog = () =>
  fireEvent.click(screen.getByRole('button', { name: /expand Catalog/i }));

/** Every percentile key the payload carries for a row, raw. */
const rawPercentiles = (row: StatRow): [string, number][] => Object.entries(row.percentiles);

afterEach(cleanup);

describe('StatisticsTable — the columns (G-12, §9 checkpoint 6)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('drives its percentile columns off the payload, not a hard-coded list', () => {
    const odd = {
      ...stats,
      stats: stats.stats.map((r) => ({ ...r, percentiles: { p50: 1, p90: 2, 'p99.9': 3 } })),
    };
    render(
      <MemoryRouter>
        <StatisticsTable stats={odd} runId={RUN_ID} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('columnheader', { name: /99\.9/ })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /^95th$/ })).toBeNull();
  });

  /**
   * The discriminating form, part one: the NEGATIVE above is live.
   *
   * `queryByRole('columnheader', { name: /^95th$/ })` returning null proves
   * nothing unless some payload makes it return something — under Gatling's own
   * "95th pct" spelling it would be null for a hard-coded column list too. So
   * the default payload is asserted to render exactly that header, which is
   * also §13.2 ⑤'s and §A.5's own naming.
   */
  it('renders the reference run s four configured percentiles, exactly as §13.2 ⑤ names them', () => {
    renderTable();
    expect(Object.keys(stats.stats[0]!.percentiles)).toEqual(['p50', 'p75', 'p95', 'p99']);
    expect(screen.getByRole('columnheader', { name: /^95th$/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /^50th$/ })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /^99th$/ })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /^99\.9th$/ })).toBeNull();
  });

  /**
   * The discriminating form, part two: the EXACT column list, in order, for
   * both payloads. A membership check cannot see a column that is missing, one
   * that is left over, or four that came out in the wrong order — and the
   * §13.2 ⑤ column set is an ordered thing.
   */
  it('lays out the §13.2 ⑤ column set in order, percentiles between Min and Max', () => {
    renderTable();
    expect(headers()).toEqual([
      'Requests',
      'Executions',
      'Response Time (ms)',
      'Total',
      'OK',
      'KO',
      '% KO',
      'Cnt/s',
      'Min',
      '50th',
      '75th',
      '95th',
      '99th',
      'Max',
      'Mean',
      'Std Dev',
    ]);

    cleanup();
    renderTable(withPercentiles({ p50: 1, p90: 2, 'p99.9': 3 }));
    expect(headers()).toEqual([
      'Requests',
      'Executions',
      'Response Time (ms)',
      'Total',
      'OK',
      'KO',
      '% KO',
      'Cnt/s',
      'Min',
      '50th',
      '90th',
      '99.9th',
      'Max',
      'Mean',
      'Std Dev',
    ]);
  });

  /**
   * Percentile keys are per-row (`Record<string, number>`), so the column set
   * is the UNION over the rows the table renders — and a row that lacks one of
   * them has a GAP there, not a zero. `0` in a response-time column asserts the
   * fastest row in the table.
   */
  it('takes the union of the rows keys, and shows a gap where a row lacks one', () => {
    const mixed: StatsResponse = {
      ...stats,
      stats: stats.stats.map((r) =>
        r.name === 'Search' ? { ...r, percentiles: { p50: r.percentiles.p50! } } : r,
      ),
    };
    renderTable(mixed);

    // The union: `Search` carries only p50, and the other nine rows still get
    // their four columns.
    expect(headers().slice(-8)).toEqual([
      'Min',
      '50th',
      '75th',
      '95th',
      '99th',
      'Max',
      'Mean',
      'Std Dev',
    ]);
    const search = rowAt('Search');
    expect(textIn(search, 'p50')).toBe('550');
    expect(textIn(search, 'p95')).toBe('—');
    expect(cellIn(search, 'p95').getAttribute('data-value')).toBeNull();
    // The rows that DO carry p95 still show it.
    expect(textIn(rowAt('View Cart'), 'p95')).toBe('41');
  });

  /** `p1` is not `1th`. The label is derived, so odd keys stay readable. */
  it('labels a percentile key with its ordinal', () => {
    expect(percentileColumnLabel('p50')).toBe('50th');
    expect(percentileColumnLabel('p99.9')).toBe('99.9th');
    expect(percentileColumnLabel('p1')).toBe('1st');
    expect(percentileColumnLabel('p2')).toBe('2nd');
    expect(percentileColumnLabel('p3')).toBe('3rd');
    expect(percentileColumnLabel('p11')).toBe('11th');
    expect(percentileColumnLabel('p12')).toBe('12th');
    expect(percentileColumnLabel('p13')).toBe('13th');
    expect(percentileColumnLabel('p21')).toBe('21st');
    // A key that is not `p<number>` at all labels itself rather than guessing.
    expect(percentileColumnLabel('median')).toBe('median');
  });

  /**
   * The columns are ordered by the percentile they carry, not by whatever
   * order the payload's object keys happen to arrive in — a JSON object that
   * listed p99 first would otherwise render 99th before 50th.
   */
  it('orders the percentile columns numerically, whatever order the keys arrive in', () => {
    renderTable(withPercentiles({ p99: 4, p50: 1, 'p99.9': 5, p75: 2, p95: 3 }));
    expect(headers().slice(-9)).toEqual([
      'Min',
      '50th',
      '75th',
      '95th',
      '99th',
      '99.9th',
      'Max',
      'Mean',
      'Std Dev',
    ]);
  });
});

describe('StatisticsTable — expand and collapse (G-13, §9 checkpoint 4)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('starts with groups collapsed', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={stats} runId={RUN_ID} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Recommendations')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /expand Catalog/i }));
    expect(screen.getByText('Recommendations')).toBeTruthy();
  });

  /**
   * The discriminating form. The absence of `Recommendations` above is
   * satisfied by a table with no rows in it — measured: a component returning
   * `null` passes the first assertion, and one rendering only the roots but no
   * toggle passes it too and then fails on a missing button, which reads as a
   * missing FEATURE rather than a missing table.
   *
   * So: the exact nine root rows are present while the child is not, the child
   * is the ONLY thing the click adds, and it arrives nested — at depth 1, with
   * the indent that depth produces.
   */
  it('shows every root row while the child is hidden, and adds only the child', () => {
    renderTable();

    expect(pathsOf(bodyRows())).toEqual(ROOT_PATHS);
    expect(screen.getByText('Catalog')).toBeTruthy();
    expect(screen.queryByText('Recommendations')).toBeNull();

    expandCatalog();

    expect(pathsOf(bodyRows())).toEqual(ALL_PATHS);
    const child = rowAt('Catalog/Recommendations');
    expect(child.getAttribute('data-depth')).toBe('1');
    // Indented from its DEPTH, which is the row's position in the tree — never
    // from a count of path segments (an orphan is depth 0 with two of them).
    expect(cellIn(child, 'name').style.paddingLeft).toBe('2rem');
    expect(cellIn(rowAt('Catalog'), 'name').style.paddingLeft).toBe('0.5rem');
  });

  it('collapses again, and says which it will do', () => {
    renderTable();

    const button = screen.getByRole('button', { name: /expand Catalog/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    expect(screen.getByRole('button', { name: /collapse Catalog/i })).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(pathsOf(bodyRows())).toEqual(ALL_PATHS);

    fireEvent.click(button);
    expect(pathsOf(bodyRows())).toEqual(ROOT_PATHS);
    expect(screen.getByRole('button', { name: /expand Catalog/i })).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * A toggle on a row with nothing to toggle is a control that does nothing,
   * and a screen-reader user is told there are ten expandable groups when
   * there is one. `Catalog` is the only row in the reference run with children.
   */
  it('gives a toggle to the rows that have children, and only those', () => {
    renderTable();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'expand Catalog',
    ]);
    expandCatalog();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'collapse Catalog',
    ]);
  });

  /**
   * An orphan — `Catalog/Recommendations` in a payload with no `Catalog` — is a
   * ROOT at depth 0 whose displayed name is its full path (`buildTree`'s rule).
   * Nothing here may re-derive either from the path's two segments: keyed on
   * `row.depth`, the row indents like the root it is.
   *
   * MEASURED: indenting from `path.split('/').length - 1` instead fails THIS
   * TEST AND NOTHING ELSE — 27 of 28 stay green, including the nested-child
   * indent assertion above, because `Catalog/Recommendations` nested under
   * `Catalog` has a segment count that happens to equal its depth. The same
   * mutation passed 15 of 17 in task 2. It is invisible on any payload where
   * the tree agrees with the paths, which is every payload but this one.
   */
  it('renders an orphan at the root, indented as depth 0, showing its full path', () => {
    renderTable({ ...stats, stats: stats.stats.filter((r) => r.name !== 'Catalog') });

    const orphan = rowAt('Catalog/Recommendations');
    expect(orphan.getAttribute('data-depth')).toBe('0');
    expect(cellIn(orphan, 'name').style.paddingLeft).toBe('0.5rem');
    expect(screen.getByText('Catalog/Recommendations')).toBeTruthy();
    expect(screen.queryByText('Recommendations')).toBeNull();
    // At the root it has no parent to expand it from, so it is visible with no
    // click at all — and it is not hidden by the collapsed default.
    expect(pathsOf(bodyRows())).toContain('Catalog/Recommendations');
  });
});

describe('StatisticsTable — the row links (G-16)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('links each row to its detail page (G-16)', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={stats} runId={RUN_ID} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /List Products/ });
    expect(link.getAttribute('href')).toBe(`/runs/${RUN_ID}/requests/List%20Products`);
  });

  /**
   * The discriminating form: EVERY row, and the two sections. A request goes to
   * `/requests/`, a group to `/groups/` — piece 3 and piece 4 fill those — and
   * a group link carries the row's FULL path, not the leaf it displays, because
   * `Recommendations` alone does not identify `Catalog/Recommendations`.
   */
  it('links every row, groups and requests to their own sections, by full path', () => {
    renderTable();
    expandCatalog();

    for (const path of ALL_PATHS) {
      const row = rowAt(path);
      const link = cellIn(row, 'name').querySelector('a');
      const section = row.getAttribute('data-scope') === 'group' ? 'groups' : 'requests';
      expect(`${path}: ${link?.getAttribute('href')}`).toBe(
        `${path}: /runs/${RUN_ID}/${section}/${encodeURIComponent(path)}`,
      );
    }

    // Spelled out for the nested group, because this is the one a leaf-name
    // link would get wrong while every other row looked right.
    expect(
      cellIn(rowAt('Catalog/Recommendations'), 'name').querySelector('a')?.getAttribute('href'),
    ).toBe(`/runs/${RUN_ID}/groups/Catalog%2FRecommendations`);
  });

  /** The totals row is the run, not a request or a group; there is no page. */
  it('does not link the totals row anywhere', () => {
    renderTable();
    expect(cellIn(totalRow(), 'name').querySelector('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /All Requests/ })).toBeNull();
  });
});

describe('StatisticsTable — the run-scope totals row', () => {
  /**
   * THE ROW `buildTree` DELIBERATELY LEAVES OUT.
   *
   * The run-scope row (`scope: 'run'`, `name: ''`) is the table's TOTAL, and
   * `buildTree` excludes it because Gatling does too — "All Requests" sits
   * alone in `<table id="container_statistics_head">`. Nothing in the brief's
   * three tests notices its absence, and nothing in `buildTree.test.ts` can:
   * this is the only assertion standing between the product and a statistics
   * table with no totals row.
   */
  it('renders the All Requests total, which is not one of the tree rows', () => {
    renderTable();

    const total = totalRow();
    expect(textIn(total, 'name')).toBe('All Requests');
    // The payload's run row, to the millisecond, formatted as Gatling formats
    // it: whole milliseconds, two decimals for the two rates.
    expect(textIn(total, 'count')).toBe('895');
    expect(textIn(total, 'okCount')).toBe('871');
    expect(textIn(total, 'koCount')).toBe('24');
    expect(textIn(total, 'errorRate')).toBe('2.68');
    expect(textIn(total, 'throughputRps')).toBe('14.40');
    expect(textIn(total, 'minMs')).toBe('16');
    expect(textIn(total, 'maxMs')).toBe('2503');
    expect(textIn(total, 'meanMs')).toBe('228');
    expect(textIn(total, 'stddevMs')).toBe('370');

    // It is NOT a body row: it never sorts, never filters, and never doubles
    // the counts a reader adds up.
    expect(bodyRows()).not.toContain(total);
    expect(pathsOf(bodyRows())).toEqual(ROOT_PATHS);
    expect(pathsOf(bodyRows())).not.toContain('');
  });

  /** A payload with no run row does not get an invented one. */
  it('omits the totals row when the payload has none, rather than inventing zeros', () => {
    renderTable({ ...stats, stats: stats.stats.filter((r) => r.scope !== 'run') });
    expect(screen.queryByTestId('stat-row-total')).toBeNull();
    expect(screen.queryByText('All Requests')).toBeNull();
    expect(pathsOf(bodyRows())).toEqual(ROOT_PATHS);
  });
});

describe('StatisticsTable — the numbers a reader reads (G-12, §A.5)', () => {
  /**
   * One whole row, cell by cell, against the captured payload — the parity
   * surface. Formatted as Gatling's own table formats it: counts plain, the two
   * rates to two decimals, response times to whole milliseconds. (Verified
   * against the reference report's own ROOT row, which writes `2.68`, `14.21`
   * and `228` for the same quantities.)
   */
  it('renders every column of a row, rounded as Gatling rounds them', () => {
    renderTable();
    const cart = rowAt('Cart');

    expect(textIn(cart, 'count')).toBe('85');
    expect(textIn(cart, 'okCount')).toBe('70');
    expect(textIn(cart, 'koCount')).toBe('15');
    expect(textIn(cart, 'errorRate')).toBe('17.65');
    expect(textIn(cart, 'throughputRps')).toBe('1.37');
    expect(textIn(cart, 'minMs')).toBe('106');
    expect(textIn(cart, 'p50')).toBe('141');
    expect(textIn(cart, 'p75')).toBe('156');
    expect(textIn(cart, 'p95')).toBe('172');
    expect(textIn(cart, 'maxMs')).toBe('179');
    expect(textIn(cart, 'meanMs')).toBe('141');
    expect(textIn(cart, 'stddevMs')).toBe('19');
  });

  /**
   * The rounded text is what a reader compares against Gatling; the exact
   * number stays beside it, so a parity spec working from the API's own figures
   * never has to reach back into the payload. Same split as the charts' data
   * table, and `% KO` carries the PERCENTAGE it displays, not the fraction the
   * payload stores.
   */
  it('keeps the exact value beside the rounded one', () => {
    renderTable();
    const cart = rowAt('Cart');
    const source = stats.stats.find((r) => r.name === 'Cart' && r.family === 'group_cumulated')!;

    expect(valueIn(cart, 'meanMs')).toBe(source.meanMs);
    expect(valueIn(cart, 'stddevMs')).toBe(source.stddevMs);
    expect(valueIn(cart, 'throughputRps')).toBe(source.throughputRps);
    expect(valueIn(cart, 'errorRate')).toBeCloseTo(source.errorRate * 100, 10);
    expect(valueIn(cart, 'count')).toBe(source.count);
  });

  /**
   * The GROUP rows come from `group_cumulated` — Task 1 measured it against the
   * reference report, which shows Cart as min 106 / max 179 / mean 141 / stddev
   * 19. `group_duration` would render 188 / 264 / 225 / 19 for the same row.
   */
  it('shows the group family Gatling s own global table shows', () => {
    renderTable();
    expect(textIn(rowAt('Cart'), 'minMs')).toBe('106');
    expect(textIn(rowAt('Cart'), 'meanMs')).toBe('141');
    // …and there is exactly one Cart row, not one per family.
    expect(pathsOf(bodyRows()).filter((p) => p === 'Cart').length).toBe(1);
  });
});

describe('StatisticsTable — a displayed percentile is clamped to [min, max]', () => {
  /**
   * THE RULING (`ruling-percentile-clamp.md`). Our p99 can exceed our max:
   * `minMs`/`maxMs` are tracked exactly while the percentiles are DDSketch
   * estimates carrying a 1% RELATIVE guarantee, and in a sparse tail that is up
   * to 14 ms. A percentile of a sample cannot lie outside that sample's own
   * range, so an estimate that does is KNOWN to be wrong — and we hold better
   * information. Clamping projects it onto the interval it was always
   * constrained to.
   *
   * THE PRECONDITION FIRST. Every assertion below is vacuous on a payload that
   * does not overshoot, and this fixture can be re-captured. So the rows that
   * exhibit it today are named: if a future capture stops overshooting, this
   * test says so rather than going quietly green.
   */
  it('the captured payload really does report percentiles above the max', () => {
    const overshooting = stats.stats
      .filter((r) => rawPercentiles(r).some(([, v]) => v > r.maxMs))
      .map((r) => `${r.scope}/${r.family}/${r.name}`);

    expect(overshooting).toEqual([
      'group/group_cumulated/Cart',
      'group/group_duration/Catalog',
      'group/group_cumulated/Catalog/Recommendations',
      'group/group_duration/Catalog/Recommendations',
      'request/response_time/Related Items',
      'request/response_time/View Cart',
      'run/response_time/',
    ]);

    // The two the ruling names, to the number it names them at.
    const recommendations = stats.stats.find(
      (r) => r.name === 'Catalog/Recommendations' && r.family === 'group_cumulated',
    )!;
    expect(recommendations.percentiles.p99).toBeCloseTo(2515.46, 2);
    expect(recommendations.maxMs).toBe(2503);
    const cart = stats.stats.find((r) => r.name === 'Cart' && r.family === 'group_cumulated')!;
    expect(cart.percentiles.p99).toBeCloseTo(179.49, 2);
    expect(cart.maxMs).toBe(179);
  });

  /**
   * The consequence in the DOM, on every rendered row at once: no percentile
   * cell may read higher than its own row's Max, or lower than its own row's
   * Min. The two sit in adjacent columns, and a reader who sees a 99th
   * percentile above the maximum concludes the product is broken.
   */
  it('renders no percentile outside its own row s min and max, on any row', () => {
    renderTable();
    expandCatalog();

    for (const row of [totalRow(), ...bodyRows()]) {
      const path = row.getAttribute('data-path') ?? 'All Requests';
      const min = valueIn(row, 'minMs');
      const max = valueIn(row, 'maxMs');
      for (const key of ['p50', 'p75', 'p95', 'p99']) {
        const value = valueIn(row, key);
        // Labelled, so a failure names the row and the column rather than
        // reporting that some number somewhere was too large.
        const verdict = value >= min && value <= max ? 'inside' : 'OUTSIDE';
        expect(`${path}.${key}=${value} vs [${min}, ${max}]: ${verdict}`).toBe(
          `${path}.${key}=${value} vs [${min}, ${max}]: inside`,
        );
        // …and the rounded text a reader compares cannot cross it either.
        expect(Number(textIn(row, key))).toBeLessThanOrEqual(Number(textIn(row, 'maxMs')));
        expect(Number(textIn(row, key))).toBeGreaterThanOrEqual(Number(textIn(row, 'minMs')));
      }
    }
  });

  /**
   * The rows that would show it, spelled out — because the sweep above passes
   * for a table that renders no percentile columns at all, and because
   * `Catalog/Recommendations` is the one row where the CLAMP is visible in the
   * rounded text (2515.46 rounds to 2515; the max is 2503). On `Cart` the
   * rounding hides it and only the exact value shows the correction.
   */
  it('clamps the rows the ruling names, in the text and in the exact value', () => {
    renderTable();
    expandCatalog();

    const recommendations = rowAt('Catalog/Recommendations');
    expect(textIn(recommendations, 'p95')).toBe('2503');
    expect(textIn(recommendations, 'p99')).toBe('2503');
    expect(textIn(recommendations, 'maxMs')).toBe('2503');
    expect(valueIn(recommendations, 'p99')).toBe(2503);

    // Rounding alone would render this cell `179` either way; the exact value
    // is what distinguishes a clamped 179 from an unclamped 179.49.
    const cart = rowAt('Cart');
    expect(valueIn(cart, 'p99')).toBe(179);
    expect(textIn(cart, 'p99')).toBe('179');

    // The totals row too — it is not in the tree, so nothing else covers it.
    expect(textIn(totalRow(), 'p99')).toBe('2503');
    expect(valueIn(totalRow(), 'p99')).toBe(2503);
  });

  /** The other rows are untouched: the clamp corrects, it does not flatten. */
  it('leaves a percentile inside the range exactly as the payload reported it', () => {
    renderTable();
    const search = stats.stats.find((r) => r.name === 'Search')!;
    expect(valueIn(rowAt('Search'), 'p95')).toBe(search.percentiles.p95);
    expect(valueIn(rowAt('Search'), 'p50')).toBe(search.percentiles.p50);
    expect(textIn(rowAt('Search'), 'p95')).toBe('1940');
  });

  it('is a pure projection onto [minMs, maxMs], at both ends', () => {
    const row = { minMs: 10, maxMs: 100 } as StatRow;
    expect(clampPercentile(50, row)).toBe(50);
    expect(clampPercentile(101, row)).toBe(100);
    expect(clampPercentile(100, row)).toBe(100);
    expect(clampPercentile(9, row)).toBe(10);
    expect(clampPercentile(10, row)).toBe(10);
  });

  /** And the caption says so — a reader comparing our p99 against another
   *  tool's needs to know it is an estimate, clamped or not. */
  it('says in the caption that percentiles are estimates within 1%', () => {
    renderTable();
    const caption = screen.getByRole('table').querySelector('caption');
    expect(caption?.textContent).toMatch(/estimate/i);
    expect(caption?.textContent).toMatch(/within 1%/i);
  });
});

describe('StatisticsTable — the table itself', () => {
  /**
   * A real `<table>`, with a caption that names it — which is what makes
   * `getByRole('table', { name: /statistics/i })` find it, in this suite and in
   * the Playwright specs piece 8 writes.
   */
  it('is a table, named, with column headers scoped as columns', () => {
    renderTable();
    const table = screen.getByRole('table', { name: /statistics/i });
    expect(table.tagName).toBe('TABLE');
    for (const header of screen.getAllByRole('columnheader')) {
      expect(['col', 'colgroup']).toContain(header.getAttribute('scope'));
    }
    // The row's own name cell is its header, so a screen reader announcing
    // "2503" out of context can say which row it belongs to.
    expect(cellIn(rowAt('Search'), 'name').getAttribute('scope')).toBe('row');
  });

  it('says so when a run recorded nothing, rather than rendering an empty table', () => {
    renderTable({ ...stats, stats: [] });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/no statistics/i)).toBeTruthy();
  });

  /** A run row and nothing else is a real payload: the totals still render. */
  it('renders the totals alone when the payload has no groups or requests', () => {
    renderTable({ ...stats, stats: stats.stats.filter((r) => r.scope === 'run') });
    expect(screen.getByRole('table', { name: /statistics/i })).toBeTruthy();
    expect(textIn(totalRow(), 'count')).toBe('895');
    expect(bodyRows()).toEqual([]);
  });
});
