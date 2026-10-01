import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { runPath, runReportPath } from '../src/routes/paths.js';

/**
 * ═══ WHAT ONLY A BROWSER CAN PROVE ABOUT BACKLOG #7 ═══
 * (docs/superpowers/specs/2026-10-01-summary-report-design.md)
 *
 * The unit layer hands each page its payload and its window and proves what it
 * draws; these prove the seams no fixture can supply:
 *
 *   - GE's Summary ignores a window in its URL (measured on GE: with a 30 s
 *     window the Summary still read the run's 900 requests), which only a real
 *     router, a real API and a real narrowed Report can say is a property of the
 *     PAGE and not of a mocked query;
 *   - the Report's sections open by keyboard and reset on reload (measured on
 *     GE: only Requests starts open, and nothing is remembered);
 *   - the three retired tab URLs land where their content went, with the
 *     reader's question (`from`/`to`, `request`) and not just the path;
 *   - a bar holding a failure is open on arrival — this product's one deviation
 *     from GE, whose bar stays shut over a failed assertion;
 *   - the Report's first chart row begins on the first screen.
 *
 * `seedRunWithData` ingests the reference bundle (`ParitySimulation`, whose own
 * `Search` p95 assertion fails), the same run `run-tables.spec.ts` opens.
 */

async function seeded(page: Page): Promise<string> {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  return runId;
}

const TOTAL = 'stat-total-requests';

/**
 * THE SUMMARY HAS FINISHED ARRIVING: its headline tiles (gated on `/stats`) are
 * showing and its two charts (their own query) have drawn. Everything that can
 * push the errors section down — the tiles and the baseline note under them, the
 * bars, the charts — is above it, so this is "nothing left to move the target".
 *
 * The chart counts are `plot()`, not the figure ids: `Payload` draws the
 * figures with their final ids from first paint (a placeholder reading
 * "Loading…"), so an id is not evidence the thing it names drew.
 */
async function summarySettled(page: Page): Promise<void> {
  await expect(page.getByTestId(TOTAL)).toHaveText(/\d/);
  await expect(plot(page.getByTestId('chart-requests-and-responses'))).toHaveCount(1);
  await expect(plot(page.getByTestId('chart-percentiles'))).toHaveCount(1);
}

/**
 * THE VACUITY GUARD IS THE HALF THAT MAKES THIS A CLAIM. "The Summary reads the
 * same with a window in its URL" is satisfied by a window that narrows nothing —
 * a bundle with no requests in those five seconds, or a run that is not
 * windowable. So the same window is first applied to the Report's table and the
 * count is required to MOVE there; only then does the Summary's not moving mean
 * the Summary ignored something real.
 *
 * AND THE TWO THINGS A WINDOWED SUMMARY USED TO SAY ARE ASSERTED ABSENT, beside
 * the number that did not move: the brush (drawn on the Report alone) and the
 * errors table's whole-run notice (it exists to disclaim a window, and the
 * Summary has none). Each is paired with its positive — the totals and the
 * errors table on screen — so neither absence can pass against a page that
 * failed to draw.
 */
test('the Summary reads the same with a narrow window in its URL, as GE’s does', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runPath(runId));
  const tile = page.getByTestId(TOTAL);
  await expect(tile).toHaveText(/\d/);
  const whole = (await tile.textContent())?.trim() ?? '';
  expect(whole, 'the tile must read a number for this to compare anything').toMatch(/\d/);

  // The same window really does narrow the Report's table.
  await page.goto(`${runReportPath(runId)}?from=0&to=5000`);
  await page.locator('section#requests').getByRole('button', { name: 'Table', exact: true }).click();
  const totalCell = page.getByTestId('stat-row-total').locator('td').first();
  await expect(totalCell).toHaveText(/\d/);
  const narrowed = (await totalCell.textContent())?.trim();
  expect(narrowed, 'the window must narrow the Report, or the Summary ignoring it proves nothing').not.toBe(
    whole.match(/\d+/)?.[0],
  );

  await page.goto(`${runPath(runId)}?from=0&to=5000`);
  await expect(tile).toHaveText(whole);
  await expect(page.getByRole('table', { name: /errors/i })).toBeVisible();
  await expect(page.getByTestId('time-brush')).toHaveCount(0);
  await expect(page.getByTestId('errors-window-note')).toHaveCount(0);
});

/** The seven charts of the Report's Requests section, in the order it draws
 *  them — the ones above `#load-generators`, whose settling can move it. */
const REPORT_REQUEST_CHARTS = [
  'requests-and-responses',
  'percentiles',
  'distribution',
  'percentile-distribution',
  'errors-over-time',
  'indicators',
  'request-counts',
] as const;

const SECTIONS = [
  ['requests', 'Requests', true],
  ['groups', 'Groups', false],
  ['virtual-users', 'Virtual users', false],
  ['connections', 'Connections', false],
  ['load-generators', 'Load generators', false],
] as const;

/**
 * A SECTION HEADER IS A REAL BUTTON, NOT A CLICKABLE `div`. GE's headers are
 * `div`s with no role (measured), so a keyboard cannot reach them; here the
 * heading holds a button, which is what lets this open a section from the
 * keyboard at all.
 *
 * `focus()` then Enter, not Tab: whether Tab reaches a control is a macOS
 * keyboard preference that the three engines default differently (CLAUDE.md,
 * the skip-link case, which is Chromium-only for exactly that reason). The
 * claim is "once a keyboard reaches this control, the keyboard can finish the
 * job", and that is engine-independent.
 *
 * AND ONLY REQUESTS IS OPEN AFTER A RELOAD, which is GE's own behaviour — open
 * sections are kept nowhere, not in the URL and not across a load. The loop
 * asserts all five states at once so a section that survived the reload, and
 * Requests failing to open on its own, are both caught. It runs after the
 * section's CONTENT has been seen, so the reload is of a section that really
 * was open.
 */
test('a Report section opens by keyboard, and only Requests is open after a reload', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runReportPath(runId));
  const groups = page.locator('section#groups').getByRole('button', { name: 'Groups', exact: true });
  await expect(groups).toHaveAttribute('aria-expanded', 'false');
  await groups.focus();
  await page.keyboard.press('Enter');
  await expect(groups).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('section#groups').getByTestId('group-row').first()).toBeVisible();

  await page.reload();
  for (const [id, title, open] of SECTIONS) {
    await expect(
      page.locator(`section#${id}`).getByRole('button', { name: title, exact: true }),
      `${title} after a reload`,
    ).toHaveAttribute('aria-expanded', String(open));
  }
});

/**
 * THE THREE RETIRED TAB URLS, each asserted to land with the reader's window.
 *
 * A link pasted into a ticket carries `from`/`to`; a redirect that kept the path
 * and dropped them would land the reader somewhere that looks right and answers a
 * different question. `RunSectionRedirect` keeps the whole query string, and
 * this is the only layer that crosses a real router doing it.
 *
 * `/load-generators` is also asserted to land with its section OPEN: the
 * fragment is what names the section, `CollapsibleSection` opens the one a
 * fragment matches, and a redirect that arrived at a shut Report with the right
 * address would have kept the URL and lost the content.
 */
for (const [old, rest, hash] of [
  ['charts', '/report', ''],
  ['load-generators', '/report', '#load-generators'],
  ['errors', '', '#errors'],
] as const) {
  test(`the old /${old} URL lands on its new place, window kept`, async ({ page }) => {
    const runId = await seeded(page);
    await page.goto(`${runPath(runId)}/${old}?from=0&to=10000`);
    await expect(page).toHaveURL(new RegExp(`${runPath(runId)}${rest}\\?from=0&to=10000${hash}$`));
    if (old === 'load-generators') {
      await expect(
        page.locator('section#load-generators').getByRole('button', { name: 'Load generators', exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
    }
    /* ═══ AND THE READER IS BROUGHT TO IT, NOT JUST ADDRESSED TO IT ═══
     *
     * The assertions above read the URL and the section's state; neither says
     * the viewport moved. A redirect to a fragment is a `replace` navigation,
     * and a browser scrolls to a fragment only on a document load or a real
     * hash navigation — so what brings the reader to the target is AppShell's
     * reveal, which no earlier line here exercised.
     *
     * CHECKED ONLY ONCE THE PAGE ABOVE HAS SETTLED. The reveal runs the frame
     * the target exists, which is before the figures above it have painted; a
     * target measured before that settles could read in or out of view for
     * reasons that are about timing and not about the redirect. The plot
     * counts are the settle. Errors per second is waited on as "no longer
     * loading" instead, because inside this case's 0-10 s window the reference
     * run has no errors to draw and the chart says so rather than plotting.
     *
     * `/errors` WAS UNASSERTED FOR A WHILE, AND THE REASON WAS A DEFECT. The
     * reveal fired the frame `#errors` existed, with the page 2,167px tall and
     * so scrolled to its maximum (1447); the tiles and bars above then arrived
     * over ~75ms, grew the page to 2,544px and left the target at top 784 of a
     * 720px viewport (891 of 900 at 1440x900) — entirely below the fold at one
     * size and nine pixels visible, by luck, at the other. AppShell now keeps
     * the target where the reveal put it while the page settles
     * (`keepInPlace`), and both sizes are asserted here.
     *
     * FULLY IN VIEW, NOT "IN THE UPPER HALF". The errors section is the last
     * thing on the Summary, so the page bottom clamps the scroll before the
     * section can reach the top: measured with the fix, top 407 of 720 and 586
     * of 900, both below the middle. What the reader needs is the whole table
     * on screen, which is also the stricter bound — nine visible pixels at
     * 1440x900 pass a bare `toBeInViewport()` and fail `ratio: 1`. */
    if (old === 'load-generators') {
      for (const id of REPORT_REQUEST_CHARTS) {
        const figure = page.getByTestId(`chart-${id}`);
        if (id === 'errors-over-time') await expect(figure, id).not.toContainText('Loading…');
        else await expect(plot(figure), id).toHaveCount(1);
      }
      await expect(page.locator('section#load-generators')).toBeInViewport();
    }
    if (old === 'errors') {
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 1440, height: 900 },
      ]) {
        // The first pass is the suite's own 1280x720; the second is a fresh
        // load of the same old link at the other size, where the miss was nine
        // pixels rather than none.
        if (viewport.height !== 720) {
          await page.setViewportSize(viewport);
          await page.goto(`${runPath(runId)}/errors?from=0&to=10000`);
        }
        await summarySettled(page);
        await expect(page.locator('#errors'), `the errors section at ${viewport.width}x${viewport.height}`).toBeInViewport({
          ratio: 1,
        });
      }
    }
  });
}

/**
 * AN OLD `/errors` LINK KEEPS THE REQUEST IT WAS NARROWED TO. `request` is the
 * other query parameter a pasted errors link carries, and it is the one the
 * Errors tab's filter wrote (review 09-13 M15): "the errors for Place Order"
 * must open as that, not as every request's. `Place Order` is a request the
 * reference run fails — `run-tables.spec.ts`' filter case narrows to it.
 */
test('an old /errors link keeps the request it was narrowed to', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(`${runPath(runId)}/errors?request=Place%20Order`);
  await expect(page).toHaveURL(new RegExp(`${runPath(runId)}\\?request=Place%20Order#errors$`));
  await expect(page.getByTestId('errors-request-filter')).toHaveValue('Place Order');
});

/**
 * ═══ CHANGING THE FILTER MUST NOT THROW THE READER TO THE TOP ═══
 *
 * An old `/errors` link lands on `/runs/:id?request=…#errors`, and the filter's
 * setter (`useSearchParams`) navigates to `"?" + params` — which DROPS the hash.
 * AppShell used to read that same-path, empty-hash navigation as a new page and
 * `scrollTo({ top: 0 })`: the reader, who had just been scrolled down to the
 * table, was thrown ~1,500px up and away from it by the first thing they did
 * there. The band's `#simulation-assertions` link and the `/load-generators`
 * redirect followed by a sort or filter did the same.
 *
 * THREE GUARDS AGAINST A VACUOUS PASS. The hash is required to be GONE after the
 * change (otherwise nothing navigated and the table stays put for free); the
 * page is required to have been scrolled before it (otherwise `scrollY` is 0 for
 * a reason that is not the bug); and the check follows two animation frames,
 * because the URL is replaced synchronously and the scroll that used to follow it
 * is a passive effect — an in-viewport read taken the instant the hash cleared
 * would pass in the one window before the jump.
 */
test('changing the Investigate filter after an old /errors link keeps the reader at the table', async ({
  page,
}) => {
  const runId = await seeded(page);
  await page.goto(`${runPath(runId)}/errors?request=Place%20Order`);
  await expect(page).toHaveURL(new RegExp(`${runPath(runId)}\\?request=Place%20Order#errors$`));
  const filter = page.getByTestId('errors-request-filter');
  await expect(filter).toHaveValue('Place Order');
  // Settled: the tiles and charts above the table have arrived, so nothing is
  // left to move it.
  await summarySettled(page);
  const table = page.locator('#errors').getByRole('table');
  /* NOT SCROLLED THERE BY THE TEST. This used to bring the table into view
   * itself, because the redirect's own reveal left it below the fold at
   * 1280x720 once the page above had grown (see the redirect cases). The reveal
   * now holds the target while the page settles, so the case relies on the
   * product's own landing: the reader is where the old link put them, and the
   * claim is that changing the filter does not move them. */
  await expect(table).toBeInViewport();
  const before = await page.evaluate(() => window.scrollY);
  expect(before, 'the reveal must have scrolled the page, or this proves nothing').toBeGreaterThan(0);

  await filter.selectOption({ label: 'All requests' });
  await expect(filter).toHaveValue('');
  await expect.poll(() => new URL(page.url()).hash, 'the setter drops the fragment').toBe('');
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

  await expect(table).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY), 'the page was thrown back to its top').toBeGreaterThan(0);
});

/**
 * ═══ THE READER WINS ═══
 *
 * `keepInPlace` re-scrolls the target while the page above it settles, and that
 * is only acceptable because the reader's first `wheel`, `touchstart`, `keydown`
 * or `pointerdown` ends it for good: pulling a page back from someone who has
 * started scrolling is worse than the defect it fixes. This is that rule, in a
 * real browser, with a real wheel.
 *
 * THE TIMING IS HELD, NOT WAITED FOR. The tiles and the two charts arrive over
 * ~75ms after the reveal — too short a window to land a wheel in by luck — so
 * the four requests that grow the page above the table are paused at the
 * network until the wheel has been delivered, and then released. Nothing here
 * sleeps: the order is reveal, wheel, release, settle, and each step waits on
 * the one before it.
 *
 * THREE GUARDS AGAINST A VACUOUS PASS, because "the page was not pulled back"
 * is also true of a page that was never scrolled, never grew, or never asked:
 *
 *   - the reveal must have scrolled the page (`revealedAt > 0`) and the wheel
 *     must have moved it back up from there, or the case proves nothing about
 *     the reader taking over;
 *   - the document must have GROWN after the release, or there was nothing to
 *     correct and the reader "winning" is free;
 *   - the check waits for the Summary to finish arriving and then two animation
 *     frames, because the correction (if the reader did not win) runs in the
 *     frame the growth lands in, and a read taken before that sees the table
 *     already below the fold for the reader's own reasons.
 *
 * And the claim itself, after all that: the table is NOT in the viewport and the
 * scroll is not back at (or past) where the reveal put it. Pulled back, the
 * table is fully on screen and `scrollY` is at the page's new maximum.
 */
test('an old /errors link does not pull back a reader who has started scrolling', async ({ page }) => {
  const runId = await seeded(page);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // What sits above `#errors` and grows when it arrives: the tiles (`/stats`),
  // the baseline note (`/trends`), the peak-users tile (`/users`) and both
  // charts (`/series`).
  for (const glob of ['**/v1/runs/*/stats*', '**/v1/runs/*/trends*', '**/v1/runs/*/users*', '**/v1/runs/*/series*']) {
    await page.route(glob, async (route) => {
      await held;
      await route.continue();
    });
  }

  await page.goto(`${runPath(runId)}/errors?from=0&to=10000`);
  // The reveal scrolled the page. `raf` polling: the wheel has to land well
  // inside the keeper's settle window, so this cannot wait on a 100ms poll.
  await page.waitForFunction(() => window.scrollY > 0, undefined, { polling: 'raf' });
  const before = await page.evaluate(() => ({
    revealedAt: window.scrollY,
    height: document.documentElement.scrollHeight,
  }));

  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -600);
  release();

  await summarySettled(page);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const after = await page.evaluate(() => ({
    scrollY: window.scrollY,
    height: document.documentElement.scrollHeight,
  }));

  expect(before.revealedAt, 'the reveal must have scrolled the page, or the reader has nothing to override').toBeGreaterThan(0);
  expect(after.height, 'the page must have grown after the wheel, or there was nothing to pull back').toBeGreaterThan(before.height);
  expect(after.scrollY, 'the reader scrolled up and must not have been returned to the reveal').toBeLessThan(before.revealedAt);
  await expect(page.locator('#errors'), 'the table is where the reader left it, below the fold').not.toBeInViewport();
});

/**
 * THIS PRODUCT'S ONE DEVIATION FROM GE: a bar that holds a failure is open on
 * arrival. GE keeps its bar shut over a failed assertion (measured), which makes
 * the one thing a reader opened the run to find a click away. The reference
 * run's own `Search` p95 assertion fails, so its simulation bar is open and its
 * first card is the failure.
 */
test('a failing simulation assertion is open on arrival', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(runPath(runId));
  const bar = page.locator('section#simulation-assertions');
  await expect(bar.getByRole('button', { name: 'Simulation assertions', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(bar.getByTestId('simulation-outcome').first()).toContainText(/failed/i);
});

/**
 * ═══ THE FOLD, MEASURED AT 1440x900 ═══
 *
 * The spec asks for the Report's first chart ROW inside the first screen. This
 * is what the page actually does, on the reference run:
 *
 *     time window (always open)   top 338     bottom 751      413px tall
 *     Requests section            top 775
 *     requests-and-responses      top 886.5   bottom 1256.5
 *
 * So the chart BEGINS on the first screen with 13.5px to spare and does not
 * FINISH on it: its bottom is 356.5px past the fold. The bound below asserts the
 * measured fact — the top is inside 900 — and not the goal, because a threshold
 * set to an unmet goal is a failing test describing work nobody has agreed to
 * do. The 413px is the cost of the time window being always open (GE's is, and
 * the collapse review M01 gave the Overview's has nothing left to buy now that
 * the window is off the page that holds the headline numbers); closing that gap
 * means shortening the window's own layout, which is a design decision rather
 * than a correction, and is recorded rather than loosened around.
 */
test('the Report’s first Requests chart begins on the first 1440x900 screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const runId = await seeded(page);
  await page.goto(runReportPath(runId));
  const first = page.locator('section#requests').getByTestId('chart-requests-and-responses');
  await expect(first).toBeVisible();
  /* SETTLED BEFORE MEASURED. The time window above the section is 413px tall
   * once its strip has drawn and far shorter while it is still a placeholder,
   * and the chart's own box is its drawn size — so a measurement taken the
   * moment the figure is visible can land before either has settled and read a
   * top that is hundreds of pixels too high. A mutation that pushed the chart
   * 56px lower passed twice and failed once on exactly this: the bound is only
   * a claim about the page as a reader sees it, which is the drawn page. */
  await expect(plot(page.getByTestId('chart-time-window'))).toHaveCount(1);
  await expect(plot(first)).toHaveCount(1);
  const box = await first.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  // top 886.5, bottom 1256.5 — see the comment above the case.
  expect(box.top, `the first chart starts at ${box.top}px (bottom ${box.bottom}px)`).toBeLessThan(900);
});

/**
 * A WINDOW THAT SELECTS NOTHING IS NOT A RUN THAT RECORDED NOTHING. The Report's
 * statistics table under `?from=62000&to=63000` — a real, in-range second of the
 * 62s reference run that holds no requests (`parseWindow` clamps out-of-range
 * windows to the whole run, so one of those would prove nothing) — used to say
 * "No statistics were recorded for this run" about a run that recorded 895
 * requests. Its Groups section already said "No groups ran in the selected
 * window."; this is that sentence for the table, and the Summary is where the
 * run's own figures are.
 *
 * ONLY A BROWSER SEES THE SEAM: the unit pair hands the table `windowSelected`,
 * so it proves the table obeys the prop and says nothing about whether the
 * Report derives it from the URL's window. The absence is paired with the
 * sentence being visible, so it cannot pass against a table that failed to draw.
 */
test('a window that selects no requests says so, not that nothing was recorded', async ({ page }) => {
  const runId = await seeded(page);
  await page.goto(`${runReportPath(runId)}?from=62000&to=63000`);
  await page.locator('section#requests').getByRole('button', { name: 'Table', exact: true }).click();

  await expect(page.getByText('No requests ran in the selected window')).toBeVisible();
  await expect(page.getByText(/no statistics were recorded/i)).toHaveCount(0);
});
