import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunnerRunWithEvents, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runLogsPath, runPath } from '../src/routes/paths.js';

/**
 * ═══ THE LOGS TAB, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * The unit layer hands the panel its events and the strip its `hasLogs`;
 * these prove the seams — `runner_job_event` through the real API to the
 * page, and `runnerJobId` deciding the tab.
 */
test('a runner run’s Logs tab shows its events and phases, and nothing of the command line', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunnerRunWithEvents(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const sections = page.getByRole('navigation', { name: 'Run sections' });
  await sections.getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${runLogsPath(runId)}$`));

  const log = page.getByRole('log', { name: 'Run events' });
  const lines = log.getByTestId('run-log-line');
  await expect(lines).toHaveCount(11);
  await expect(lines.first()).toHaveText(/^\[\d{2}:\d{2}:\d{2}\.\d{3} GMT[^\]]*\] \[perfportal\] Start requested\.$/);
  await expect(log.locator('[data-phase]')).toHaveText([/---\| Deploying \|/, /---\| Injecting \|/, /---\| Ending \|/]);
  await expect(lines.last()).toContainText('[runner] Run ended');
  await expect(log).not.toContainText('io.gatling.app.Gatling');
});

test('an uploaded run has no Logs tab', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const sections = page.getByRole('navigation', { name: 'Run sections' });
  await expect(sections.getByRole('link', { name: 'Overview', exact: true })).toBeVisible();
  await expect(sections.getByRole('link', { name: 'Logs', exact: true })).toHaveCount(0);
});
