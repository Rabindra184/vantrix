import { expect, test } from '@playwright/test';
import {
  QUEUED_EVENT_COUNT, RUNNER_RUN_EVENTS, seedAdmin, seedRunnerRunWithEvents, seedRunWithData,
} from './fixtures.js';
import { signIn } from './helpers.js';
import { runLogsPath, runPath } from '../src/routes/paths.js';

/**
 * ═══ THE LOGS TAB, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * The unit layer hands the panel its events and the strip its `hasLogs`;
 * these prove the seams — `runner_job_event` through the real API to the
 * page, and `runnerJobId` deciding the tab.
 *
 * WHAT THE FIXTURE SUPPLIES IS READ FROM THE FIXTURE, NOT RESTATED: the line
 * count, the phase names and the closing line all come from
 * `RUNNER_RUN_EVENTS`, so adding an event there moves this case with it. What
 * IS written out is what the real API writer produces (`Start requested.`)
 * and what must never appear, because neither is the fixture's to define.
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
  await expect(lines).toHaveCount(QUEUED_EVENT_COUNT + RUNNER_RUN_EVENTS.length);
  await expect(lines.first()).toHaveText(/^\[\d{2}:\d{2}:\d{2}\.\d{3} GMT[^\]]*\] \[perfportal\] Start requested\.$/);

  const phases = RUNNER_RUN_EVENTS.flatMap((event) => ('phase' in event ? [event.phase] : []));
  expect(phases.length).toBeGreaterThan(0);
  await expect(log.locator('[data-phase]')).toHaveText(phases.map((phase) => new RegExp(`---\\| ${phase} \\|`)));

  const closing = RUNNER_RUN_EVENTS.at(-1);
  if (closing === undefined || !('message' in closing)) throw new Error('the fixture must end on a message event');
  await expect(lines.last()).toContainText(`[runner] ${closing.message}`);

  // The job was seeded with `-Xmx7g`, a `leak.*` system property and a storage
  // path (see `seedRunnerRunWithEvents`); none of it may reach the log, and
  // neither may the launch command. `PARAM-LEAK` is the value both parameters
  // carry, `leak.` their shared key prefix and `runner-artifacts/` the storage
  // key's directory.
  for (const forbidden of ['PARAM-LEAK', '-Xmx7g', 'leak.', 'runner-artifacts/', 'io.gatling.app.Gatling']) {
    await expect(log).not.toContainText(forbidden);
  }
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
