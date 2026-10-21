import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData, settleVerification } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ WHERE GATLING'S REPORT DIFFERS, IN A BROWSER ═══
 * (exact statistics PR 4)
 *
 * The unit layer hands the panel its record; this proves the seam — a
 * `run_verification` row through the real `GET /v1/runs/{id}/verification`,
 * whose contract parse the differences must survive, to the table in the
 * header mark's panel. The row is written by `settleVerification`, because no
 * verify job runs in this harness.
 */
const TABLE_NAME = 'Differences from Gatling’s report';

/** Opens the run's verification panel and waits until it has loaded. */
async function openVerification(page: Page, runId: string) {
  await page.goto(runPath(runId));
  await page.getByTestId('run-verification').click();
  const panel = page.getByRole('dialog', { name: 'Verification' });
  // Loaded, not merely open: the record's own figure count is on screen.
  await expect(panel).toContainText(/Figures checked\s*1482/);
  return panel;
}

test('the verification panel lists where Gatling’s report differs, as a range', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await settleVerification(runId, [
    { scope: 'request', name: 'Search', population: 'all', figure: 'p95', gatlingLow: 2389, gatlingHigh: 3410, exact: 2401 },
  ]);
  await signIn(page, admin);

  const panel = await openVerification(page, runId);
  // EXACT: Playwright matches a name as a case-insensitive substring.
  const table = panel.getByRole('table', { name: TABLE_NAME, exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['Request', 'Figure', 'Gatling’s report', 'PerfPortal']);
  const row = table.getByRole('row').nth(1);
  await expect(row.getByRole('cell')).toHaveText(['request · Search', 'p95', '2389–3410', '2401']);

  // The ⓘ is a popover inside a popover: opening it must not dismiss the
  // panel it sits in, and it shows the copy.
  await panel.getByRole('button', { name: 'About differences from Gatling’s report' }).click();
  await expect(page.getByRole('dialog', { name: 'About differences from Gatling’s report' })).toContainText(
    'its estimate can change between two reports of the same run',
  );
  await expect(panel).toBeVisible();
});

test('an empty list draws no table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await settleVerification(runId, []);
  await signIn(page, admin);

  const panel = await openVerification(page, runId);
  await expect(panel.getByRole('table')).toHaveCount(0);
  await expect(panel).not.toContainText('Differences from Gatling');
});
