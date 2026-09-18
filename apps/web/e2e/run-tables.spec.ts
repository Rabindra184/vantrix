import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedRunWithFailedAssertion } from './fixtures.js';
import { openTimeWindow, plot, signIn } from './helpers.js';
import { runErrorsPath, runPath } from '../src/routes/paths.js';

/**
 * §13.2 ⑤ the statistics table and ⑥ the errors table, on the run detail page,
 * in a real browser.
 *
 * WHAT ONLY EXISTS HERE. The unit suites (`StatisticsTable.test.tsx`,
 * `ErrorsTable.test.tsx`, `buildTree.test.ts`) already pin the tree, the sort,
 * the filter, the columns and the shares against the captured fixture, in jsdom.
 * What they cannot reach is the MOUNT: that the run detail page fetches these
 * two payloads at all, that the statistics table lives on the run's Overview
 * tab and the errors table on its own (design §6), that the row links resolve
 * to routes the router actually has, and that the accessible names these
 * tables were built around are the names a REAL ENGINE computes.
 * That last one is not a formality — task 6 measured that jsdom's
 * `dom-accessibility-api` consults a descendant's `aria-labelledby` but not its
 * `aria-label`, and browsers do not all agree. This file is the first time
 * Chromium computes them.
 *
 * EVERY EXPECTATION IS COMPUTED FROM THE API'S OWN PAYLOAD, fetched over the
 * session the test just signed in with (`payload` below), rather than written
 * down here. A re-captured fixture, or a project configured with different
 * percentiles, then moves the expectation with it instead of turning this file
 * red for a reason that is not a defect — the same rule the unit suites follow.
 *
 * DEVIATION D-10 IS RESOLVED AND THESE ASSERTIONS PIN THE RESOLUTION. The
 * engine joins a request's group path onto its name, so `List Products` is
 * `Catalog/List Products` and nests under `Catalog` exactly as Gatling's own
 * report nests it. `openingPaths` below derives the root set from the payload
 * rather than listing it, so the expectation moves with a re-captured fixture.
 */

/* ======================================================================== *
 * THE PAYLOADS — every expectation below is derived from these
 * ======================================================================== */

/** Only the fields these tests read. Deliberately NOT `@perfportal/contracts`:
 *  a test that re-uses the app's own types agrees with the app by construction,
 *  and what is being checked here is the wire. */
interface StatRowJson {
  readonly scope: 'run' | 'group' | 'request';
  readonly name: string;
  readonly family: string;
  readonly count: number;
  readonly percentiles: Record<string, number>;
}
interface StatsJson {
  readonly stats: readonly StatRowJson[];
}
interface ErrorsJson {
  readonly errors: readonly { readonly message: string; readonly count: number }[];
}
interface ErrorSeriesJson {
  /** `message: null` is the folded remainder, which is still a drawn series. */
  readonly series: readonly { readonly message: string | null }[];
}

/**
 * The run's own payload, read through the SAME session the browser is using —
 * `page.request` shares the context's cookie jar, so this is the reader's view
 * of the run, not a privileged one.
 */
async function payload<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.ok(), `GET ${path} → HTTP ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

const stats = (page: Page, runId: string) => payload<StatsJson>(page, `/v1/runs/${runId}/stats`);
const errors = (page: Page, runId: string) =>
  payload<ErrorsJson>(page, `/v1/runs/${runId}/errors?scope=run&name=`);
const errorSeriesPayload = (page: Page, runId: string) =>
  payload<ErrorSeriesJson>(page, `/v1/runs/${runId}/errors/series`);

/** `p99.9` → 99.9; a key naming no percentile → null. Written here rather than
 *  imported from `StatisticsTable`, so the code under test does not get to
 *  define what the test expects. */
const percentileIn = (key: string): number | null =>
  /^p\d+(?:\.\d+)?$/.test(key) ? Number(key.slice(1)) : null;

/** Every percentile key in the payload, ascending — the column set the table
 *  must render, and whose LAST entry is the column it must open sorted on. */
function percentileKeys(json: StatsJson): string[] {
  const keys = new Set<string>();
  for (const row of json.stats) for (const key of Object.keys(row.percentiles)) keys.add(key);
  return [...keys]
    .filter((key) => percentileIn(key) !== null)
    .sort((a, b) => percentileIn(a)! - percentileIn(b)!);
}

/** `p95` → `95th`. `StatisticsTable.percentileColumnLabel`'s rule, restated. */
const percentileLabel = (key: string): string => {
  const n = percentileIn(key)!;
  if (!Number.isInteger(n)) return `${key.slice(1)}th`;
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
};

/**
 * THE ROWS THE TABLE MUST OPEN WITH, derived from the payload.
 *
 * A row opens at root when its immediate parent path is not itself a group in
 * the payload — the same rule `buildTree` applies, deliberately restated from
 * the payload rather than imported, so a change to the tree's parenting has to
 * disagree with this file to pass.
 *
 * Post-D-10 the reference run opens with 2 root groups (`Catalog`, `Cart`) and
 * the 2 genuinely-rootless requests (`Search`, `Place Order`).
 * `Catalog/Recommendations` is a CHILD group and starts collapsed.
 */
function openingPaths(json: StatsJson): string[] {
  const groups = new Set(
    json.stats.filter((r) => r.scope === 'group').map((r) => r.name),
  );
  const paths = new Set<string>();
  for (const row of json.stats) {
    if (row.scope !== 'request' && row.scope !== 'group') continue;
    const cut = row.name.lastIndexOf('/');
    const parent = cut <= 0 ? null : row.name.slice(0, cut);
    if (parent === null || !groups.has(parent)) paths.add(row.name);
  }
  return [...paths];
}

/** The run-scope row, which is the table's totals row and not a tree row. */
const runRow = (json: StatsJson): StatRowJson => {
  const row = json.stats.find((r) => r.scope === 'run');
  expect(row, 'the payload carries no run-scope row').toBeDefined();
  return row!;
};

/* ======================================================================== *
 * OPENING A RUN
 * ======================================================================== */

const statisticsTable = (page: Page): Locator => page.getByRole('table', { name: /statistics/i });
const errorsTable = (page: Page): Locator => page.getByRole('table', { name: /errors/i });
const statRows = (page: Page): Locator => page.getByTestId('stat-row');
const rowAt = (page: Page, path: string): Locator =>
  page.locator(`[data-testid="stat-row"][data-path="${path}"]`);

/** The rendered body rows, in document order, as `path@depth`. */
const renderedRows = (page: Page): Promise<string[]> =>
  statRows(page).evaluateAll((nodes) =>
    nodes.map((n) => `${n.getAttribute('data-path')}@${n.getAttribute('data-depth')}`),
  );

const renderedPaths = (page: Page): Promise<string[]> =>
  statRows(page).evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-path') ?? ''));

async function openRun(page: Page): Promise<string> {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));
  await expect(statisticsTable(page)).toBeVisible();
  return runId;
}

/* ======================================================================== *
 * 1. THE STATISTICS TABLE HOLDS EVERY ROW; THE ERRORS TABLE IS ITS OWN TAB
 * ======================================================================== */

test('a completed run shows every request and group in one table', async ({ page }) => {
  const runId = await openRun(page);

  await expect(statisticsTable(page)).toBeVisible();

  /* ---- the brief's own assertion, with the ROLE the markup actually has ----
   *
   * The brief writes `getByRole('cell', { name })`. Measured: it cannot pass,
   * and not because the table is wrong. A row's name lives in
   * `<th scope="row">`, which Playwright resolves to `rowheader` (its
   * `roleUtils` maps `scope="row"` → rowheader before anything else), and
   * `getByRole('cell')` does not match a rowheader. The `<th>` is deliberate
   * and unit-tested — it is what makes "2503" mean something when a screen
   * reader announces it out of the row's context — so the ASSERTION moves.
   */
  // `Search` and `Place Order` are the two rows D-10 leaves genuinely leafy —
  // no toggle button inside their `<th>`. `Cart` and `Catalog` carry one (D-10
  // gives both real children), and are asserted the same way right below: the
  // `<th>` names itself via `aria-labelledby` (`StatisticsTable.tsx`'s `Row`),
  // so the toggle's own `aria-label` does not leak into the row's name.
  for (const name of ['Search', 'Place Order', 'Cart', 'Catalog']) {
    await expect(page.getByRole('rowheader', { name, exact: true })).toBeVisible();
  }

  /* ---- THE REGRESSION ALARM: a group row's name is its name, and only that ----
   *
   * `Cart` and `Catalog` are exactly the rows a name-from-content `<th>` gets
   * wrong: each holds an `aria-label`led expand button ALONGSIDE the `<Link>`
   * that renders the name, so a `<th>` left to compute its own name from its
   * contents announces "expand Cart Cart" in Chromium — measured, and the
   * defect this file exists to catch on the row axis, `SortableHeader`'s own
   * comment block having already caught it on the column axis. The loop above
   * would pass equally for a `<th>` named "expand Cart Cart, Cart" (a
   * substring match); `exact: true` on the plain name is what a concatenation
   * fails and a correct `aria-labelledby` passes, so it is restated here on
   * its own for that entire mutation class rather than folded silently into
   * the loop above. */
  await expect(page.getByRole('rowheader', { name: 'Catalog', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Cart', exact: true })).toBeVisible();
  // And the concatenation itself is confirmed absent, not merely un-matched:
  // "Cart" being found above is also true of a `<th>` named "Cart Extra", so
  // the exact negative is pinned too.
  await expect(page.getByRole('rowheader', { name: 'expand Cart Cart' })).toHaveCount(0);
  await expect(page.getByRole('rowheader', { name: 'expand Catalog Catalog' })).toHaveCount(0);

  /* ---- the discriminating form: EVERY row, from the payload ----
   *
   * Three names being visible is satisfied by a table holding only those
   * three, by one that renders each group twice (once per metric family), and
   * by one that renders nested rows expanded. Comparing the whole set against
   * the payload's own is satisfied by none of them.
   */
  const json = await stats(page, runId);
  const expected = openingPaths(json);
  expect(expected.length, 'the reference run should open with 2 root groups + 2 root requests').toBe(4);
  expect((await renderedPaths(page)).slice().sort()).toEqual(expected.slice().sort());

  // Every OPENING row is a root row: children exist now (D-10 nests five of the
  // seven requests) and start collapsed, so none of them is on screen yet.
  const depths = await statRows(page).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('data-depth')),
  );
  expect(new Set(depths)).toEqual(new Set(['0']));

  /* ---- the totals row: present, named, and NOT one of the tree rows ---- */
  const total = page.getByTestId('stat-row-total');
  await expect(total).toBeVisible();
  await expect(total.getByRole('rowheader')).toHaveText('All Requests');
  await expect(total.locator('[data-column="count"]')).toHaveAttribute(
    'data-value',
    String(runRow(json).count),
  );
  // It is a row of the table, not a row of the tree: nothing in the sortable
  // body carries the run scope, or the reader would add the run's own totals
  // into their sum of the rows.
  await expect(page.locator('[data-testid="stat-row"][data-scope="run"]')).toHaveCount(0);

  /* ---- the Overview tab's sections, in order (design §6, Appendix A G-05) ----
   *
   * Through the section headings rather than pixel positions, so this survives
   * any layout change that keeps the order. Errors and the eight charts moved
   * to their own tabs; `Overview`'s own `<h2>` went with the split, deleted
   * rather than left behind, since a tab named Overview directly above a
   * heading that said Overview would say it twice.
   *
   * `Simulation assertions` joined the list with G-05. It is a SEPARATE section
   * from `Platform gates` on purpose and the two must not be collapsed: the
   * first is this platform's SLA rules, which a project configures and the
   * 200/422 verdict gates on; the second is what the load test itself
   * declared, fixed at run time and able to express comparisons (`between`,
   * `in`) the SLA comparator set has no member for.
   *
   * BOTH WERE CALLED "ASSERTIONS" UNTIL REVIEW N01, which is the drift that
   * finding names. Only the platform's moved: `Simulation assertions` keeps
   * its word because that word is right — the PRD gives "Assertions table" to
   * G-05, the tool's own feature.
   *
   * It appears here because this run was ingested through the real pipeline, so
   * the plugin decoded the reference simulation's own assertions. A run seeded
   * without that path carries `null` and draws no section at all — which is
   * deliberately distinct from `[]`, "the simulation declared none".
   */
  expect(await page.getByRole('heading', { level: 2 }).allTextContents()).toEqual([
    'Platform gates',
    'Simulation assertions',
    'Statistics',
  ]);

  /* ---- and the errors table is one tab away, not a second scroll down ---- */
  await page.goto(runErrorsPath(runId));
  await expect(errorsTable(page)).toBeVisible();
  expect(await page.getByRole('heading', { level: 2 }).allTextContents()).toEqual(['Errors']);
});

/* ======================================================================== *
 * 2. GROUPS START COLLAPSED, AND THE TOGGLE REALLY TOGGLES
 * ======================================================================== */

test('a group expands to its children and collapses again', async ({ page }) => {
  await openRun(page);

  const parent = rowAt(page, 'Catalog');
  const child = rowAt(page, 'Catalog/Recommendations');

  /* `toHaveCount(0)` on the child is satisfied by a table that rendered
   * NOTHING AT ALL, so the parent's presence is asserted first, every time the
   * child's absence is. That is the whole difference between this test and the
   * brief's. */
  await expect(parent).toBeVisible();
  await expect(child).toHaveCount(0);
  await expect(page.getByText('Recommendations')).toHaveCount(0);

  const toggle = page.getByRole('button', { name: /expand Catalog/i });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  await expect(child).toBeVisible();
  await expect(page.getByText('Recommendations')).toBeVisible();
  // A CHILD, not a row that happened to appear: at depth 1, directly beneath
  // its parent. An implementation that appended matches to the end of the
  // table would satisfy "is visible" and fail this.
  await expect(child).toHaveAttribute('data-depth', '1');
  const rows = await renderedRows(page);
  expect(rows[rows.indexOf('Catalog@0') + 1]).toBe('Catalog/Recommendations@1');
  await expect(page.getByRole('button', { name: /collapse Catalog/i })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await page.getByRole('button', { name: /collapse Catalog/i }).click();
  await expect(child).toHaveCount(0);
  await expect(page.getByText('Recommendations')).toHaveCount(0);
  await expect(parent).toBeVisible();
});

/* ======================================================================== *
 * 3. FILTERING KEEPS THE MATCH IN ITS GROUP
 * ======================================================================== */

test('filtering keeps the match in its group', async ({ page }) => {
  await openRun(page);
  const opening = await renderedRows(page);

  const filter = page.getByLabel(/filter/i);
  await filter.fill('Recommend');

  await expect(page.getByText('Catalog', { exact: true })).toBeVisible();
  await expect(page.getByText('List Products')).toHaveCount(0);

  /* THE MATCH ITSELF. The brief's version checks that the ANCESTOR survived and
   * that a non-match went away — both of which a filter that dropped the match
   * and kept its parent would also satisfy. The rendered set, whole, is what
   * says the filter answered the question that was asked: `Catalog` kept for
   * context, at depth 0, with `Catalog/Recommendations` open underneath it —
   * and, while filtering runs, `Recommendations`' own child (`Related Items`,
   * nested one level further down post-D-10) is open too, since a matching
   * row's whole subtree is visible along with it. */
  expect(await renderedRows(page)).toEqual([
    'Catalog@0',
    'Catalog/Recommendations@1',
    'Catalog/Recommendations/Related Items@2',
  ]);
  await expect(rowAt(page, 'Catalog/Recommendations')).toBeVisible();

  /* A filter that matches nothing says so, rather than going silently empty. */
  await filter.fill('no-such-request');
  await expect(statRows(page)).toHaveCount(0);
  await expect(page.getByText(/no rows match this filter/i)).toBeVisible();

  /* Clearing it hands the tree back EXACTLY as the reader left it — including
   * `Catalog` closed again, because the filter opened it and the reader never
   * did. */
  await filter.fill('');
  expect(await renderedRows(page)).toEqual(opening);
});

/* ======================================================================== *
 * 4. A ROW LINKS TO ITS DETAIL PAGE
 * ======================================================================== */

test('a row links to its detail page', async ({ page }) => {
  const runId = await openRun(page);

  // `List Products` is `Catalog/List Products` post-D-10, nested under a
  // group that starts collapsed.
  await page.getByRole('button', { name: /expand Catalog/i }).click();
  await page.getByRole('link', { name: /List Products/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}/requests/Catalog%2FList%20Products$`));
  // Piece 3 built this page for real (see request-detail.spec.ts, which
  // exercises it in full); this test only needs to confirm the ROW's link
  // actually resolves to the right request, by its full path.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Catalog/List Products');

  /* ---- and a GROUP row, which goes somewhere ELSE, by its FULL path ----
   *
   * "A link exists" proves nothing about where it goes, and neither does one
   * link resolving: a table that sent every row to `/requests/<leaf name>`
   * passes everything above. `Recommendations` alone does not identify
   * `Catalog/Recommendations`, and two groups under different parents may share
   * a leaf name — so the separator must arrive as DATA (`%2F`), in one segment,
   * or the route it lands on is one nobody wrote.
   *
   * Piece 5 built this page for real (see group-detail.spec.ts, which
   * exercises it in full, including a hard `page.goto()` load of this exact
   * encoded path); this test only needs to confirm the ROW's link actually
   * resolves to the right group, by its full path.
   */
  await page.goBack();
  await expect(statisticsTable(page)).toBeVisible();
  await page.getByRole('button', { name: /expand Catalog/i }).click();
  await page.getByRole('link', { name: 'Recommendations', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}/groups/Catalog%2FRecommendations$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Catalog/Recommendations');

  /* The group page is a page of the app, not a dead end: it is inside the
   * signed-in shell and offers the way back. */
  await page.getByRole('link', { name: /back to (this|the) run/i }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(statisticsTable(page)).toBeVisible();
});

/* ======================================================================== *
 * 5. THE COLUMNS, AND THE NAMES A REAL ENGINE COMPUTES FOR THEM
 * ======================================================================== */

test('the column headings are the payload’s own, and name themselves in Chromium', async ({
  page,
}) => {
  const runId = await openRun(page);
  const json = await stats(page, runId);
  const keys = percentileKeys(json);
  expect(keys.length, 'the reference run configures four percentiles').toBe(4);

  const table = statisticsTable(page);

  /* ═══ THE DEFAULT SET, NOT EVERY MEASURE (review M11) ═══
   *
   * This used to assert all fifteen columns. The table opens on eight now —
   * what happened, what failed, how often, how fast at the ranks anybody
   * quotes — with the rest behind a picker. Nothing was removed; the CSV
   * export still carries every column.
   *
   * `99.9th` rides along because `worstFirstColumn` opens the table sorted by
   * the HIGHEST percentile the payload configures, and a column the table
   * sorts by must be visible. The reference run configures four, so the
   * default shows 50th, 95th, 99th and whichever is worst — which for this
   * payload is the fourth.
   *
   * The negative below is unchanged and still the load-bearing half: a
   * percentile the payload does NOT configure gets no column, whether or not
   * the picker could otherwise offer it. */
  const worst = keys.map(percentileLabel).at(-1)!;
  const defaults = ['50th', '95th', '99th'].filter((p) => keys.map(percentileLabel).includes(p));
  const expected = [
    'Requests',
    'Executions',
    'Response Time (ms)',
    'Total',
    'KO',
    '% KO',
    'Cnt/s',
    ...Array.from(new Set([...defaults, worst])),
    'Max',
  ];

  /* THE ACCESSIBLE NAME OF EVERY HEADER, computed by Chromium rather than by
   * jsdom. Task 6 measured that a descendant's `aria-labelledby` IS consulted
   * by `dom-accessibility-api` while its `aria-label` is NOT — which is why
   * each `<th>` names itself explicitly via `aria-labelledby` pointing at the
   * span that renders the label. If a browser computed these differently, the
   * column set would silently become "Sort by 95th" and §9 checkpoint 6's
   * negative (`queryByRole('columnheader', { name: /^95th$/ })` being null for
   * a payload without p95) would be null for every implementation. */
  for (const name of expected) {
    await expect(
      table.getByRole('columnheader', { name, exact: true }),
      `columnheader named ${JSON.stringify(name)}`,
    ).toHaveCount(1);
  }
  await expect(table.getByRole('columnheader')).toHaveCount(expected.length);
  // Not one of them is named after the ACTION its control performs.
  await expect(table.getByRole('columnheader', { name: /sort by/i })).toHaveCount(0);
  // A percentile the payload does not configure gets no column.
  await expect(table.getByRole('columnheader', { name: '99.9th', exact: true })).toHaveCount(0);

  /* ═══ AND THE PICKER REVEALS THE REST, WHICH IS THE OTHER HALF ═══
   *
   * The set above is a default, not a ceiling — nothing was deleted. Ticking
   * every box restores exactly the fifteen columns this test asserted before
   * M11, so the old coverage is still here and now sits behind the disclosure.
   *
   * The negative survives the reveal too, and that is the point of repeating
   * it: `99.9th` is absent because the PAYLOAD does not configure it, not
   * because a checkbox is unticked. A picker built from a hard-coded column
   * list would offer it and fail here. */
  const picker = page.getByTestId('column-picker');
  await picker.locator('summary').click();
  for (const box of await picker.getByRole('checkbox').all()) {
    if (!(await box.isChecked())) await box.check();
  }

  const everything = [
    'Requests',
    'Executions',
    'Response Time (ms)',
    'Total',
    'OK',
    'KO',
    '% KO',
    'Cnt/s',
    'Min',
    ...keys.map(percentileLabel),
    'Max',
    'Mean',
    'Std Dev',
  ];
  for (const name of everything) {
    await expect(
      table.getByRole('columnheader', { name, exact: true }),
      `columnheader named ${JSON.stringify(name)} once every box is ticked`,
    ).toHaveCount(1);
  }
  await expect(table.getByRole('columnheader')).toHaveCount(everything.length);
  await expect(table.getByRole('columnheader', { name: '99.9th', exact: true })).toHaveCount(0);

  // D-8: the errors table has three columns and no fourth — its own tab now.
  //
  // `Share of errors`, not `Percentage` (review 09-13 M15): a bare "Percentage"
  // needed a paragraph underneath to say percentage OF WHAT, and the column
  // that needs a footnote to be read is the column that is named wrong.
  await page.goto(runErrorsPath(runId));
  const errorHeaders = errorsTable(page).getByRole('columnheader');
  await expect(errorHeaders).toHaveText(['Error', 'Count', 'Share of errors']);
});

/* ======================================================================== *
 * 6. THE TABLE OPENS WORST-FIRST (§9 checkpoint 3, non-numeric)
 * ======================================================================== */

test('the table opens sorted worst-first, on the highest percentile the payload configures', async ({
  page,
}) => {
  const runId = await openRun(page);
  const json = await stats(page, runId);
  const keys = percentileKeys(json);
  const worst = percentileLabel(keys[keys.length - 1]!);

  /* WHICH column, and WHICH WAY — the two facts a numeric assertion cannot
   * see. `aria-sort` is the table's own claim, and it is read from the header
   * whose accessible name is the highest configured percentile, so a
   * hard-coded `p99` in a project configured otherwise fails here. */
  const table = statisticsTable(page);
  await expect(table.getByRole('columnheader', { name: worst, exact: true })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  const sorted = await table
    .getByRole('columnheader')
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => (n.getAttribute('aria-sort') ?? 'none') !== 'none')
        .map((n) => n.textContent ?? ''),
    );
  expect(sorted, 'exactly one column claims to be the sorted one').toHaveLength(1);

  /* And the ROWS agree with the claim: non-increasing down that column. A table
   * that says `aria-sort="descending"` over ascending rows passes every
   * assertion above. */
  const column = keys[keys.length - 1]!;
  const values = await statRows(page).evaluateAll(
    (nodes, col) =>
      nodes.map((n) => Number(n.querySelector(`[data-column="${col}"]`)?.getAttribute('data-value'))),
    column,
  );
  expect(values.length).toBeGreaterThan(1);
  expect(values.some(Number.isNaN)).toBe(false);
  expect(values).toEqual([...values].sort((a, b) => b - a));
  // Not a table that is merely non-increasing because every value is equal.
  expect(new Set(values).size).toBeGreaterThan(1);

  /* Clicking that same heading REVERSES it — proof the opening direction was a
   * decision and not the only thing this table can do. */
  await page.getByRole('button', { name: `Sort by ${worst}` }).click();
  await expect(table.getByRole('columnheader', { name: worst, exact: true })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  const reversed = await statRows(page).evaluateAll(
    (nodes, col) =>
      nodes.map((n) => Number(n.querySelector(`[data-column="${col}"]`)?.getAttribute('data-value'))),
    column,
  );
  expect(reversed).toEqual([...values].reverse());
});

/* ======================================================================== *
 * 7. THE ERRORS TABLE — SHARES OF THE RUN TOTAL (§9 checkpoint 5)
 * ======================================================================== */

test('the errors table shows each distinct error as a share of the run’s failures', async ({
  page,
}) => {
  // Not `openRun`: that helper lands on Overview, where the errors table
  // no longer is (design §6) — this test is about the errors table alone,
  // so it goes straight to its own tab.
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));
  await expect(errorsTable(page)).toBeVisible();

  const json = await errors(page, runId);
  expect(json.errors.length, 'the reference run records two distinct errors').toBe(2);
  const total = json.errors.reduce((sum, row) => sum + row.count, 0);

  const rows = page.getByTestId('error-row');
  await expect(rows).toHaveCount(json.errors.length);

  const rendered = await rows.evaluateAll((nodes) =>
    nodes.map((n) => ({
      message: n.querySelector('[data-column="message"]')?.textContent ?? '',
      count: n.querySelector('[data-column="count"]')?.getAttribute('data-value') ?? '',
      share: n.querySelector('[data-column="share"]')?.getAttribute('data-value') ?? '',
      shareText: n.querySelector('[data-column="share"]')?.textContent ?? '',
    })),
  );

  // The API's order, most frequent first, not re-sorted in the browser.
  expect(rendered.map((r) => r.message)).toEqual(json.errors.map((e) => e.message));
  expect(rendered.map((r) => r.count)).toEqual(json.errors.map((e) => String(e.count)));

  /* EACH SHARE AGAINST THE RUN TOTAL, ROW BY ROW. "They sum to 100" alone is
   * green for a table that SWAPPED the two shares, for one that split evenly,
   * and for one that showed each row's complement — task 7 measured all three.
   * The per-row identity is green for none of them, because the reference run's
   * two counts differ (15 and 9). */
  for (const [i, row] of rendered.entries()) {
    const expectedShare = (json.errors[i]!.count * 100) / total;
    expect(Number(row.share), `share of ${JSON.stringify(row.message)}`).toBeCloseTo(
      expectedShare,
      9,
    );
    expect(row.shareText).toBe(`${Number(expectedShare.toFixed(2))}%`);
  }
  expect(rendered.reduce((sum, r) => sum + Number(r.share), 0)).toBeCloseTo(100, 9);

  // The denominator the caption names is the one the shares were divided by —
  // failures, not requests. 24 of 895 requests failed here; a reader who reads
  // 62.5% as a share of requests is out by a factor of thirty-seven.
  await expect(errorsTable(page).locator('caption')).toContainText(`${total} errors`);
});

/* ======================================================================== *
 * 8. THE URL THE ERRORS TABLE IS FED BY
 * ======================================================================== */

test('the errors payload is fetched run-scoped, spelled exactly as the fixture captured it', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  /* `scripts/capture-chart-fixture.mjs` captured `reference-run.json` with the
   * literal string asserted below. If `api/metrics.ts` and that script diverge,
   * the fixture every unit test in this sub-project runs against stops being
   * what the browser receives — and nothing else in the repo would notice. The
   * duplication is real and recorded as follow-up; this at least makes the app
   * half of it observable.
   *
   * The `?scope=run&name=` is asserted because the captured fixture was taken
   * with exactly this string, so the two staying identical is what makes the
   * fixture what the browser receives.
   *
   * It is NOT asserted because the unscoped form is dangerous — measured, it is
   * not: `MetricsController.errors` sets `name` to `''` when `scope` is
   * omitted, and the reader's SQL is unconditionally scoped, so `/errors` and
   * `/errors?scope=run&name=` are identical. The real trap is the inverse —
   * `?name=X` WITHOUT `scope` is silently ignored and returns the run totals. */
  // `startsWith('/v1/')` as well as `endsWith('/errors')`, now that the PAGE's
  // own route is `/runs/:id/errors` (design §3) — a filter on the suffix
  // alone would also catch the document navigation below and put a second,
  // wrong entry in `seen`.
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/v1/') && url.pathname.endsWith('/errors')) {
      seen.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto(runErrorsPath(runId));
  await expect(errorsTable(page)).toBeVisible();

  expect(seen).toEqual([`/v1/runs/${runId}/errors?scope=run&name=`]);
});

/* ======================================================================== *
 * ERRORS OVER TIME — the chart above the table
 * ======================================================================== */

test('the errors tab draws failures over time above the table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  const figure = page.getByTestId('chart-errors-over-time');
  // EXACTLY ONE svg in the PLOT. Scoped to `[data-chart-canvas]`, so the
  // figure's own header icons are not in the count — see `helpers.ts`.
  await expect(plot(figure)).toHaveCount(1);

  // The table is still below it, holding every message rather than five.
  await expect(errorsTable(page)).toBeVisible();
});

test('it draws a series per message the payload really carries', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  // DERIVED FROM THE ENDPOINT THE CHART ACTUALLY DRAWS, not from the flat
  // `/errors` table beside it. Two things make the flat payload the wrong
  // source, and `Math.min(…, 5)` was papering over both:
  //
  //   - It EXCLUDES WARM-UP and this series includes it, so on a project with
  //     a warm-up window the two disagree about which messages exist at all.
  //   - It cannot represent the folded remainder. A run with more than five
  //     distinct messages draws SIX series — five named plus `Other errors` —
  //     and a count capped at five would fail on a perfectly valid re-capture.
  //
  // The drawn series count is just the payload's series count.
  const body = await errorSeriesPayload(page, runId);
  const expected = body.series.length;
  expect(expected, 'the reference run has no failures to draw').toBeGreaterThan(0);

  // `Chart` draws no legend below two series — "a one-entry legend is a label
  // pretending to be a control" — so the legend can only be counted when the
  // run really has two or more distinct messages.
  const legend = page.getByTestId('chart-errors-over-time').locator('svg text[text-anchor="start"]');
  await expect(legend).toHaveCount(expected > 1 ? expected : 0);
});

test('the errors chart carries its data table, like every other chart', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  // The parity surface, and the screen-reader route to the same numbers.
  await expect(page.getByTestId('chart-data-errors-over-time')).toHaveCount(1);
});

/**
 * REVIEW M01 — THE NUMBERS BEFORE THE NARRATIVE.
 *
 * Measured at 1440x900 before this change: the run's own totals began at
 * y=1570 and the statistics table at y=1745, behind two assertion sections. An
 * engineer opening a run to ask "how fast was it, and did anything break"
 * scrolled past everything that answers neither.
 *
 * Two assertions, because they fail for different reasons. ORDER is the fix
 * and cannot regress silently — the tiles contribute no heading, so the
 * heading-outline case above cannot see them. GEOMETRY is the measure of
 * whether the fix was enough.
 *
 * THE THRESHOLD IS WHAT WAS ACHIEVED, NOT WHAT THE REVIEW ASKED FOR, and the
 * difference is deliberate. Reordering and shortening the brush took the
 * totals from y=1570 to y=1001. Getting them inside a 900px window needs the
 * decision band — 313px of it at this width — to become materially shorter,
 * which trades against the three separate outcomes C02 put there and against
 * the redesign's choice to make the verdict the largest text on the page.
 * That is a design decision, not a defect, so this guards the ground gained
 * rather than failing on ground nobody has agreed to take.
 */
test('the run totals come before the assertions, and near the top', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(runPath(runId));

  const totals = page.getByRole('region', { name: 'Run totals' });
  await expect(totals).toBeVisible();

  /* ORDER: the numbers precede the platform gates in the document.

     THE HEADING TEXT IS LOAD-BEARING HERE AND FAILS LOUDLY, which is why it is
     safe: `find` returns undefined for a heading that has been renamed, the
     guard returns null, and `expect(null).toBe(true)` fails with the stale
     string visible. Contrast the `not.toContain` guard in `run-charts.spec.ts`,
     which goes vacuously green on the same rename. */
  const totalsFirst = await page.evaluate(() => {
    const t = document.querySelector('section[aria-label="Run totals"]');
    const headings = Array.from(document.querySelectorAll('h2'));
    const gates = headings.find((h) => h.textContent?.trim() === 'Platform gates');
    if (!t || !gates) return null;
    // 4 === DOCUMENT_POSITION_FOLLOWING: `gates` comes after `t`.
    return (t.compareDocumentPosition(gates) & 4) !== 0;
  });
  expect(totalsFirst).toBe(true);

  /* ═══ GEOMETRY: M01's OWN BAR, AT LAST ═══
   *
   * The review asks for failure, p95, error rate and throughput inside the
   * first 1440x900 screen. The history of this number is the point:
   *
   *     1570  before the Overview was reordered
   *     1001  after the reorder shortened the brush to a navigator
   *      937  after C01 took the decision band from 316px to 246px
   *      649  after M01 collapsed the time window (332px -> 44px)
   *
   * It was 1100 for three branches — deliberately the MEASUREMENT rather than
   * the goal, because a threshold set to an unmet bar is a failing test
   * describing work nobody had agreed to do. The bar is cleared now, so the
   * bound is the bar: the run's own totals begin inside the viewport, and the
   * assertion below checks the TILES too, since a section that starts at 880
   * with its values at 980 would satisfy a bound on the section alone.
   */
  const top = await totals.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeLessThan(900);

  for (const id of ['stat-error-rate', 'stat-throughput', 'stat-p95']) {
    const y = await page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(y, `${id} is below the fold at 1440x900`).toBeLessThan(900);
  }
});

/**
 * REVIEW M01 / M10 — FAILED CHECKS FIRST, THE REST BEHIND A DISCLOSURE.
 *
 * The list was in the tool's own order, so the parity run showed two PASSING
 * checks above its failing one. The reader's question is "what broke".
 */
test('simulation assertions lead with the failures', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const outcomes = page.getByTestId('tool-assertion-outcome');
  await expect(outcomes.first()).toBeVisible();

  // Whatever is on screen at rest is the failure, not a passing check above it.
  expect(await outcomes.first().textContent()).toMatch(/failed/i);

  // And the rest are one click away, counted rather than merely hinted at.
  const toggle = page.getByTestId('tool-assertions-toggle');
  await expect(toggle).toBeVisible();
  const before = await outcomes.count();
  await toggle.click();
  expect(await outcomes.count()).toBeGreaterThan(before);
});

/**
 * ═══ REVIEW 09-13 M13 — THE FAILING CHECK IS A ROUTE TO THE EVIDENCE ═══
 *
 * WHY THIS IS NOT COVERED BY `ToolAssertions.test.tsx`. That suite builds both
 * sides of the join by hand: a `details` path spelling `Search`, and a stats
 * fixture holding a request called `Search`. It proves the component links
 * what it is told to link and cannot prove the two agree in the real world —
 * exactly the "a test that supplies the value it is checking" trap CLAUDE.md
 * records costing this project a whole feature that never worked.
 *
 * Here the path comes out of a REAL simulation.log, decoded by the plugin
 * during a real ingest, and the request name comes out of the statistics
 * engine that read the same file. Nothing in this test writes either one down.
 * If the decoder ever joined its parts differently from the way the engine
 * names a row — a space around the separator is all it would take — this is
 * the only place that would notice.
 */
test('a failing simulation check leads to the request it is about', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const failing = page.getByTestId('tool-assertion-row').first();
  await expect(failing.getByTestId('tool-assertion-outcome')).toContainText(/failed/i);

  // The Target cell, which was plain text: the reader could read the name of
  // the request that broke and had nowhere to go with it.
  const target = failing.getByRole('link');
  await expect(target).toHaveCount(1);
  const name = (await target.textContent())?.trim() ?? '';
  expect(name).not.toBe('');

  await target.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}/requests/`));

  /* AND THE PAGE IT REACHES IS ABOUT THAT REQUEST.
   *
   * The two spellings are the assertion. The cell READS `Cart / Add To Cart`,
   * because a path is easier to scan with air in it; the row is ADDRESSED as
   * `Cart/Add To Cart`, which is what `rowFor` keys on and what `buildTree`
   * splits — and `RequestDetail`'s `<h1>` renders the URL parameter verbatim.
   * A link built from the displayed label would still satisfy the URL check
   * above and land on a page that says it found no such request. */
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name.replace(/ \/ /g, '/'));
});

/**
 * ═══ A DRILL-DOWN CARRIES THE WINDOW AND CANNOT HONOUR IT ═══
 * (the 09-13 review's acceptance list: "selected-window versus whole-run evidence")
 *
 * The request and group pages keep `from`/`to` deliberately — a reader arrives
 * from a windowed table, and sending them back to an un-narrowed run would
 * discard the selection they were investigating with. But their endpoints take
 * no `from`/`to`: the figures are the run's, whatever the address bar says.
 *
 * So the window was visible in the URL, visible on the page they came from,
 * and silently did not apply. `ErrorsTable` already corrects this for its own
 * totals — and the drill-down was the ONE call site that never passed
 * `windowSelected`, so the identical table under the identical window
 * explained itself on the run page and said nothing here.
 */
test('a windowed drill-down says its figures are the whole run’s', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // WITHOUT a window first: there is nothing to disclaim, and a permanent
  // notice on a page whose figures are always whole-run is the
  // over-explanation review N04 spent four rows removing.
  await page.goto(`${runPath(runId)}/requests/${encodeURIComponent('Search')}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('whole-run-notice')).toHaveCount(0);

  await page.goto(`${runPath(runId)}/requests/${encodeURIComponent('Search')}?from=0&to=10000`);
  const notice = page.getByTestId('whole-run-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/does not narrow/i);
  await expect(notice).toContainText(/whole run/i);

  /* AND THE ERRORS TABLE SAYS IT FOR ITS OWN TOTALS, which is the half that
     was missing from this call site alone. Both, because the page-level notice
     is about the page's figures and this one is about a number the reader is
     looking straight at. */
  await expect(page.getByTestId('errors-window-note')).toContainText(/whole run/i);

  /* AND THE GROUP DRILL-DOWN, which is the same shape and a DIFFERENT wiring.
     Both pages render the shared `WholeRunNotice`, so what this catches is the
     half a shared component cannot guarantee: that the page actually mounts it
     under a window. Asserted without a window too, for the same reason as
     above — the notice must not become permanent furniture. */
  await page.goto(`${runPath(runId)}/groups/Cart`);
  await expect(page.getByTestId('whole-run-notice')).toHaveCount(0);

  await page.goto(`${runPath(runId)}/groups/Cart?from=0&to=10000`);
  await expect(page.getByTestId('whole-run-notice')).toContainText(/does not narrow/i);
});

/**
 * The Errors tab's request filter (review 09-13 M15).
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE IS THE SEAM. `errorRequestFilter.test.ts`
 * pins which names the derivation offers, from a payload it writes itself — so
 * it proves the rule and nothing about whether the API ever produces those
 * rows. That join is the whole finding: the mapping was always stored
 * (`run_error.scope` / `.name`) and `?scope=request&name=` always worked, and
 * only the tab never asked. A test that supplies both sides would prove the
 * consumer and never the seam.
 *
 * So this drives the real control against a real run and checks the table
 * CHANGED — a filter that rewrites the URL and returns the same rows is the
 * failure worth catching, and asserting "the select has options" would miss
 * it entirely.
 */
test('the errors table can be narrowed to the request that failed', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runErrorsPath(runId));

  const filter = page.getByTestId('errors-request-filter');
  await expect(filter).toBeVisible();

  // Only the requests that actually failed — the reference run makes seven and
  // two of them fail, so this is also the derivation's own claim proven against
  // data nobody hand-wrote.
  expect(await filter.locator('option').allTextContents()).toEqual([
    'All requests',
    'Cart/Add To Cart',
    'Place Order',
  ]);

  const unfiltered = await errorsTable(page).getByRole('row').allTextContents();
  expect(unfiltered.length).toBeGreaterThan(2); // header + both messages

  await filter.selectOption('Cart/Add To Cart');

  // The URL carries the question, so the view is shareable — the lesson
  // `RunCompare` records for its metric.
  await expect(page).toHaveURL(/[?&]request=Cart%2FAdd\+To\+Cart/);

  // And the rows really narrowed. `Place Order`'s failure is a 503 and
  // `Cart/Add To Cart`'s a 500, so the filtered table must hold one and not the
  // other — checked by CONTENT rather than by row count, which a re-render
  // could satisfy without filtering anything.
  const filtered = errorsTable(page).getByRole('row');
  await expect(filtered).toHaveCount(2); // header + the one message
  await expect(filtered.nth(1)).toContainText('found 500');
  await expect(errorsTable(page)).not.toContainText('found 503');

  // Back out again — a filter a reader cannot escape is worse than none.
  await filter.selectOption('');
  await expect(page).not.toHaveURL(/[?&]request=/);
  await expect(errorsTable(page)).toContainText('found 503');
});

/**
 * ═══ A VERDICT AND A STATISTIC, SIDE BY SIDE, IN DIFFERENT SCOPES ═══
 *
 * The evidence-window-scope branch fixed one mistake made three times -- a
 * number the window narrowed under wording that still described the whole run
 * -- and the two evidence SECTIONS were the fourth. Platform gates and
 * simulation assertions are decided once, at finalize, over the whole run; the
 * statistics above them are re-read per window. A reader narrowing to a healthy
 * stretch saw a windowed p95 beside a whole-run FAILED gate whose actual
 * appears nowhere on their screen.
 *
 * WHAT ONLY A BROWSER PROVES. `ToolAssertions.test.tsx` hands the tab a window
 * through a stand-in for the shell's `<Outlet context>`, so it can only show
 * the section renders what it is given. Whether the REAL shell's brush delivers
 * a window to this tab is a different question -- the "a test that writes both
 * sides of a join proves neither" rule this repo already records for M13's
 * Target link.
 *
 * Both states are asserted, because the notice is withheld without a window and
 * an assertion on the windowed state alone passes against one rendered always.
 */
test('the evidence sections say their verdicts are the whole run’s under a window', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithFailedAssertion(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  // The gate is on screen and there is nothing to disclaim yet.
  await expect(page.getByRole('heading', { name: 'Platform gates' })).toBeVisible();
  await expect(page.getByTestId('finalized-verdict-notice')).toHaveCount(0);

  await openTimeWindow(page);
  await page.getByTestId('window-from').fill('0');
  await page.getByTestId('window-to').fill('10');
  await page.getByTestId('window-apply').click();
  await expect(page).toHaveURL(/[?&]from=0/);

  // The window reached the tab, and the gate says which scope it belongs to.
  const notices = page.getByTestId('finalized-verdict-notice');
  await expect(notices.first()).toBeVisible();
  await expect(notices.first()).toContainText(/decided when the run finished, against the whole run/);
});
