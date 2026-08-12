import { expect, test } from '@playwright/test';
import {
  seedAdmin,
  seedPendingRun,
  seedRunInOtherOrg,
  seedRunWithData,
  seedRunWithFailedAssertion,
  seedRunWithNaAssertion,
} from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * The run detail page — the last screen of the parity shell, and the one the
 * definition of done ends on: sign in, see the org's runs, open one, read its
 * header and its assertions.
 *
 * EVERY test seeds its own admin, and therefore its own org, for the same
 * reason run-list.spec.ts does: with `fullyParallel: true` a shared org makes
 * each test's assertions depend on what the others seeded. Here it matters
 * more than there, because three of these seeds attach SLA RULES, and a rule
 * lives on a project — a shared org would let one test's always-failing rule
 * decide another test's verdict.
 */

/**
 * The outcome vocabulary from apps/web/src/routes/marks.tsx, mirrored rather
 * than imported — the same trade run-list.spec.ts makes for PAGE_SIZE, and
 * for the same mechanical reason: this file typechecks under
 * apps/web/e2e/tsconfig.json (`module: NodeNext`), where src/'s extensionless
 * relative imports do not resolve.
 *
 * Mirroring is what lets the not_applicable test below assert the thing it is
 * actually about. "Distinct from a pass" is a claim about two treatments, and
 * the not_applicable fixture's run has exactly ONE assertion — there is no
 * passed row on the page to compare against. Naming the passed treatment here
 * gives the comparison something real to fail against: flatten
 * not_applicable onto passed in marks.tsx and the glyph assertion and the
 * label assertion both go red, independently.
 */
const PASSED_MARK = { glyph: '✓', label: 'passed' };
const NOT_APPLICABLE_MARK = { glyph: '○', label: 'not applicable' };

test('shows the run header', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);

  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // The reference bundle's simulation is `example.ParitySimulation`
  // (read.integration.test.ts:75); the substring is what identifies it.
  await expect(page.getByRole('heading', { name: /ParitySimulation/ })).toBeVisible();
  await expect(page.getByTestId('run-status')).toContainText(/complete/i);

  // Its own element with its own testid, not a bare `getByText(/^\d+s$/)`:
  // an anchored text regex can match an element AND an ancestor whose entire
  // text is the same, and `toBeVisible()` on a two-match locator raises a
  // strict-mode violation rather than a useful failure.
  const duration = page.getByTestId('run-duration');
  await expect(duration).toHaveText(/^\d+s$/);

  // The regex alone is satisfied by both directions of a broken unit
  // conversion: `0s` (dividing twice, or flooring a sub-second value) and
  // `61234s` (never dividing at all) each match `^\d+s$` perfectly. The
  // reference bundle's run has a real duration — read.integration.test.ts:77
  // pins `durationMs > 60_000` — so the rendered number must land in whole
  // seconds between 60 and an hour, which neither broken direction can.
  const seconds = Number((await duration.innerText()).replace(/s$/, ''));
  expect(seconds).toBeGreaterThanOrEqual(60);
  expect(seconds).toBeLessThan(3600);
});

// not_applicable must never read as a pass.
test('renders a not_applicable assertion distinctly from a pass', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithNaAssertion(admin.orgId);

  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  const row = page.getByRole('row', { name: /not applicable/i });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(/passed/i);

  // The assertion above is weak on its own — "not applicable" and "passed"
  // could coexist in one row only by accident. This is the one that carries
  // the requirement: the outcome CELL, in isolation, must not render the
  // treatment a passed assertion renders. Text and shape, never colour alone
  // (WCAG 2.2 AA 1.4.1), so both are checked.
  const outcome = page.getByTestId('assertion-outcome');
  await expect(outcome).toHaveCount(1);
  await expect(outcome).toHaveText(/not applicable/i);
  await expect(outcome).toContainText(NOT_APPLICABLE_MARK.glyph);
  await expect(outcome).not.toContainText(PASSED_MARK.label);
  await expect(outcome).not.toContainText(PASSED_MARK.glyph);

  // The run-level consequence of the same decision: every rule was
  // inapplicable, so nothing was checked, so the run was NOT assessed as
  // passing. `not_evaluated` is the verdict, and it is not a pass.
  await expect(page.getByTestId('run-verdict')).not.toContainText(/passed/i);
});

test('a pending run says so rather than showing zeros', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedPendingRun(admin.orgId);

  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByText(/still processing/i)).toBeVisible();
  // "rather than showing zeros" is the actual requirement, and it needs its
  // own assertions: a 202 carries no duration, no verdict and no assertions,
  // so a page that rendered the header shell anyway would show `0s`, "no
  // verdict yet" and an empty assertions table as though they were facts
  // about the run.
  await expect(page.getByTestId('run-duration')).toHaveCount(0);
  await expect(page.getByTestId('run-verdict')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('another org run is not readable', async ({ page }) => {
  const admin = await seedAdmin();
  const otherOrgRunId = await seedRunInOtherOrg();

  await signIn(page, admin);
  await page.goto(`/runs/${otherOrgRunId}`);

  // The API's OWN words, not invented copy: RunsController.get throws
  // `new NotFoundException('No run <id> in this project.')`, which
  // ProblemFilter renders as a 404 problem document whose `detail` is that
  // sentence. The brief guessed "not found"; the API does not say it.
  // Asserting the real detail — id included — also proves the page is
  // reporting THIS run rather than echoing a generic failure.
  await expect(page.getByRole('alert')).toContainText(`No run ${otherOrgRunId} in this project.`);
  // Every `/v1` error carries a remediation and the page must show it. Its
  // presence is the requirement; its wording belongs to the API, so this
  // asserts the element is rendered and non-empty rather than pinning copy
  // this repo would then have to keep in two places.
  await expect(page.getByTestId('problem-remediation')).not.toBeEmpty();
  // And none of the run itself leaks through the error.
  await expect(page.getByTestId('run-duration')).toHaveCount(0);
});

test('a run that failed its SLA renders as a run, not as an error', async ({ page }) => {
  // 422 carries a full run body. Reading it as an error would tell the user
  // their most important run is unreadable.
  const admin = await seedAdmin();
  const runId = await seedRunWithFailedAssertion(admin.orgId);

  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole('heading', { name: /ParitySimulation/ })).toBeVisible();
  await expect(page.getByTestId('run-verdict')).toContainText(/failed/i);
  // The specific way this breaks: apiFetch's synthetic branch, which fires
  // when a non-2xx body is not problem-shaped — and a 422 run body never is.
  await expect(page.getByText(/CLIENT_UNREADABLE_ERROR|could not be parsed/i)).toHaveCount(0);
  // The run is readable AND the failure is legible: the rule that failed is
  // in the table, not merely summarised in the header.
  await expect(page.getByTestId('assertion-outcome')).toHaveText(/failed/i);
});
