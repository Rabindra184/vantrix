import { expect, test } from '@playwright/test';
import { seedAdmin, seedIncompleteRun, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ THE RUN'S JOURNEY, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * The unit layer hands the strip its steps; these prove the seams: a real
 * upload's stamps reaching the page through the real API, the band without
 * its Execution row, and a seeded incomplete run — which carries no stream
 * stamps at all — still saying its load test stopped early.
 */
test('an uploaded run walks Load test, Received, Processing and Verdict, with its times', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const strip = page.getByRole('region', { name: 'Run lifecycle' });
  await expect(strip.getByRole('list').getByRole('listitem')).toHaveText([
    /Load test/,
    /Received/,
    /Processed/,
    /Verdict:/,
  ]);

  await strip.getByText('Step times').click();
  // Processing's START and END both arrive — `ingestedAt`, its end, is a
  // RunResponse field the shell's type once erased — and so does the time
  // between them. Unanchored: the reference bundle's test ran on 2026-08-07,
  // so these cells, stamped today, carry their own date.
  await expect(strip.getByTestId('lifecycle-times-processing').getByRole('cell')).toHaveText([
    /\d{2}:\d{2}:\d{2}/,
    /\d{2}:\d{2}:\d{2}/,
    /^\d+s$/,
  ]);

  const band = page.getByRole('region', { name: 'Release decision' });
  await expect(band).toBeVisible();
  await expect(band.getByTestId('outcome-execution')).toHaveCount(0);
});

test('an incomplete run says its load test stopped early', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedIncompleteRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  await expect(page.getByRole('region', { name: 'Run lifecycle' })).toContainText(/stopped early/i);
});
