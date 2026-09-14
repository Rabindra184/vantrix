import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { runComparePath, runTrendsPath } from '../src/routes/paths.js';

/**
 * Compare runs, in a real browser.
 *
 * TWO INGESTS OF THE REFERENCE BUNDLE give two runs of the same simulation in
 * the same project — a cohort of two, which is the minimum that proves an
 * OVERLAY rather than a chart that happens to have drawn. Several cases here
 * check the count of drawn series for exactly that reason: "an svg exists" is
 * satisfied by one line.
 */

const OVERLAY = 'chart-compare-overlay';

function overlay(page: Page): Locator {
  return page.getByTestId(OVERLAY);
}

async function drawn(page: Page): Promise<void> {
  await expect(plot(overlay(page))).toHaveCount(1);
}

/**
 * Waits until the overlay is drawing exactly `n` runs, then returns their
 * legend labels.
 *
 * ═══ WHY THIS RETRIES INSTEAD OF READING ONCE ═══
 *
 * `allTextContents()` is a ONE-SHOT read, and the figure's `<svg>` appears as
 * soon as the FIRST run's `/series` resolves — the second is still in flight,
 * and `Chart` redraws with `notMerge` when it lands. Reading at that moment
 * samples a chart mid-assembly, which is why this suite failed on a different
 * test each run.
 *
 * The count is asserted with a retrying `expect` first; only then are the
 * labels read. Below two series `Chart` draws no legend at all, so this is for
 * the multi-run cases and `runsInTable` covers the rest.
 */
async function expectSeriesNames(page: Page, n: number): Promise<string[]> {
  const labels = overlay(page).locator('svg text[text-anchor="start"]');
  await expect(labels).toHaveCount(n);
  return labels.allTextContents();
}

/**
 * The overlay's data-table value columns — one per drawn run.
 *
 * NOT the legend, which `Chart` hides below two series ("one series is named
 * by the title, and a one-entry legend is a label pretending to be a
 * control"), so a legend count cannot tell one run from none — exactly the
 * distinction the dropped-run case turns on.
 */
function runsInTable(page: Page): Locator {
  // `thead th` includes the elapsed-time label column, so `n + 1` is the
  // expectation callers pass.
  return page.getByTestId('chart-data-compare-overlay').locator('thead th');
}

/** Seeds a cohort of two and returns the newer run's id. */
async function cohortOfTwo(): Promise<{ admin: Awaited<ReturnType<typeof seedAdmin>>; runId: string }> {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const runId = await seedRunWithData(admin.orgId);
  return { admin, runId };
}

test('is reachable at its own URL and overlays both runs', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  // TWO SERIES, not merely one chart. A single-run overlay would satisfy every
  // other assertion in this file. Asserted twice over: the legend names two
  // runs, and they are DISTINCT — identical labels would collapse to one entry
  // and leave a reader unable to tell the lines apart.
  const names = await expectSeriesNames(page, 2);
  expect(new Set(names).size).toBe(2);
  await expect(runsInTable(page)).toHaveCount(3);

  // The parity surface is present, as it is on every chart in this app.
  await expect(page.getByTestId(`chart-data-compare-overlay`)).toHaveCount(1);
});

test('the metric selector redraws without navigating away', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  const before = await page.getByRole('heading', { name: /across runs/ }).textContent();

  await page.getByLabel('Metric', { exact: true }).selectOption('throughput');

  // The figure's own heading names the metric, so a screen-reader user is told
  // what changed rather than only sighted readers seeing the line move.
  await expect(page.getByRole('heading', { name: 'Throughput across runs', exact: true })).toBeVisible();
  expect(await page.getByRole('heading', { name: /across runs/ }).textContent()).not.toBe(before);

  await expect(page).toHaveURL(new RegExp(`${runId}/compare`));
  await drawn(page);
});

test('toggling a run rewrites the URL, so a comparison can be pasted', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  // The other run in the cohort — the one that is not the current run, which
  // is deliberately not deselectable.
  const others = page.locator('[data-testid^="compare-run-"]:not([disabled])');
  await expect(others).toHaveCount(1);
  await others.first().click();

  // Its id is now in the query string, which is the whole point: the selection
  // lives somewhere a reader can copy.
  await expect(page).toHaveURL(/[?&]runs=/);
});

test('the per-request matrix has a column per run and a row per request', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  const table = page.getByRole('table', { name: /request/i });
  await expect(table).toHaveCount(1);

  // One label column plus one per selected run. Retrying, for the same reason
  // the overlay's helper does: the table renders as each /stats resolves.
  await expect(table.locator('thead th')).toHaveCount(3);
  expect((await table.locator('thead th').allTextContents())[0]).toBe('Request');

  // Every request the reference bundle produces gets a row, and each row has a
  // cell per run.
  const rows = table.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(1);
  await expect(rows.first().locator('td')).toHaveCount(2);
});

test('a run outside the cohort is dropped, and the page says so', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  // A real run, but of a different project and therefore a different cohort.
  const stranger = await seedRunWithData((await seedAdmin()).orgId);
  await signIn(page, admin);

  await page.goto(`${runComparePath(runId)}?runs=${stranger}`);
  await drawn(page);

  // Dropped, not fetched: the overlay still shows only this cohort's runs.
  // Counted from the data table, because a single-series chart draws no
  // legend at all and a legend count cannot tell one run from none.
  await expect(runsInTable(page)).toHaveCount(2);
  await expect(page.getByText('Some runs named in this link were left out')).toBeVisible();
});

test('Trends links here, and only when there is something to compare', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runTrendsPath(runId));

  // `exact: true` because ProjectRail puts a link per project in every
  // authenticated document and Playwright's default name match is a
  // case-insensitive substring.
  const link = page.getByRole('link', { name: 'Compare these runs', exact: true });
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${runId}/compare`));
});

test('a cohort of one offers no comparison and explains why', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // The link is absent on Trends...
  await page.goto(runTrendsPath(runId));
  await expect(page.getByRole('link', { name: 'Compare these runs', exact: true })).toHaveCount(0);

  // ...and the route, reached directly, says why rather than drawing a
  // one-line "comparison".
  await page.goto(runComparePath(runId));
  await expect(page.getByText('Nothing to compare yet')).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
});

/**
 * ═══ MORE THAN TWO RUNS, WHICH NOBODY HAD EVER DRAWN ═══
 * (the 09-13 review's acceptance list: "multiple comparisons")
 *
 * `MAX_COMPARE` is 5 and every case above this one goes through
 * `cohortOfTwo` — so the cap was proven only against a synthetic array in a
 * unit test, and three, four or five overlaid runs had never existed in a
 * browser. The overlay, the comparability panel, the summary tiles and the
 * legend had all only ever been seen with two.
 *
 * SIX RUNS SEEDED, ONE MORE THAN THE CAP, because the interesting states are
 * AT the boundary and just past it: five selected and drawing, and a sixth
 * chip that refuses.
 */
test('overlays five runs and says why it will not take a sixth', async ({ page }) => {
  const admin = await seedAdmin();
  let runId = '';
  for (let i = 0; i < 6; i += 1) runId = await seedRunWithData(admin.orgId);

  await signIn(page, admin);
  await page.goto(runComparePath(runId));

  const chips = page.locator('[data-testid^="compare-run-"]');
  await expect(chips).toHaveCount(6);

  /* ═══ SELECT UP TO THE CAP ═══
   *
   * IT OPENS WITH TWO, NOT ONE, AND THE COMMENT HERE SAID ONE FOR AS LONG AS
   * THIS TEST HAS EXISTED. `parseCompareSelection` prepends the run you came
   * from to `defaultSelection`, which answers with its NEAREST NEIGHBOUR —
   * deliberately, so Compare never opens having answered nothing and asking
   * the reader to go find a second run. So two are selected on arrival and
   * THREE more reach five. Only the run you came from is `disabled`; the
   * neighbour is pressed and can be deselected.
   *
   * Nothing caught that, because the loop this replaces ran until the count
   * reached five from WHATEVER it found. A test indifferent to its own
   * starting state cannot notice when that state stops matching the sentence
   * above it.
   *
   * EVERY STEP WAITS, AND THAT IS THE WHOLE FIX. `count()`, `getAttribute()`
   * and `isDisabled()` are IMMEDIATE reads with no auto-waiting — only
   * `expect()` and an action's own actionability check retry. The loop this
   * replaces read all three and then clicked, so it chose its next move from a
   * DOM React had not necessarily committed yet. And the state it was racing
   * is precisely the one this test exists to reach: at the cap, EVERY
   * unselected chip takes `disabled` (`RunCompare`: `atCap = !on &&
   * selected.length >= MAX_COMPARE`). So a stale-low count sent it to click a
   * chip that was already refusing, and `click()` then waited out the test's
   * entire 60s deadline rather than failing on anything — which is why the
   * report named a timeout and no assertion. Seen twice in one day on CI,
   * both chromium.
   *
   * Asserting the count after each click is what leaves the next iteration a
   * settled page to read. Both selectors are attribute selectors on the chip
   * ITSELF rather than `filter()`, for the reason recorded below: `filter`
   * matches DESCENDANTS.
   */
  const pressed = () => page.locator('[data-testid^="compare-run-"][aria-pressed="true"]');
  const selectable = () =>
    page.locator('[data-testid^="compare-run-"][aria-pressed="false"]:not([disabled])');

  // Stated rather than tolerated — and stating it is what found the two above.
  const OPENS_WITH = 2;
  await expect(pressed()).toHaveCount(OPENS_WITH);
  for (let n = OPENS_WITH; n < 5; n += 1) {
    await selectable().first().click();
    await expect(pressed()).toHaveCount(n + 1);
  }
  await expect(pressed()).toHaveCount(5);

  await drawn(page);

  /* FIVE DISTINCT SERIES. `toHaveCount` alone would pass against an overlay
     that drew one line five times; distinctness is what says a reader can tell
     them apart, and `compareLabels` disambiguates colliding timestamps
     precisely so they can. */
  const names = await expectSeriesNames(page, 5);
  expect(new Set(names).size).toBe(5);
  await expect(runsInTable(page)).toHaveCount(6); // 5 runs + the elapsed column

  /* ═══ AND THE SIXTH REFUSES WITH A REASON ═══
   *
   * Every unselected chip went to `disabled` and 50% opacity with nothing
   * anywhere explaining it — the only `title` in the picker belongs to the run
   * you came from. A reader met greyed buttons and had to guess the rule. */
  const cap = page.getByTestId('compare-cap');
  await expect(cap).toBeVisible();
  await expect(cap).toContainText(/most this overlay can draw|deselect one/i);

  // The refusal reaches assistive technology through the CONTROL, not just the
  // page: a sentence a screen-reader user has to go looking for is not a reason
  // the disabled button gave them.
  // `aria-pressed` is on the chip ITSELF, so this is an attribute selector and
  // not a `filter({ hasNot })` — that matches DESCENDANTS and quietly kept
  // every chip, including the five selected ones.
  const refused = page.locator('[data-testid^="compare-run-"][aria-pressed="false"]').first();
  await expect(refused).toBeDisabled();
  await expect(refused).toHaveAttribute('aria-describedby', 'compare-cap');
});
