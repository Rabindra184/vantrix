import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedTestWithRuns } from './fixtures.js';
import { plot, signIn } from './helpers.js';

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

/**
 * ═══ THE RULES PANEL ON A TEST'S PAGE ═══
 *
 * `ProjectRules.test.tsx` pins what the panel does with a given payload, with
 * `fetch` stubbed. What only a real stack can show is that it is MOUNTED here
 * with the right props and that `GET /v1/projects/:slug/rules?test=` is a
 * request the API actually honours — a panel wired with the wrong slug, or a
 * query parameter the server rejects, renders an error state that no
 * stubbed-fetch test would ever produce.
 */
test('a test’s page carries the gates that judge it, and authors new ones against it', async ({
  page,
}) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 1,
  });

  await signIn(page, admin);
  await page.goto('/projects/checkout/tests/payments-sweep');

  // No "Applies to" select here — the page is titled after one test, and the
  // one non-default option would silently widen a rule to every OTHER test.
  await expect(page.getByRole('button', { name: 'Add rule' })).toBeVisible();
  await expect(page.getByLabel('Applies to')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add rule' }).click();

  // The row appears, and says the rule belongs to THIS test rather than to the
  // project — which is the whole difference this feature adds.
  const appliesTo = page.getByTestId('rule-applies-to');
  await expect(appliesTo).toHaveCount(1);
  await expect(appliesTo).toHaveText('This test');

  // And the project's own setup page sees it too, named by the test it judges
  // — the same row, read from the other end of the union.
  await page.goto('/projects/checkout/setup');
  await expect(page.getByTestId('rule-applies-to')).toHaveText('Payments sweep');
});

/**
 * ═══ COMPARE, REACHED FROM THE TEST RATHER THAN FROM A RUN ═══
 *
 * `TestRuns.test.tsx` pins the link's href against a stubbed run list. What
 * only a real stack shows is that the link ARRIVES somewhere that draws: the
 * Compare page validates every id against its own cohort (`TRENDS_SQL`, which
 * takes only complete runs of this test), so a selection built from the wrong
 * runs would be silently dropped and the page would render a comparison of
 * one. That failure looks like nothing being wrong.
 *
 * TWO INGESTS of the reference bundle, the same way `run-compare.spec.ts`
 * builds its cohort — two real runs of `example.ParitySimulation`, which the
 * worker groups into one test.
 */
test('a test links to a comparison of its own latest runs, and it draws', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await seedRunWithData(admin.orgId);

  await signIn(page, admin);
  await page.goto('/projects/checkout/tests/example-paritysimulation');

  await page.getByRole('link', { name: 'Compare latest 2', exact: true }).click();
  await page.waitForURL('**/compare?runs=**');

  // TWO series drawn, not one: a selection whose second id the cohort rejected
  // would still render a chart, and a chart is not a comparison.
  const overlay = page.getByTestId('chart-compare-overlay');
  await expect(plot(overlay)).toHaveCount(1);
  await expect(overlay.locator('svg text[text-anchor="start"]')).toHaveCount(2);
});
