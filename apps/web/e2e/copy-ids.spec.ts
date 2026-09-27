import { expect, test } from '@playwright/test';
import { renameSimulation, seedAdmin, seedRunWithData, seedTestWithRuns } from './fixtures.js';
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

/**
 * ═══ AND THE BUTTON COSTS A ROW NOTHING WHERE THE TABLE IS TIGHT ═══
 *
 * Every existing layout guard passed against the first version — the button
 * inline after the link — while it made every row 19 to 24px taller: p95 and
 * Errors, which those guards measure, did not move a pixel. Below ~1400px the
 * table is wider than its box, every column sits at its minimum, and the
 * Simulation column's minimum is its header word. `RunList`'s `IdentityCell`
 * docstring has the numbers.
 *
 * TWO CLAIMS, ONE PER HALF OF THE FIX, and each has its own mutation:
 *   the button sits on the name's FIRST line — an inline button falls onto a
 *     line of its own, which is the height the first version cost;
 *   the name's track is at least as wide as the header word — a grid without
 *     the header's reservation keeps the button beside the name and takes its
 *     24px out of the name instead (rows at 768 went from 75 to 134px).
 *
 * A real 56-character class on the page, because the reference bundle's
 * 24-character one is the fixture CLAUDE.md records hiding exactly this kind
 * of width defect. Not at 1440, where the table fits its box and the column
 * gets a leftover width — a cost that docstring records rather than denies.
 */
test('the copy button sits beside the name without taking the name’s width', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const long = await seedRunWithData(admin.orgId);
  await renameSimulation(long, 'com.acme.checkout.simulations.CheckoutPeakLoadSimulation');
  await signIn(page, admin);

  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/runs');
    await expect(page.getByTestId('run-row')).toHaveCount(2);

    const cells = await page.evaluate(() => {
      const th = Array.from(document.querySelectorAll('thead th')).find(
        (h) => h.textContent?.trim() === 'Simulation',
      )!;
      const range = document.createRange();
      range.selectNodeContents(th);
      const headerWord = range.getBoundingClientRect().width;
      return Array.from(document.querySelectorAll('[data-testid="run-simulation"]')).map((td) => {
        const link = td.querySelector('a')!.getBoundingClientRect();
        const button = td.querySelector('[data-testid="copy-id"]')!.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(td.querySelector('a')!).lineHeight);
        return {
          headerWord: Math.round(headerWord),
          nameTrack: Math.round(button.left - link.left),
          buttonBelowFirstLine: Math.round(button.top - link.top) >= lineHeight,
        };
      });
    });

    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.buttonBelowFirstLine, `at ${width}px the button fell onto a line of its own`).toBe(
        false,
      );
      expect(
        cell.nameTrack,
        `at ${width}px the name has ${cell.nameTrack}px beside the button, under the header's ${cell.headerWord}px`,
      ).toBeGreaterThanOrEqual(cell.headerWord - 1);
    }
  }
});
