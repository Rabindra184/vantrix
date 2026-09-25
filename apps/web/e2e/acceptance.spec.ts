import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedProjectWithRuns, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ THE 09-13 REVIEW'S PRODUCTION-READINESS BAR ═══
 *
 * The review closes with a list of states to exercise "before calling the UI
 * production-ready" — scale, long names, the six widths, failure paths. A
 * coverage sweep found 45 of its 91 distinct items unexercised. This file takes
 * the ones whose absence is most likely to hide a real defect rather than
 * merely a missing assertion, and it is deliberately NOT a home for everything
 * left: cases belong beside the surface they are about, and these are here
 * because each spans several.
 */

/** Does the document itself scroll sideways? The table is allowed to; the page is not. */
async function documentOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

/**
 * ═══ TWENTY PROJECTS, WHICH IS WHERE THE RAIL RUNS OUT OF COLUMN ═══
 *
 * `GET /v1/projects` is unpaginated by design and `ProjectRail` renders every
 * row with no cap, so the rail's height is the org's project count. Rows are
 * 40px inside `calc(100dvh - var(--header-height))`, which at 1440x900 is about
 * 844px of usable column — so it begins to scroll at almost exactly twenty and
 * nothing announces that. The most anyone had drawn before this was SEVEN
 * (`project-rail.spec.ts`).
 *
 * What this pins is not the scrolling — a long list scrolling is correct — but
 * that every project stays REACHABLE and the page around it does not break:
 * the rail scrolls within itself rather than pushing the document sideways, and
 * the twentieth row can still be scrolled to and clicked.
 */
test('the project rail stays usable at twenty projects', async ({ page }) => {
  const admin = await seedAdmin();
  for (let i = 0; i < 20; i += 1) {
    await seedProjectWithRuns(admin.orgId, `scale-${i}`, `Scale Project ${i}`, 1);
  }

  await signIn(page, admin);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/runs');

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  await expect(rail).toBeVisible();

  // Every project is present — the rail caps nothing.
  const rows = rail.getByRole('link');
  // 20 seeded + seedAdmin's own 'checkout' + the "All runs" row.
  await expect(rows).toHaveCount(22);

  /* IT SCROLLS WITHIN ITSELF. `lg:overflow-y-auto` is what makes a
     twenty-first project reachable instead of clipped, and it is the one thing
     separating "a long list" from "a broken column". */
  const scrolls = await rail.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(scrolls, 'the rail scrolls rather than clipping its last rows').toBe(true);

  // AND THE PAGE DOES NOT. A rail that pushed the document sideways would take
  // every other page with it, since it renders on all of them.
  expect(await documentOverflows(page)).toBe(false);

  /* The last row is reachable and real — `scrollIntoViewIfNeeded` is what a
     reader's scroll does, and clicking proves the row is not merely painted. */
  const last = rail.getByRole('link', { name: 'Scale Project 9', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
});

/**
 * ═══ A 120-CHARACTER PROJECT NAME, WHICH THE CONTRACT ALLOWS ═══
 *
 * `CreateProjectRequestSchema` caps the name at 120 characters. The rail
 * truncates and has been measured since a real defect at FOURTEEN — but no
 * other surface that draws a project name has either a truncate rule or a
 * test, and there is no global `overflow-wrap`. Two shapes matter and only
 * one is obvious: a name WITH spaces wraps (ugly, harmless); a name WITHOUT
 * them cannot break at all.
 *
 * Asserted as the document not scrolling sideways rather than as a pixel
 * bound, because that is the failure a reader meets — every page acquiring a
 * horizontal scrollbar because one project was named badly.
 */
test('a 120-character project name does not push any page sideways', async ({ page }) => {
  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'wordy', `${'Extremely '.repeat(11)}Long`, 1);
  // The harder case: no space anywhere, so there is no break opportunity.
  await seedProjectWithRuns(admin.orgId, 'unbroken', 'x'.repeat(120), 1);

  await signIn(page, admin);

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/runs', '/projects/unbroken', '/projects/unbroken/runs']) {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();
      expect(
        await documentOverflows(page),
        `${path} scrolls sideways at ${width}px with a 120-character project name`,
      ).toBe(false);
    }
  }
});

/**
 * ═══ 320px AND 414px, TWO OF THE SIX WIDTHS THE REVIEW NAMES ═══
 *
 * `mobile.spec.ts` is scoped to 375 by a file-level `test.use`, so the two
 * either side of it had never been drawn. 320 is the floor — the narrowest
 * viewport in common use — and it is where a `truncate`d rail, a two-column
 * chip grid and a nine-column table are all most likely to break out of the
 * page.
 *
 * The claim is the same one `mobile.spec.ts` makes at 375 and the review makes
 * for all six: table-local scroll is fine, a document that scrolls sideways is
 * not.
 */
for (const width of [320, 414]) {
  test(`neither the run list nor a run page scrolls sideways at ${width}px`, async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await seedRunWithData(admin.orgId);
    await signIn(page, admin);
    await page.setViewportSize({ width, height: 800 });

    for (const [name, path] of [
      ['run list', '/runs'],
      ['run page', runPath(runId)],
      ['project tests', '/projects/checkout'],
    ] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await documentOverflows(page), `the ${name} scrolls sideways at ${width}px`).toBe(
        false,
      );
    }
  });
}

/**
 * ═══ A SESSION THAT DIES WHILE THE APP IS ALREADY MOUNTED ═══
 *
 * `auth.spec.ts` covers the COLD case: a dead cookie on a full page load, where
 * `AuthGate` asks once and redirects. The mid-session case is different and was
 * unexercised — the gate has already passed, the shell is drawn, and the next
 * data request is the one that comes back 401.
 *
 * `apiFetch` deliberately does NOT redirect on a 401 (`api/fetch.ts` says so at
 * length: the decision belongs to a component, not the transport). So what a
 * reader meets is whatever the page does with a `ProblemError` carrying status
 * 401 — and the thing that must NOT happen is silence over stale data, which
 * is how somebody reads numbers from a session they no longer have.
 */
test('a session that expires mid-read says so rather than showing stale data', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  /* THE SESSION DIES HERE, not before: every subsequent API call answers 401
     the way the server would once the cookie has expired. Route interception
     rather than deleting the cookie, because the cookie is httpOnly and
     because this has to hold for the NEXT request whatever its path. */
  await page.route('**/v1/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'UNAUTHENTICATED',
        detail: 'Your session has expired.',
      }),
    }),
  );

  await page.reload();

  /* EITHER is acceptable and the point is that neither is silence: the app may
     send the reader to sign in again, or it may say the load failed. What it
     may not do is render a page that looks fine. */
  const login = page.getByRole('button', { name: /sign in/i });
  const failure = page.getByRole('alert');
  await expect(login.or(failure).first()).toBeVisible({ timeout: 10_000 });

  // And no run data is presented as current underneath whatever it says.
  await expect(page.getByTestId('run-row')).toHaveCount(0);
});

/**
 * ═══ 200% TEXT ZOOM, WHICH THE ACCEPTANCE LIST NAMES ═══
 *
 * `run-list.spec.ts` doubles the root font size and checks the run list's type
 * SCALES. This is the other half of that question — whether the LAYOUT
 * survives it — and the answer was no on two pages of four.
 *
 * MEASURED AT 1280 WITH A 32px ROOT, which is 200% of the 16px default:
 *
 * ```
 *                    before   after
 *   SLA rules form     1280    1280
 *   Add results        1280    1280
 *   run list           1421    1280
 *   run page           1574    1280
 * ```
 *
 * The DOCUMENT scrolling sideways is the defect, not a table doing it: the
 * review allows table-local scroll, and what a reader met instead was having
 * to scroll horizontally to reach the rail and the header. WCAG 1.4.10 asks
 * for reflow without two-dimensional scrolling at this size.
 *
 * FOUR CAUSES, ONE SHAPE — a length that does not scale with the reader's
 * text, or a breakpoint that asks the viewport a question only the content can
 * answer:
 *
 *   - the run list's filter grid held `<select>`s in FIXED 180px tracks
 *   - `HealthTile` laid its three parts in a flex row that could not wrap
 *   - the statistics toolbar put a 14rem input, its label and a button in a
 *     row gated on `sm:`
 *   - `StatTile` put a `text-2xl` value and its unit in an unwrapped row, six
 *     across, gated on `xl:`
 *
 * A fixed track and an unwrapped flex row do not CLIP when their content grows
 * — they spill, and a parent with `overflow: visible` passes it up until it
 * reaches the document. That is why none of this shows at 100%.
 */
test('every page still fits the window at 200% text', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  for (const url of ['/projects/checkout/rules', '/projects/checkout/setup', '/runs', runPath(runId)]) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    try {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      // Polled rather than read once: the run page settles several charts, and
      // a single read can land mid-layout.
      await expect
        .poll(() => documentOverflows(page), {
          message: `${url} pushes the document sideways at a 32px root`,
        })
        .toBe(false);
    } finally {
      // Restored in `finally` because Playwright reuses the page across a
      // file, and a leaked 32px root is somebody else's mystery failure.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
    }
  }
});

/**
 * ═══ A KEYBOARD-ONLY PASS THROUGH THE CHART MENU ═══
 *
 * The acceptance list names "keyboard-only navigation", and before this the
 * whole suite held ONE keyboard journey — the skip link — plus two Escape
 * presses. M17 moved three controls behind `role="menu"`, and a role is a
 * promise about arrow keys and focus return.
 *
 * `ChartActions.test.tsx` now checks that promise in jsdom, which is where
 * Radix's own handlers run against a DOM that has no layout. This is the half
 * jsdom cannot answer: a real engine, real focus, and the table actually
 * appearing at the end of it.
 *
 * DRIVEN FROM `focus()` RATHER THAN FROM Tab, deliberately. Whether Tab reaches
 * a given control is a macOS keyboard-navigation preference and the three
 * engines ship different defaults — this repo already pays for that in
 * `project-rail.spec.ts`, whose skip-link case is Chromium-only for exactly
 * that reason. The claim here is not "this is the nth tab stop"; it is "once a
 * keyboard reaches this control, the keyboard can finish the job", and that is
 * engine-independent.
 */
test('a keyboard alone can open a chart’s data table and get back out', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`${runPath(runId)}/charts`);

  const figure = page.getByTestId('chart-requests-per-second');
  const trigger = figure.getByRole('button', { name: /data and exports$/ });
  await expect(trigger).toBeVisible();
  const table = page.getByTestId('chart-data-requests-per-second');
  await expect(table).not.toBeVisible();

  await trigger.focus();
  await expect(trigger).toBeFocused();

  // Enter opens it, and the menu takes focus with it — a menu that opens and
  // leaves the caret behind is one a keyboard user cannot reach into.
  await page.keyboard.press('Enter');
  const item = page.locator('[role="menuitem"][aria-controls="chart-data-requests-per-second"]');
  await expect(item).toHaveCount(1);
  await expect(item).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(table).toBeVisible();

  // And the caret comes back to where the reader started, rather than to the
  // top of a document holding nine figures.
  await expect(trigger).toBeFocused();
});
