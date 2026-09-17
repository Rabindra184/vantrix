import { expect, test } from '@playwright/test';
import {
  parseUploadedRun,
  referenceBundle,
  seedAdmin,
  seedRunWithData,
  seedTestWithRuns,
} from './fixtures.js';
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

  /* ═══ ACROSS, THROUGH THE SHELL'S NAV — review M10 ═══
     This used to be a "Project runs" button on the tests page, answered by an
     "All tests" button on the run list: the same relationship spelled two
     different ways depending on which end you stood at, and neither page
     mentioning that rules or tokens existed. One strip now, so the same two
     links do both directions. */
  const sections = page.getByRole('navigation', { name: 'Project sections' });
  await sections.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.waitForURL('**/projects/checkout/runs');

  // Every run of every test in the project — the view no test's page can give,
  // and the only one that would show a run belonging to no test at all.
  await expect(page.getByTestId('run-row')).toHaveCount(4);

  // And back up, through the same strip.
  await sections.getByRole('link', { name: 'Tests', exact: true }).click();
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

  /* The rule appears under THIS TEST's own heading rather than the project's —
     which is the whole difference this feature adds.

     It used to be a cell reading "This test" in an Applies-to column beside
     one reading "Every test (project-wide)". Review M17 split the two into
     separate tables, because the rows are not equally safe to act on: deleting
     an inherited rule changes every OTHER test in the project, and a row that
     looks identical to the one above it does not carry that warning. Inside a
     group the column would be one word repeated, so it went. */
  const own = page.getByRole('region', { name: 'Test SLA rules' });
  await expect(own.getByRole('row')).toHaveCount(2); // the header, and one rule
  await expect(page.getByTestId('rule-applies-to')).toHaveCount(0);

  // And the project's own SLA rules page sees it too, named by the test it
  // judges — the same row, read from the other end of the union.
  //
  // That page used to be `/setup`, which carried tokens, an import snippet and
  // these rules in one scroll. Review M15 split it; rules have their own
  // destination now and this is the URL that holds them.
  await page.goto('/projects/checkout/rules');
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

/**
 * ═══ REVIEW M15 — CONFIGURATION IS THREE DESTINATIONS, NOT ONE PAGE ═══
 *
 * `/projects/:slug/setup` used to mint tokens, revoke tokens, explain
 * importing a report and author SLA rules in one scroll, which is why the
 * import instructions were reachable only by opening a credentials screen and
 * reading past them.
 *
 * WHAT ONLY A REAL BROWSER PROVES HERE. Rules and Access are new ROUTES behind
 * `lazy()` imports, and a route that fails to resolve — a bad path, a chunk
 * that does not load — is invisible to a component test that mounts the page
 * under a hand-written `<Route>`. The walk below is therefore a real
 * navigation through the real router on each of the three, by clicking the nav
 * rather than by `goto`, because the nav is the thing the split added.
 */
test('the project nav reaches the three configuration pages', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  await page.goto('/projects/checkout/setup');

  // The entry choices the review asked for, named for what the reader wants.
  // "Import results", not "Import via API" — review 09-13 M05. That label was
  // the INTERIM the finding itself specifies, kept only while the browser
  // genuinely could not deliver a bundle. It can now.
  for (const choice of ['Import results', 'Run a test', 'Configure CI']) {
    await expect(page.getByRole('heading', { name: choice, level: 2 })).toBeVisible();
  }

  // And the credential is a NAMED prerequisite with a link, rather than a
  // section of this page — the inversion is the whole fix.
  await expect(page.getByRole('button', { name: 'Create token' })).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: 'Project sections' });
  // "API tokens", not "Access" — review 09-13 M18. The section and the page it
  // opens must agree about what the page is, and "Access" promised members and
  // roles this product does not have.
  //
  // SCOPED TO THE NAV, and that is not decoration: the Add results page
  // carries its own "Create one under API tokens" link, and Playwright matches
  // accessible names as a case-insensitive SUBSTRING — so a page-wide query
  // for 'API tokens' resolves two elements here and fails strict mode.
  await nav.getByRole('link', { name: 'API tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create token' })).toBeVisible();

  await nav.getByRole('link', { name: 'SLA rules', exact: true }).click();
  // ONE heading with those words, not two — and on this page, none: review M10
  // made the `<h1>` the PROJECT and left the section to the nav, so the panel
  // drops its own card title here the way it always did. A duplicate is
  // invisible on screen while a screen-reader user meets the page twice.
  await expect(page.getByRole('heading', { name: 'SLA rules' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Checkout');

  // The active section says so to a screen reader, not only in colour.
  await expect(nav.getByRole('link', { name: 'SLA rules', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

/**
 * ═══ REVIEW M04 — EXPAND ONLY THE CHOSEN WORKFLOW ═══
 *
 * Add results presented documentation as task UI: all three paths showed their
 * explanations, prerequisites, code and implementation caveats at once. The
 * choices stay on screen; the commands moved behind a `<details name>`, which
 * is an accordion a browser closes for you.
 *
 * ONLY A REAL ENGINE CAN SEE THIS. The shared `name` is pinned in jsdom
 * (`ProjectSetup.test.tsx`), but the EXCLUSION is the browser's own behaviour
 * — no JavaScript in this product implements it — so nothing short of an
 * engine proves it happens. Where it is unsupported the two open
 * independently, which is the behaviour this replaced and is why the case
 * asserts the CHOSEN one opened rather than asserting the other is shut.
 */
test('opening one workflow on Add results collapses the other', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  await page.goto('/projects/checkout/setup');

  const importCmd = page.getByTestId('upload-command');
  const ciCmd = page.getByTestId('ci-command');

  // Three short choices, no commands: the state the review asks the page to
  // open in.
  await expect(importCmd).toBeHidden();
  await expect(ciCmd).toBeHidden();

  // `entry-import-results` — `EntryCard` DERIVES its testid from the title
  // (`entry-${title.toLowerCase().replace(/\s+/g, '-')}`), so the M05 rename
  // moved this selector. Exactly the trap CLAUDE.md records for this component:
  // grep for the derived value, not just the label.
  const importCard = page.getByTestId('entry-import-results');
  // `.first()`, because this card now holds TWO disclosures: the card's own,
  // and the "Or post it from a terminal" one the curl moved into when the
  // picker took the primary slot. The outer one is the card's.
  await importCard.getByRole('group').first().locator('summary').first().click();
  // The command is now one level further in — opening the card reveals the
  // picker, and the terminal recipe sits behind its own summary.
  await importCard.getByText('Or post it from a terminal').click();
  await expect(importCmd).toBeVisible();

  // And the chosen one is the only one — the browser closed the first when the
  // second opened, because they share a `name`.
  const ciCard = page.getByTestId('entry-configure-ci');
  await ciCard.getByRole('group').locator('summary').click();
  await expect(ciCmd).toBeVisible();

  /* ═══ NOT `toBeHidden()`, AND THE REASON IS THE HARNESS RATHER THAN THE PAGE ═══
   *
   * It WAS `toBeHidden()`, and it passed on all three engines until M05 put the
   * terminal recipe behind its own `<details>` inside this card. `upload-command`
   * now has two disclosure ancestors — the nested one still OPEN, the card's own
   * CLOSED by the accordion — and Playwright's WebKit path reads only the
   * nearest, so the closed ancestor is masked.
   *
   * MEASURED, after the click, with the identical DOM in all three:
   *
   *   ancestors (innermost first)   {name: null, open: true}, {name: add-results, open: false}
   *   element.checkVisibility()     false     false     false        <- the ENGINE's own answer
   *   playwright isVisible()        false     false     TRUE         <- chromium, firefox, WEBKIT
   *
   * So WebKit itself agrees the reader cannot see this; only the harness's
   * substitute for `checkVisibility()` disagrees — the same
   * `browserNameForWorkarounds === 'webkit'` branch CLAUDE.md already records
   * for a forced-open `<details>`, met from the other side.
   *
   * Both halves are asserted because they are different claims. The `open`
   * property is what the ACCORDION did; `checkVisibility()` is what the reader
   * gets, in the engine's own words rather than through the harness. Asserting
   * only the attribute would pass against a stylesheet that kept a closed
   * card's content on screen. */
  await expect(importCard.getByRole('group').first()).toHaveJSProperty('open', false);
  await expect
    .poll(() => importCmd.evaluate((el) => el.checkVisibility()))
    .toBe(false);
});

/**
 * Uploading a bundle from the browser (review 09-13 M05).
 *
 * WHAT ONLY THIS CAN PROVE. `uploadBundle.test.ts` pins the validation rules
 * against files it invents, which says nothing about whether the server accepts
 * what this control sends. The finding was never a component: `POST /v1/runs`
 * refuses a session, so until `POST /v1/projects/:slug/runs` existed there was
 * no route for a picker to post to. This drives the real control against the
 * real route and reads the run back.
 *
 * ALL FOUR OF THE FINDING'S REQUIREMENTS ARE SEPARATE ASSERTIONS, because three
 * of them are satisfiable by an upload button that does none of the work:
 * accepted formats (declared on the control), validation (refused locally,
 * before any request), progress, and the PROCESSING state — which is the one
 * usually missed, since 202 means stored and not yet parsed.
 */
test('a bundle can be uploaded from the browser and becomes a run', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  await page.goto('/projects/checkout/setup');

  const card = page.getByTestId('entry-import-results');
  await card.getByRole('group').first().locator('summary').first().click();

  const input = page.getByTestId('bundle-file');
  // The formats are declared ON the control, so the OS picker greys out the
  // rest — the constraint is where the choice is made, not in prose below it.
  await expect(input).toHaveAttribute('accept', '.tgz,.tar.gz');

  // VALIDATION, locally: a wrong format is refused without a request, which is
  // what stops a reader spending minutes uploading a file that cannot work.
  await input.setInputFiles({ name: 'results.zip', mimeType: 'application/zip', buffer: Buffer.from('not a tarball') });
  await expect(page.getByTestId('bundle-invalid')).toContainText('not a .tgz');
  await expect(page.getByRole('button', { name: 'Upload bundle' })).toBeDisabled();

  // An empty file is a DIFFERENT mistake and says so — usually a failed `tar`
  // that still produced a file, and "not a gzipped tar" would send the reader
  // to check the wrong thing.
  await input.setInputFiles({ name: 'empty.tgz', mimeType: 'application/gzip', buffer: Buffer.alloc(0) });
  await expect(page.getByTestId('bundle-invalid')).toContainText('is empty');

  // And the real thing, end to end.
  await input.setInputFiles({
    name: 'results.tgz',
    mimeType: 'application/gzip',
    buffer: await referenceBundle(),
  });
  await expect(page.getByTestId('bundle-invalid')).toHaveCount(0);
  await page.getByRole('button', { name: 'Upload bundle' }).click();

  // PROCESSING, not "uploaded": 202 means the bytes are stored and nothing has
  // parsed them. A control that stopped at success here would hand the reader a
  // message and no run, which is the requirement of the four most often missed.
  await expect(page.getByTestId('bundle-processing')).toBeVisible();
  await expect(page.getByTestId('bundle-done')).toHaveCount(0);

  // The worker, standing in — see `parseUploadedRun`. Nothing in this harness
  // parses a run the browser posted, so without this the page would go on
  // truthfully reporting 'parsing' until the test timed out. The page is NOT
  // told: it discovers the run finished through its own polling, which is the
  // transition this case exists to prove.
  await parseUploadedRun(admin.orgId);

  await expect(page.getByTestId('bundle-done')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Open the run' }).click();

  // The run is real, and it is THIS bundle: the reference run's own numbers.
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ParitySimulation');
});
