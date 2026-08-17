import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  seedAdmin,
  seedCompleteRunWithoutMetrics,
  seedPendingRun,
  seedRunWithData,
} from './fixtures.js';
import { apiJson, signIn } from './helpers.js';
import { SURFACE_TOKENS } from '../src/charts/theme.js';
import { runChartsPath } from '../src/routes/paths.js';

/**
 * The eight overview charts on the run detail page, in a real browser.
 *
 * THIS IS THE FIRST PLACE THE REAL ECHARTS RUNS. The unit suite mocks it —
 * deliberately, because `getBoundingClientRect` returns zeros in jsdom, so a
 * chart lays out at 0×0 and any assertion about what it drew is theatre
 * (`Chart.tsx` says so at length). Everything about the DRAWING is therefore
 * proven here or nowhere: that the library initialises at the pinned version,
 * that the SVG renderer emits marks, and that `echarts.connect` links the
 * time-axis charts into one crosshair.
 *
 * THE DATA TABLE IS THE PARITY SURFACE (design §7). Every numeric assertion
 * below reads the table rather than the SVG, for the reason `DataTable.tsx`
 * gives: the number a screen-reader user hears and the number a test asserts
 * are then the same number, and cannot drift apart.
 */

/**
 * §13.2's order, and the chart ids as the COMPONENTS actually declare them —
 * `requests-per-second`/`responses-per-second`, not `request-rate`/
 * `response-rate`. The ids are the ones `RatesChart.tsx` passes to `Chart`;
 * a list here that merely resembled them would fail loudly, which is the point
 * of naming them once.
 *
 * The ORDER is asserted, not just the membership. §13.2 numbers these charts
 * ③④⑦⑦ᵇ⑧⑨⑩⑪ and the sequence is itself information: concurrent users sits
 * directly above the arrival rate, and requests/s directly above responses/s,
 * because each pair is meant to be read against its neighbour. A page holding
 * them all in a shuffled order satisfies "the charts are present" and fails
 * the thing the section actually specifies.
 *
 * `percentile-distribution` follows `distribution` under exactly that rule,
 * and is not an exception to it: the two are folds of the same payload and
 * answer halves of one question — where the mass of the response times is, and
 * how bad the tail gets. Read apart, the histogram invites eyeballing the area
 * under an unmarked stretch of its right-hand side.
 */
const CHART_IDS = [
  'indicators',
  'request-counts',
  'concurrent-users',
  'user-start-rate',
  'distribution',
  'percentile-distribution',
  'percentiles',
  'requests-per-second',
  'responses-per-second',
] as const;

/** Every chart figure on the page, in document order. */
/**
 * The §13.2 overview figures — the eight this tab is about.
 *
 * EXCLUDING THE TIME-WINDOW STRIP, which is a `Chart` too and therefore shares
 * this testid namespace, but is a CONTROL rendered by `RunShell` above the
 * tabs rather than one of the numbered figures. Without the exclusion every
 * count and ordering assertion here would silently be about nine charts, and
 * §13.2's numbering is itself information.
 */
function figures(page: Page): Locator {
  return page.locator('figure[data-testid^="chart-"]:not([data-testid="chart-time-window"])');
}

interface Cell {
  readonly text: string;
  /** The unrounded value the transform produced — see `DataTable.formatCell`. */
  readonly value: string | null;
}

interface Row {
  readonly label: string;
  readonly cells: readonly Cell[];
}

/**
 * A chart's data table, as data. Reads the DOM the reader is given: the
 * rendered text of each cell AND the exact value carried beside it, so a spec
 * can assert both what is displayed and what was not thrown away.
 *
 * No click required — the table is in the DOM from first paint and merely
 * `hidden`, which is exactly what makes it assertable.
 */
async function readTable(page: Page, id: string): Promise<Row[]> {
  const table = page.getByTestId(`chart-data-${id}`);
  await expect(table).toHaveCount(1);
  // WAIT FOR THE TABLE TO BE POPULATED, not merely present. The table exists
  // from first paint — that is what makes it the parity surface — and so does
  // the placeholder figure `RunDetail` renders while the fetch is in flight, so
  // `toHaveCount(1)` is satisfied a frame after navigation with nothing in it.
  // Reading then returns `[]`, and every `toEqual` below would compare two
  // empty arrays and pass. Every caller of this helper reads a chart that has
  // real data, so "at least one row" is the honest thing to wait for.
  await expect(table.locator('tbody tr').first()).toBeAttached();
  // `Array.from`, not spread: the e2e tsconfig's lib set has DOM without
  // DOM.Iterable, so a NodeList is not iterable to the compiler here.
  return table.evaluate((el) =>
    Array.from(el.querySelectorAll('tbody tr')).map((tr) => ({
      label: tr.querySelector('th')?.textContent ?? '',
      cells: Array.from(tr.querySelectorAll('td')).map((td) => ({
        text: td.textContent ?? '',
        value: td.getAttribute('data-value'),
      })),
    })),
  );
}

interface SeriesPayload {
  bucketWidthMs: number;
  buckets: {
    startOffsetMs: number;
    startedCount: number;
    endedCount: number;
  }[];
}

interface DistributionPayload {
  labels: number[];
  okPercent: number[];
  koPercent: number[];
  okCount: number[];
  koCount: number[];
}

/**
 * The crosshair line, as ECharts 6.1.0's SVG renderer actually emits it.
 *
 * PINNED BY INSPECTION, not by hope. The obvious guesses — `.echarts-axis-
 * pointer`, `[class*="axisPointer"]` — match nothing: zrender's SVG output
 * carries no class names at all, so a spec written against them would report
 * `toHaveCount(0)` both before and after the hover and pass while proving
 * nothing at all. What the pointer IS, at this version, is a single `<path>`
 * with a DASH PATTERN:
 *
 *     <path d="M194.5 256L194.5 36" fill="none" stroke="#5b6470"
 *           stroke-dasharray="4,2"></path>
 *
 * Nothing else these charts draw is dashed — gridlines, axis lines, series
 * lines, bars, donut sectors and legend swatches are all solid — so
 * `stroke-dasharray` identifies the pointer exactly. Verified against the
 * rendered DOM: zero of these before the hover, one after.
 */
const AXIS_POINTER = 'svg path[stroke-dasharray]';

/**
 * WHICH elapsed second the pointer sits on, read off the chart's own tooltip,
 * whose first line is the hovered category.
 *
 * The comparison has to be by CATEGORY, never by pixel: the time-axis charts
 * have different grid geometry — the concurrent-users grid starts at x=56 and
 * the requests/s grid at x=59.7, because their value-axis labels are different
 * widths — so the same second is a different x on each and two pointer
 * coordinates could not be compared directly.
 *
 * ECharts appends its tooltip INTO the chart's own container (the element it
 * stamps `_echarts_instance_` on), as a sibling of the zrender root, which is
 * that container's first child. Hence "the container's second child".
 */
async function hoveredSecond(chart: Locator): Promise<string> {
  const tooltip = chart.locator('[_echarts_instance_] > div').nth(1);
  const text = (await tooltip.textContent()) ?? '';
  return /^\s*(-?[\d.]+)/.exec(text)?.[1] ?? '';
}

test('a completed run shows the eight overview charts, in §13.2 order, on their own tab', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // The order, as rendered. `toHaveAttribute` per index would report "expected
  // chart-percentiles" without saying what was there instead; a single array
  // comparison names the whole sequence on failure.
  await expect(figures(page)).toHaveCount(CHART_IDS.length);
  const rendered = await figures(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  expect(rendered).toEqual(CHART_IDS.map((id) => `chart-${id}`));

  // NOT below the assertions panel any more — its own tab, entirely (design
  // §6). The run's own header persists across the tab switch (the layout
  // route mounts it once, design §3), so its `<h1>` is still the page's first
  // heading; the Charts section itself carries an `<h2>Charts</h2>` that is
  // `sr-only` — present in the heading list below (so a screen-reader user
  // navigating by heading can actually reach this section, which
  // `aria-label` alone never let them do) but invisible on screen, so
  // "Assertions" and "Overview" still appear nowhere on this tab.
  const headings = await page.getByRole('heading').allTextContents();
  expect(headings[0]).toMatch(/ParitySimulation/);
  expect(headings).toContain('Charts');
  expect(headings).not.toContain('Assertions');
  expect(headings).not.toContain('Overview');
});

test('every chart actually draws — the real ECharts renders SVG marks for all eight', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // One <svg> per chart, each containing marks. This is the assertion that
  // fails if ECharts 6.1.0 does not initialise in a browser at all — which the
  // jsdom suite cannot tell us, since it mocks the library.
  for (const id of CHART_IDS) {
    const svg = page.getByTestId(`chart-${id}`).locator('svg');
    await expect(svg, `${id} drew no SVG`).toHaveCount(1);
    // `path` covers every mark type on the page: the line charts' polylines,
    // the bar charts' rectangles and the donut's sectors are all paths in
    // zrender's SVG output.
    await expect(svg.locator('path').first(), `${id} drew no marks`).toBeAttached();
  }

  // No console errors while eight ECharts instances initialise, connect and
  // draw. A thrown option error leaves a chart blank without failing anything
  // above it.
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.reload();
  await expect(page.getByTestId('chart-percentiles').locator('svg')).toHaveCount(1);
  expect(errors).toEqual([]);
});

/**
 * CRITICAL 2b (fix wave). Design §10 claims "Every chart still draws marks,
 * **in both themes**" and, before this test, nothing proved the second half —
 * no test anywhere emulated dark mode. `theme.ts` reads every `--chart-*`
 * token off the LIVE document (`token()`'s `getComputedStyle` call), so a
 * wrong hex in `tokens.css`'s `@media (prefers-color-scheme: dark)` block
 * would only ever surface here, in a real browser under a forced dark
 * scheme — the jsdom unit suite mocks ECharts entirely and never resolves a
 * `prefers-color-scheme` media query either way.
 *
 * `emulateMedia` runs BEFORE `signIn`/`goto`, so the app is dark from its
 * very first paint rather than reacting to a later flip — the same
 * first-paint guarantee a reader with a dark OS setting actually gets.
 *
 * This is also the regression test for CRITICAL 2: before the fix wave,
 * nothing set a background or `color-scheme` on `body`, so `bg-surface` and
 * `THEAD`'s `bg-sunken` painted a dark fill behind UA-default BLACK text
 * (measured 1.44:1) instead of the page painting `--color-surface-page` at
 * all. The body-background assertion below is what would have caught that.
 */
test('every chart actually draws in dark mode too, and the page background follows', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // The same "every chart draws marks" shape as the light-mode test above,
  // run under a forced dark `prefers-color-scheme`.
  for (const id of CHART_IDS) {
    const svg = page.getByTestId(`chart-${id}`).locator('svg');
    await expect(svg, `${id} drew no SVG in dark mode`).toHaveCount(1);
    await expect(svg.locator('path').first(), `${id} drew no marks in dark mode`).toBeAttached();
  }

  // The RESOLVED colour, not the token string — `getComputedStyle` returns
  // what a reader's eyes actually see, in the `rgb()` form the browser
  // normalises every colour to. Both are asserted — the positive AND the
  // explicit negative — so a `body` rule that forgot to reference the token at
  // all (and therefore stayed transparent, showing the light OS/browser
  // default through) fails here too, rather than only a body painted the wrong
  // dark hex.
  //
  // DERIVED FROM `SURFACE_TOKENS`, NOT WRITTEN DOWN. Both hexes were literals
  // here (`rgb(15, 23, 42)` / `rgb(248, 250, 252)`), and the design pass that
  // moved the dark canvas from slate-900 to a near-neutral `#0b0d12` broke this
  // assertion for a reason that was not a defect — the exact failure mode
  // CLAUDE.md's "expectations are computed from the payload, never written
  // down" rule exists to prevent, arriving through a design token instead of
  // through a fixture. `charts/theme.ts` is the single source both this and
  // `tokens.css` are gated against (`palette.test.ts`), so reading it here
  // means a deliberate palette change updates the test with the code and an
  // ACCIDENTAL one still fails.
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBackground).toBe(rgbOf(SURFACE_TOKENS.dark.page));
  expect(bodyBackground).not.toBe(rgbOf(SURFACE_TOKENS.light.page));
});

/** `#0b0d12` → `rgb(11, 13, 18)`, the form `getComputedStyle` normalises to. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test("the requests/s and responses/s tables carry the API's own numbers, on their own edges", async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  const series = await apiJson<SeriesPayload>(page, `/v1/runs/${runId}/series?scope=run&name=`);
  expect(series.buckets.length).toBeGreaterThan(0);
  const perSecond = series.bucketWidthMs / 1000;

  const requests = await readTable(page, 'requests-per-second');
  const responses = await readTable(page, 'responses-per-second');

  // EVERY bucket, not the first one. A spec that checked `[0]` passes against a
  // chart that plots one correct point and garbage after it, and passes against
  // a table whose rows are misaligned with the axis by any offset that leaves
  // the first row alone.
  expect(requests.map((row) => row.label)).toEqual(
    series.buckets.map((b) => String(b.startOffsetMs / 1000)),
  );
  expect(requests.map((row) => row.cells[0]?.text)).toEqual(
    series.buckets.map((b) => String(b.startedCount / perSecond)),
  );
  expect(responses.map((row) => row.cells[0]?.text)).toEqual(
    series.buckets.map((b) => String(b.endedCount / perSecond)),
  );

  // THE TWO CHARTS MUST NOT BE THE SAME CHART. Both read the same payload and
  // differ only in which counter they take (`rates.ts`'s START_EDGE/END_EDGE),
  // so mounting `RequestRateChart` twice — or handing one component an `edge`
  // string and getting it wrong — produces two charts that look entirely
  // reasonable. On the reference run 33 of 62 seconds start a different number
  // of requests than they finish, so the two columns genuinely diverge and the
  // assertions above are each pinned to their own edge.
  expect(requests.map((row) => row.cells[0]?.text)).not.toEqual(
    responses.map((row) => row.cells[0]?.text),
  );
});

test('the distribution table reads at two decimals and keeps the exact percentage beside it', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  const d = await apiJson<DistributionPayload>(
    page,
    `/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`,
  );
  expect(d.labels.length).toBeGreaterThan(0);

  // The premise of this whole test: the API's percentages really are the long
  // ones. Without this guard, a payload that happened to hold only round
  // numbers would make everything below vacuously true — and the rounding
  // could be deleted with the suite still green.
  const longOnes = d.okPercent.filter((p) => String(p).replace(/^\d+\./, '').length > 2);
  expect(longOnes.length).toBeGreaterThan(0);

  const rows = await readTable(page, 'distribution');
  expect(rows.map((row) => row.label)).toEqual(d.labels.map(String));

  for (const [i, row] of rows.entries()) {
    const okPercent = d.okPercent[i]!;
    const koPercent = d.koPercent[i]!;

    // Displayed: at most two decimals — the tolerance Appendix A §A.9 F-8
    // compares G-20/G-21 at, and the thing seventeen significant digits in a
    // cell was hiding.
    for (const cell of [row.cells[0]!, row.cells[1]!]) {
      const decimals = cell.text.includes('.') ? cell.text.split('.')[1]!.length : 0;
      expect(decimals, `${cell.text} is displayed at more than 2 decimals`).toBeLessThanOrEqual(2);
    }
    // …and still the right number: within half of the last displayed decimal
    // of the API's own. Asserted as a property, not as a second copy of
    // `formatCell`'s arithmetic — a spec that recomputed the rounding would be
    // testing the formatter against itself.
    expect(Math.abs(Number(row.cells[0]!.text) - okPercent)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(Number(row.cells[1]!.text) - koPercent)).toBeLessThanOrEqual(0.005);

    // Carried: the API's own number, unrounded. Rounding for display is
    // recoverable; rounding in the transform would not have been, which is why
    // the transform still holds full precision and only the cell is formatted.
    expect(row.cells[0]!.value).toBe(String(okPercent));
    expect(row.cells[1]!.value).toBe(String(koPercent));

    // The exact counts, untouched — they are integers and must render as
    // themselves, with no separator a locale could move.
    expect(row.cells[2]!.text).toBe(String(d.okCount[i]));
    expect(row.cells[3]!.text).toBe(String(d.koCount[i]));
  }
});

/** Every chart whose x-axis is elapsed seconds, and which therefore shares the
 *  `run-time` crosshair. Concurrent users is in this list and NOT overlaid on
 *  requests/s: that is the PRD's deliberate encoding change (§22.4 forbids dual
 *  axes), and the shared pointer is what pays for it. */
const TIME_AXIS_IDS = [
  'concurrent-users',
  'user-start-rate',
  'percentiles',
  'requests-per-second',
  'responses-per-second',
] as const;

/** The charts that are NOT on a time axis, and must therefore be untouched by
 *  a hover on one that is. */
const OTHER_IDS = ['indicators', 'request-counts', 'distribution'] as const;

test('the time-linked charts share one crosshair', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  const requests = page.getByTestId('chart-requests-per-second');
  const users = page.getByTestId('chart-concurrent-users');
  for (const id of [...TIME_AXIS_IDS, ...OTHER_IDS]) {
    await expect(page.getByTestId(`chart-${id}`).locator('svg')).toHaveCount(1);
  }

  // Nothing is hovered, so no chart has a pointer. Asserted across all eight,
  // so "the pointer was already there" cannot be what makes the hover below
  // look successful.
  for (const id of [...TIME_AXIS_IDS, ...OTHER_IDS]) {
    await expect(page.getByTestId(`chart-${id}`).locator(AXIS_POINTER)).toHaveCount(0);
  }

  // Hovering requests/s must move the pointer on concurrent users too — that
  // linkage is why active users is its own chart rather than a second y-axis
  // on requests/s.
  await requests.locator('svg').hover({ position: { x: 200, y: 60 } });
  await expect.poll(() => users.locator(AXIS_POINTER).count()).toBeGreaterThan(0);

  // ALL FIVE, and ONLY the five. The pointer reaching every time-axis chart is
  // half the claim; the other half is that it reaches no further. A `group`
  // applied to all eight charts would connect a percentage histogram and a
  // donut to a time axis they do not share, and would still satisfy an
  // assertion that only looked at concurrent users.
  for (const id of TIME_AXIS_IDS) {
    await expect(
      page.getByTestId(`chart-${id}`).locator(AXIS_POINTER),
      `${id} is on the time axis and should carry the shared pointer`,
    ).toHaveCount(1);
  }
  for (const id of OTHER_IDS) {
    await expect(
      page.getByTestId(`chart-${id}`).locator(AXIS_POINTER),
      `${id} is not on a time axis and must not be crosshaired with one`,
    ).toHaveCount(0);
  }

  // And it is a CROSSHAIR, not merely "an element appeared": every linked chart
  // is pointing at the SAME elapsed second, which is the entire claim. A
  // connection that propagated the hover without aligning the category would
  // pass every count above and be useless to read.
  const second = await hoveredSecond(requests);
  expect(second).not.toBe('');
  for (const id of TIME_AXIS_IDS) {
    expect(await hoveredSecond(page.getByTestId(`chart-${id}`)), `${id} points elsewhere`).toBe(
      second,
    );
  }

  // Moving away takes it back. A pointer that appears once and sticks is a
  // stale reading of a chart nobody is hovering. The "Overview" heading this
  // used to hover is gone with the split (design §6) — the run's own `<h1>`,
  // outside the chart stack and present on every tab, is an equally neutral
  // target to move the mouse to.
  await page.getByRole('heading', { level: 1 }).hover();
  await expect.poll(() => users.locator(AXIS_POINTER).count()).toBe(0);
});

test('a processing run mounts no charts at all', async ({ page }) => {
  const admin = await seedAdmin();
  // A pending run no worker will ever pick up: `GET /v1/runs/:id` answers 202.
  const runId = await seedPendingRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  await expect(page.getByText(/still processing/i).first()).toBeVisible();

  // Charts mount inside the `ready` branch ONLY. A page that rendered them
  // here would fire four metric queries against a run whose rows do not exist
  // yet and put eight "no data" figures under a run nobody has parsed —
  // stating as a measurement ("nothing was recorded") what is merely "not yet".
  await expect(figures(page)).toHaveCount(0);
});

test('a completed run with no data explains every chart rather than showing empty axes', async ({
  page,
}) => {
  const admin = await seedAdmin();
  // Complete, so the ready branch mounts all eight charts — but carrying no
  // metric rows at all, so every payload is empty. A PENDING run cannot test
  // this: it never renders a chart, so "the page says there is no data" would
  // pass with the whole chart stack deleted.
  const runId = await seedCompleteRunWithoutMetrics(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // All eight are present, in order — the sequence does not develop holes
  // because a payload was empty.
  await expect(figures(page)).toHaveCount(CHART_IDS.length);
  const rendered = await figures(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  expect(rendered).toEqual(CHART_IDS.map((id) => `chart-${id}`));

  // The parity surface survives the absence of data: eight tables, still.
  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // NOT EMPTY AXES. A grid with no marks reads as "we measured, and there was
  // nothing"; the truth here is "nothing was recorded", and the two are acted
  // on differently. No chart may draw at all.
  await expect(figures(page).locator('svg')).toHaveCount(0);

  // Each one says so in its own words, naming what is missing.
  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-${id}`).locator('[role="status"]')).toHaveCount(1);
  }
  await expect(page.getByTestId('chart-indicators')).toContainText(/no requests were recorded/i);
  await expect(page.getByTestId('chart-concurrent-users')).toContainText(
    /no user activity was recorded/i,
  );
  await expect(page.getByTestId('chart-user-start-rate')).toContainText(
    /no user activity was recorded/i,
  );
  await expect(page.getByTestId('chart-percentiles')).toContainText(/no response times/i);
  await expect(page.getByTestId('chart-requests-per-second')).toContainText(
    /no requests were recorded/i,
  );
  await expect(page.getByTestId('chart-responses-per-second')).toContainText(
    /no responses were recorded/i,
  );

  // `/distribution` is the one endpoint that 404s rather than answering an
  // empty payload (ParityController: there is no histogram to read), so this
  // chart relays the server's own sentence instead of a transform's. Either
  // way the reader is told; only the wording differs.
  await expect(page.getByTestId('chart-distribution')).toContainText(/histogram/i);
});

test("every chart's data table is reachable by its own toggle", async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // WAIT FOR ALL FOUR PAYLOADS FIRST, which "all eight have drawn" proves.
  // A chart swaps from `RunDetail`'s loading figure to its real component when
  // its query resolves, and React remounts the subtree across that swap — so a
  // table opened before then is a table on an element about to be replaced, and
  // its disclosure state goes with it. That is a real (if brief) behaviour of
  // the page, not a test artefact; what it is not is what this test is about.
  await expect(figures(page).locator('svg')).toHaveCount(CHART_IDS.length);

  for (const id of CHART_IDS) {
    const table = page.getByTestId(`chart-data-${id}`);
    // Collapsed to begin with — eight always-announced tables of a hundred
    // numbers each is not an accessible page.
    await expect(table).not.toBeVisible();

    // The button that controls THIS table, found the way assistive tech finds
    // it: `aria-controls`. Picking the nth "Show data table" button by index
    // would assert nothing about which table it opens.
    const toggle = page.locator(`button[aria-controls="chart-data-${id}"]`);
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(table).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
});

/* ------------------------------------------------------------------ *
 * ⑨ the percentile chart's two controls — §13.2 ⑨ and §12.4
 *
 * These had NO test at any layer. `grep` across the unit and e2e suites found
 * no reference to `scale-toggle`, `band-*` or `PercentilesChart`, so changing
 * the default scale from log to linear left every suite green while shipping
 * the axis §11 says squashes every band below the 95th into a few pixels.
 * §9's falsification checkpoints are all numeric, and a control is not a
 * number — which is exactly how this got through.
 * ------------------------------------------------------------------ */

/** The legend's own labels: the series ECharts is actually drawing, in drawn
 *  order. Legend text is the only `text-anchor="start"` text these charts
 *  emit — value-axis ticks are `end`, category ticks and axis names `middle`. */
async function legendLabels(chart: Locator): Promise<string[]> {
  return chart.locator('svg text[text-anchor="start"]').allTextContents();
}

/** The value axis' tick labels — what a change of SCALE changes. */
async function valueAxisTicks(chart: Locator): Promise<string[]> {
  return chart.locator('svg text[text-anchor="end"]').allTextContents();
}

/**
 * All eight charts drawn, which proves all four payloads resolved.
 *
 * Required before touching a chart's own controls: a chart swaps from
 * `RunDetail`'s loading figure to its real component when its query resolves,
 * and React remounts across that swap — taking `PercentilesChart`'s `scale` and
 * `bands` state with it. A click landing before then is silently undone.
 */
async function settled(page: Page): Promise<void> {
  await expect(figures(page).locator('svg')).toHaveCount(CHART_IDS.length);
}

test('the percentile chart draws on a log axis by default, and the toggle really switches it', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');
  const toggle = page.getByTestId('scale-toggle-percentiles');

  // LOG IS THE DEFAULT. §11: ten bands from min to max on a linear axis push
  // every band below the 95th into a strip a few pixels tall, and the chart
  // becomes a picture of its own outliers.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // THE LABEL NAMES THE SCALE, NOT THE NEXT ACTION, and it does not move.
  //
  // It used to read "Log scale" when log was on and "Linear scale" when it was
  // off — the current state — while the outcome buttons drawn identically
  // beside it were labelled with the state they would SELECT. One row of
  // controls therefore read two ways at once, and there was no way to tell
  // from the label alone which convention any given button followed. The
  // control is now a switch: a fixed label, and the knob plus `aria-pressed`
  // carry the state. So this asserts the label is STABLE across the toggle,
  // which is the property that makes it unambiguous.
  await expect(toggle).toHaveText('Logarithmic');
  const logTicks = await valueAxisTicks(chart);
  expect(logTicks.length).toBeGreaterThan(1);

  // …and it is the AXIS that is log, not merely the label on a button. Asserted
  // as a rendered difference rather than against ECharts' tick algorithm, which
  // is not this app's to pin: the tick labels must change when the scale does.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // Same label, opposite state — see above.
  await expect(toggle).toHaveText('Logarithmic');
  await expect
    .poll(async () => (await valueAxisTicks(chart)).join('|') !== logTicks.join('|'))
    .toBe(true);

  // And back — a control that only goes one way is not a toggle, and the round
  // trip is what shows the first tick set was the log one rather than whatever
  // the axis happened to hold at first paint.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => valueAxisTicks(chart)).toEqual(logTicks);
});

test('the tooltip reads at the same precision the data table does', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  // THE TOOLTIP IS THE SURFACE A SIGHTED READER ACTUALLY USES — the table is
  // collapsed until asked for — and it was rendering ECharts' raw values:
  // `122.74516052680153` for a percentile whose parity tolerance is two
  // decimals. `Chart` now hands ECharts the same `formatCell` the table uses.
  const chart = page.getByTestId('chart-percentiles');
  await chart.locator('svg').hover({ position: { x: 300, y: 120 } });

  const tooltip = chart.locator('[_echarts_instance_] > div').nth(1);
  await expect(tooltip).toBeVisible();

  // PER ELEMENT, not over the tooltip's concatenated text. Six of these band
  // names are themselves numbers ("50%", "75%"), so a value and the next row's
  // name run together into `127.7575%` and any regex over the whole string
  // finds a false eight-digit number. ECharts renders each value in its own
  // element; reading them individually is the only honest way to ask how
  // precise they are.
  /*
   * THE UNIT COMES WITH THE NUMBER, and this used to ignore that.
   *
   * The old pattern was `/^-?\d+(\.\d+)?$/` — a BARE number, no suffix. Every
   * value row here renders as "284.33 ms", so no value ever matched it. The
   * one element that did was the tooltip's TITLE, which on a category axis was
   * the bare category label ("49"). So a test named for the precision of the
   * VALUES was in fact only ever asserting the precision of the title, and it
   * only came to light when the time axes became value axes and the title
   * stopped being a bare number.
   *
   * Matching the number at the START of an element and ignoring whatever unit
   * follows is what makes this assert the thing it is named for.
   */
  const values = (await tooltip.locator('span, div').allTextContents())
    .map((text) => text.trim())
    .map((text) => /^(-?[\d,]+(?:\.\d+)?)(?:\s|$)/.exec(text)?.[1])
    .filter((n): n is string => n !== undefined);

  // The premise: if the tooltip's structure ever changes so that no element
  // holds a number, this says so rather than passing over an empty list.
  expect(values.length, 'no numeric element found in the tooltip').toBeGreaterThan(0);

  for (const value of values) {
    const decimals = value.includes('.') ? value.split('.')[1]!.length : 0;
    expect(decimals, `tooltip renders ${value} at more than 2 decimals`).toBeLessThanOrEqual(2);
  }
});

test('the band selector adds and removes exactly the band it names', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');

  // The default six — a readable subset, and no more than the six hues the
  // categorical palette has.
  expect(await legendLabels(chart)).toEqual(['min', '50%', '75%', '95%', '99%', 'max']);

  await page.getByTestId('band-p50-percentiles').click();
  await expect(page.getByTestId('band-p50-percentiles')).toHaveAttribute('aria-pressed', 'false');
  // EXACTLY that one leaves, and the other five stay. A selector that redrew
  // the default set, or dropped the last band instead of the named one, passes
  // an assertion that only counted series.
  await expect.poll(() => legendLabels(chart)).toEqual(['min', '75%', '95%', '99%', 'max']);

  // Turning one on puts it in BANDS order, NOT in the order it was clicked —
  // 25% belongs between min and 75%, not at the end. `toPercentiles` promises
  // this and nothing in a browser had checked it.
  await page.getByTestId('band-p25-percentiles').click();
  await expect(page.getByTestId('band-p25-percentiles')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => legendLabels(chart))
    .toEqual(['min', '25%', '75%', '95%', '99%', 'max']);
});

test('the percentile table carries all ten bands while six are drawn', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');

  // Six DRAWN, because six is the DEFAULT SELECTION — ten lines on one axis is
  // more than a sighted reader can follow. It is no longer a palette limit:
  // the percentile ramp has a colour for all ten and the reader can select
  // them.
  expect(await legendLabels(chart)).toHaveLength(6);

  // TEN CARRIED. The table is the parity surface (§7) and the screen-reader
  // route to the same data, and D-7 requires ten — so it must not shrink
  // because a sighted reader narrowed the drawing. The table used to follow the
  // selection, which left the parity surface holding six of ten and no spec
  // reading it.
  const headers = await page
    .getByTestId('chart-data-percentiles')
    .locator('th[scope="col"]')
    .allTextContents();
  expect(headers).toEqual([
    'Elapsed (s)', 'min', '25%', '50%', '75%', '80%', '85%', '90%', '95%', '99%', 'max',
  ]);

  // Ten columns of real numbers, not ten headings over four empty columns.
  const rows = await readTable(page, 'percentiles');
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.cells).toHaveLength(10);
  }
  const p80 = rows.map((row) => row.cells[4]!.text).filter((text) => text !== '—');
  expect(p80.length).toBeGreaterThan(50);
});

test('selecting every band draws all ten, which the palette used to forbid', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');
  for (const band of ['p25', 'p80', 'p85', 'p90']) {
    const button = page.getByTestId(`band-${band}-percentiles`);
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  }

  await expect.poll(() => legendLabels(chart)).toHaveLength(10);
  // And no "showing 6 of 10" prose, because nothing was dropped.
  await expect(chart.getByText(/not drawn/)).toHaveCount(0);
});

test('deselecting every band explains itself rather than drawing an empty grid', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');

  for (const band of ['min', 'p25', 'p50', 'p75', 'p80', 'p85', 'p90', 'p95', 'p99', 'max']) {
    const button = page.getByTestId(`band-${band}-percentiles`);
    if ((await button.getAttribute('aria-pressed')) === 'true') await button.click();
  }

  // NOT a labelled grid with no marks. `empty` was set only from the payload's
  // bucket count, so an empty SELECTION drew 62 axis labels and zero series —
  // the picture that says "we measured this and there was nothing here", for
  // data that is entirely intact.
  await expect(chart.locator('svg')).toHaveCount(0);
  await expect(chart.locator('[role="status"]')).toHaveCount(1);
  await expect(chart).toContainText(/no percentile bands are selected/i);
  // Names the remedy: unlike every other empty state on this page, the reader
  // is one click from fixing it.
  await expect(chart).toContainText(/choose at least one band/i);

  // The parity surface survives the drawing being switched off, whole.
  const headers = await page
    .getByTestId('chart-data-percentiles')
    .locator('th[scope="col"]')
    .allTextContents();
  expect(headers).toHaveLength(11);
  expect(await readTable(page, 'percentiles')).not.toHaveLength(0);

  // One click back and it draws again.
  await page.getByTestId('band-p95-percentiles').click();
  await expect(chart.locator('svg')).toHaveCount(1);

  // A second band, and the legend appears with exactly those two — which also
  // pins the "a legend only from two series up" rule from the other side: with
  // p95 alone above, the chart draws and names itself in its title, and there
  // is no one-entry legend pretending to be a control.
  await page.getByTestId('band-p99-percentiles').click();
  await expect.poll(() => legendLabels(chart)).toEqual(['95%', '99%']);
});

/* ======================================================================== *
 * THE TIME WINDOW — a re-aggregation, not a redrawn axis
 * ======================================================================== */

interface WindowedStats {
  readonly stats: readonly { readonly scope: string; readonly family: string; readonly count: number }[];
  readonly window: { readonly fromMs: number; readonly toMs: number; readonly bucketWidthMs: number } | null;
}

const runRow = (body: WindowedStats): number =>
  body.stats.find((s) => s.scope === 'run' && s.family === 'response_time')!.count;

test('brushing recomputes the statistics, not just the axis', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // DERIVED FROM THE RUN ITSELF: the reference bundle's duration changes on
  // re-capture, so the cut is taken from the run's own series rather than
  // written down.
  const series = await apiJson<{ buckets: { startOffsetMs: number }[]; bucketWidthMs: number }>(
    page, `/v1/runs/${runId}/series?scope=run&name=&family=response_time`);
  const offsets = series.buckets.map((b) => b.startOffsetMs).sort((a, b) => a - b);
  const cut = offsets[Math.floor(offsets.length / 2)]!;

  const whole = runRow(await apiJson<WindowedStats>(page, `/v1/runs/${runId}/stats?scope=run&name=`));
  const part = runRow(await apiJson<WindowedStats>(
    page, `/v1/runs/${runId}/stats?scope=run&name=&from=0&to=${cut}`));

  // The numbers really move. An axis clip pretending to be a re-aggregation
  // would return the same count for both.
  expect(part).toBeGreaterThan(0);
  expect(part).toBeLessThan(whole);
});

test('the brush writes the window into the URL and states what it computed', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  const brush = page.getByTestId('time-brush');
  await expect(brush).toBeVisible();

  await page.getByTestId('window-from').fill('0');
  await page.getByTestId('window-to').fill('10');
  await page.getByTestId('window-apply').click();

  // In the URL, so the selection can be pasted into a ticket.
  await expect(page).toHaveURL(/[?&]from=0/);
  await expect(page).toHaveURL(/[?&]to=10000/);

  // And the page states the SNAPPED range it actually computed, not the one
  // that was typed.
  await expect(page.getByTestId('window-applied')).toBeVisible();

  // Clearing returns to the whole run.
  await page.getByTestId('window-clear').click();
  await expect(page).not.toHaveURL(/[?&]from=/);
});

test('the scrubber is a real chart, and it really draws a slider', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  // ONE `<svg>` in the strip's figure, exactly like every other chart. This is
  // the assertion that settles the question the design turned on: an ECharts
  // dataZoom draws INSIDE the single svg root its instance emits, so the
  // invariant nine other specs rest on is untouched by adding a slider.
  const strip = page.getByTestId('chart-time-window');
  await expect(strip.locator('svg')).toHaveCount(1);

  /**
   * AND THE SLIDER IS ACTUALLY THERE.
   *
   * This is not decoration: `DataZoomSliderComponent` was unregistered at
   * first, and ECharts DISCARDS an option for a component it does not know —
   * silently, with nothing in the console at the point of use. The strip
   * rendered as a perfectly ordinary chart. Asserting the option is a unit
   * test's job; asserting the registration takes a browser.
   *
   * Counted RELATIVE to a chart with no brush rather than against a magic
   * number, so it stays true as ECharts' internals change: the strip's bottom
   * band carries the slider's track, handles and range labels, and a plain
   * chart's carries only its axis.
   */
  const bottomBandCount = (testId: string) =>
    page.getByTestId(testId).locator('svg').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll('*')).filter((node) => {
        const r = node.getBoundingClientRect();
        return r.height > 0 && r.top > box.bottom - 45;
      }).length;
    });

  const withSlider = await bottomBandCount('chart-time-window');
  const withoutSlider = await bottomBandCount('chart-requests-per-second');
  expect(withSlider).toBeGreaterThan(withoutSlider);
});

/**
 * THE DRAG GESTURE, WHICH THIS SUITE ONCE ARGUED ITSELF OUT OF ASSERTING.
 *
 * The argument was that `Chart.test.tsx` pins the `datazoom` handler's mapping
 * from event to AXIS UNITS and on to `onChange`, so only pixels were left. It
 * was true and it was not enough: it establishes what the handler does with
 * the axis' units and says nothing about what those units ARE. `TimeBrush`
 * drew the category form — scalars, one per label — on a value axis, so
 * ECharts mapped each point onto both axes, the strip plotted requests/s
 * against requests/s as a straight 45° line, and the handles reported RATES.
 * Every unit test on both sides stayed green while a drag across the first
 * third of a 63 s run committed `?from=0&to=7` — seven milliseconds.
 *
 * Nothing that mocks the renderer can see that, because the mistake is in what
 * the renderer was asked to do. So the gesture is driven here, and the two
 * flakiness concerns above are answered rather than dismissed: the coordinates
 * are computed from the slider's OWN measured geometry (never written down),
 * and the assertion is about the SCALE of what came back — milliseconds, not
 * rate values — which no plausible imprecision in the drag can satisfy by
 * accident.
 */
test('dragging the scrubber commits a window in milliseconds, not axis noise', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  const strip = page.getByTestId('chart-time-window').locator('svg');
  await expect(strip).toHaveCount(1);

  // The run's real extent, from the run itself — the reference bundle's
  // duration moves on re-capture.
  const series = await apiJson<{ buckets: { startOffsetMs: number }[] }>(
    page, `/v1/runs/${runId}/series?scope=run&name=&family=response_time`);
  const endMs = Math.max(...series.buckets.map((b) => b.startOffsetMs));

  /**
   * THE HANDLE IS FOUND, NOT GUESSED — which is what answers the flakiness
   * objection this suite recorded against driving the gesture at all.
   *
   * zrender emits the slider with no class names and no stable hook, but it
   * emits it in a KNOWN BAND: the bottom of the strip's own box, inset from
   * the left by the grid's gutter (so `box.x + a few pixels` lands on nothing,
   * which is how this test first failed). The handles are the narrow nodes in
   * that band. Taking the leftmost narrow one gets the left handle wherever
   * the layout puts it, at any viewport and any font metrics.
   */
  const box = (await strip.boundingBox())!;
  const handle = await strip.evaluate((el, band) => {
    const root = el.getBoundingClientRect();
    const narrow = Array.from(el.querySelectorAll('path, rect'))
      .map((node) => node.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.width < 20 && r.top > root.bottom - band)
      .sort((a, b) => a.left - b.left);
    const first = narrow[0];
    return first ? { x: first.left + first.width / 2, y: first.top + first.height / 2 } : null;
  }, 40);
  expect(handle, 'expected to find the slider’s left handle in the strip').not.toBeNull();

  // Pull it about a third of the way into the run.
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, handle!.y, { steps: 12 });
  await page.mouse.up();

  // The window settles (SETTLE_MS) and is written once, to the URL.
  await expect(page).toHaveURL(/[?&]from=\d+/, { timeout: 5_000 });

  const params = new URL(page.url()).searchParams;
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));

  // THE SCALE IS THE ASSERTION. On the rate-valued axis this replaced, a drag
  // of any distance produced single- or double-digit values: `from=0&to=7`.
  // The right handle was never touched, so `to` is still the run's end.
  expect(to).toBeGreaterThan(endMs * 0.9);
  // And the left handle moved a real distance into the run, in milliseconds.
  expect(from).toBeGreaterThan(1_000);
  expect(from).toBeLessThan(to);

  // The page states the snapped range it computed, in seconds — the failure
  // this replaces reported "Showing 0s–1s" for every drag.
  await expect(page.getByTestId('window-applied')).toBeVisible();
});

/**
 * WHAT REMAINS COVERED ELSEWHERE: `Chart.test.tsx` pins the option the slider
 * is built from and the `datazoom` handler's mapping on to `onChange`;
 * `TimeBrush.test.tsx` pins that the numbers handed to that axis are elapsed
 * milliseconds spanning the run; the case above pins that the component is
 * registered and drawn; and the case below pins the whole path from a selected
 * window to recomputed numbers, through the fields that are also the keyboard
 * route.
 */
test('a run with no metrics is offered no brush at all', async ({ page }) => {
  // Its buckets carry no histograms, so every windowed call would 400. An
  // invitation to drag something that cannot work is worse than no invitation.
  const admin = await seedAdmin();
  const runId = await seedCompleteRunWithoutMetrics(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));

  await expect(page.getByTestId('time-brush')).toHaveCount(0);
});
