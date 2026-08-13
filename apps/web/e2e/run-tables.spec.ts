import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * §13.2 ⑤ the statistics table and ⑥ the errors table, on the run detail page,
 * in a real browser.
 *
 * WHAT ONLY EXISTS HERE. The unit suites (`StatisticsTable.test.tsx`,
 * `ErrorsTable.test.tsx`, `buildTree.test.ts`) already pin the tree, the sort,
 * the filter, the columns and the shares against the captured fixture, in jsdom.
 * What they cannot reach is the MOUNT: that the run detail page fetches these
 * two payloads at all, that it puts both tables above the chart stack, that the
 * row links resolve to routes the router actually has, and that the accessible
 * names these tables were built around are the names a REAL ENGINE computes.
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
  await page.goto(`/runs/${runId}`);
  await expect(statisticsTable(page)).toBeVisible();
  return runId;
}

/* ======================================================================== *
 * 1. BOTH TABLES ARE THERE, ABOVE THE CHARTS, HOLDING EVERY ROW
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
  for (const name of ['List Products', 'Search', 'Place Order']) {
    await expect(page.getByRole('rowheader', { name, exact: true })).toBeVisible();
  }

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

  /* ---- both tables, ABOVE the chart stack (design §7, §10) ----
   *
   * Through the section headings rather than pixel positions, so this survives
   * any layout change that keeps the order. The charts are `<h3>`s inside
   * `Overview`, so the level-2 list is exactly the page's four sections.
   */
  await expect(errorsTable(page)).toBeVisible();
  expect(await page.getByRole('heading', { level: 2 }).allTextContents()).toEqual([
    'Assertions',
    'Statistics',
    'Errors',
    'Overview',
  ]);
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
   * context, at depth 0, with `Catalog/Recommendations` open underneath it. */
  expect(await renderedRows(page)).toEqual(['Catalog@0', 'Catalog/Recommendations@1']);
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

  await page.getByRole('link', { name: /List Products/ }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}/requests/List%20Products$`));
  // Piece 3 builds this page; today it must say so rather than 404.
  await expect(page.getByText(/not built yet|coming/i)).toBeVisible();
  // The row it came from, so the reader knows the placeholder is theirs.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('List Products');

  /* ---- and a GROUP row, which goes somewhere ELSE, by its FULL path ----
   *
   * "A link exists" proves nothing about where it goes, and neither does one
   * link resolving: a table that sent every row to `/requests/<leaf name>`
   * passes everything above. `Recommendations` alone does not identify
   * `Catalog/Recommendations`, and two groups under different parents may share
   * a leaf name — so the separator must arrive as DATA (`%2F`), in one segment,
   * or the route it lands on is one nobody wrote.
   */
  await page.goBack();
  await expect(statisticsTable(page)).toBeVisible();
  await page.getByRole('button', { name: /expand Catalog/i }).click();
  await page.getByRole('link', { name: 'Recommendations', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}/groups/Catalog%2FRecommendations$`));
  await expect(page.getByText(/not built yet|coming/i)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Catalog/Recommendations');

  /* The placeholder is a page of the app, not a dead end: it is inside the
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
  const expected = [
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

  // D-8: the errors table has three columns and no fourth.
  const errorHeaders = errorsTable(page).getByRole('columnheader');
  await expect(errorHeaders).toHaveText(['Error', 'Count', 'Percentage']);
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
  const runId = await openRun(page);
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
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/errors')) seen.push(`${url.pathname}${url.search}`);
  });

  await page.goto(`/runs/${runId}`);
  await expect(errorsTable(page)).toBeVisible();

  expect(seen).toEqual([`/v1/runs/${runId}/errors?scope=run&name=`]);
});
