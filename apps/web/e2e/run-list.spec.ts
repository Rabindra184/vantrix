import { expect, test } from '@playwright/test';
import { seedAdmin, seedAdminForEmptyOrg, seedRunsAt } from './fixtures.js';
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

  // Without this, an empty list would satisfy the ordering assertion
  // trivially — the exact failure this test exists to prevent.
  expect(shown.length).toBeGreaterThan(1);
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

test('an empty org says so instead of showing an empty table', async ({ page }) => {
  const emptyOrgAdmin = await seedAdminForEmptyOrg();

  await signIn(page, emptyOrgAdmin);
  await expect(page.getByText(/no runs yet/i)).toBeVisible();
  // A table with a header row and nothing under it looks like a list that
  // failed to load, which is the confusion the empty state exists to remove.
  await expect(page.getByRole('table')).toHaveCount(0);
});
