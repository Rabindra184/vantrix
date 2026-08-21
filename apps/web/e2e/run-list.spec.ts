import { expect, test } from '@playwright/test';
import { seedAdmin, seedAdminForEmptyOrg, seedRunsAt, seedRunWithData } from './fixtures.js';
import { firstRowId, signIn } from './helpers.js';

/**
 * The org run list — the first screen that shows a user their own data.
 *
 * EVERY test here seeds its own admin, and therefore its own org, rather than
 * sharing one from a `beforeAll`. That is not ceremony: these tests want
 * mutually incompatible row sets. The row-count test needs fewer rows than
 * one page, the pagination test needs more, and the ordering test needs a
 * specific pair of runs whose ingest order disagrees with their tool order.
 * A shared org would make each test's assertion depend on what the others
 * seeded, which with `fullyParallel: true` is a race, not a fixture.
 */

/**
 * Mirrors PAGE_SIZE in apps/web/src/api/runs.ts, rather than importing it.
 * This file typechecks under apps/web/e2e/tsconfig.json (`module: NodeNext`),
 * where src/api/runs.ts's own extensionless relative imports (`./fetch`) do
 * not resolve — importing the constant would break `pnpm typecheck` for the
 * sake of one number. Drift is loud rather than silent: if the app's page
 * size ever exceeds this, the pagination test's Next button stays disabled
 * and the click fails.
 */
const PAGE_SIZE = 25;

/**
 * An ISO-8601 UTC instant, the shape `Date.toISOString()` emits and the shape
 * `z.string().datetime()` pins in the contract. Asserting the FORMAT, not
 * merely that a string came back, is what stops the ordering test below
 * passing against a degenerate constant attribute.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

test('lists the org runs in a real table', async ({ page }) => {
  const admin = await seedAdmin();
  // Fewer than one page, so every seeded run is on the first page and the
  // row count is the whole list rather than a page of it.
  const seeded = [
    { startedAt: new Date('2026-05-01T10:00:00Z') },
    { startedAt: new Date('2026-05-02T10:00:00Z') },
    { startedAt: new Date('2026-05-03T10:00:00Z') },
  ];
  await seedRunsAt(admin.orgId, seeded);

  await signIn(page, admin);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(seeded.length + 1); // + header
});

/**
 * Sort and display must agree, or the list reads as mis-sorted.
 *
 * The seed is chosen so that displaying the WRONG field is detectable. Two
 * runs whose `toolStartedAt` merely differs from their `startedAt` are not
 * enough — the two ORDERINGS have to disagree, or a list rendering
 * `startedAt` while the server sorts by the coalesced value still comes out
 * descending and the test cannot tell the difference:
 *
 *   run   startedAt (ingest)   toolStartedAt (tool)   coalesced
 *   A     2026-03-01           2026-01-01             2026-01-01
 *   B     2026-01-01           2026-03-01             2026-03-01
 *
 * Correct descending order is B, A. By `startedAt` it is A, B — reversed. So
 * a list that displays `startedAt` renders [Jan, Mar], which is ascending,
 * and this test fails. C sits well before both, so the assertion has more
 * than a single pair to work with and a tiebreak-free tail.
 */
test('orders by the same value it displays', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunsAt(admin.orgId, [
    { startedAt: new Date('2026-03-01T00:00:00Z'), toolStartedAt: new Date('2026-01-01T00:00:00Z') },
    { startedAt: new Date('2026-01-01T00:00:00Z'), toolStartedAt: new Date('2026-03-01T00:00:00Z') },
    { startedAt: new Date('2025-01-01T00:00:00Z'), toolStartedAt: new Date('2025-01-01T00:00:00Z') },
  ]);

  await signIn(page, admin);
  await expect(page.getByRole('table')).toBeVisible();

  // The `datetime` attribute, not the cell's text: the rendered text is
  // localised ("1 Mar 2026, 00:00") and a lexicographic sort of it means
  // nothing. These are the API's own ISO-8601 UTC strings, which do sort
  // chronologically.
  const shown = await page
    .getByTestId('run-started')
    .locator('time')
    .evaluateAll((els) => els.map((el) => el.getAttribute('datetime')));

  // Three guards, not one, because the ordering assertion below is trivially
  // satisfied by any array equal to its own sort().reverse() — and several
  // broken renders produce exactly that:
  //   - a <time> that lost its datetime attribute yields [null, null, null];
  //   - a constant or malformed attribute yields ['', '', ''] or ['x', 'x', 'x'].
  // Each has length > 1 and each equals its own reverse-sort, so without
  // these the test would report success for a list whose order it cannot
  // observe at all.
  expect(shown.length).toBeGreaterThan(1);
  expect(shown.every((v) => typeof v === 'string' && ISO_8601_UTC.test(v))).toBe(true);
  expect(new Set(shown).size).toBe(shown.length);

  expect(shown).toEqual([...shown].sort().reverse());
});

test('follows the cursor to the next page', async ({ page }) => {
  const admin = await seedAdmin();
  // One more than a page, so there is a second page with exactly one row on
  // it and `nextCursor` on the first page is non-null.
  const base = Date.UTC(2026, 3, 1, 0, 0, 0);
  await seedRunsAt(
    admin.orgId,
    Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({ startedAt: new Date(base + i * 60_000) })),
  );

  await signIn(page, admin);
  const first = await firstRowId(page);
  await page.getByRole('button', { name: 'Next' }).click();
  // Polled, never a single read: the previous page's rows are still on
  // screen at the moment of the click, and `firstRowId` waits only for *a*
  // run-row to be visible — the stale one already is. A bare assertion here
  // would pass or fail on timing rather than on behaviour.
  await expect.poll(() => firstRowId(page)).not.toBe(first);
});

test('a badge does not leak its glyph into the row’s accessible name', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  // Chromium, not jsdom: dom-accessibility-api does not consult a descendant's
  // aria-hidden the way a real AT tree does, so this assertion is only
  // meaningful in a browser (CLAUDE.md).
  //
  // Located by column position, not by text containing "complete" — a
  // regex/substring name match would still find the cell even if the glyph
  // leaked into its accessible name, since "complete" would still appear
  // somewhere in "● complete". Started/Project/Simulation/Status/Verdict is
  // the column order RunList.tsx renders (RunRow), so index 3 is the status
  // cell.
  const statusCell = page.getByTestId('run-row').first().getByRole('cell').nth(3);
  await expect(statusCell).toBeVisible();
  // Exact match, not a substring: verified this catches the regression by
  // temporarily removing Badge's aria-hidden and re-running this test, which
  // failed with `Received: "● complete"` against `Expected: "complete"` — a
  // broken aria-hidden fails this exact-equality check instead of quietly
  // satisfying it.
  await expect(statusCell).toHaveAccessibleName('complete');
});

test('an empty org says so instead of showing an empty table', async ({ page }) => {
  const emptyOrgAdmin = await seedAdminForEmptyOrg();

  await signIn(page, emptyOrgAdmin);
  await expect(page.getByText(/no runs yet/i)).toBeVisible();
  // A table with a header row and nothing under it looks like a list that
  // failed to load, which is the confusion the empty state exists to remove.
  await expect(page.getByRole('table')).toHaveCount(0);
  // Nor any page controls: an org with no runs was being told "You have
  // reached the end of the list" beneath "No runs yet" — the end of a list it
  // had never walked. There is nothing to page through, so there is nothing
  // to page with.
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
});

test('a row link is named by the whole run id, not by its visible text', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);       // this suite's existing seed
  await signIn(page, admin);
  await page.goto('/runs');
  // Chromium's real accessibility tree — a <code> inside the link must not
  // pollute or replace the name the aria-label supplies.
  await expect(page.getByRole('link', { name: `View run ${runId}` })).toBeVisible();
});

/**
 * ONE "New project" LINK IN THE DOCUMENT, not two.
 *
 * `ProjectRail` renders on every authenticated page, so when it also carried
 * a "New project" row the `/runs` document held two links with the identical
 * accessible name — the rail's and the run list heading's. Playwright matches
 * `name` as a case-insensitive SUBSTRING and enforces strict mode, so this
 * very query resolved two elements and threw; a screen-reader user heard the
 * same action announced twice in one view.
 *
 * IT HAS TO BE AN E2E ASSERTION. jsdom renders one component at a time, so
 * neither `ProjectRail.test.tsx` nor a run-list unit test can see two
 * components colliding in one document — the unit suite stayed green for the
 * whole life of the bug. This is the same reason CLAUDE.md puts
 * accessible-name assertions in Playwright.
 *
 * `toHaveCount(1)`, never `toBeVisible()`: a duplicate that CSS happens to
 * hide is still in the accessibility tree and still breaks the query, so
 * counting is what actually pins the invariant.
 */
test('offers exactly one New project link on the org-wide list', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  // Paired positive: the rail is present, so this is about a duplicate name
  // rather than about a page that failed to render its chrome.
  await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New project' })).toHaveCount(1);

  // And the one that survives is the page heading's, which actually goes to
  // the create form.
  await expect(page.getByRole('link', { name: 'New project' })).toHaveAttribute(
    'href',
    '/projects/_new',
  );
});
