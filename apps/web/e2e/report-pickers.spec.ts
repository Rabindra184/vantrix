import { expect, test, type Locator, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { openLiveRun, seedAdmin, seedRunWithData } from './fixtures.js';
import { apiJson, openSection, plot, signIn } from './helpers.js';
import { runReportPath } from '../src/routes/paths.js';

/**
 * The Report's pickers in a real browser — the Requests section's Group and
 * Request, and Virtual users' Scenario
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md, section 9).
 *
 * WHAT ONLY EXISTS HERE. `RunReport.test.tsx` proves which read each chart
 * makes under a pick, against `fetch` stubs it writes itself, so it proves the
 * page asks for what it is told and nothing about the seam: that the API
 * answers a group read with the group's merged buckets, that the chart draws
 * THAT answer, and that a real router keeps the pick, the window and the open
 * section across a reload and a fresh load of a shared link. Every number below
 * is the API's own answer to the same read the chart makes, fetched through the
 * page's own session (`apiJson`), never written down.
 *
 * THE DATA TABLE IS THE PARITY SURFACE, as `run-charts.spec.ts` argues: each
 * chart's table is in the DOM from first paint (merely `hidden`), and its cells
 * carry the unrounded value as `data-value`, so a table read compares exact
 * numbers without opening anything.
 *
 * The reference bundle (`seedRunWithData`) has the shape every case leans on:
 * groups `Cart`, `Catalog` and `Catalog/Recommendations`, requests in each and
 * two in no group (`Search`, `Place Order`), and scenarios `Browse` and
 * `Checkout`. `Catalog/Recommendations` holds one request, which is what the
 * one-request case needs; each premise is asserted where a case uses it.
 */

/* ======================================================================== *
 * Locators
 * ======================================================================== */

/** Each picker's own box (`RequestsPickers`): two "this link named…" notes can
 *  show at once, so every query is scoped to the control it means. */
const groupPicker = (page: Page): Locator => page.getByTestId('requests-group-picker');
const requestPicker = (page: Page): Locator => page.getByTestId('requests-request-picker');
const scenarioPicker = (page: Page): Locator => page.getByTestId('users-scenario-picker');

/** `exact: true` because Playwright matches a name as a case-insensitive
 *  substring, and the section holds other controls with these words in them. */
const groupSelect = (page: Page): Locator => groupPicker(page).getByLabel('Group', { exact: true });
const requestSelect = (page: Page): Locator => requestPicker(page).getByLabel('Request', { exact: true });
const scenarioSelect = (page: Page): Locator => scenarioPicker(page).getByLabel('Scenario', { exact: true });

/**
 * One query parameter of the page's current URL, PARSED. `useRequestsPick`
 * writes through `URLSearchParams`, which spells a space `+` rather than
 * `%20`; the two read back identically, so a check compares what the URL
 * means rather than how it is spelled.
 */
const param = (page: Page, key: string): string | null => new URL(page.url()).searchParams.get(key);
const hash = (page: Page): string => new URL(page.url()).hash;

/* ======================================================================== *
 * Payloads, as the API answers them
 * ======================================================================== */

interface SeriesPayload {
  readonly scope: string;
  readonly name: string;
  readonly group?: string | null;
  readonly buckets: readonly {
    readonly startOffsetMs: number;
    readonly minMs: number;
    readonly maxMs: number;
    readonly percentilesOk: Readonly<Record<string, number>>;
  }[];
}

interface StatsPayload {
  readonly stats: readonly { readonly scope: string; readonly family: string; readonly name: string }[];
}

interface UsersPayload {
  readonly scenarios: readonly {
    readonly scenario: string;
    readonly buckets: readonly { readonly startOffsetMs: number; readonly maxConcurrent: number }[];
  }[];
}

/** The two reads a Requests chart makes under each pick, spelled as the spec's
 *  section 4 spells them — independently of the page's own path builders, so a
 *  builder that drifted cannot agree with itself here. */
const runSeriesPath = (runId: string): string =>
  `/v1/runs/${runId}/series?scope=run&name=&family=response_time`;
const groupSeriesPath = (runId: string, group: string): string =>
  `/v1/runs/${runId}/series?scope=request&group=${encodeURIComponent(group)}&family=response_time`;
const requestSeriesPath = (runId: string, name: string): string =>
  `/v1/runs/${runId}/series?scope=request&name=${encodeURIComponent(name)}&family=response_time`;

/* ======================================================================== *
 * A chart's data table, read without waiting
 * ======================================================================== */

interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * A chart's data table — its header, then each row's label and each cell's
 * `data-value` (the unrounded number; `—` for a gap) — or `null` while the
 * chart is not drawn (a loading figure has no table).
 *
 * `page.evaluate` over `document.querySelector`, NOT a locator: a locator's
 * `evaluate` waits for the element, and inside `expect.poll` a chart that
 * never draws would then hang the poll until the whole test times out rather
 * than failing it on the poll's own bound.
 */
function readTable(page: Page, id: string): Promise<Table | null> {
  return page.evaluate((chartId) => {
    const el = document.querySelector(`[data-testid="chart-data-${chartId}"]`);
    if (el === null) return null;
    // `Array.from`, not spread: the e2e tsconfig's lib has DOM without
    // DOM.Iterable, so a NodeList is not iterable to the compiler here.
    return {
      columns: Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent ?? ''),
      rows: Array.from(el.querySelectorAll('tbody tr')).map((tr) => [
        tr.querySelector('th')?.textContent ?? '',
        ...Array.from(tr.querySelectorAll('td')).map((td) => td.getAttribute('data-value') ?? td.textContent ?? ''),
      ]),
    };
  }, id);
}

/** The percentiles chart's header, as it heads every series: the label column,
 *  then GE's ten bands (`run-charts.spec.ts` pins the ten). */
const PERCENTILE_COLUMNS = ['Elapsed (s)', 'min', '25%', '50%', '75%', '80%', '85%', '90%', '95%', '99%', 'max'];

/**
 * What the percentiles chart's table must hold for `series`, by the rule the
 * chart states behind its own ⓘ: the bands are the OK-only percentiles, `min`
 * and `max` the bucket's combined extremes, and a second that measured no
 * successful response is a gap in every column. The band a column reads is
 * named by the column itself (`95%` is `percentilesOk.p95`).
 */
function percentileRows(series: SeriesPayload): string[][] {
  return series.buckets.map((bucket) => {
    const measured = Object.keys(bucket.percentilesOk).length > 0;
    const cells = PERCENTILE_COLUMNS.slice(1).map((band) => {
      if (!measured) return '—';
      const value =
        band === 'min'
          ? bucket.minMs
          : band === 'max'
            ? bucket.maxMs
            : bucket.percentilesOk[`p${band.replace('%', '')}`];
      return value === undefined ? '—' : String(value);
    });
    return [String(bucket.startOffsetMs / 1000), ...cells];
  });
}

/** Waits until the percentiles chart's table holds exactly `series`' rows. A
 *  pick re-keys the read, so the chart passes through "Loading…" (no table) and
 *  may briefly hold the previous pick's table; the poll waits through both and
 *  fails on its own bound, printing the last table it read. */
async function expectPercentiles(page: Page, series: SeriesPayload, message: string): Promise<void> {
  const expected = { columns: PERCENTILE_COLUMNS, rows: percentileRows(series) };
  await expect.poll(() => readTable(page, 'percentiles'), { message, timeout: 15_000 }).toEqual(expected);
}

/** The concurrent-users table a pick of `scenario` must hold: one column for
 *  that scenario and NO "All users" — under a scenario pick the total would be a
 *  second, identical line (`usersChart`) — and one row per bucket of that
 *  scenario, its peak concurrency. */
function concurrentRows(users: UsersPayload, scenario: string): Table {
  const one = users.scenarios.find((s) => s.scenario === scenario);
  if (one === undefined) throw new Error(`/users has no scenario ${scenario}`);
  return {
    columns: ['Elapsed (s)', scenario],
    rows: one.buckets.map((b) => [String(b.startOffsetMs / 1000), String(b.maxConcurrent)]),
  };
}

/* ======================================================================== *
 * The Requests section
 * ======================================================================== */

/**
 * The Report with the Requests section's pickers drawn, which happens only
 * once the run's whole-run `/stats` has answered (`useRequestsNarrowing`):
 * until then the section has no Group control to choose from.
 */
async function openRequests(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('section#requests').getByRole('button', { name: 'Requests', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(groupSelect(page)).toBeVisible();
}

test('a group, then a request, narrow the charts and survive a reload', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // Every /series request the page makes, so the case can say WHICH read the
  // narrowed table came from, not only that its numbers agree.
  const seriesReads: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/v1/runs/${runId}/series`) seriesReads.push(url);
  });

  await openRequests(page, runReportPath(runId));
  const runSeries = await apiJson<SeriesPayload>(page, runSeriesPath(runId));
  // Before any pick the chart is the run's own: the baseline a pick must leave.
  await expectPercentiles(page, runSeries, 'with no pick, the run’s own percentiles');

  /* ---- the group ---- */
  await groupSelect(page).selectOption({ label: 'Cart' });
  await expect.poll(() => param(page, 'requests-group'), { message: 'the group in the URL' }).toBe('Cart');
  expect(hash(page), 'the pick writes the section’s fragment').toBe('#requests');
  expect(param(page, 'requests-request'), 'a group pick names no request').toBeNull();

  const cart = await apiJson<SeriesPayload>(page, groupSeriesPath(runId, 'Cart'));
  // The premise: the group's merged series is not the run's, so a chart still
  // drawing the run cannot satisfy what follows. And the API echoes the group,
  // which is what the page checks before it draws a group read at all.
  expect(cart.group, 'the server echoes the group it merged').toBe('Cart');
  expect(percentileRows(cart)).not.toEqual(percentileRows(runSeries));
  await expectPercentiles(page, cart, 'under Cart, the percentiles table is the group read’s');
  // It came from the group read the spec defines: request scope, the group,
  // and no `name` (the server refuses `group` beside one).
  expect(
    seriesReads.some(
      (url) =>
        url.searchParams.get('scope') === 'request' &&
        url.searchParams.get('group') === 'Cart' &&
        !url.searchParams.has('name'),
    ),
    'the page read /series?scope=request&group=Cart',
  ).toBe(true);
  // And the chart says what it is narrowed to, behind its ⓘ.
  const percentiles = page.getByTestId('chart-percentiles');
  await expect(percentiles.getByRole('button', { name: /^About / })).toHaveAccessibleDescription(
    /Narrowed to the group Cart\./,
  );

  /* ---- the request ---- */
  // Picked by the label the control shows (ruling R5): the request's group
  // path, then its own name.
  await requestSelect(page).selectOption({ label: 'Cart / Add To Cart' });
  await expect.poll(() => param(page, 'requests-request'), { message: 'the request in the URL' }).toBe(
    'Cart/Add To Cart',
  );
  expect(param(page, 'requests-group'), 'the request keeps its group').toBe('Cart');
  expect(hash(page)).toBe('#requests');

  const addToCart = await apiJson<SeriesPayload>(page, requestSeriesPath(runId, 'Cart/Add To Cart'));
  expect(percentileRows(addToCart)).not.toEqual(percentileRows(cart));
  await expectPercentiles(page, addToCart, 'under Cart / Add To Cart, the percentiles table is the request’s');
  await expect(percentiles.getByRole('button', { name: /^About / })).toHaveAccessibleDescription(
    /Narrowed to the request Cart \/ Add To Cart\./,
  );

  // The Table narrows with the charts: that request's row alone, and no All
  // Requests row, since the run's total is not the pick's.
  await page.getByTestId('requests-bar').getByRole('button', { name: 'Table', exact: true }).click();
  await expect
    .poll(() => page.getByTestId('stat-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path'))), {
      message: 'the Table under a request pick',
    })
    .toEqual(['Cart/Add To Cart']);
  await expect(page.getByTestId('stat-row-total')).toHaveCount(0);

  /* ---- a reload ---- */
  await page.reload();
  await expect(page.locator('section#requests').getByRole('button', { name: 'Requests', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(hash(page), 'the section’s fragment survives the reload').toBe('#requests');
  await expect(groupSelect(page)).toHaveValue('Cart');
  await expect(requestSelect(page)).toHaveValue('Cart/Add To Cart');
  // Not only the controls: the charts drew the pick again, from the URL alone.
  await expectPercentiles(page, addToCart, 'after a reload, the percentiles table is still the request’s');
});

/**
 * Ruling R2. `setGroup` deletes `requests-request` in the same navigation
 * (`useRequestsPick`): left behind, the previous group's request would sit in
 * the URL under a group that does not hold it, read as All — so the control
 * LOOKS right — and be named in a "this link named…" line the reader's own
 * click had caused. The URL is what tells the two apart, so it is asserted
 * first; the note's absence is the visible half.
 */
test('changing the group drops the previous request', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await openRequests(page, runReportPath(runId));

  await groupSelect(page).selectOption({ label: 'Cart' });
  await requestSelect(page).selectOption({ label: 'Cart / Add To Cart' });
  await expect.poll(() => param(page, 'requests-request')).toBe('Cart/Add To Cart');

  // Catalog holds three requests, so its Request control is a select with a
  // choice to make — not a one-request group's read-only field.
  await groupSelect(page).selectOption({ label: 'Catalog' });
  await expect.poll(() => param(page, 'requests-group'), { message: 'the new group in the URL' }).toBe('Catalog');
  expect(param(page, 'requests-request'), 'the previous group’s request has left the URL').toBeNull();
  await expect(requestSelect(page)).toHaveValue('*');
  await expect(requestSelect(page).locator('option:checked')).toHaveText('All requests');
  await expect(requestPicker(page).getByTestId('filter-unknown')).toHaveCount(0);
});

test('a one-request group selects its request', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await openRequests(page, runReportPath(runId));

  // The premise, from the run's own rows: Catalog/Recommendations holds
  // exactly one request.
  const stats = await apiJson<StatsPayload>(page, `/v1/runs/${runId}/stats`);
  const members = stats.stats.filter(
    (row) => row.scope === 'request' && row.family === 'response_time' && row.name.startsWith('Catalog/Recommendations/'),
  );
  expect(members.map((row) => row.name)).toEqual(['Catalog/Recommendations/Related Items']);

  await groupSelect(page).selectOption({ label: 'Catalog / Recommendations' });
  await expect.poll(() => param(page, 'requests-group')).toBe('Catalog/Recommendations');

  // A labelled value, not a control: a select whose every option drew the same
  // data would do nothing. Read off the `dl` the field renders.
  const field = requestPicker(page).locator('dl');
  await expect(field.locator('dt')).toHaveText('Request');
  await expect(field.locator('dd')).toHaveText('Catalog / Recommendations / Related Items');
  await expect(requestPicker(page).locator('select')).toHaveCount(0);
  // Selected without being written: the URL names the group the reader chose,
  // and nothing they did not.
  expect(param(page, 'requests-request')).toBeNull();
});

/**
 * Errors per second and Responses by status cannot narrow (spec section 2):
 * error buckets are run-wide and status counts are filed under every request.
 * Beside six charts that do, each says so in one visible line, above its own
 * figure. The copy is ruling R15's, true with a window or without, and exact:
 * these are the sentences the spec's own cases assert.
 */
test('the whole-run notes show under a pick', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await openRequests(page, runReportPath(runId));

  // With no pick nothing is narrowed, so neither chart is the odd one out.
  await expect(page.getByTestId('chart-errors-over-time')).toBeVisible();
  await expect(page.getByTestId('whole-run-note')).toHaveCount(0);

  await groupSelect(page).selectOption({ label: 'Cart' });
  const notes = page.getByTestId('whole-run-note');
  await expect(notes).toHaveText([
    'Shows every request: errors are not recorded per request.',
    'Shows every request: status codes are not recorded per request.',
  ]);
  // Each note sits in its own chart's cell, so the two read as one.
  for (const [i, chart] of [
    [0, 'chart-errors-over-time'],
    [1, 'chart-agent-status'],
  ] as const) {
    await expect(notes.nth(i).locator('xpath=..').getByTestId(chart)).toHaveCount(1);
  }
});

/**
 * A link for a group this run never recorded reads as All, and says so in one
 * line beside the Group control. The wording is `ReportFilterControl`'s; what
 * is asserted is its CLAIM — the value the link named, and what is shown in
 * its place — so the sentence stays rewritable.
 */
test('a stale link names what it asked for', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await openRequests(page, `${runReportPath(runId)}?requests-group=Nope#requests`);

  const note = groupPicker(page).getByTestId('filter-unknown');
  await expect(note).toContainText('Nope');
  await expect(note).toContainText(/showing all groups/i);
  // The Request control says nothing of its own: the link named no request.
  await expect(requestPicker(page).getByTestId('filter-unknown')).toHaveCount(0);

  // All groups, and every group the run offers — its recorded groups, in the
  // payload's order, then "(no group)" (stored as '') for Search and Place Order.
  const stats = await apiJson<StatsPayload>(page, `/v1/runs/${runId}/stats`);
  const groups = stats.stats.filter((r) => r.scope === 'group' && r.family === 'group_cumulated').map((r) => r.name);
  expect(groups.length).toBeGreaterThan(1);
  await expect(groupSelect(page)).toHaveValue('*');
  await expect
    .poll(() => groupSelect(page).locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)))
    .toEqual(['*', ...groups, '']);
  // Nothing is narrowed, so no chart needs to say it is not.
  await expect(page.getByTestId('whole-run-note')).toHaveCount(0);
});

/* ======================================================================== *
 * Virtual users
 * ======================================================================== */

/**
 * The scenario pick narrows the payload the section already holds
 * (`narrowUsers`), so the oracle is `/users` itself: the concurrent-users table
 * under `Browse` is Browse's buckets and nothing else.
 *
 * Then the same pick as a SHARED LINK, fresh, with a window: Virtual users is
 * shut on arrival, so the `#virtual-users` fragment is what opens it, and the
 * figures read the WINDOW's `/users` while the picker's names come from the
 * whole run (Task 9) — so the oracle is the windowed read, the one the chart
 * makes.
 */
test('Virtual users narrows by scenario, and a shared link with a window reopens it', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runReportPath(runId));
  await openSection(page, 'virtual-users', 'Virtual users');

  const users = await apiJson<UsersPayload>(page, `/v1/runs/${runId}/users`);
  expect(users.scenarios.map((s) => s.scenario)).toEqual(['Browse', 'Checkout']);

  await scenarioSelect(page).selectOption('Browse');
  await expect.poll(() => param(page, 'users-scenario'), { message: 'the scenario in the URL' }).toBe('Browse');
  expect(hash(page), 'the pick writes the section’s fragment').toBe('#virtual-users');
  await expect
    .poll(() => readTable(page, 'concurrent-users'), {
      message: 'under Browse, the concurrent-users table is Browse’s buckets',
      timeout: 15_000,
    })
    .toEqual(concurrentRows(users, 'Browse'));

  /* ---- a shared link, with a window ---- */
  const fromMs = 10_000;
  const toMs = 40_000;
  const windowed = await apiJson<UsersPayload>(page, `/v1/runs/${runId}/users?from=${fromMs}&to=${toMs}`);
  // The premise: the window narrows Browse (so its table differs from the whole
  // run's), and Checkout ran in it too (so a table that ignored the pick would
  // carry a second scenario).
  const windowedBrowse = concurrentRows(windowed, 'Browse');
  expect(windowedBrowse.rows.length).toBeGreaterThan(0);
  expect(windowedBrowse.rows.length).toBeLessThan(concurrentRows(users, 'Browse').rows.length);
  expect(concurrentRows(windowed, 'Checkout').rows.length).toBeGreaterThan(0);

  await page.goto(`${runReportPath(runId)}?from=${fromMs}&to=${toMs}&users-scenario=Browse#virtual-users`);
  await expect(
    page.locator('section#virtual-users').getByRole('button', { name: 'Virtual users', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(scenarioSelect(page)).toHaveValue('Browse');
  expect(param(page, 'from')).toBe(String(fromMs));
  expect(param(page, 'to')).toBe(String(toMs));
  await expect
    .poll(() => readTable(page, 'concurrent-users'), {
      message: 'under the window, the concurrent-users table is Browse’s windowed buckets',
      timeout: 15_000,
    })
    .toEqual(windowedBrowse);
});

/* ======================================================================== *
 * A streaming run
 * ======================================================================== */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

/**
 * A delta shaped as the fold owner publishes one — `run-live.spec.ts`'s
 * fixture, cut to what this case reads, with TWO scenarios so a scenario pick
 * applied while live would visibly drop one.
 *
 * Every field `LiveDeltaSchema` requires is here: `parseFrame` drops a whole
 * delta that fails it, and the page would then wait for ever.
 */
function deltaFixture(runId: string) {
  const offsets = [0, 1000, 2000, 3000];
  const bucket = (startOffsetMs: number) => ({
    startOffsetMs,
    startedCount: 20,
    endedCount: 20,
    okCount: 18,
    koCount: 2,
    startedOkCount: 18,
    startedKoCount: 2,
    minMs: 10,
    maxMs: 800,
    meanMs: 145,
    percentiles: { p50: 120, p95: 480, p99: 700 },
    percentilesOk: { p50: 110, p95: 400, p99: 650 },
    percentilesKo: { p50: 600, p95: 780, p99: 800 },
  });
  return {
    runId,
    seq: 3,
    summary: {
      count: 320,
      okCount: 288,
      koCount: 32,
      errorRate: 0.1,
      percentiles: { p50: 125, p95: 470, p99: 690 },
      maxUsers: 12,
      durationMs: (offsets.at(-1) ?? 0) + 1000,
    },
    responseTime: { widthMs: 1000, replaces: true, buckets: offsets.map(bucket) },
    users: {
      widthMs: 1000,
      buckets: offsets.flatMap((o) => [
        { scenario: 'Browse', startOffsetMs: o, started: 3, ended: 1, active: 3 },
        { scenario: 'Checkout', startOffsetMs: o, started: 4, ended: 1, active: 4 },
      ]),
    },
    errors: { rows: [{ message: 'HTTP 500', count: 32 }] },
    sla: { evaluated: 0, breaching: [] },
  };
}

/**
 * The live wire carries run-scope series only, so there is nothing to narrow
 * while a run streams: no pickers, and nothing narrowed whatever the URL asks
 * for. The link here names a group, a request and a scenario, so a pick
 * applied while live would show — in a note beside two charts, or in the
 * concurrent-users table losing a scenario and its "All users" line.
 */
test('a streaming run shows no pickers', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await openLiveRun(admin.orgId);
  const redis = new Redis(REDIS_URL);
  try {
    await redis.set(`live:${runId}:snapshot`, JSON.stringify(deltaFixture(runId)), 'EX', 300);
    await signIn(page, admin);
    await page.goto(
      `${runReportPath(runId)}?requests-group=Cart&requests-request=Cart%2FAdd%20To%20Cart&users-scenario=Checkout#requests`,
    );

    // The live charts drew, so the section is past its wait and this is the
    // streaming branch, not a page that had not rendered the pickers yet.
    for (const id of ['requests-and-responses', 'percentiles']) {
      await expect(plot(page.getByTestId(`chart-${id}`))).toHaveCount(1);
    }
    await expect(groupPicker(page)).toHaveCount(0);
    await expect(requestPicker(page)).toHaveCount(0);
    await expect(page.getByTestId('requests-names-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('whole-run-note')).toHaveCount(0);

    await openSection(page, 'virtual-users', 'Virtual users');
    await expect(plot(page.getByTestId('chart-concurrent-users'))).toHaveCount(1);
    await expect(scenarioPicker(page)).toHaveCount(0);
    await expect(page.getByTestId('users-names-unavailable')).toHaveCount(0);
    // The run's users whole: both scenarios and their total, despite the link.
    await expect
      .poll(async () => (await readTable(page, 'concurrent-users'))?.columns)
      .toEqual(['Elapsed (s)', 'Browse', 'Checkout', 'All users']);
  } finally {
    await redis.del(`live:${runId}:snapshot`, `live:${runId}:deltas`);
    await redis.quit();
  }
});
