import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { projectTestPath, runComparePath, runPath, runTrendsPath } from '../src/routes/paths.js';

/**
 * ═══ A TEST'S RUNS, NAMED BY NUMBER, ON EVERY SURFACE THAT NAMES THEM ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * WHAT ONLY THIS LAYER CAN PROVE. Every unit case hands a component a
 * `runNumber` of its own making. Here the two runs are ingested and PROCESSED
 * by the real pipeline (`seedRunWithData`), so the numbers on screen are the
 * ones the worker assigned — the seam between the writer and five surfaces.
 *
 * The reference bundle names `example.ParitySimulation`, which the worker
 * files under an auto-created test slugged `example-paritysimulation` and
 * NAMED after the class. Both runs start at the same instant (one bundle), so
 * a timestamp label could not tell them apart; the numbers do.
 */
test('two runs of one test read Run 1 and Run 2 on the list, the run page, Compare and Trends', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const first = await seedRunWithData(admin.orgId);
  const second = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // The test's own list: named by number, the link still naming the WHOLE id.
  await page.goto(projectTestPath('checkout', 'example-paritysimulation'));
  await expect(page.getByRole('link', { name: `View run ${first}`, exact: true })).toHaveText('Run 1');
  await expect(page.getByRole('link', { name: `View run ${second}`, exact: true })).toHaveText('Run 2');

  // The run page: the breadcrumb's current rung, and the tab title.
  await page.goto(runPath(second));
  await expect(page.getByTestId('run-crumb')).toHaveText('Run 2');
  await expect(page).toHaveTitle('example.ParitySimulation · Run 2 · PerfPortal');

  // Compare: the picker's chips, and the overlay's two series.
  await page.goto(runComparePath(second));
  await expect(page.getByTestId(`compare-run-${first}`)).toContainText('Run 1');
  await expect(page.getByTestId(`compare-run-${second}`)).toContainText('Run 2');
  const overlay = page.getByTestId('chart-compare-overlay');
  await expect(plot(overlay)).toHaveCount(1);
  const series = overlay.locator('svg text[text-anchor="start"]');
  await expect(series).toHaveCount(2);
  expect((await series.allTextContents()).sort()).toEqual(['Run 1', 'Run 2']);

  // Trends: the axis's own data table, whose row headers are the axis labels.
  await page.goto(runTrendsPath(second));
  const rowHeads = page.getByTestId('chart-data-trend-status').locator('tbody th[scope="row"]');
  await expect(rowHeads).toHaveCount(2);
  expect((await rowHeads.allTextContents()).sort()).toEqual(['#1', '#2']);
});
