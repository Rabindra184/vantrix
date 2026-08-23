import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedTestWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * `Organization → Project → Test → Run`, walked in a real browser against a
 * real Postgres.
 *
 * WHAT ONLY THIS SUITE CAN PROVE. `apps/web/test/ProjectTests.test.tsx` and
 * `TestRuns.test.tsx` stub `fetch`, so they pin what each page does with a
 * given payload and nothing about whether the API produces one. Three claims
 * here need the whole stack:
 *
 *   that `/projects/:slug` really is the test list now and `/projects/:slug/runs`
 *   really is the run list — a routing change, invisible to a component test
 *   that mounts one component under a hand-written `<Route>`;
 *
 *   that `?project=&test=` narrows the server's own response, rather than the
 *   page merely asking for it;
 *
 *   and that a run's breadcrumb names the test the WORKER resolved, from a
 *   genuinely parsed bundle — the one place the resolve-or-create in
 *   `PipelineService` meets the UI.
 *
 * FIXTURE NAMES AVOID THE PROJECT'S OWN. `ProjectRail` renders on every
 * authenticated page and Playwright matches accessible names as a
 * case-insensitive SUBSTRING by default, so a test named "Checkout smoke"
 * would be matched by `getByRole('link', { name: 'Checkout' })` — the rail's
 * own row for the project. "Payments sweep" and "Search latency" share no word
 * with it. See CLAUDE.md's "Conventions that bite".
 */

test('a project lists its tests, and each test its own runs', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 3,
  });
  await seedTestWithRuns(admin.orgId, {
    slug: 'search-latency',
    name: 'Search latency',
    simulationClass: 'shop.SearchSimulation',
    runs: 1,
    verdict: 'failed',
  });

  await signIn(page, admin);
  await page.goto('/projects/checkout');

  // The project page is the TEST list — two rows, not four runs.
  await expect(page.getByTestId('test-row')).toHaveCount(2);
  // A table's accessible name is its `<caption>`, and the caption is a
  // SENTENCE — so the pattern has to be a phrase that sentence actually
  // contains. `/tests/i` did not match it: the caption reads "Every test in
  // this project", singular throughout, and the assertion failed as
  // "element(s) not found" rather than as anything about the table.
  await expect(page.getByRole('table', { name: /every test in this project/i })).toBeVisible();

  // The class is shown beside the name, because the two diverge the moment
  // anybody renames a test and only the class matches the simulation source.
  const sweep = page.locator('[data-test-slug="payments-sweep"]');
  await expect(sweep).toContainText('shop.PaymentsSimulation');
  await expect(sweep).toContainText('3');

  // Down a rung. `exact: true` because the rail is in this document too — see
  // this file's docstring.
  await page.getByRole('link', { name: 'View test Payments sweep', exact: true }).click();
  await page.waitForURL('**/projects/checkout/tests/payments-sweep');

  await expect(page.getByRole('heading', { level: 1, name: 'Payments sweep' })).toBeVisible();
  // THE SERVER NARROWED IT, not the page: three runs of this test exist and a
  // fourth run of the other test does not appear. A client-side filter would
  // have shown four here, or three by coincidence.
  await expect(page.getByTestId('run-row')).toHaveCount(3);

  // Exactly one `<h1>`: `RunList` draws its own everywhere else and is told
  // not to here. Two would make a screen-reader user meet the page twice, and
  // nothing about the rendering would look wrong.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('the project run list moved to /runs and still shows every test’s runs', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 3,
  });
  await seedTestWithRuns(admin.orgId, {
    slug: 'search-latency',
    name: 'Search latency',
    simulationClass: 'shop.SearchSimulation',
    runs: 1,
  });

  await signIn(page, admin);
  await page.goto('/projects/checkout');

  await page.getByRole('link', { name: 'Project runs', exact: true }).click();
  await page.waitForURL('**/projects/checkout/runs');

  // Every run of every test in the project — the view no test's page can give,
  // and the only one that would show a run belonging to no test at all.
  await expect(page.getByTestId('run-row')).toHaveCount(4);

  // And back up, which is the whole reason this page carries the link.
  await page.getByRole('link', { name: 'All tests', exact: true }).click();
  await page.waitForURL('**/projects/checkout');
  await expect(page.getByTestId('test-row')).toHaveCount(2);
});

/**
 * THE ONE CASE THAT USES A REAL PARSE. `seedRunWithData` uploads the reference
 * bundle and runs the actual pipeline, so the `test` row this asserts on is
 * the one `PipelineService`'s resolve-or-create produced from the log header's
 * simulation class — not a row this file wrote. That join is the only thing
 * standing between the worker's grouping rule and the breadcrumb a reader
 * clicks, and no seeded fixture can stand in for it.
 */
test('a parsed run names its test in the breadcrumb, and the link opens that test', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);

  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  const crumb = page.getByTestId('run-test');
  await expect(crumb).toBeVisible();
  // The reference bundle's own simulation class, which is also the name the
  // worker gives a test nobody has renamed.
  await expect(crumb).toHaveText('example.ParitySimulation');

  await crumb.click();
  await page.waitForURL('**/projects/checkout/tests/**');
  // The run we came from is in the history of the test we arrived at — which
  // is the claim the breadcrumb makes, followed all the way round.
  await expect(page.locator(`[data-run-id="${runId}"]`)).toBeVisible();
});
