import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { clampPercentile } from '../src/percentile';
import StatisticsTable, {
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
 *
 * ── TASK 6, the sort and filter CONTROLS (G-14, G-15) ───────────────────────
 *
 * Its three example tests were measured the same way, against eleven wrong
 * implementations. Three of them survive assertions that name their behaviour:
 *
 * - **"toggles direction when the same column is clicked twice" passes for a
 *   table that reverses its rows on EVERY click without reading the column at
 *   all** — `desc === asc.reverse()` says nothing about WHICH column was
 *   sorted. Measured: that mutation leaves both of the brief's sort tests
 *   green and is caught only by asserting the ORDER ITSELF, computed from the
 *   payload, for the column that was clicked.
 * - **"filters as you type, keeping ancestors" passes for a filter that keeps
 *   the ancestor and HIDES THE MATCH** — which is what a table with groups
 *   collapsed by default does unless the filter opens what it kept, and what a
 *   reader experiences as "the filter found nothing". Measured: green.
 * - **A FLAT sort of the rendered rows — sorting what is on screen instead of
 *   the tree — leaves 48 of these 49 tests green**, including both of the
 *   brief's. Only "keeps a child with its group when sorted" separates them,
 *   and only because `Catalog` and its child sit five rows apart on p50.
 *
 * All three are kept verbatim (save for the `MemoryRouter` every render here
 * needs), each followed by the assertions that can fail. Every expectation
 * about ORDER is computed from the payload by helpers written in this file, so
 * none of them can drift from the fixture — and none of them is `sortTree`.
 */

const stats = fixture.stats as unknown as StatsResponse;
const RUN_ID = stats.runId;

/**
 * The reference run's four root rows, in payload order. D-10 nests the other
 * five requests under their groups, so `Place Order` and `Search` — the two
 * genuinely groupless ones — are the only requests left at the root.
 */
const ROOT_PATHS = ['Cart', 'Catalog', 'Place Order', 'Search'];

/** Every row the table can show, with `Catalog` — and only `Catalog` —
 *  expanded: its own three direct children, `Cart`'s two staying hidden. */
const WITH_CATALOG_EXPANDED_PATHS = [
  'Cart',
  'Catalog',
  'Catalog/Recommendations',
  'Catalog/List Products',
  'Catalog/Product Detail',
  'Place Order',
  'Search',
];

/** Every row in the tree, full path — every group and request expanded. */
const ALL_PATHS = [
  'Cart',
  'Catalog',
  'Catalog/Recommendations',
  'Cart/Add To Cart',
  'Cart/View Cart',
  'Catalog/List Products',
  'Catalog/Product Detail',
  'Catalog/Recommendations/Related Items',
  'Place Order',
  'Search',
];

function renderTable(payload: StatsResponse = stats) {
  return render(
    <MemoryRouter>
      <StatisticsTable stats={payload} runId={RUN_ID} />
    </MemoryRouter>,
  );
}

/**
 * Turn every optional column on.
 *
 * ═══ WHY SO MANY CASES BELOW CALL THIS ═══
 *
 * The table now opens on eight columns with the rest behind a picker (review
 * M11). Most of the cases in this file are about a PROPERTY of columns —
 * percentile clamping, the sort control, the exact value in a `title`, the
 * group headings — and not about which ones happen to be default. Narrowing
 * them to the default set would quietly shrink what they cover; the property
 * is what they exist to pin, so they pin it over every column there is.
 *
 * The cases that ARE about the default set say so in their own names.
 */
function showAllColumns() {
  for (const box of screen.getAllByRole('checkbox')) {
    if (!(box as HTMLInputElement).checked) fireEvent.click(box);
  }
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

/* ======================================================================== *
 * SORT AND FILTER — every expectation computed FROM THE PAYLOAD
 *
 * Nothing below names a row. The brief's "opens worst-first" test compares
 * against `slowestPathIn(stats)` rather than against `'Catalog'` so that a
 * re-captured fixture moves the expectation with it instead of turning this
 * file red for a reason that is not a defect — and the ordering helpers are
 * written HERE, independently of `sortTree`, rather than imported from the
 * code under test.
 * ======================================================================== */

/** `p99.9` → 99.9; a key that names no percentile → null. */
const percentileIn = (key: string): number | null =>
  /^p\d+(?:\.\d+)?$/.test(key) ? Number(key.slice(1)) : null;

/**
 * The column the table opens sorted on: THE HIGHEST PERCENTILE THE PAYLOAD
 * CONFIGURES — `p99` for the reference run, `p99.9` for a project that
 * configures one. Read off the payload's own keys, exactly as the percentile
 * COLUMNS are (§9 checkpoint 6), so neither can be hard-coded here.
 */
const worstColumnIn = (payload: StatsResponse): string => {
  let worst: string | null = null;
  for (const row of payload.stats) {
    for (const key of Object.keys(row.percentiles)) {
      const value = percentileIn(key);
      if (value === null) continue;
      if (worst === null || value > percentileIn(worst)!) worst = key;
    }
  }
  if (worst === null) throw new Error('this payload configures no percentiles at all');
  return worst;
};

/**
 * The payload rows the tree puts DIRECTLY under `parentPath` — `null` for the
 * root — the sibling list a sort of that level reorders. Generalised over
 * `buildTree`'s own rule (a row's parent is the segment before its last `/`),
 * so it answers for any level of the D-10 tree, not only the root.
 *
 * The root case is what `ROOT_PATHS` is asserted against below, so a fixture
 * that stops agreeing says so rather than quietly comparing against a row the
 * table never puts at the top.
 */
const childRowsIn = (payload: StatsResponse, parentPath: string | null): StatRow[] =>
  payload.stats.filter((r) => {
    if (r.scope === 'run') return false;
    if (r.family !== (r.scope === 'group' ? 'group_cumulated' : 'response_time')) return false;
    const cut = r.name.lastIndexOf('/');
    const parent = cut <= 0 ? null : r.name.slice(0, cut);
    return parent === parentPath;
  });

const rootRowsIn = (payload: StatsResponse): StatRow[] => childRowsIn(payload, null);

/** A payload row's own value on a column — `undefined` when it HAS none. */
const valueOn = (row: StatRow, column: string): number | undefined => {
  const raw =
    column in row.percentiles
      ? row.percentiles[column]
      : (row as unknown as Record<string, unknown>)[column];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
};

/**
 * The order a sibling list takes on a column, computed here from the payload.
 *
 * Stable — ties keep PAYLOAD order, which is the order `buildTree` hands the
 * sort — and a row with no value on the column goes last in BOTH directions,
 * because it is absent rather than smallest.
 */
const orderBy = (rows: readonly StatRow[], column: string, direction: 'asc' | 'desc'): string[] =>
  rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = valueOn(a.row, column);
      const bv = valueOn(b.row, column);
      if (av === undefined || bv === undefined) {
        if (av === bv) return a.index - b.index;
        return av === undefined ? 1 : -1;
      }
      if (av === bv) return a.index - b.index;
      return direction === 'asc' ? av - bv : bv - av;
    })
    .map((entry) => entry.row.name);

const rootOrderBy = (
  column: string,
  direction: 'asc' | 'desc',
  payload: StatsResponse = stats,
): string[] => orderBy(rootRowsIn(payload), column, direction);

/** The order `parentPath`'s own direct children take on a column. */
const childOrderBy = (
  payload: StatsResponse,
  parentPath: string,
  column: string,
  direction: 'asc' | 'desc',
): string[] => orderBy(childRowsIn(payload, parentPath), column, direction);

/** The row a reader opening this run should be looking at first. */
const slowestPathIn = (payload: StatsResponse): string =>
  rootOrderBy(worstColumnIn(payload), 'desc', payload)[0]!;

/**
 * The four root rows IN THE ORDER THE TABLE OPENS IN.
 *
 * `ROOT_PATHS` is payload order, which is what the table showed until task 6
 * wired the sort; it stays as the literal row SET every assertion below still
 * anchors on. The ORDER is now the opening sort's, so it is computed rather
 * than written down twice.
 */
const openingPaths = (): string[] => rootOrderBy(worstColumnIn(stats), 'desc');

/** …and the same, with `Catalog`'s own children in place beneath it — all
 *  three of them, D-10 gives it, in the opening sort's order. */
const openingPathsExpanded = (): string[] =>
  openingPaths().flatMap((path) =>
    path === 'Catalog'
      ? [path, ...childOrderBy(stats, 'Catalog', worstColumnIn(stats), 'desc')]
      : [path],
  );

/** A column's sort control, by the exact accessible name it must carry. */
const sortButton = (label: string): HTMLElement =>
  screen.getByRole('button', { name: `Sort by ${label}` });

/** Which column the table says it is sorted by, and which way. */
const sortedColumns = (): string[] =>
  screen
    .getAllByRole('columnheader')
    .filter((header) => (header.getAttribute('aria-sort') ?? 'none') !== 'none')
    .map((header) => `${header.textContent}:${header.getAttribute('aria-sort')}`);

const typeFilter = (value: string) =>
  fireEvent.change(screen.getByLabelText(/filter/i), { target: { value } });

/** The §13.2 ⑤ column set the reference payload renders, in order. */
const REFERENCE_HEADERS = [
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
];

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
    showAllColumns();
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
    showAllColumns();
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
    showAllColumns();

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
    expect(textIn(rowAt('Cart'), 'p95')).toBe('172');
  });

  it('takes a key from a row that is NOT the first, which is the only thing a union does', () => {
    // MEASURED: the test above exercises only the SUBSET direction — it removes
    // keys from one row. Replacing the column scan with `rows.slice(0, 1)`, or
    // sourcing columns from the totals row alone, leaves the whole suite green.
    // A union is only a union if a LATER row can contribute a column the first
    // row lacks, and StatRow.percentiles is a per-row Record written per
    // (scope, name) sketch, so that is reachable, not hypothetical.
    const extra: StatsResponse = {
      ...stats,
      stats: stats.stats.map((r) =>
        r.name === 'Search'
          ? { ...r, percentiles: { ...r.percentiles, 'p99.9': 2280 } }
          : r,
      ),
    };
    renderTable(extra);

    expect(headers()).toContain('99.9th');
    // 2280 sits inside Search's [407, 2287], so the clamp leaves it alone and
    // this asserts the union rather than the clamp. (9000 here would render
    // 2287 — correct behaviour, wrong test.)
    expect(textIn(rowAt('Search'), 'p99.9')).toBe('2280');
    // Every other row shows the gap rather than borrowing Search's number.
    expect(textIn(rowAt('Cart'), 'p99.9')).toBe('—');
    expect(cellIn(rowAt('Cart'), 'p99.9').getAttribute('data-value')).toBeNull();
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
    showAllColumns();
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
   * So: the exact four root rows are present while `Catalog`'s children are
   * not, expanding `Catalog` is the ONLY thing that changes — `Cart`'s own two
   * children, D-10 gives it, stay hidden — and every row it adds arrives
   * nested — at depth 1, with the indent that depth produces.
   *
   * The row SET is still pinned to the literal `ROOT_PATHS`; the ORDER became
   * the opening sort's when task 6 wired it, and is asserted alongside.
   */
  it('shows every root row while the children are hidden, and adds only Catalog s own', () => {
    renderTable();

    expect([...pathsOf(bodyRows())].sort()).toEqual([...ROOT_PATHS].sort());
    expect(pathsOf(bodyRows())).toEqual(openingPaths());
    expect(screen.getByText('Catalog')).toBeTruthy();
    expect(screen.queryByText('Recommendations')).toBeNull();

    expandCatalog();

    expect([...pathsOf(bodyRows())].sort()).toEqual([...WITH_CATALOG_EXPANDED_PATHS].sort());
    expect(pathsOf(bodyRows())).toEqual(openingPathsExpanded());
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
    expect(pathsOf(bodyRows())).toEqual(openingPathsExpanded());

    fireEvent.click(button);
    expect(pathsOf(bodyRows())).toEqual(openingPaths());
    expect(screen.getByRole('button', { name: /expand Catalog/i })).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * A toggle on a row with nothing to toggle is a control that does nothing,
   * and a screen-reader user is told there is an expandable group where there
   * is none. D-10 gives both top-level groups — `Cart` and `Catalog` — real
   * children; `Place Order` and `Search`, the two groupless requests, have
   * none. Expanding `Catalog` reveals a THIRD: `Recommendations`, its own
   * nested subgroup, which has one child of its own (`Related Items`) and so
   * gets a toggle the moment it is on screen.
   *
   * SCOPED TO THE BODY ROWS (task 6). It was `screen.getAllByRole('button')`,
   * which said "these are the only buttons in the table at all" — true until
   * the column headings became sort controls. Scoped to the rows it still says
   * exactly what it names: no LEAF row ever carries a button of any kind,
   * which is the assertion that catches a toggle rendered where it should not
   * be.
   */
  it('gives a toggle to the rows that have children, and only those', () => {
    renderTable();
    const rowButtons = (): (string | null)[] =>
      bodyRows().flatMap((row) =>
        within(row)
          .queryAllByRole('button')
          .map((b) => b.getAttribute('aria-label')),
      );

    // Opening order is worst-first by p99: Catalog, Search, Cart, Place Order
    // — the two rows with children, in that order, each labelled to expand.
    expect(rowButtons()).toEqual(['expand Catalog', 'expand Cart']);
    expandCatalog();
    // Catalog's own children insert right after it — including
    // `Recommendations`, which now shows its own toggle too.
    expect(rowButtons()).toEqual(['collapse Catalog', 'expand Recommendations', 'expand Cart']);
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
    // `List Products` is `Catalog/List Products` post-D-10, nested under a
    // group that starts collapsed.
    fireEvent.click(screen.getByRole('button', { name: /expand Catalog/i }));
    const link = screen.getByRole('link', { name: /List Products/ });
    expect(link.getAttribute('href')).toBe(`/runs/${RUN_ID}/requests/Catalog%2FList%20Products`);
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
    // D-10 gives `Cart` its own children, and `Recommendations` its own
    // nested request — expand both to reach every row `ALL_PATHS` names.
    fireEvent.click(screen.getByRole('button', { name: /expand Cart/i }));
    fireEvent.click(screen.getByRole('button', { name: /expand Recommendations/i }));

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
    showAllColumns();

    const total = totalRow();
    expect(textIn(total, 'name')).toBe('All Requests');
    // The payload's run row, to the millisecond, formatted as Gatling formats
    // it: whole milliseconds, two decimals for the two rates.
    expect(textIn(total, 'count')).toBe('895');
    expect(textIn(total, 'okCount')).toBe('871');
    expect(textIn(total, 'koCount')).toBe('24');
    expect(textIn(total, 'errorRate')).toBe('2.68');
    // D-11: OURS IS 14.40, GATLING'S REFERENCE ROW SAYS 14.21. Not a
    // formatting difference — a duration-edge difference upstream, newly
    // visible now the number is on screen. The FORMAT matches Gatling (two
    // decimals); the VALUE does not, and that belongs to a backend pass, not
    // to this table. Recorded here rather than only in the ledger so a reader
    // comparing the two reports finds the discrepancy already known.
    expect(textIn(total, 'throughputRps')).toBe('14.40');
    expect(textIn(total, 'minMs')).toBe('16');
    expect(textIn(total, 'maxMs')).toBe('2503');
    expect(textIn(total, 'meanMs')).toBe('228');
    expect(textIn(total, 'stddevMs')).toBe('370');

    // It is NOT a body row: it never sorts, never filters, and never doubles
    // the counts a reader adds up.
    expect(bodyRows()).not.toContain(total);
    expect([...pathsOf(bodyRows())].sort()).toEqual([...ROOT_PATHS].sort());
    expect(pathsOf(bodyRows())).not.toContain('');
  });

  /** A payload with no run row does not get an invented one. */
  it('omits the totals row when the payload has none, rather than inventing zeros', () => {
    renderTable({ ...stats, stats: stats.stats.filter((r) => r.scope !== 'run') });
    showAllColumns();
    expect(screen.queryByTestId('stat-row-total')).toBeNull();
    expect(screen.queryByText('All Requests')).toBeNull();
    expect([...pathsOf(bodyRows())].sort()).toEqual([...ROOT_PATHS].sort());
  });

  /**
   * THE TOTALS ROW'S NAME CELL STAYS BOLD BY INHERITANCE, NOT BY ITS OWN
   * CLASS — see the comment on the cell itself.
   *
   * Every other `<th scope="row">` in this file's table family (the per-row
   * name cell below, `ErrorsTable`'s message cell, `DataTable`'s row label)
   * uses `TH_ROW`, which carries `font-normal` to cancel the browser's
   * default bold `<th>`. This cell is the one exception: its parent `<tr>`
   * carries `font-semibold`, and a `font-weight` specified DIRECTLY on the
   * `<th>` — which is exactly what `TH_ROW` would add — wins over that
   * inherited value and silently un-bolds it. So this cell has NO font
   * utility of its own on purpose.
   *
   * Nothing about that is visible from outside: every other test in this
   * suite reads text and attributes, not classes, so a "normalizing" edit
   * that swapped this cell to `TH_ROW` — matching the visually identical
   * pattern 260 lines away — would compile, typecheck, and pass every other
   * test in this file. This is the one assertion that would catch it.
   */
  it('does not cancel the inherited bold on the totals row name cell', () => {
    renderTable();
    const nameCell = cellIn(totalRow(), 'name');
    expect(nameCell.className).not.toMatch(/\bfont-normal\b/);
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
    showAllColumns();
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
    showAllColumns();
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
    showAllColumns();
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
      // Payload order, not alphabetical: `Cart/View Cart` precedes
      // `Catalog/Recommendations/Related Items` among the requests.
      'request/response_time/Cart/View Cart',
      'request/response_time/Catalog/Recommendations/Related Items',
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
    showAllColumns();
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
    showAllColumns();
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
  it('says the percentiles are estimates within 1%, in the disclosure', () => {
    renderTable();
    /* READ OFF THE PAGE, NOT OFF THE `<caption>` (review C06). The claim is
       that the product tells a reader how close these numbers are; it used to
       be checked on the table's accessible NAME, which is where C06 says the
       prose must not be. The words moved into `TableFrame`'s disclosure and
       the claim is unchanged. */
    const page = document.body.textContent ?? '';
    expect(page).toMatch(/estimate/i);
    expect(page).toMatch(/within 1%/i);
  });
});

describe('StatisticsTable — sortable columns (G-15, §9 checkpoint 3)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's tests, verbatim — save for the MemoryRouter every render
   * in this file needs, because the rows carry <Link>s
   * ------------------------------------------------------------------ */

  it('opens worst-first, not alphabetically', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={stats} runId={RUN_ID} />
      </MemoryRouter>,
    );
    const first = screen.getAllByTestId('stat-row')[0]!;
    // The slowest row, not the first alphabetically. A default of ascending
    // would put the fastest at the top, which is the opposite of the question.
    expect(first.getAttribute('data-path')).toBe(slowestPathIn(stats));
  });

  it('toggles direction when the same column is clicked twice', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={stats} runId={RUN_ID} />
      </MemoryRouter>,
    );
    const header = screen.getByRole('button', { name: /sort by 95th/i });
    fireEvent.click(header);
    const asc = screen.getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
    fireEvent.click(header);
    const desc = screen.getAllByTestId('stat-row').map((r) => r.getAttribute('data-path'));
    expect(desc).toEqual([...asc].reverse());
  });

  /**
   * THE TOGGLE TEST ABOVE IS EXPOSED, AND THIS IS WHAT COVERS IT.
   *
   * `desc === asc.reverse()` is satisfied by a table that REVERSES ITS ROWS ON
   * EVERY CLICK without reading the column at all, and — on a payload with
   * fewer than two distinct values — by one that never sorts. Measured against
   * both, plus against a table sorted only by the first column ever clicked.
   *
   * So: the ORDER ITSELF, computed from the payload, for the clicked column,
   * in both directions; and the precondition that the two directions really
   * are reverses on this column (they are not, in general — a row missing the
   * sorted percentile sorts last in BOTH directions, task 3's rule).
   */
  it('sorts by the clicked column s own values, in the direction it says', () => {
    renderTable();

    const button = sortButton('95th');
    fireEvent.click(button);
    const first = pathsOf(bodyRows());
    fireEvent.click(button);
    const second = pathsOf(bodyRows());

    // Every root row carries p95 in this payload, so — and only so — the two
    // directions are exact reverses of each other.
    expect(rootOrderBy('p95', 'desc')).toEqual([...rootOrderBy('p95', 'asc')].reverse());
    expect(first).toEqual(rootOrderBy('p95', 'desc'));
    expect(second).toEqual(rootOrderBy('p95', 'asc'));
    // A fresh numeric column opens WORST FIRST, like the table itself does.
    expect(sortedColumns()).toEqual(['95th:ascending']);
    fireEvent.click(button);
    expect(sortedColumns()).toEqual(['95th:descending']);
  });

  /**
   * §9 CHECKPOINT 3, the non-numeric one: the table OPENS worst-first.
   *
   * The brief's test above checks the first row. This checks every row, names
   * the column the default is taken on, and asserts the resulting order is
   * neither the payload's nor the alphabet's — so a table that does not sort
   * at all, and one that opens sorted by name, both fail here rather than
   * needing a click to be caught.
   */
  it('opens on the highest percentile the payload configures, worst first, on every row', () => {
    renderTable();

    expect(worstColumnIn(stats)).toBe('p99');
    expect(pathsOf(bodyRows())).toEqual(rootOrderBy('p99', 'desc'));
    expect(sortedColumns()).toEqual(['99th:descending']);

    // …and that order is neither of the two orders that would arrive for free.
    expect(pathsOf(bodyRows())).not.toEqual(ROOT_PATHS);
    expect(pathsOf(bodyRows())).not.toEqual([...ROOT_PATHS].sort());
    // The helper above really is describing the rows the table puts at its top
    // level, so `slowestPathIn` is the slowest of the right set.
    expect(rootRowsIn(stats).map((r) => r.name).sort()).toEqual([...ROOT_PATHS].sort());
  });

  /**
   * A payload configured with a different tail gets ITS tail sorted, for the
   * same reason the columns are the payload's: `p99` is not a constant of the
   * product. Here the highest configured percentile is `p99.9`.
   */
  it('opens on whichever percentile the payload configures, not on p99', () => {
    const odd = withPercentiles({ p50: 1, p90: 2, 'p99.9': 3 });
    renderTable(odd);
    expect(worstColumnIn(odd)).toBe('p99.9');
    expect(sortedColumns()).toEqual(['99.9th:descending']);
  });

  /**
   * Clicking a SECOND column sorts by that column — it does not reverse what
   * was there, and it does not keep sorting by the first column clicked.
   */
  it('sorts by the column that was clicked, not by reversing what was there', () => {
    renderTable();

    fireEvent.click(sortButton('Total'));
    const byCount = pathsOf(bodyRows());
    expect(byCount).toEqual(rootOrderBy('count', 'desc'));
    expect(sortedColumns()).toEqual(['Total:descending']);

    fireEvent.click(sortButton('50th'));
    expect(pathsOf(bodyRows())).toEqual(rootOrderBy('p50', 'desc'));
    expect(pathsOf(bodyRows())).not.toEqual([...byCount].reverse());
    expect(sortedColumns()).toEqual(['50th:descending']);
  });

  /** The leftmost column sorts too, and a NAME sorts A→Z first. */
  it('sorts by name, ascending first', () => {
    renderTable();
    const alphabetical = [...ROOT_PATHS].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : 1,
    );

    fireEvent.click(sortButton('Requests'));
    expect(pathsOf(bodyRows())).toEqual(alphabetical);
    expect(sortedColumns()).toEqual(['Requests:ascending']);

    fireEvent.click(sortButton('Requests'));
    expect(pathsOf(bodyRows())).toEqual([...alphabetical].reverse());
    expect(sortedColumns()).toEqual(['Requests:descending']);
  });

  /**
   * SORTING A TREE IS NOT SORTING THE VISIBLE ROWS (§9 checkpoint 1, at the
   * component's own level — task 3 proved it of `sortTree`, and this proves
   * the component hands `sortTree` the TREE rather than sorting the flat list
   * it renders).
   *
   * `Catalog` sorts second on p50 (361 ms). D-10 gives it three children of
   * its own — `Product Detail` (219 ms), `Recommendations` (109 ms), `List
   * Products` (30 ms) — and a flat sort of the rendered rows would scatter
   * them among the OTHER roots' rows instead of keeping them directly beneath
   * their parent, in their own p50 order.
   */
  it('keeps a child with its group when sorted', () => {
    renderTable();
    expandCatalog();
    fireEvent.click(sortButton('50th'));

    const paths = pathsOf(bodyRows());
    expect(paths).toEqual(
      rootOrderBy('p50', 'desc').flatMap((path) =>
        path === 'Catalog' ? [path, ...childOrderBy(stats, 'Catalog', 'p50', 'desc')] : [path],
      ),
    );
    // Every one of Catalog's children sits directly beneath it, not scattered
    // among the other roots' own rows.
    const catalogIndex = paths.indexOf('Catalog');
    const catalogChildren = childOrderBy(stats, 'Catalog', 'p50', 'desc');
    expect(paths.slice(catalogIndex + 1, catalogIndex + 1 + catalogChildren.length)).toEqual(
      catalogChildren,
    );
    // The children are still children: sorting reorders siblings, it does not
    // promote anything to the root.
    expect(rowAt('Catalog/Recommendations').getAttribute('data-depth')).toBe('1');
    expect(rowAt('Catalog/Product Detail').getAttribute('data-depth')).toBe('1');
    expect(rowAt('Catalog/List Products').getAttribute('data-depth')).toBe('1');
  });

  /** Row keys are stable across a sort, so a group a reader opened stays open. */
  it('keeps an opened group open through a sort', () => {
    renderTable();
    expandCatalog();
    fireEvent.click(sortButton('Max'));
    expect(pathsOf(bodyRows())).toContain('Catalog/Recommendations');
    expect(screen.getByRole('button', { name: /collapse Catalog/i })).toBeTruthy();
  });

  /** G-15 is "sortable columns", plural: every column, and only the columns. */
  it('gives every column a sort control, and none to the two group headings', () => {
    renderTable();
    showAllColumns();

    expect(
      screen.getAllByRole('button', { name: /^sort by /i }).map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Sort by Requests',
      'Sort by Total',
      'Sort by OK',
      'Sort by KO',
      'Sort by % KO',
      'Sort by Cnt/s',
      'Sort by Min',
      'Sort by 50th',
      'Sort by 75th',
      'Sort by 95th',
      'Sort by 99th',
      'Sort by Max',
      'Sort by Mean',
      'Sort by Std Dev',
    ]);

    // The two headings that SPAN columns are not columns; there is nothing to
    // sort by, and a control there would sort by whichever column it guessed.
    for (const heading of ['Executions', 'Response Time (ms)']) {
      const header = screen.getByRole('columnheader', { name: heading });
      expect(header.querySelector('button')).toBeNull();
      expect(header.getAttribute('aria-sort')).toBeNull();
    }
  });

  /**
   * THE TRAP TASK 5 MEASURED AND HANDED THIS TASK, kept measured.
   *
   * A sort control inside a `<th>` can change THE HEADER'S OWN ACCESSIBLE
   * NAME, and the column test's negative —
   * `queryByRole('columnheader', { name: /^95th$/ })` being null for a payload
   * without p95 — silently stops meaning anything the moment it does: it is
   * null for every implementation once no header is named `95th` at all.
   *
   * MEASURED in this stack (jsdom 30, dom-accessibility-api 0.5.16, which is
   * what `getByRole({ name })` computes with):
   *   - `<th><button aria-label="Sort by 95th">95th</button></th>`
   *     → th named "95th". The descendant's `aria-label` is NOT consulted.
   *   - `<th><button aria-labelledby="hint lbl">…</button></th>`
   *     → th named "SORT BY 95TH". A descendant's `aria-labelledby` IS.
   * The second is the one a careful implementer reaches for, and it is the one
   * that breaks the negative. Browsers do not agree with jsdom on the first
   * either, and piece 8's Playwright specs read these names in a real one — so
   * the header states its own name explicitly and this test pins the result.
   */
  it('leaves the column headers own names alone — the sort control is not part of them', () => {
    renderTable();
    showAllColumns();

    expect(screen.queryAllByRole('columnheader', { name: /sort by/i })).toEqual([]);
    expect(screen.getByRole('columnheader', { name: '95th' })).toBeTruthy();
    expect(headers()).toEqual(REFERENCE_HEADERS);
    // The name is the label, sorted or not: it does not acquire an arrow, a
    // direction, or the word "sorted" when it is the sorted column.
    fireEvent.click(sortButton('95th'));
    expect(screen.getByRole('columnheader', { name: '95th' })).toBeTruthy();
    expect(headers()).toEqual(REFERENCE_HEADERS);

    // …so §9 checkpoint 6's negative is still live with the controls wired.
    cleanup();
    renderTable(withPercentiles({ p50: 1, p90: 2, 'p99.9': 3 }));
    showAllColumns();
    expect(screen.queryByRole('columnheader', { name: /^95th$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /sort by 95th/i })).toBeNull();
  });

  /** The totals row is the run's own; it is not a row the sort can move. */
  it('never moves the totals row into the sorted rows', () => {
    renderTable();
    showAllColumns();
    fireEvent.click(sortButton('Max'));
    expect(bodyRows()).not.toContain(totalRow());
    expect(textIn(totalRow(), 'count')).toBe('895');
    expect(pathsOf(bodyRows())).toEqual(rootOrderBy('maxMs', 'desc'));
  });
});

describe('StatisticsTable — the name filter (G-14)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim (plus the MemoryRouter)
   * ------------------------------------------------------------------ */

  it('filters as you type, keeping ancestors', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={stats} runId={RUN_ID} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/filter/i), { target: { value: 'Recommend' } });
    expect(screen.getByText('Catalog')).toBeTruthy();
    expect(screen.queryByText('List Products')).toBeNull();
  });

  /**
   * The discriminating form. The brief's test is satisfied by a filter that
   * keeps the ANCESTOR and hides the match — which is what a table with groups
   * collapsed by default does unless the filter opens what it kept, and it is
   * the exact failure a reader experiences as "the filter found nothing".
   *
   * So: the exact row set, the match VISIBLE, and still nested under the group
   * that gives it its meaning.
   */
  it('shows the match itself, open inside the group that gives it context', () => {
    renderTable();
    typeFilter('Recommend');

    // `Recommendations` matches, and while filtering runs a kept row is
    // treated as expanded, so its own child — `Related Items`, nested one
    // level under it post-D-10 — is visible too.
    expect(pathsOf(bodyRows())).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
    expect(screen.getByText('Recommendations')).toBeTruthy();
    expect(rowAt('Catalog/Recommendations').getAttribute('data-depth')).toBe('1');
  });

  /** It is the FULL PATH that matches, case-insensitively, trimmed at the ends. */
  it('matches the full path, whatever the case, ignoring stray spaces', () => {
    renderTable();
    typeFilter('  catalog/rec  ');
    expect(pathsOf(bodyRows())).toEqual([
      'Catalog',
      'Catalog/Recommendations',
      'Catalog/Recommendations/Related Items',
    ]);
  });

  it('keeps every match, not only the first', () => {
    renderTable();
    typeFilter('Cart');
    // `Cart` itself matches, and while filtering runs a matching row's own
    // subtree is visible too — its two children, D-10 gives it, in the
    // opening sort's order (p99 desc: `Add To Cart` 144, `View Cart` 44).
    expect(pathsOf(bodyRows())).toEqual([
      'Cart',
      ...childOrderBy(stats, 'Cart', 'p99', 'desc'),
    ]);
  });

  /** An empty table with headings over it reads as a run that recorded nothing. */
  it('says so when nothing matches, and keeps the run s own totals', () => {
    renderTable();
    typeFilter('no row is named this');

    expect(bodyRows()).toEqual([]);
    expect(screen.getByText(/no rows match/i)).toBeTruthy();
    // The totals row is the RUN's, not a match: it is not filtered away.
    expect(textIn(totalRow(), 'count')).toBe('895');
  });

  /**
   * AN EMPTY QUERY IS NOT A QUERY (task 4's contract, and this component must
   * not implement it a second time). Clearing the box gives the whole table
   * back — in the sort it was in, and with the reader's OWN expansion state,
   * not the one the filter needed.
   */
  it('gives the whole table back when the box is cleared', () => {
    renderTable();
    typeFilter('Recommend');
    typeFilter('');

    expect(pathsOf(bodyRows())).toEqual(rootOrderBy('p99', 'desc'));
    expect(screen.queryByText('Recommendations')).toBeNull();
    expect(screen.getByRole('button', { name: /expand Catalog/i })).toBeTruthy();
  });

  it('remembers a group the reader opened, through a filter that hides it', () => {
    renderTable();
    expandCatalog();
    typeFilter('Place Order');
    expect(pathsOf(bodyRows())).toEqual(['Place Order']);

    typeFilter('');
    expect(pathsOf(bodyRows())).toContain('Catalog/Recommendations');
  });

  /** Filtering hides rows. It is not a re-sort, and not a re-shaping. */
  it('changes neither the sort nor the column set', () => {
    renderTable();
    showAllColumns();
    fireEvent.click(sortButton('Min'));
    typeFilter('Product');

    // `Product` matches both of `Catalog`'s own requests — `Product Detail`
    // directly, and `List Products` because "Products" contains "Product" —
    // so `Catalog` is kept as their ancestor and both arrive with it, sorted
    // by Min descending like everything else.
    expect(pathsOf(bodyRows())).toEqual([
      'Catalog',
      ...childOrderBy(stats, 'Catalog', 'minMs', 'desc').filter((path) =>
        path.toLowerCase().includes('product'),
      ),
    ]);
    expect(sortedColumns()).toEqual(['Min:descending']);
    // The columns come from the whole payload, so a filter down to one row
    // cannot take a percentile column away with it.
    expect(headers()).toEqual(REFERENCE_HEADERS);
  });

  /** G-14 is a filter BOX: a real labelled control, not a placeholder. */
  it('is a labelled text control that shows what was typed', () => {
    renderTable();
    showAllColumns();
    const box = screen.getByLabelText(/filter/i);
    expect(box.tagName).toBe('INPUT');
    typeFilter('Search');
    expect((box as HTMLInputElement).value).toBe('Search');
  });
});

describe('StatisticsTable — why it is empty, when it is', () => {
  const empty: StatsResponse = { ...stats, stats: [] };

  /**
   * ═══ "RECORDED" IS FALSE FOR A RUN WHOSE STREAM STOPPED ═══
   *
   * MEASURED END TO END, not reasoned about. A live run was opened against a
   * real stack, given 18,884 bytes of a real `simulation.log`, and its
   * producer was then killed. The fold owner published a delta reading
   * `count 440 / ok 428 / ko 12` — numbers a reader WATCHED on the live page
   * — and the sweeper finalized the run `incomplete` with ZERO stat rows, no
   * simulation and no duration. The chunks are still in the object store;
   * nothing assembles them, because `finalizeLive` runs only under `close()`
   * and the sweeper must never re-enqueue.
   *
   * So the unconditional "No statistics were recorded for this run" told a
   * reader who had just watched 440 requests that none had existed. They were
   * recorded; they are not RETAINED, and those are different claims.
   *
   * ASSERTED AS A PAIR. "says retained" alone passes against a table that
   * says it for EVERY empty run — a new wrong sentence for a run that
   * genuinely measured nothing, which is the state the case below pins.
   */
  it('says statistics were not RETAINED when the stream stopped early', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={empty} runId={RUN_ID} runStatus="incomplete" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no statistics were retained/i)).toBeTruthy();
    expect(screen.queryByText(/no statistics were recorded/i)).toBeNull();
  });

  it('keeps "recorded" for a completed run that measured nothing', () => {
    render(
      <MemoryRouter>
        <StatisticsTable stats={empty} runId={RUN_ID} runStatus="complete" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no statistics were recorded/i)).toBeTruthy();
    expect(screen.queryByText(/no statistics were retained/i)).toBeNull();
  });

  /** No caller is obliged to pass it, and an un-told table must fall back to
   *  the unconditional wording rather than to the narrower claim. */
  it('falls back to "recorded" when nobody says what happened', () => {
    renderTable(empty);
    expect(screen.getByText(/no statistics were recorded/i)).toBeTruthy();
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
    showAllColumns();
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

/**
 * CSV EXPORT.
 *
 * The interesting decision is WHICH ROWS, and it is not "the visible ones":
 * expansion is a display convenience, so a collapsed group's children are
 * still rows of the statistics table and must be in the file. The filter and
 * the sort ARE honoured, because both are explicit acts of selection.
 *
 * Driven through the real button rather than by calling `statisticsCsv`
 * directly, so the wiring is covered too — `flatten(sorted)` versus `rows` is
 * exactly the mistake this guards, and it lives at the call site.
 */
describe('StatisticsTable — CSV export', () => {
  /** jsdom implements neither of these; the Blob itself is real. */
  function clickDownload(): Blob {
    const held: { blob: Blob | null } = { blob: null };
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        held.blob = blob;
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));

    if (held.blob === null) throw new Error('Download CSV produced no blob');
    return held.blob;
  }

  /**
   * `Blob.text()` UTF-8-DECODES, and decoding strips a leading BOM — so the
   * text a test reads never contains one however the file was written. The BOM
   * is asserted on the bytes instead, in its own case below.
   */
  const csvText = (): Promise<string> => clickDownload().text();

  it('exports every row in the tree, including collapsed groups’ children', async () => {
    // The table opens with every group COLLAPSED, so only the four roots are
    // on screen. All ten must still be in the file.
    renderTable();
    const csv = await csvText();

    for (const path of ALL_PATHS) {
      expect(csv, `${path} missing from the export`).toContain(`"${path}"`);
    }
  });

  it('puts the totals row first, labelled as the table labels it', async () => {
    renderTable();
    const csv = await csvText();
    const records = csv.split('\r\n');

    expect(records[1]).toContain('"All Requests"');
  });

  it('heads the file with the columns the table is rendering', async () => {
    renderTable();
    const csv = await csvText();

    // Derived from the payload, not written down: the percentile columns are
    // whatever this run configured.
    //
    // THE LEAF HEADERS ONLY. The table heads its columns in two rows - the
    // GROUPS ("Executions", "Response Time (ms)") carry the unit and span
    // several columns each, and are not columns themselves. `colSpan > 1` is
    // what tells them apart, and it is the same fact the markup encodes.
    const rendered = screen
      .getAllByRole('columnheader')
      .filter((th) => (th as HTMLTableCellElement).colSpan <= 1)
      .map((th) => th.textContent?.trim() ?? '')
      .filter((label) => label !== '');
    const header = csv.split('\r\n')[0] ?? '';

    expect(rendered.length).toBeGreaterThan(5);
    for (const label of rendered) {
      expect(header, `${label} missing from the header`).toContain(`"${label}"`);
    }
  });

  it('honours the filter, because typing one is an act of selection', async () => {
    renderTable();
    fireEvent.change(screen.getByLabelText('Filter by name'), {
      target: { value: 'Recommendations' },
    });

    const csv = await csvText();
    expect(csv).toContain('"Catalog/Recommendations"');
    expect(csv).not.toContain('"Search"');
  });

  /**
   * ═══ THE EXPORT IS AN ARCHIVE, SO THE PICKER DOES NOT NARROW IT ═══
   *
   * `DEFAULT_STATISTIC_COLUMNS` opens the table on eight of the thirteen this
   * payload carries. M11 argued that is right for a TABLE and said in the same
   * breath that "the CSV export is unchanged" — then shipped
   * `allColumns = [...shown...]`, the visible set under the other one's name,
   * and the file lost OK, Min, 75th, Mean and Std Dev for 237 commits.
   *
   * ═══ WHY THE EXISTING HEADER CASE COULD NOT SEE IT ═══
   *
   * "heads the file with the columns the table is rendering" asserts every
   * VISIBLE header appears in the file — which an export of exactly the
   * visible columns satisfies perfectly. It pins the intersection; the claim
   * is about the superset, and no assertion in this file made it. Same shape
   * CLAUDE.md records for `window.integration.test.ts`, where a case named for
   * the behaviour passed `?scope=request` on both sides and so proved the
   * consumer rather than the default.
   *
   * ═══ ASSERTED AS A PAIR, AND NEITHER HALF IS SUFFICIENT ═══
   *
   * "the file carries Std Dev" alone passes against a table that has simply
   * stopped hiding anything — the picker broken, M11 undone, and the export
   * merely agreeing with a screen that now shows everything. "Std Dev is not
   * on screen" alone is satisfied by a file that does not have it either,
   * which is the defect. Only the two together say the file is WIDER than the
   * screen, which is the whole claim.
   */
  it('carries every column the payload has, not the ones the picker has on', async () => {
    renderTable();

    const onScreen = () =>
      screen
        .getAllByRole('columnheader')
        .map((th) => th.textContent?.trim() ?? '')
        .filter((label) => label !== '');

    // The default really is narrower than the payload — otherwise the case
    // below is vacuous, and it would be vacuous SILENTLY.
    const atRest = onScreen();
    const hidden = ['OK', 'Min', 'Mean', 'Std Dev'].filter(
      (label) => !atRest.some((h) => h.includes(label)),
    );
    expect(hidden, 'the default column set no longer hides anything').not.toHaveLength(0);

    const csv = await csvText();
    const header = csv.split('\r\n')[0] ?? '';
    for (const label of hidden) {
      expect(header, `${label} is off by default and must still be in the file`).toContain(
        `"${label}"`,
      );
    }
  });

  /**
   * THE REASON THE CASE ABOVE IS WORTH ITS LINES, STATED AS A TEST.
   *
   * `RunGlossary`'s `estimate` entry — the branch that named the one column
   * Gatling parity cannot keep — tells a reader that "Total, OK, KO, Min, Max
   * and Mean are exact, and are what to diff the two reports on". Three of
   * those six are off by default. A reader who follows that sentence to the
   * download gets the file it sent them for, or the sentence is wrong.
   *
   * Spelled as the six labels rather than by importing the glossary: the
   * coupling is a CLAIM about two surfaces agreeing, and a shared constant
   * would make both sides move together and assert nothing.
   */
  it('carries every column the glossary calls exact, which is what a Gatling diff needs', async () => {
    renderTable();
    const header = (await csvText()).split('\r\n')[0] ?? '';
    for (const label of ['Total', 'OK', 'KO', 'Min', 'Max', 'Mean']) {
      expect(header, `the glossary sends readers here to diff ${label}`).toContain(`"${label}"`);
    }
  });

  it('writes a UTF-8 BOM, so Excel does not mangle a non-ASCII name', async () => {
    // Asserted on the BYTES. Blob.text() UTF-8-decodes, and decoding consumes
    // the BOM, so a text-level assertion can never see one and would fail
    // whether or not the file actually has it.
    renderTable();
    const bytes = new Uint8Array(await clickDownload().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

/**
 * REVIEW m02 — THE EXPLANATION STOPS COMPETING WITH THE DATA.
 *
 * Most tables here open with a paragraph about ingestion behaviour, pagination
 * semantics or percentile internals. The information is real and worth having
 * — it is read once and then met on every visit, above the numbers somebody
 * came for.
 *
 * THE `<caption>` IS A SHORT NAME NOW, AND THE ARGUMENT THAT KEPT IT LONG HAS
 * EXPIRED. This read: "Shortening the name to tidy the page would break all of
 * that AND tell a screen-reader user less than a sighted one." The second half
 * was true WHEN THE CAPTION WAS THE ONLY COPY OF THE PROSE. It is not any
 * more: C06's first half removed the `aria-hidden` from `TableFrame`'s
 * disclosure, so the full methodology is exposed to the accessibility tree,
 * one keystroke away, for everyone. A screen-reader user now gets the same
 * short name and the same opt-in detail a sighted one does.
 *
 * C06's second half is explicit — "Avoid duplicating the full prose as the
 * accessible name" — and a 94-word `<caption>` is met on arrival with no way
 * to skip it. So the name is "Statistics for every request and group in this
 * run" and the prose lives only in the disclosure.
 *
 * THE DISTINCTIVE WORD SURVIVES ON PURPOSE. Six specs find this table by
 * `getByRole('table', { name: /statistics/i })`; the visible summary does not
 * contain "statistics", so a shorter name that dropped it would have been a
 * rename smuggled in behind an accessibility fix.
 *
 * This entry is the "a test that pins prose verbatim protects it from
 * correction" lesson CLAUDE.md already records, met from the other side: the
 * pin was right when written and became the reason the defect survived.
 */
describe('StatisticsTable — the prose is available rather than present', () => {
  it('names the table concisely, without reciting the methodology', () => {
    renderTable();
    const name = screen.getByRole('table').querySelector('caption')?.textContent ?? '';
    // Concise and useful, which is C06's own acceptance wording.
    expect(name).toMatch(/^Statistics for every request and group in this run$/);
    // The two pieces of methodology that used to be in the NAME are not.
    expect(name).not.toMatch(/percentile|within 1%|never be added/i);
    // PAIRED: they are still on the page, in the disclosure, so this is a move
    // rather than a deletion — the whole of C06's "expose optional methodology
    // as an accessible disclosure".
    expect(document.body.textContent ?? '').toMatch(/within 1%/i);
  });

  it('shows a short line and puts the detail behind a disclosure', () => {
    renderTable();
    // `getByText` throws when absent, so finding it IS the assertion — this
    // file has no jest-dom matchers.
    expect(screen.getByText(/with the run’s own totals first/i)).toBeTruthy();
    // Closed by default: the point is that the prose is available, not present.
    const disclosure = document.querySelector('details');
    expect(disclosure).not.toBeNull();
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
  });
});

/**
 * REVIEW M11 — FIFTEEN COLUMNS IS AN ARCHIVE, NOT A TABLE.
 *
 * The default showed every measure the payload carried. A reader scanning for
 * a regression reads maybe four, and the other eleven cost width that pushed
 * request names into `truncate` and the whole table into a horizontal
 * scroller.
 *
 * NOTHING IS REMOVED — the rest are one disclosure away and the CSV export is
 * untouched. These cases are about the DEFAULT, which is why they are the only
 * ones in this file that do not call `showAllColumns`.
 */
describe('StatisticsTable — the columns it opens with', () => {
  const headings = () =>
    screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.trim() ?? '')
      .filter((t) => t !== '');

  it('opens on the triage columns rather than every measure', () => {
    renderTable();
    const shown = headings();
    for (const wanted of ['Total', 'KO', '% KO', 'Cnt/s', '50th', '95th', '99th', 'Max']) {
      expect(shown.some((h) => h.includes(wanted))).toBe(true);
    }
    // And the ones a reader rarely scans are not there at rest.
    expect(shown.some((h) => h.includes('Std Dev'))).toBe(false);
    expect(shown.some((h) => h.includes('Min'))).toBe(false);
  });

  it('reveals the rest through the picker', () => {
    renderTable();
    expect(headings().some((h) => h.includes('Std Dev'))).toBe(false);
    showAllColumns();
    expect(headings().some((h) => h.includes('Std Dev'))).toBe(true);
    expect(headings().some((h) => h.includes('Min'))).toBe(true);
  });

  /**
   * THE SORTED COLUMN IS ALWAYS VISIBLE, and this case exists because the
   * first version of the change broke it. `worstFirstColumn` picks the HIGHEST
   * percentile the payload configures, which need not be p99 — so a project on
   * p99.9 opened sorted by a column the default list does not name, with the
   * sort arrow nowhere on screen.
   */
  it('always shows the column it opens sorted by', () => {
    renderTable(withPercentiles({ p50: 1, 'p99.9': 2 }));
    expect(headings().some((h) => h.includes('99.9th'))).toBe(true);
  });

  /** A table of row names and nothing else is not a state worth being able to
   *  click your way into, and there is no undo for it on screen. */
  it('refuses to turn off the last remaining column', () => {
    renderTable();
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes) {
      if ((box as HTMLInputElement).checked) fireEvent.click(box);
    }
    expect(headings().length).toBeGreaterThan(0);
  });
});

/* ======================================================================== *
 * A GROUP ROW SAYS IT IS ONE (review M11)
 * ======================================================================== */

/**
 * ═══ WHY THIS NEEDED SAYING AT ALL ═══
 *
 * A group and a request rendered identically apart from the expand chevron —
 * and the chevron is a property of having CHILDREN, not of being a group. So a
 * childless group was indistinguishable from a request, and a running filter
 * (which flattens the tree to the rows that matched) removed the distinction
 * from every row at once.
 *
 * It matters because the two quantities are not comparable: a group's counts
 * already contain the counts of the requests inside it, so adding a group row
 * to a request row double-counts. The caption states that; the tag is what
 * lets a reader apply the caption to the row in front of them.
 */
describe('StatisticsTable — a group row is marked as one', () => {
  const typeTagIn = (row: HTMLElement): HTMLElement | null =>
    within(row).queryByTestId('stat-row-type');

  it('tags every group row and no request row', () => {
    renderTable();
    // Computed from the payload, never written down — `data-scope` is the
    // row's own claim and the tag has to agree with it on every rendered row.
    const rows = bodyRows();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.getAttribute('data-scope') === 'group')).toBe(true);
    expect(rows.some((r) => r.getAttribute('data-scope') === 'request')).toBe(true);

    for (const row of rows) {
      const tagged = typeTagIn(row) !== null;
      expect(tagged, `row ${row.getAttribute('data-path')} tagged`).toBe(
        row.getAttribute('data-scope') === 'group',
      );
    }
  });

  /**
   * THE ROW HEADER'S ACCESSIBLE NAME IS STILL THE ROW'S NAME, which is the
   * half a visible tag most easily breaks. `run-tables.spec.ts` reaches these
   * rows with `getByRole('rowheader', { name, exact: true })`, and the `<th>`
   * pins its name with `aria-labelledby` for exactly this reason — measured
   * here rather than assumed, because the tag is a new text node inside that
   * `<th>` and a name computed from contents would now include it.
   */
  it('does not put the tag in the row header’s accessible name', () => {
    renderTable();
    const group = bodyRows().find((r) => r.getAttribute('data-scope') === 'group')!;
    const name = group.querySelector('a')!.textContent!;
    const header = within(group).getByRole('rowheader', { name });

    // The cell that resolved is the NAME cell, and the tag really is inside
    // it — without this second half the query above would pass just as well
    // for a tag rendered in some other cell, which is not the construction at
    // risk.
    expect(header.getAttribute('data-column')).toBe('name');
    expect(within(header).getByTestId('stat-row-type').textContent).toBe('group');
  });

  /** And the tag is explained where the table explains itself, rather than
   *  being a convention the reader has to infer from two rows. */
  it('says what a tagged row is, and that it does not add, in the disclosure', () => {
    renderTable();
    // Off the page rather than off the `<caption>` — see the percentile case
    // above and review C06: the name is short now, the prose is disclosed.
    const page = document.body.textContent ?? '';
    expect(page).toMatch(/tagged group/i);
    expect(page).toMatch(/never be added/i);
    expect(page).toMatch(/untagged row is a single request/i);
  });
});


/**
 * AC-DASH-4: "given any FILTERED, SORTED, zoomed view, when its URL is copied
 * and opened in a new session, then the identical view renders."
 *
 * Zoomed was already true — the time window is a search param. Sorted and
 * filtered were `useState`, so a reader who sorted by p95 and filtered to a
 * request handed over the page and not the question. This product has made
 * the same fix twice before (the compare metric, the errors request filter)
 * and written down the reasoning both times.
 *
 * THE ROUND TRIP IS THE CLAIM, so these render from a URL rather than only
 * asserting one gets written. A test that clicked a header and checked the
 * address bar proves the WRITE and says nothing about whether a recipient's
 * fresh mount reads it back — which is the half a shared link depends on.
 */
describe('StatisticsTable — a shared link carries the question', () => {
  // A real request name out of the fixture's own roots, not a literal: the
  // file already keeps `ROOT_PATHS` for exactly this reason.
  const FILTERABLE = ROOT_PATHS[1]!;   // 'Catalog'

  /** Renders the live location, so a case can read what a reader would copy. */
  const Where = () => <span data-testid="where">{useLocation().search}</span>;

  const at = (search: string) =>
    render(
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}${search}`]}>
        <StatisticsTable stats={stats} runId={RUN_ID} />
        <Where />
      </MemoryRouter>,
    );

  // `bodyRows`/`pathsOf` are the file's own helpers, and they exclude the
  // totals row — which carries no `data-path` and would answer null for
  // every case below.
  const firstBodyPath = () => pathsOf(bodyRows()).at(0) ?? null;

  it('opens sorted the way the link says, not on its own default', () => {
    // Ascending on the leftmost column is the one order this table never
    // opens on by itself, so a match here cannot be the default wearing a
    // disguise.
    at('?sort=name&dir=asc');
    const ascending = firstBodyPath();

    cleanup();
    at('');
    expect(firstBodyPath(), 'the link must not render the default view').not.toBe(ascending);
  });

  it('opens filtered the way the link says', () => {
    at(`?q=${encodeURIComponent(FILTERABLE)}`);
    const paths = pathsOf(bodyRows());
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect((path ?? '').toLowerCase()).toContain(FILTERABLE.toLowerCase());
    }
    // And the box shows what is filtering, or the reader cannot tell why
    // rows are missing and has nothing to clear.
    // `.value` rather than `toHaveValue`: this file does not import
    // `@testing-library/jest-dom/vitest`, so that matcher is an "Invalid Chai
    // property" rather than a failed assertion — CLAUDE.md records the same
    // trap in this same file.
    expect((screen.getByLabelText(/filter/i) as HTMLInputElement).value).toBe(FILTERABLE);
  });

  it('writes the sort into the URL when a header is clicked', () => {
    at('');
    fireEvent.click(screen.getByRole('button', { name: /sort by 95th/i }));
    // Read off the rendered location rather than a spy: the claim is about
    // what a reader would copy out of the address bar.
    expect(screen.getByTestId('where').textContent).toMatch(/sort=p95/);
  });

  /**
   * The guard. `?sort=` is a string a reader can type, and `buildTree`'s
   * `valueOf` degrades on an unknown column by reading `undefined` — so an
   * unvalidated one would not crash, it would render every row in arrival
   * order with no header marked sorted. That reads as a broken table rather
   * than an ignored parameter.
   */
  it('ignores a sort column this payload does not have, falling back to the default', () => {
    at('?sort=totally-not-a-column&dir=asc');
    const junk = firstBodyPath();
    cleanup();
    at('');
    expect(junk, 'an unknown column must render the default view').toBe(firstBodyPath());
  });
});
