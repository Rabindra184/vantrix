import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedIncompleteRun, seedRunWithData, seedRunWithProvenance } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ REVIEW M18, IN THE ONLY PLACE IT CAN BE CHECKED ═══
 *
 * The finding is geometric: "at 375px the first run table begins around
 * y=1123… the basic decision must fit in the initial mobile screen". Every
 * unit test in this repo runs in jsdom, which lays everything out at 0x0 — the
 * same reason CLAUDE.md records that `m-auto` on a `<dialog>`, a `truncate`d
 * rail name and the decision band's collapsed column were all invisible to a
 * green suite. A height claim needs a browser with a real viewport.
 *
 * MEASURED HERE before the change, at 375x812 against a seeded run:
 *
 *   run list    first row            y=908   (table scrolled sideways too)
 *   run page    run's own totals     y=1485
 *   run page    p95                  y=1801
 *   run page    time brush           394px, between the decision and the numbers
 *
 * ═══ THE THRESHOLDS ARE THE MEASUREMENT, NOT THE GOAL ═══
 *
 * Each bound below is set just above what this branch actually achieves, so it
 * catches a regression and does not describe work nobody has agreed to do.
 * That is the same discipline the run-page reading-order branch used when M01's
 * own acceptance was not met: a threshold set to the goal rather than to the
 * measurement is a failing test pretending to be a plan.
 */

// 375x812 — the width the review measured at, and the one `useIsCompact`
// decides on (`max-width: 767px`). `test.use` at file scope, so every case
// below runs on it; a `test.skip` at this level would drop the whole file
// instead, which CLAUDE.md records costing a suite its coverage silently.
test.use({ viewport: { width: 375, height: 812 } });

/** The distance from the top of the document to an element's top edge. */
async function topOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return Math.round(box.top + window.scrollY);
  });
}

test('the run list shows a run without scrolling, and does not scroll sideways', async ({
  page,
}) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  await expect(page.getByTestId('run-row').first()).toBeVisible();

  /* ═══ THE ASSERTION THE FINDING IS ABOUT ═══
   *
   * Not "a row exists" — one did before, at y=908 on an 812px screen, which
   * is a list whose every run is below the fold. */
  const firstCard = await topOf(page, '[data-testid="run-row"]');
  expect(firstCard, 'the first run is within the initial screen').toBeLessThan(700);

  // A TABLE OF NINE COLUMNS IS NOT A MOBILE LAYOUT, and `overflow-x` on it is
  // not a fix: p95 and Errors — the two columns triage turns on — were off the
  // right edge. The cards carry them, so no table is rendered at this width.
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.getByTestId('run-p95').first()).toBeVisible();
  await expect(page.getByTestId('run-error-rate').first()).toBeVisible();

  // And the document itself never scrolls horizontally. The review notes the
  // measured root did NOT overflow before, so this is a guard on the new
  // layout rather than a repair — a card with a long simulation class in it is
  // exactly the thing that would break it.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflows).toBe(false);
});

test('the filters are folded away until something is filtering', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto('/runs');
  const filters = page.getByTestId('compact-filters');
  await expect(filters).toBeVisible();
  // Closed: the control is one tap away and its 314px is not spent by default.
  await expect(filters).not.toHaveAttribute('open', /.*/);

  /* OPEN WHEN A FILTER IS ON, because a shortened list under a closed control
     is a list that looks like it is missing runs — and a filtered link is
     exactly the link most likely to be opened on a phone. */
  await page.goto('/runs?status=complete');
  await expect(page.getByTestId('compact-filters')).toHaveAttribute('open', /.*/);
});

test('a run page leads with its decision and mounts no drag control', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  await expect(page.getByTestId('decision-word')).toBeVisible();

  // THE BASIC DECISION IN THE INITIAL SCREEN — the review's own wording, and
  // the one acceptance that is a hard bound rather than a direction.
  const decision = await topOf(page, '[data-testid="decision-word"]');
  expect(decision, 'the verdict is on the first screen').toBeLessThan(600);

  /* THE BRUSH IS A DRAG CONTROL AND IT IS NOT MOUNTED HERE. 394px of it sat
     between the decision and the run's own numbers; §22.6 already calls deep
     analysis a desktop task and dragging is the gesture a phone is worst at.
     `toHaveCount(0)`, not "not visible": the point is that no ECharts instance
     is built at all, which is what `DesktopOnly`'s function-children contract
     exists to guarantee elsewhere. */
  await expect(page.getByTestId('time-brush')).toHaveCount(0);

  /* ═══ THE NUMBERS' TOP, AND THE BOUND IS THE VIEWPORT NOW ═══
   *
   *     1485  as found
   *     1110  once the brush stopped mounting here (M18)
   *      928  after C01 shortened the decision band
   *      876  after M02 withheld the band's prose restatement on a phone
   *      802  after M02 folded the header's secondary metadata away
   *      812  the viewport
   *
   * Every earlier bound in this file was the MEASUREMENT rather than the goal,
   * because the goal was unmet and a threshold set to an unmet goal is a
   * failing test describing work nobody agreed to do. This is the first one
   * where the two meet: 802 against an 812 viewport, so the bound is 812 and
   * it is the thing M02 is about rather than a waypoint towards it.
   *
   * TEN PIXELS OF HEADROOM, AND WHAT IT DOES NOT COVER. `seedRunWithData`
   * ingests `{ tool: 'gatling', waitMs: 0 }` and no provenance, so this run
   * draws four chips. A run carrying environment, branch and commit draws
   * seven, and its metadata box measures 96px against this one's 44 — putting
   * its totals near 854, still inside the second screen rather than the first.
   * Measured, both, rather than inferred; the case below is the one that seeds
   * provenance, and it asserts placement rather than height for that reason. */
  /* ANCHORED ON THE FIRST TILE, ASKED OF THE DOM RATHER THAN NAMED.
   *
   * This measured `[data-testid="stat-total-requests"]`, which was the first
   * tile when the bound was written and is the FOURTH since the 09-13
   * review's target layout put p95 first. The claim above is about where the
   * numbers START; naming one tile quietly made it a claim about the Requests
   * tile's position, so a reorder that moved nothing a reader cares about —
   * the section's top and its first row are unchanged — dropped Requests to
   * the second row of the two-column grid and failed a bound with ten pixels
   * of headroom.
   *
   * `dd[...]`, not `[data-testid^="stat-"]` alone: the empty-window branch
   * names its own SECTION `stats-empty-window`, which that prefix also
   * matches. The tiles' testids are on their `<dd>` values, which is also what
   * the 802 measurement above was taken from, so this stays apples-to-apples
   * with the history.
   *
   * This is `run-list.spec.ts`'s `.nth(3)` lesson one file over: derive the
   * handle from the relationship the assertion is about, and it does not rot
   * when the thing it names moves. */
  const firstTile = 'section[aria-label="Run totals"] dd[data-testid^="stat-"]';
  await expect(page.locator(firstTile).first()).toBeVisible();
  const totals = await topOf(page, firstTile);
  expect(totals, 'the run’s own numbers start inside the first screen').toBeLessThan(812);
});

/**
 * ═══ REVIEW M02 — THE PROSE THAT REPEATED THE ROWS ═══
 *
 * The band stated its outcomes as labelled rows (then Execution, Platform
 * gates and Simulation checks — the lifecycle strip has since taken
 * Execution) and then restates them in a sentence: on a run with no
 * rules it read "This run completed, but no SLA rule produced a release
 * verdict" directly above a row saying "Platform gates — not configured". One
 * fact twice, in 42px of the 424px that WAS the whole first screen on a phone.
 *
 * WITHHELD ONLY WHERE IT IS A RESTATEMENT. When a gate has failed the band
 * shows that gate's own message instead, which names a rule and is never a
 * summary of the rows — so it survives at every width. That distinction is the
 * case below, and it is the one worth guarding: a blanket `max-sm:hidden`
 * would silently drop the one sentence that says WHY a run failed.
 */
test('the phone keeps the failing gate’s own message, and drops only the summary', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const band = page.getByRole('region', { name: 'Release decision' });
  await expect(band).toBeVisible();

  /* HIDDEN, NOT ABSENT — and the assertion has to know the difference.
     `max-sm:hidden` is `display: none`, and `toContainText` reads
     `textContent`, which includes text no one can see. The first version of
     this case asserted the substring was gone and failed against a product
     that was already correct: the band measured 424px -> 372px at 375, so the
     paragraph WAS hidden. Same shape as the `truncate` lesson CLAUDE.md
     records — `textContent` is identical whether a string is clipped, hidden
     or shown, so only a visibility check can see this. */
  await expect(page.getByTestId('decision-detail')).toBeHidden();

  // The rows it restates are still there, which is the half that makes
  // dropping it honest rather than lossy.
  await expect(band).toContainText('Platform gates');
  await expect(band).toContainText('Simulation assertions');
  // What the run itself did is the lifecycle strip's now, one line on a phone.
  await expect(page.getByRole('region', { name: 'Run lifecycle' })).toBeVisible();
});

/**
 * WITHHOLDING THE CONTROL IS NOT IGNORING THE WINDOW, and this is the half a
 * browser is needed for: the query string has to survive a real navigation and
 * a real router, and the narrowed data has to come back from the real API.
 *
 * A phone reader who follows a narrowed link keeps the narrowed view — that is
 * why the link was sent — and is told what they are looking at, with the one
 * action they cannot otherwise perform.
 */
test('a narrowed link still narrows on a phone, and says so', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`${runPath(runId)}?from=10000&to=30000`);

  const notice = page.getByTestId('compact-window-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('10–30 s');

  // The one control that cannot be reconstructed without a brush: widen back.
  await notice.getByRole('button', { name: 'Show whole run' }).click();
  await expect(page.getByTestId('compact-window-notice')).toHaveCount(0);
  await expect(page).toHaveURL((url) => !url.searchParams.has('from'));
});

/**
 * ═══ REVIEW M02 — WHAT THE HEADER LEADS WITH ═══
 *
 * "Keep run name, environment, outcome, and primary metrics BEFORE secondary
 * metadata." The chip strip put seven values between the `<h1>` and the
 * decision band; six of them now sit behind a disclosure on a phone, and
 * ENVIRONMENT does not, because the finding names it beside the run name and
 * the outcome — and because it decides what every number below it means.
 *
 * ═══ WHY THIS CANNOT BE A UNIT CASE, AND WHAT IS ═══
 *
 * jsdom applies no CSS, so a closed `<details>` keeps every child queryable
 * there: `RunHeader.test.tsx` can prove the chips are INSIDE the disclosure
 * and cannot prove a reader does not see them. Only a browser can, and the
 * assertion has to be `toBeHidden()` — never `toHaveCount(0)`, and never a
 * `toContainText` absence, which reads `textContent` and includes text no one
 * can see. That correction cost M02's own first half a round: its guard passed
 * against a product that was already right.
 *
 * SEEDS PROVENANCE, unlike every other case in this file. `seedRunWithData`
 * posts no environment, branch or commit, so on that run the three chips this
 * is about do not exist and every assertion below would pass vacuously.
 * `seedRunWithProvenance` writes the run row directly and attaches no metrics,
 * which is why this case asserts placement and the case above asserts height.
 */
test('a phone leads with the environment and folds the rest one tap away', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithProvenance(admin.orgId, {
    environment: 'staging',
    branch: 'release/24.8',
    commitSha: 'abc1234def5678',
  });
  await signIn(page, admin);
  await page.goto(runPath(runId));

  // OUTSIDE the disclosure and on screen without a tap — the half of the
  // finding that says which value is primary.
  await expect(page.getByTestId('run-environment')).toBeVisible();
  await expect(page.getByTestId('run-environment')).toHaveText('staging');

  const metadata = page.getByTestId('run-metadata');
  await expect(metadata).not.toHaveAttribute('open', /.*/);
  // Present in the DOM and unread — the distinction jsdom cannot draw.
  await expect(page.getByTestId('run-branch')).toBeHidden();
  await expect(page.getByTestId('run-commit')).toBeHidden();

  // ONE TAP AWAY, not withheld. Nothing a phone reader could see before this
  // change is unreachable after it, which is what makes folding honest rather
  // than lossy — the same standard M02's first half had to meet.
  await page.getByTestId('run-metadata-toggle').click();
  await expect(page.getByTestId('run-branch')).toBeVisible();
  await expect(page.getByTestId('run-commit')).toBeVisible();
  await expect(page.getByTestId('run-duration')).toBeVisible();
});

/**
 * ═══ AN INCOMPLETE RUN, ON A PHONE ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * The decision band's Execution row used to say "the stream stopped early",
 * and it is gone; the lifecycle strip's one phone line is the only place left
 * to say it. Its first rule showed the furthest step reached, which on an
 * incomplete run is always Processing — so a phone read "Nothing retained",
 * with nothing saying the test was cut short. Found by the whole-branch
 * review; no layer had tested a phone and an incomplete run together.
 */
test('an incomplete run says its load test stopped early on a phone', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedIncompleteRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const strip = page.getByRole('region', { name: 'Run lifecycle' });
  await expect(strip.getByRole('listitem')).toHaveCount(1);
  await expect(strip.getByRole('listitem')).toContainText(/stopped early/i);
});
