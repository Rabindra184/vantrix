import { expect, test } from '@playwright/test';
import { seedAdmin, seedTestWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * ═══ A MACHINE ID, FROM ITS ROW TO THE CLIPBOARD ═══ (backlog #4)
 *
 * WHAT ONLY THIS SUITE CAN PROVE. jsdom ships no `navigator.clipboard`, so
 * every unit case installs a stand-in and asserts what the component HANDED
 * it. Whether a real browser, on this app's real origin, puts that value on
 * the clipboard — and whether the click lands on the button rather than on the
 * link beside it — is a question only a browser can answer. This one reads
 * the clipboard BACK, which is the claim a reader actually relies on.
 *
 * CHROMIUM ONLY, AND SKIPPED INSIDE THE BODY. Playwright grants
 * `clipboard-read` in Chromium alone; Firefox and WebKit reject the permission
 * name. `test.skip` at FILE scope would drop the spec on those engines
 * silently (CLAUDE.md records the trap); inside the body it reports a skip
 * with its reason.
 *
 * FIXTURE NAMES AVOID THE PROJECT'S OWN — "Payments sweep" shares no word with
 * the rail's `Checkout` row, for the substring-match reason CLAUDE.md records.
 */
test('a test’s slug and a run’s full id reach the clipboard from their rows', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Playwright grants clipboard-read in Chromium only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());

  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 2,
  });
  await signIn(page, admin);

  // THE TESTS CATALOGUE: the slug is shown, and the button copies exactly it.
  await page.goto('/projects/checkout');
  const testRow = page.locator('[data-test-slug="payments-sweep"]');
  await expect(testRow.getByTestId('test-slug')).toHaveText('payments-sweep');
  await testRow.getByRole('button', { name: 'Copy test slug payments-sweep', exact: true }).click();
  // Asserted before the clipboard read, because the acknowledgement lapses
  // after two seconds by design and a slow read must not race it.
  await expect(testRow.getByRole('status')).toHaveText(/copied/i);
  await expect.poll(readClipboard).toBe('payments-sweep');

  // A TEST'S OWN RUN LIST shows an 8-character prefix, which no endpoint
  // accepts — so this is the list where copying the display would be wrong.
  await page.goto('/projects/checkout/tests/payments-sweep');
  const runRow = page.getByTestId('run-row').first();
  await expect(runRow).toBeVisible();
  const id = await runRow.getAttribute('data-run-id');
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await expect(runRow.getByRole('link', { name: `View run ${id}`, exact: true })).toHaveText(
    id!.slice(0, 8),
  );

  await runRow.getByRole('button', { name: `Copy run id ${id}`, exact: true }).click();
  await expect.poll(readClipboard).toBe(id);
  // The click was the button's alone: the link beside it did not navigate.
  await expect(page).toHaveURL(/\/projects\/checkout\/tests\/payments-sweep$/);
});
