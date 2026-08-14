import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
 * The payload rows the tree puts at its ROOT — the rows a sort of the top
 * level reorders.
 *
 * A row is a root when its name carries no `/`, which is true of every request
 * in this payload (measured in task 2: request names carry NO group path,
 * deviation D-10) and of the two top-level groups. `Catalog/Recommendations`
 * is the one row it excludes, and it is excluded correctly: it is `Catalog`'s
 * child. The row set this produces is asserted against `ROOT_PATHS` below, so
 * a fixture that stops agreeing says so rather than quietly comparing against
 * a row the table never puts at the top.
 */
const rootRowsIn = (payload: StatsResponse): StatRow[] =>
  payload.stats.filter(
    (r) =>
      r.scope !== 'run' &&
      !r.name.includes('/') &&
      r.family === (r.scope === 'group' ? 'group_cumulated' : 'response_time'),
  );

/** A payload row's own value on a column — `undefined` when it HAS none. */
const valueOn = (row: StatRow, column: string): number | undefined => {
  const raw =
    column in row.percentiles
      ? row.percentiles[column]
      : (row as unknown as Record<string, unknown>)[column];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
};

/**
 * The order the root rows take on a column, computed here from the payload.
 *
 * Stable — ties keep PAYLOAD order, which is the order `buildTree` hands the
 * sort — and a row with no value on the column goes last in BOTH directions,
 * because it is absent rather than smallest.
 */
const rootOrderBy = (
  column: string,
  direction: 'asc' | 'desc',
  payload: StatsResponse = stats,
): string[] =>
  rootRowsIn(payload)
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

/** The row a reader opening this run should be looking at first. */
const slowestPathIn = (payload: StatsResponse): string =>
  rootOrderBy(worstColumnIn(payload), 'desc', payload)[0]!;

/**
 * The nine root rows IN THE ORDER THE TABLE OPENS IN.
 *
 * `ROOT_PATHS` is payload order, which is what the table showed until task 6
 * wired the sort; it stays as the literal row SET every assertion below still
 * anchors on. The ORDER is now the opening sort's, so it is computed rather
 * than written down twice.
 */
const openingPaths = (): string[] => rootOrderBy(worstColumnIn(stats), 'desc');

/** …and the same, with `Catalog`'s child in place beneath it. */
const openingPathsExpanded = (): string[] =>
  openingPaths().flatMap((path) =>
    path === 'Catalog' ? [path, 'Catalog/Recommendations'] : [path],
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
    expect(textIn(rowAt('View Cart'), 'p99.9')).toBe('—');
    expect(cellIn(rowAt('View Cart'), 'p99.9').getAttribute('data-value')).toBeNull();
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
   *
   * The row SET is still pinned to the literal `ROOT_PATHS`; the ORDER became
   * the opening sort's when task 6 wired it, and is asserted alongside.
   */
  it('shows every root row while the child is hidden, and adds only the child', () => {
    renderTable();

    expect([...pathsOf(bodyRows())].sort()).toEqual([...ROOT_PATHS].sort());
    expect(pathsOf(bodyRows())).toEqual(openingPaths());
    expect(screen.getByText('Catalog')).toBeTruthy();
    expect(screen.queryByText('Recommendations')).toBeNull();

    expandCatalog();

    expect([...pathsOf(bodyRows())].sort()).toEqual([...ALL_PATHS].sort());
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
   * and a screen-reader user is told there are ten expandable groups when
   * there is one. `Catalog` is the only row in the reference run with children.
   *
   * SCOPED TO THE BODY ROWS (task 6). It was `screen.getAllByRole('button')`,
   * which said "these are the only buttons in the table at all" — true until
   * the column headings became sort controls. Scoped to the rows it still says
   * exactly what it names: NO ROW but `Catalog` carries a button of any kind,
   * which is the assertion that catches a toggle rendered on a leaf.
   */
  it('gives a toggle to the rows that have children, and only those', () => {
    renderTable();
    const rowButtons = (): (string | null)[] =>
      bodyRows().flatMap((row) =>
        within(row)
          .queryAllByRole('button')
          .map((b) => b.getAttribute('aria-label')),
      );

    expect(rowButtons()).toEqual(['expand Catalog']);
    expandCatalog();
    expect(rowButtons()).toEqual(['collapse Catalog']);
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
    expect(screen.queryByTestId('stat-row-total')).toBeNull();
    expect(screen.queryByText('All Requests')).toBeNull();
    expect([...pathsOf(bodyRows())].sort()).toEqual([...ROOT_PATHS].sort());
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
   * `Catalog` sorts second on p50 (361 ms) and its child sixth (109 ms). A
   * flat sort of the rendered rows would put five rows between a parent and
   * its child; the tree sort keeps it directly beneath.
   */
  it('keeps a child with its group when sorted', () => {
    renderTable();
    expandCatalog();
    fireEvent.click(sortButton('50th'));

    const paths = pathsOf(bodyRows());
    expect(paths).toEqual(
      rootOrderBy('p50', 'desc').flatMap((path) =>
        path === 'Catalog' ? [path, 'Catalog/Recommendations'] : [path],
      ),
    );
    expect(paths.indexOf('Catalog/Recommendations')).toBe(paths.indexOf('Catalog') + 1);
    // The child is still the child: sorting reorders siblings, it does not
    // promote anything to the root.
    expect(rowAt('Catalog/Recommendations').getAttribute('data-depth')).toBe('1');
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
    expect(screen.queryByRole('columnheader', { name: /^95th$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /sort by 95th/i })).toBeNull();
  });

  /** The totals row is the run's own; it is not a row the sort can move. */
  it('never moves the totals row into the sorted rows', () => {
    renderTable();
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

    expect(pathsOf(bodyRows())).toEqual(['Catalog', 'Catalog/Recommendations']);
    expect(screen.getByText('Recommendations')).toBeTruthy();
    expect(rowAt('Catalog/Recommendations').getAttribute('data-depth')).toBe('1');
  });

  /** It is the FULL PATH that matches, case-insensitively, trimmed at the ends. */
  it('matches the full path, whatever the case, ignoring stray spaces', () => {
    renderTable();
    typeFilter('  catalog/rec  ');
    expect(pathsOf(bodyRows())).toEqual(['Catalog', 'Catalog/Recommendations']);
  });

  it('keeps every match, not only the first', () => {
    renderTable();
    typeFilter('Cart');
    expect(pathsOf(bodyRows())).toEqual(
      rootOrderBy('p99', 'desc').filter((path) => path.toLowerCase().includes('cart')),
    );
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
    fireEvent.click(sortButton('Min'));
    typeFilter('Product');

    expect(pathsOf(bodyRows())).toEqual(
      rootOrderBy('minMs', 'desc').filter((path) => path.toLowerCase().includes('product')),
    );
    expect(sortedColumns()).toEqual(['Min:descending']);
    // The columns come from the whole payload, so a filter down to one row
    // cannot take a percentile column away with it.
    expect(headers()).toEqual(REFERENCE_HEADERS);
  });

  /** G-14 is a filter BOX: a real labelled control, not a placeholder. */
  it('is a labelled text control that shows what was typed', () => {
    renderTable();
    const box = screen.getByLabelText(/filter/i);
    expect(box.tagName).toBe('INPUT');
    typeFilter('Search');
    expect((box as HTMLInputElement).value).toBe('Search');
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
