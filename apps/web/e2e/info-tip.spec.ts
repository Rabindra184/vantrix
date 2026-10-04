import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * THE InfoTip IN A REAL BROWSER (clean UI, PR 1).
 *
 * The unit suite proves the trigger's name, its description and the panel's
 * open/close behaviour in jsdom, which lays nothing out and computes the
 * accessible description with its own library. Three things only a browser
 * can answer, and each is a promise the clean-UI text rule rests on:
 *
 *   - the caveat really is the trigger's accessible description — once
 *     through Playwright's `toHaveAccessibleDescription` (Playwright's OWN
 *     accname code, not the browser's), and once from Chromium's real
 *     accessibility tree over CDP, which is what a screen reader reads.
 *     Following `aria-describedby` into a `hidden` node is what both must do,
 *     so moving the caveat off the page did not take it from a screen reader;
 *   - the panel lands inside the viewport — on a desktop chart, and on a
 *     375px phone where the table frame's trigger sits at the right edge and
 *     a panel aligned to its start would run off the screen without Radix's
 *     collision handling;
 *   - Escape closes it and focus comes back to the trigger.
 */

test('a chart’s caveat opens from its info, lands on screen, and Escape returns focus', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const chart = page.getByTestId('chart-percentiles');
  const trigger = chart.getByRole('button', { name: 'About Response time percentiles over time' });
  await expect(trigger).toHaveAccessibleDescription(/no successful response/i);

  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'About Response time percentiles over time' });
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect(panel).toContainText(/no successful response/i);

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a table frame’s info stays on a 375px screen', async ({ page }) => {
  const admin = await seedAdmin();
  // Gives the seeded project (`checkout`) a test, so its tests table renders.
  await seedRunWithData(admin.orgId);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, admin);
  // `ProjectTests` has no card layout, so the table — and its frame's info at
  // the top-right — renders on a phone too.
  await page.goto('/projects/checkout');

  const trigger = page.getByRole('button', { name: 'About Tests' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'About Tests' })).toBeInViewport({ ratio: 1 });
});

/**
 * THE SCREEN-READER PROMISE, MEASURED WHERE A SCREEN READER READS IT.
 *
 * `toHaveAccessibleDescription` above is computed by Playwright's injected
 * script, which is not the browser's accessibility tree (the final review
 * caught an earlier docstring here saying otherwise). This reads Chromium's
 * own tree through CDP and requires the trigger's description to be the
 * caveat. Chromium only — CDP does not exist in Firefox or WebKit — and the
 * skip sits inside the body so the other engines still run the file.
 */
test('Chromium’s own accessibility tree gives the trigger the caveat as its description', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP, and so the real accessibility tree, is Chromium-only');
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const name = 'About Response time percentiles over time';
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const trigger = nodes.find((n) => n.role?.value === 'button' && n.name?.value === name);
  expect(trigger, 'the trigger is in Chromium’s accessibility tree').toBeDefined();
  expect(String(trigger?.description?.value ?? '')).toMatch(/no successful response/i);
});
