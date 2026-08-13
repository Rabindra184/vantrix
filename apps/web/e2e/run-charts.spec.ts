import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  seedAdmin,
  seedCompleteRunWithoutMetrics,
  seedPendingRun,
  seedRunWithData,
} from './fixtures.js';
import { signIn } from './helpers.js';

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
 * all eight in a shuffled order satisfies "the eight charts are present" and
 * fails the thing the section actually specifies.
 */
const CHART_IDS = [
  'indicators',
  'request-counts',
  'concurrent-users',
  'user-start-rate',
  'distribution',
  'percentiles',
  'requests-per-second',
  'responses-per-second',
] as const;

/** Every chart figure on the page, in document order. */
function figures(page: Page): Locator {
  return page.locator('figure[data-testid^="chart-"]');
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
 * Fetches an endpoint THROUGH THE PAGE'S OWN SESSION, so a parity assertion
 * reads exactly what the browser read — not a second request made with
 * different credentials, against which "the page agrees with the API" would be
 * a weaker claim than it looks.
 */
async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${p} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }, path);
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

test('a completed run shows the eight overview charts, in §13.2 order, below the assertions', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

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

  // BELOW the assertions panel, which is where §13.2 puts them: the SLA
  // verdict is what a reader opened the page for, and the charts are the
  // evidence under it. Compared through the headings rather than pixel
  // positions, so the check survives any layout change that keeps the order.
  const headings = await page.getByRole('heading').allTextContents();
  expect(headings.indexOf('Assertions')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Overview')).toBeGreaterThan(headings.indexOf('Assertions'));
});

test('every chart actually draws — the real ECharts renders SVG marks for all eight', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

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

test("the requests/s and responses/s tables carry the API's own numbers, on their own edges", async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

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
  await page.goto(`/runs/${runId}`);

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
  await page.goto(`/runs/${runId}`);

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
  // stale reading of a chart nobody is hovering.
  await page.getByRole('heading', { name: 'Overview' }).hover();
  await expect.poll(() => users.locator(AXIS_POINTER).count()).toBe(0);
});

test('a processing run mounts no charts at all', async ({ page }) => {
  const admin = await seedAdmin();
  // A pending run no worker will ever pick up: `GET /v1/runs/:id` answers 202.
  const runId = await seedPendingRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

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
  await page.goto(`/runs/${runId}`);

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
  await page.goto(`/runs/${runId}`);

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
