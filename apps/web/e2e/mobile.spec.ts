import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
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

  // The numbers moved up by what the brush was costing. Bound set just above
  // the 1110 this branch measures, from 1485 before it.
  await expect(page.getByTestId('stat-total-requests')).toBeVisible();
  const totals = await topOf(page, '[data-testid="stat-total-requests"]');
  expect(totals).toBeLessThan(1250);
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
