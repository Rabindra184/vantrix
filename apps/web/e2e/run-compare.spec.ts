import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { apiJson, plot, signIn } from './helpers.js';
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

/**
 * `useWindowControl`'s settle: how long a drag must stop before it is written.
 *
 * Restated rather than imported, because that module imports `../routes/window`
 * without an extension and this project's `nodenext` resolution refuses it.
 *
 * WHICH WAY DRIFT CUTS. Only the drag case leans on it: it waits four settles
 * for a late write, and `slowDrag` beats ~130 ms between moves. A LONGER
 * product settle (up to that ~1 s wait) is harmless. A SHORTER one is what
 * breaks it — below the beat, each move commits on its own and "written
 * exactly once" goes red on a correct product — so a change to the product's
 * value must be mirrored here. The Apply case's only use of it is a wait
 * four settles long, so a late write has time to land; what it ASSERTS rests
 * on the order of writes off the history recorder, not on this value.
 */
const SETTLE_MS = 250;

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

/**
 * The comparison table, by its exact name.
 *
 * `exact`, because Playwright matches a table's name as a SUBSTRING and this
 * page carries a second table — the overlay's data table — whose caption a
 * looser pattern has already collided with once (the matrix's own docstring).
 */
const MATRIX = 'Changes against the reference';

function matrix(page: Page): Locator {
  return page.getByRole('table', { name: MATRIX, exact: true });
}

/**
 * Each matrix column's run label, in the order the table draws them — the
 * reference first. Read from the label's own span, so the `Reference` tag and
 * the pin button beside it are not part of it, and the unit suffix is dropped.
 */
async function columnLabels(page: Page): Promise<string[]> {
  return matrix(page)
    .getByTestId('compare-column')
    .evaluateAll((ths) =>
      ths.map((th) => (th.querySelector('span[id]')?.textContent ?? '').replace(/\s\([^)]*\)$/, '')),
    );
}

/**
 * The `All requests` row's values, one per column, as each cell SHOWS its
 * value — the change chip beside it excluded, a dash for a missing figure.
 * Empty when the first row is anything else, so a caller comparing against
 * expected values cannot pass on the wrong row.
 */
async function allRequestsRow(page: Page): Promise<string[]> {
  // `evaluateAll`, which reads what is there NOW and never waits: this runs
  // inside `expect.poll`, and a read that waited for a row would spend the
  // poll's whole budget on one attempt.
  return matrix(page)
    .locator('tbody tr')
    .evaluateAll((trs) => {
      const tr = trs[0];
      if (tr === undefined || tr.querySelector('th')?.textContent !== 'All requests') return [];
      return Array.from(tr.querySelectorAll('td')).map(
        (td) => td.querySelector(':scope > span > span')?.textContent ?? td.textContent ?? '',
      );
    });
}

/**
 * The `All requests` row keyed by column label — or `{}` until every one of
 * `columns` columns has drawn. Keyed rather than ordered, so an expectation
 * built before the table settles cannot be built against the wrong order.
 */
async function allRequestsByLabel(page: Page, columns: number): Promise<Record<string, string>> {
  const labels = await columnLabels(page);
  const row = await allRequestsRow(page);
  if (labels.length !== columns || row.length !== columns) return {};
  return Object.fromEntries(labels.map((label, i) => [label, row[i]!]));
}

/** Every picker chip's run label, mapped to its run id. */
async function runIdsByLabel(page: Page): Promise<Map<string, string>> {
  const pairs = await page
    .locator('[data-testid^="compare-run-"]')
    .evaluateAll((chips) =>
      chips.map((chip): [string, string] => [
        (chip.getAttribute('aria-label') ?? '').split(' · ')[0]!,
        (chip.getAttribute('data-testid') ?? '').slice('compare-run-'.length),
      ]),
    );
  return new Map(pairs);
}

interface StatsJson {
  readonly stats: readonly {
    readonly scope: string;
    readonly family: string;
    readonly percentiles: Readonly<Record<string, number>>;
  }[];
}

/**
 * A run-scope percentile from the API itself, with the page's own session —
 * the independent half of every "the table shows the right number" claim
 * here. Exact runs answer an observed integer, which is how the table prints
 * it; anything else is a fixture that cannot distinguish two answers.
 */
async function runPercentile(page: Page, runId: string, key: string, query = ''): Promise<number> {
  const body = await apiJson<StatsJson>(page, `/v1/runs/${runId}/stats${query}`);
  const row = body.stats.find((s) => s.scope === 'run' && s.family === 'response_time');
  const value = row?.percentiles[key];
  if (value === undefined) throw new Error(`/stats${query} for ${runId} carried no ${key}`);
  expect(Number.isInteger(value), `${key} of an exact run is an observed integer`).toBe(true);
  return value;
}

/** The longest run's duration among `ids`: the overlay slider's extent. */
async function extentOf(page: Page, runId: string): Promise<number> {
  const trends = await apiJson<{ runs: { id: string; durationMs: number | null }[] }>(
    page,
    `/v1/runs/${runId}/trends`,
  );
  return Math.max(...trends.runs.map((run) => run.durationMs ?? 0));
}

/**
 * The overlay's slider, found in its own SVG — the same method
 * `run-charts.spec.ts` uses for the run page's scrubber, and for the same
 * reason: zrender emits it with no hooks, but in a KNOWN BAND at the bottom
 * of the figure. The handles are its narrow, full-height nodes; the track is
 * the widest node there. Measured in VIEWPORT coordinates, so the figure is
 * scrolled into view first — `page.mouse` does not scroll.
 *
 * `getBoundingClientRect` on the handles is safe on every engine here because
 * nothing below compares them to another node's edge within a pixel: Firefox
 * inflates a stroked path's client rect by its stroke, which moves a handle's
 * CENTRE by nothing and leaves a 6 px handle narrow.
 */
async function slider(page: Page): Promise<{
  left: { x: number; y: number };
  right: { x: number; y: number };
  track: { left: number; right: number };
}> {
  const svg = plot(overlay(page));
  await svg.scrollIntoViewIfNeeded();
  const found = await svg.evaluate((el) => {
    const root = el.getBoundingClientRect();
    const band = Array.from(el.querySelectorAll('path, rect'))
      .map((node) => node.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.top > root.bottom - 40);
    const handles = band.filter((r) => r.width < 20 && r.height >= 10).sort((a, b) => a.left - b.left);
    const track = band.reduce((widest, r) => (r.width > widest.width ? r : widest), band[0]!);
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    return handles.length < 2 || track === undefined
      ? null
      : {
          left: centre(handles[0]!),
          right: centre(handles.at(-1)!),
          track: { left: track.left, right: track.right },
        };
  });
  expect(found, 'expected the overlay slider’s two handles and its track').not.toBeNull();
  return found!;
}

async function drag(page: Page, from: { x: number; y: number }, toX: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(toX, from.y, { steps: 6 });
  await page.mouse.up();
}

/**
 * A drag a reader actually makes: several moves with a beat between them.
 *
 * ECharts throttles the slider's `datazoom` reports (100 ms by default), so a
 * drag that is over inside one throttle window reports ONCE whatever the page
 * does with it — and a "written once" assertion over it proves nothing about
 * the settle. Pausing ~130 ms per move makes each move its own report while
 * staying well inside the 250 ms settle, which is the gesture the settle
 * exists for. The page timestamps the moves, so the caller can check the beat
 * held rather than trust the runner's clock.
 */
async function slowDrag(page: Page, from: { x: number; y: number }, toX: number): Promise<void> {
  await page.evaluate(() => {
    const moves: number[] = [];
    (window as unknown as { __moves: number[] }).__moves = moves;
    document.addEventListener('mousemove', () => moves.push(performance.now()), true);
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const segments = 5;
  for (let i = 1; i <= segments; i += 1) {
    await page.mouse.move(from.x + ((toX - from.x) * i) / segments, from.y);
    if (i < segments) await page.waitForTimeout(130);
  }
  await page.mouse.up();
}

/** `from`/`to` off the current URL, `null` where absent. */
function windowParams(page: Page): { from: number | null; to: number | null } {
  const params = new URL(page.url()).searchParams;
  const read = (key: string) => (params.has(key) ? Number(params.get(key)) : null);
  return { from: read('from'), to: read('to') };
}

/** One view-state write the page made: its (from, to) pair and when. */
interface WindowWrite {
  /** `"<from>-<to>"`, or `''` when the URL carries no window. */
  readonly pair: string;
  /** `performance.now()` in the page. */
  readonly at: number;
}

/**
 * Records every write the page makes to its address, before it loads.
 *
 * Every view-state write on Compare goes through React Router's `replace`,
 * i.e. `history.replaceState`, so wrapping the history API sees each one —
 * timestamped in the page's own clock, so a case can ask what was written
 * BETWEEN two of the reader's actions rather than trusting a mirrored timer.
 */
async function recordWindowWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: { pair: string; at: number }[] = [];
    (window as unknown as { __windowWrites: typeof writes }).__windowWrites = writes;
    const record = (url: string | URL | null | undefined) => {
      if (url == null) return;
      const params = new URL(String(url), location.href).searchParams;
      const pair =
        params.has('from') || params.has('to') ? `${params.get('from')}-${params.get('to')}` : '';
      writes.push({ pair, at: performance.now() });
    };
    const replace = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      record(url);
      replace(data, unused, url);
    };
    const push = history.pushState.bind(history);
    history.pushState = (data, unused, url) => {
      record(url);
      push(data, unused, url);
    };
  });
}

async function windowWrites(page: Page): Promise<WindowWrite[]> {
  return page.evaluate(() => (window as unknown as { __windowWrites: WindowWrite[] }).__windowWrites);
}

/**
 * The distinct windows written, in order: a re-write of the window already in
 * the address is not a second window.
 */
function distinctWindows(writes: readonly WindowWrite[]): string[] {
  return writes.reduce<string[]>(
    (seen, write) => (seen.at(-1) === write.pair ? seen : [...seen, write.pair]),
    [],
  );
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

  // ═══ THE SUMMARY LEADS WITH THE DELTA (review.md 19) ═══
  //
  // "Summary cards then repeat the active selection and metric." A `Selected
  // runs` tile read `2` over "p95 across the active selection" — a number the
  // reader gets by counting the pressed chips directly above.
  //
  // ONLY THIS LAYER CAN SEE IT. `CompareSummary` renders only once the runs'
  // statistics have arrived, and the unit harness answers `/stats` with a body
  // that fails its schema — so a jsdom assertion that the tile is absent would
  // pass against a summary that never rendered at all.
  //
  // AND THE DELTA IS AGAINST THE REFERENCE, which is what the tile says now:
  // pinned on the current run it states the first other run against it, so a
  // label naming the current run as the subject would be false.
  const summary = page.getByRole('region', { name: 'Comparison summary' });
  await expect(summary.getByText('Change against the reference', { exact: true })).toBeVisible();
  await expect(summary.getByText(/baseline/i)).toHaveCount(0);
  await expect(summary.getByText('Selected runs')).toHaveCount(0);
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

/**
 * THE TICK MUST NOT DISCARD THE ANALYSIS WINDOW, AND ONLY A BROWSER SHOWS IT.
 *
 * `toggle` wrote `setParams({ runs })` — an OBJECT, which React Router reads as
 * the COMPLETE new search string — so ticking a run dropped `from`/`to` and
 * `metric` along with them. `RunCompare.test.tsx` pins the URL write itself;
 * what no unit case can reach is the RETURN JOURNEY, because `useWindowSuffix`
 * builds every tab link out of the current params. That is the seam, and this
 * is the case that crosses it.
 *
 * The loss was silent by construction: the brush is deliberately withheld on
 * Compare, so nothing on screen changed at the moment the window went.
 */
test('ticking a run keeps the analysis window, there and back', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(`${runComparePath(runId)}?from=0&to=10000`);
  await drawn(page);

  // The other run in the cohort — the current one is deliberately not
  // deselectable, so this is the only chip a reader can actually toggle.
  const others = page.locator('[data-testid^="compare-run-"]:not([disabled])');
  await expect(others).toHaveCount(1);
  await others.first().click();

  // The tick landed, AND the window it was made under survived it. Asserting
  // only the first is what let this ship: the existing toggle case checks
  // `runs=` and nothing else.
  await expect(page).toHaveURL(/[?&]runs=/);
  await expect(page, 'the window survived the tick').toHaveURL(/[?&]from=0/);
  await expect(page).toHaveURL(/[?&]to=10000/);

  // THE RETURN JOURNEY. The tab links are built FROM these params, so a window
  // dropped here is not hidden — it is gone from every tab that follows. The
  // Report is the tab that proves it: it is the one page that draws the window
  // (the Summary reads the whole run whatever the address says), so its
  // From field is where a lost window would show.
  await page
    .getByRole('navigation', { name: 'Run sections' })
    .getByRole('link', { name: 'Report', exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]from=0/);
  await expect(page.getByTestId('window-from')).toHaveValue('0');
});

/**
 * ═══ THE TABLE LEADS WITH THE REFERENCE AND MEASURES THE REST AGAINST IT ═══
 *
 * Gatling Enterprise's comparison table, not the old two-run grid with a
 * trailing Change column: the reference is the FIRST data column, every other
 * column carries its own change beside its value, and the summary rows come
 * before the requests. Each of those is a claim a layout can drop while still
 * drawing a table, so each is asserted rather than the table's existence.
 */
test('the matrix leads with the reference and measures the other run against it', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  // The table lives in its own scroll region, so a wide comparison scrolls
  // there rather than dragging the page sideways.
  const region = page.getByRole('region', { name: 'Reference comparison', exact: true });
  await expect(region.getByRole('table', { name: MATRIX, exact: true })).toHaveCount(1);

  const table = matrix(page);
  // The label column and one column per selected run — NO change column. A
  // change belongs to the run it measures, not to a column of its own.
  // Retrying, because each column appears as its run's /stats resolves.
  await expect(table.getByTestId('compare-column')).toHaveCount(2);
  await expect(table.locator('thead th')).toHaveCount(3);
  await expect(table.locator('thead th').first()).toHaveText('Request');

  // FIRST is the reference, and its header SAYS so in its accessible name —
  // the word a screen-reader user hears with every cell beneath it.
  const columns = table.getByTestId('compare-column');
  await expect(columns.first()).toHaveAttribute('data-reference', 'true');
  await expect(columns.first()).toHaveAccessibleName(/Reference$/);
  await expect(columns.nth(1)).not.toHaveAttribute('data-reference', 'true');
  // The reference is the one column without a pin: it is already pinned.
  await expect(columns.first().getByRole('button')).toHaveCount(0);
  await expect(columns.nth(1).getByRole('button', { name: /^Set .+ as reference$/ })).toHaveCount(1);

  // The summary row comes first, then a row per request.
  const rows = table.locator('tbody tr');
  await expect(rows.first().getByRole('rowheader')).toHaveText('All requests');
  expect(await rows.count()).toBeGreaterThan(2);
  await expect(rows.first().locator('td')).toHaveCount(2);

  /* AND THE CHANGE IS REAL, AND ON THE RIGHT SIDE. `cohortOfTwo` ingests the
     same bundle twice, so most rows move by nothing — a comparison of a run
     with its twin is exactly where a fabricated delta would hide. What must be
     true is that the measured column STATES a change (both runs have these
     requests, so "no measurement" is the one wrong answer) and that the
     reference, which is what the change is measured FROM, states none. */
  const cells = rows.first().locator('td');
  await expect(cells.nth(1).getByTestId('compare-change')).toHaveCount(1);
  await expect(cells.first().getByTestId('compare-change')).toHaveCount(0);
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
     them apart. This cohort is pipeline-seeded, so every run has a number now
     (spec 2026-09-27-run-number) and five distinct run numbers are what make
     them distinct — which five depends on the selection, since the page is
     opened from the sixth seeded run and that run is always among them.
     `compareLabels`' minute-collision suffix is the fallback for a run with
     none, which none of these are. */
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

  /* ═══ AND FIVE COLUMNS OF VALUES AND CHANGES FIT THE PAGE ═══
   *
   * The widest the comparison table gets, and the one width no unit case can
   * measure: every non-reference header carries a pin and every cell a change
   * chip beside its value. Whatever the table's own width, the PAGE must not
   * scroll sideways — the table scrolls inside its region, which is what that
   * region is for. Measured at the suite's own viewport. */
  await expect(matrix(page).getByTestId('compare-column')).toHaveCount(5);
  const region = page.getByRole('region', { name: 'Reference comparison', exact: true });
  await region.scrollIntoViewIfNeeded();
  const layout = await region.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const table = el.querySelector('table')!.getBoundingClientRect();
    return {
      documentScroll: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      regionRight: box.right,
      regionScroll: el.scrollWidth,
      tableWidth: table.width,
      overflowX: getComputedStyle(el).overflowX,
    };
  });
  expect(layout.documentScroll, 'the page itself does not scroll sideways').toBeLessThanOrEqual(
    layout.viewport,
  );
  expect(layout.regionRight).toBeLessThanOrEqual(layout.viewport);
  expect(layout.overflowX, 'a wider table scrolls inside its region').toBe('auto');
  // The table is held by the region: all of it lies within what the region
  // can scroll to, so nothing of it spills onto the page.
  expect(layout.tableWidth).toBeLessThanOrEqual(layout.regionScroll);
});

/**
 * ═══ CURRENT AND REFERENCE, NAMED, ON A REAL COHORT (review.md 17) ═══
 *
 * WHAT ONLY THIS LAYER CAN PROVE. `RunCompare.test.tsx` hands the picker a
 * cohort of its own making, so it shows the chips render what they are given.
 * Whether the page ARRIVES at a two-run selection — `parseCompareSelection`
 * prepending the current run and answering with its nearest neighbour, against
 * a cohort the trends endpoint really built — is a different question, and it
 * is the one that decides whether a reader ever sees either word.
 *
 * Both roles are asserted because either alone passes against the wrong page: a
 * picker that marked every chip Current satisfies the first, and one that
 * marked every chip Reference satisfies the second.
 */
test('the picker names which run is current and which is the reference', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  await expect(page.getByTestId(`compare-role-${runId}`)).toHaveText('Current');

  // Exactly one Reference, and with nothing pinned it is NOT the run the page
  // was opened from — and it is the run the table leads with, because the
  // chip, the tiles and the table are all built from one `resolveReference`
  // answer. A chip naming a different run would be labelling the wrong
  // evidence.
  const reference = page.locator('[data-testid^="compare-role-"]', { hasText: 'Reference' });
  await expect(reference).toHaveCount(1);
  await expect(page.getByTestId(`compare-role-${runId}`)).not.toContainText('Reference');
  await expect(page.locator('[data-testid^="compare-role-"]', { hasText: 'Baseline' })).toHaveCount(0);

  const referenceId = (await reference.getAttribute('data-testid'))!.slice('compare-role-'.length);
  const byLabel = await runIdsByLabel(page);
  await expect.poll(async () => byLabel.get((await columnLabels(page))[0] ?? '')).toBe(referenceId);
});

/**
 * ═══ A RANK THE PROJECT DOES NOT STORE, ANSWERED EXACTLY ═══
 *
 * p99.9 is not in the project's percentile set, so `/stats` carries it only
 * when the page asks for it with `?percentiles=`. Without the ask, the cell is
 * a dash — never a guess. What the browser proves here and nothing else can:
 * that the page really asks, and that the figure it then shows is the run's
 * OWN p99.9, the one the API answers for that run alone.
 *
 * Compared per COLUMN, through each column's label, because the table orders
 * columns by reference first rather than by selection.
 */
test('p99.9 on Compare equals the run’s own /stats p99.9', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  await page.getByLabel('Metric', { exact: true }).selectOption({ label: '99.9th percentile' });
  await expect(page).toHaveURL(/[?&]metric=p99\.9(&|$)/);

  // BOTH runs' chips, or the expectation below is `{}` — and so is the
  // table's answer until it settles, which would pass the poll at once.
  const byLabel = await runIdsByLabel(page);
  expect(byLabel.size, 'one label per run in the cohort').toBe(2);
  const expected: Record<string, string> = {};
  for (const [label, id] of byLabel) {
    expected[label] = String(await runPercentile(page, id, 'p99.9', '?percentiles=99.9'));
  }

  // Retried as a whole: the columns are rebuilt as each run's re-asked /stats
  // lands, and a one-shot read could sample the p95 table on its way out.
  await expect.poll(() => allRequestsByLabel(page, 2)).toEqual(expected);
});

/**
 * ═══ A PIN IS PART OF THE QUESTION, SO IT IS IN THE URL ═══
 *
 * Pinning the CURRENT run — the one run that is never the reference by
 * default, so the move is visible — puts its column first, names it Reference
 * in the header and in the picker (where it is both, and says both), and
 * writes `ref=` so a pasted link measures from the same run. The reload is the
 * proof that the pin lives in the address and not in component state.
 */
test('pinning a run moves it first and keeps it in the URL', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);
  await expect(matrix(page).getByTestId('compare-column')).toHaveCount(2);

  const byLabel = await runIdsByLabel(page);
  const currentLabel = [...byLabel].find(([, id]) => id === runId)![0];
  // Not already first, or the pin would move nothing.
  expect((await columnLabels(page))[0]).not.toBe(currentLabel);

  await matrix(page)
    .getByRole('button', { name: `Set ${currentLabel} as reference`, exact: true })
    .click();

  const expectPinned = async () => {
    await expect(page).toHaveURL(new RegExp(`[?&]ref=${runId}(&|$)`));
    await expect.poll(async () => (await columnLabels(page))[0]).toBe(currentLabel);
    const first = matrix(page).getByTestId('compare-column').first();
    await expect(first).toHaveAttribute('data-reference', 'true');
    await expect(first.getByTestId('compare-reference')).toHaveText('Reference');
    await expect(page.getByTestId(`compare-role-${runId}`)).toHaveText('Current · Reference');
  };

  await expectPinned();
  await page.reload();
  await drawn(page);
  await expectPinned();
});

/**
 * ═══ A TYPED WINDOW NARROWS THE TABLE, AND THE ADDRESS KEEPS IT ═══
 *
 * The fields are the keyboard path to the window, and the exact one. What only
 * a browser can show is the whole loop: the window reaches the URL in
 * milliseconds, every run's /stats is re-read for it, and the table then
 * carries THAT window's figures — the same ones the API answers for the same
 * window — rather than the whole run's.
 *
 * "Differs from the whole run for at least one run" is the vacuity guard: a
 * window the figures happened not to move under would let a page that ignored
 * the window pass the equality.
 */
test('a time range narrows the table and survives a reload', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(runComparePath(runId));
  await drawn(page);

  const byLabel = await runIdsByLabel(page);
  const whole: Record<string, string> = {};
  const windowed: Record<string, string> = {};
  for (const [label, id] of byLabel) {
    whole[label] = String(await runPercentile(page, id, 'p95'));
    windowed[label] = String(await runPercentile(page, id, 'p95', '?from=10000&to=40000'));
  }
  expect(
    [...byLabel.keys()].some((label) => whole[label] !== windowed[label]),
    'the window must move p95 for at least one run, or this case proves nothing',
  ).toBe(true);
  // And the page starts on the whole run, so the move below is the window's.
  await expect.poll(() => allRequestsByLabel(page, 2)).toEqual(whole);

  await page.getByTestId('compare-window-from').fill('10');
  await page.getByTestId('compare-window-to').fill('40');
  await page.getByTestId('compare-window-apply').click();
  await expect(page).toHaveURL(/[?&]from=10000(&|$)/);
  await expect(page).toHaveURL(/[?&]to=40000(&|$)/);

  const expectWindowed = () => expect.poll(() => allRequestsByLabel(page, 2)).toEqual(windowed);

  await expectWindowed();
  await page.reload();
  await drawn(page);
  await expect(page.getByTestId('compare-window-from')).toHaveValue('10');
  await expect(page.getByTestId('compare-window-to')).toHaveValue('40');
  await expectWindowed();
});

/**
 * ═══ THE OVERLAY'S SLIDER, DRIVEN BY A REAL POINTER ═══
 *
 * jsdom cannot drive an ECharts slider, so every claim about the gesture is a
 * claim only this layer can check: that a drag SETTLES before it is written
 * (one write for the whole gesture, not one per animation frame — each write
 * re-reads every run), and that the window it writes narrows all three
 * readers of it — the overlay, the table and the tiles.
 *
 * WRITES ARE COUNTED AT THE HISTORY API (`recordWindowWrites`), as distinct
 * (from, to) pairs in order: a re-write of the same window is not a second
 * window.
 */
test('a drag on the overlay settles into one window that narrows the chart, table and tiles', async ({
  page,
}) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);
  await recordWindowWrites(page);

  await page.goto(runComparePath(runId));
  await drawn(page);
  // The overlay's data table: one row per elapsed second, both runs drawn.
  const overlayTable = page.getByTestId('chart-data-compare-overlay');
  const overlayRows = overlayTable.locator('tbody tr');
  const firstElapsed = async () => Number(await overlayRows.first().locator('th').textContent());
  await expect(runsInTable(page)).toHaveCount(3);
  const wholeFirst = await firstElapsed();
  // Polled, not read once: `count()` is an immediate read with no waiting,
  // and a table still filling in would make the narrowing below compare
  // against a short baseline. The overlay draws only once every run's read
  // has answered, so a non-empty count here is the whole run's.
  await expect.poll(() => overlayRows.count()).toBeGreaterThan(0);
  const wholeRows = await overlayRows.count();

  const { left, track } = await slider(page);
  await slowDrag(page, left, track.left + (track.right - track.left) * 0.35);

  // THE GESTURE WAS THE ONE THE SETTLE IS FOR: long enough to span several of
  // ECharts' report windows, and never still for a whole settle — a machine
  // that stalled mid-drag would legitimately write twice, and is reported as
  // such here rather than as a product defect below.
  const moves = await page.evaluate(() => (window as unknown as { __moves: number[] }).__moves);
  const gaps = moves.slice(1).map((t, i) => t - moves[i]!);
  expect(moves.at(-1)! - moves[0]!, 'the drag spans several report windows').toBeGreaterThan(400);
  expect(Math.max(...gaps), 'the drag never paused for a whole settle').toBeLessThan(SETTLE_MS);

  await expect(page).toHaveURL(/[?&]from=\d+/, { timeout: 5_000 });

  // ONE window for the whole gesture, and nothing more once it has settled.
  // The wait is longer than a settle, so a late second write would land here.
  await page.waitForTimeout(SETTLE_MS * 4);
  const { from, to } = windowParams(page);

  /* AND IT IS THE WINDOW THE GESTURE ENDED ON. A page that wrote on every
     report would write the FIRST move's window, and that write redraws the
     overlay under the pointer and ends the drag — so it, too, writes exactly
     once. What tells the two apart is where the window starts: the drag
     ended 35% of the way along a track spanning the whole run (the axis is
     pinned to it), and only a settled write carries that. */
  const extent = await extentOf(page, runId);
  expect(Math.abs(from! - extent * 0.35), `from=${from} against 35% of ${extent}`).toBeLessThan(
    extent * 0.05,
  );
  expect(to).toBe(extent);

  const writes = distinctWindows(await windowWrites(page));
  expect(writes.filter((pair) => pair !== ''), 'the drag was written exactly once').toEqual([
    `${from}-${to}`,
  ]);

  // THE CHART: its first plotted bucket moved from the run's start to where
  // the window starts — the first whole-second bucket at or after `from`,
  // because a windowed /series selects the buckets that START inside it.
  await expect.poll(firstElapsed).toBeGreaterThan(wholeFirst);
  expect(Math.abs((await firstElapsed()) * 1000 - from!)).toBeLessThan(1000);
  expect(await overlayRows.count()).toBeLessThan(wholeRows);

  // THE TABLE: each run's figures for this window, as the API answers them.
  // Both runs named first, or `{}` would match a table that has not settled.
  const byLabel = await runIdsByLabel(page);
  expect(byLabel.size, 'one label per run in the cohort').toBe(2);
  const windowed: Record<string, string> = {};
  for (const [label, id] of byLabel) {
    windowed[label] = String(await runPercentile(page, id, 'p95', `?from=${from}&to=${to}`));
  }
  await expect.poll(() => allRequestsByLabel(page, 2)).toEqual(windowed);

  // THE TILES: the best p95 is the lowest of those same windowed figures.
  await expect(page.getByTestId('compare-best')).toHaveText(
    new RegExp(`^${Math.min(...Object.values(windowed).map(Number))} ms$`),
  );
});

/**
 * ═══ APPLY DURING A SETTLING DRAG KEEPS THE DRAG ═══
 *
 * The fields hold the window from BEFORE the gesture. Pressing Apply inside
 * the settle used to commit those stale fields and cancel the drag — the
 * reader's last gesture silently undone. Started from a window, so the stale
 * answer (10–40 s) is distinguishable from the dragged one.
 *
 * The guard is what keeps this honest: Apply has to land BEFORE the drag's own
 * write, or the drag commits first and the case proves nothing about the
 * race. It is read off the history recorder, in the page's clock: until the
 * click, nothing but the opening 10–40 s window may have been written. So it
 * needs no copy of the product's settle and cannot drift from it — and it
 * covers the whole gesture, not only the gap after the release, because a
 * short settle can commit while the pointer is still down (measured: at a
 * 20 ms settle the drag wrote 40 ms BEFORE its own mouseup).
 */
test('Apply pressed right after a drag commits the dragged window', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);
  await recordWindowWrites(page);

  await page.goto(`${runComparePath(runId)}?from=10000&to=40000`);
  await drawn(page);
  await expect(page.getByTestId('compare-window-from')).toHaveValue('10');

  const apply = page.getByTestId('compare-window-apply');
  await apply.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const clicked = { at: 0 };
    (window as unknown as { __applyClicked: typeof clicked }).__applyClicked = clicked;
    document
      .querySelector('[data-testid="compare-window-apply"]')!
      .addEventListener('click', () => (clicked.at = performance.now()), true);
  });

  const { left, track } = await slider(page);
  await drag(page, left, track.left + (track.right - track.left) * 0.03);
  await apply.click();

  const applyAt = await page.evaluate(
    () => (window as unknown as { __applyClicked: { at: number } }).__applyClicked.at,
  );
  expect(applyAt, 'the Apply click was recorded').toBeGreaterThan(0);
  const beforeApply = (await windowWrites(page)).filter(
    (write) => write.at < applyAt && write.pair !== '10000-40000',
  );
  expect(beforeApply, 'Apply must land before the drag’s own write').toEqual([]);

  // The dragged window, not the fields' 10–40 s, once everything has settled.
  await expect.poll(() => windowParams(page).from, { timeout: 5_000 }).not.toBe(10_000);
  await page.waitForTimeout(SETTLE_MS * 4);
  const { from, to } = windowParams(page);
  expect(from === null || from < 10_000, `dragged left of 10 s, got from=${from}`).toBe(true);
  expect(to).toBe(40_000);
});

/**
 * ═══ THE AXIS STAYS WHOLE, SO A NARROWED WINDOW CAN WIDEN AGAIN ═══
 *
 * The overlay's data is read for the window, so its own extent is only the
 * window. Left to auto-scale, the slider's track would shrink to the slice
 * and its handles would sit at the track's ends — no gesture could reach past
 * them. Pinning the axis to `[0, extent]` keeps the map whole while the
 * territory narrows: dragging each handle out to its end widens the window
 * back to the whole run.
 */
test('the overlay slider widens a narrowed window back to the whole run', async ({ page }) => {
  const { admin, runId } = await cohortOfTwo();
  await signIn(page, admin);

  await page.goto(`${runComparePath(runId)}?from=10000&to=40000`);
  await drawn(page);
  const extent = await extentOf(page, runId);
  expect(extent).toBeGreaterThan(40_000);

  // Right handle out to the track's end: the window reaches the run's end.
  const before = await slider(page);
  await drag(page, before.right, before.track.right + 4);
  await expect.poll(() => windowParams(page).to, { timeout: 5_000 }).toBe(extent);
  expect(windowParams(page).from).toBe(10_000);

  // Then the left handle out to the start: the whole run, which the URL
  // carries as no window at all.
  const after = await slider(page);
  await drag(page, after.left, after.track.left - 4);
  await expect(page).not.toHaveURL(/[?&]from=/, { timeout: 5_000 });
  await expect(page).not.toHaveURL(/[?&]to=/);
});
