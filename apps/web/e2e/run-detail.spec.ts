import { expect, test } from '@playwright/test';
import {
  seedAdmin,
  seedPendingRun,
  seedRunInOtherOrg,
  seedRunWithData,
  seedRunWithFailedAssertion,
  seedRunWithNaAndPassedAssertions,
  seedRunWithNaAssertion,
} from './fixtures.js';
import { signIn } from './helpers.js';
import { runChartsPath, runErrorsPath, runPath } from '../src/routes/paths.js';

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
  await page.goto(runPath(runId));

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
  // reference bundle's run has a real duration — read.integration.test.ts:76
  // pins `durationMs > 60_000` — so the rendered number must land in whole
  // seconds between 60 and an hour, which neither broken direction can.
  const seconds = Number((await duration.innerText()).replace(/s$/, ''));
  expect(seconds).toBeGreaterThanOrEqual(60);
  expect(seconds).toBeLessThan(3600);
});

/**
 * Task 10's one content change: six stat tiles above the statistics table,
 * every value read from the same run-scope row the table's "All Requests"
 * row reads. This does not re-derive the number and compare it to a
 * written-down expectation — it reads the SAME CELL the tile is required not
 * to disagree with, off the SAME PAGE, and compares the two strings.
 */
test('the stat tiles agree with the statistics table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  // `stat-row-total` is the All Requests row — the run's own totals, in its own
  // <tbody>, and the same row RunStats reads. NOT `stat-row`, which is the
  // per-request and per-group rows in the second body.
  //
  // Its first cell is a <th scope="row"> carrying "All Requests", so the Total
  // column is the first <td>.
  const tile = await page.getByTestId('stat-total-requests').textContent();
  const totalCell = page.getByTestId('stat-row-total').locator('td').first();
  expect((await totalCell.textContent())?.trim()).toBe(tile?.trim());
});

// not_applicable must never read as a pass.
test('renders a not_applicable assertion distinctly from a pass', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithNaAssertion(admin.orgId);

  await signIn(page, admin);
  await page.goto(runPath(runId));

  const row = page.getByRole('row', { name: /not applicable/i });
  // Every `not.*` in this file is paired with a POSITIVE assertion on the
  // same locator. Two reasons, and the SECOND is the load-bearing one:
  //
  // 1. Not all negated matchers need the pairing. Measured against Playwright
  //    1.62.1 rather than assumed: the CONTENT matchers used here —
  //    `toBeEmpty`, `toContainText`, `toHaveText` — fail on an absent element
  //    in BOTH polarities, because they have to resolve the element to read
  //    its text ("Error: element(s) not found"). It is the STATE matchers
  //    that quietly pass: `not.toBeVisible()` on a deleted element succeeds,
  //    since "not attached" is a way of being "not visible". So a bare
  //    `not.toBeVisible()` is the one to be suspicious of; this file uses
  //    none.
  // 2. A negation is a weaker claim than the requirement it stands in for.
  //    "Is not a pass" is satisfied by a hundred wrong values; "is not
  //    evaluated" is satisfied by one right one. The positive assertion is
  //    what pins the requirement, and the negation documents the specific
  //    wrong answer this screen must never give.
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
  //
  // Asserted POSITIVELY first, because `not.toContainText(/passed/i)` alone
  // says only that the verdict is not one particular wrong value. The run's
  // verdict here is a known, specific fact — `not_evaluated`, the verdict a
  // run made entirely of inapplicable rules produces — and pinning it is a
  // far stronger claim than excluding "passed". (It also fails if the verdict
  // is deleted outright, though as measured above the negation would too.)
  await expect(page.getByTestId('run-verdict')).toHaveText(/not evaluated/i);
  await expect(page.getByTestId('run-verdict')).not.toContainText(/passed/i);
});

/**
 * The same requirement as the test above, asserted WITHOUT a mirror.
 *
 * The test above compares the rendered not_applicable cell to
 * `PASSED_MARK`/`NOT_APPLICABLE_MARK` — constants copied into this file. That
 * catches a change to `not_applicable`'s treatment, but not a change to
 * `passed`'s: set `ASSERTION_OUTCOME.passed.glyph` to '○' and the two
 * treatments become shape-identical while the copy here still says '✓', so
 * `not.toContainText(PASSED_MARK.glyph)` keeps passing. "Text plus shape"
 * would silently degrade to text only, and every mirrored assertion in this
 * file would report success.
 *
 * This test has nothing to go stale. One run carries both outcomes, both
 * cells are read off the page, and they are compared to EACH OTHER.
 */
test('a not_applicable outcome and a passed outcome render differently on the page', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithNaAndPassedAssertions(admin.orgId);

  await signIn(page, admin);
  await page.goto(runPath(runId));

  const outcomes = page.getByTestId('assertion-outcome');
  await expect(outcomes).toHaveCount(2);

  // The glyph is read from its own element rather than sliced off the cell
  // text, so "the shapes differ" is a claim about the shape and not about
  // whatever the label happens to make the string look like.
  const cells = await outcomes.evaluateAll((els) =>
    els.map((el) => ({
      text: (el.textContent ?? '').trim(),
      glyph: (el.querySelector('[aria-hidden="true"]')?.textContent ?? '').trim(),
    })),
  );

  // Guards before the comparison, in the spirit of the run list's ordering
  // test: "these two differ" is trivially satisfied by two empty strings, or
  // by a cell that renders no glyph element at all. Establish that both sides
  // are well-formed BEFORE asserting they are distinct.
  expect(cells).toHaveLength(2);
  for (const cell of cells) {
    expect(cell.text.length).toBeGreaterThan(0);
    expect(cell.glyph.length).toBeGreaterThan(0);
  }

  // The fixture guarantees one not_applicable and one passed row exist; this
  // pins which cell is which, so the comparison below is between the two
  // outcomes it claims to be about and not between two arbitrary rows.
  const na = cells.find((c) => /not applicable/i.test(c.text));
  const passed = cells.find((c) => /^\W*passed$/i.test(c.text));
  expect(na, 'no cell rendered a not_applicable outcome').toBeDefined();
  expect(passed, 'no cell rendered a passed outcome').toBeDefined();

  // Text differs, and SHAPE differs. Neither is asserted against a constant.
  expect(na!.text).not.toBe(passed!.text);
  expect(na!.glyph).not.toBe(passed!.glyph);
});

test('a pending run says so rather than showing zeros', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedPendingRun(admin.orgId);

  await signIn(page, admin);
  await page.goto(runPath(runId));

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

/**
 * The page ASKS AGAIN on its own.
 *
 * The test above proves what a pending run says; it says exactly the same
 * thing whether the page polls or renders once and goes silent forever.
 * Delete `refetchInterval` from RunDetail.tsx and it — and every other suite
 * in this repo — stays green, while the mechanism by which a person watches
 * their run finish is gone. So polling is asserted here, directly, as
 * requests actually leaving the browser.
 *
 * Cheap and stable because of what `seedPendingRun` is: a run row written
 * straight through Prisma, never posted over HTTP and never handed to
 * PipelineService, so no worker exists that could ever settle it. The page
 * therefore polls at the fixed POLL_INTERVAL_MS (5s, api/run.ts) for as long
 * as it is open, with nothing racing it — two requests take about six
 * seconds, well inside this file's 60s timeout.
 *
 * `> 1`, not `>= 1`: the first request is the initial load, which happens
 * whether or not anything polls. The SECOND is the evidence.
 *
 * NOT covered here, deliberately: the two-minute cap (POLL_CAP_MS). Reaching
 * it means two real minutes of wall clock in a browser — there is nothing to
 * wait ON, only elapsed time — and the two ways to shorten that are a DOM
 * test environment (a new dependency) or a `?pollCapMs=` query knob shipped
 * in production code purely so a test can reach a branch. Both were declined;
 * see apps/web/test/run-detail.test.ts, which covers the cap's UI by
 * rendering `Processing` directly, and RunDetail.tsx's effect for what that
 * leaves open.
 */
test('a pending run is asked about again', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedPendingRun(admin.orgId);

  await signIn(page, admin);

  // Attached BEFORE the navigation that triggers the first fetch: a listener
  // registered after `goto` would race the initial request, and the count
  // this test turns on would depend on which won.
  let polls = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/v1/runs/${runId}`)) polls += 1;
  });

  await page.goto(runPath(runId));
  // The page is on screen and in its processing state before anything is
  // counted, so a failure below reads as "did not poll" rather than "never
  // loaded".
  await expect(page.getByText(/still processing/i)).toBeVisible();

  await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThan(1);
});

test('another org run is not readable', async ({ page }) => {
  const admin = await seedAdmin();
  const otherOrgRunId = await seedRunInOtherOrg();

  await signIn(page, admin);
  await page.goto(runPath(otherOrgRunId));

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
  //
  // `toHaveCount(1)` FIRST — existence stated as its own requirement rather
  // than left as a side effect of a negation. A2 required the remediation to
  // be RENDERED, and that is a claim about the element being there, which is
  // not what `not.toBeEmpty()` is about even though this version of
  // Playwright happens to fail when it is missing (measured; see the note in
  // the not_applicable test). Asserting the requirement directly does not
  // depend on that behaviour staying the same.
  await expect(page.getByTestId('problem-remediation')).toHaveCount(1);
  await expect(page.getByTestId('problem-remediation')).not.toBeEmpty();
  // And none of the run itself leaks through the error.
  await expect(page.getByTestId('run-duration')).toHaveCount(0);
});

test('each tab is its own URL, reachable directly', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // A hard load of each tab, never a click — this is what makes a link
  // pasted into an incident channel land where it says it will.
  await page.goto(runChartsPath(runId));
  await expect(page.getByTestId('chart-percentiles')).toBeVisible();
  await expect(page.getByTestId('stat-row-total')).toHaveCount(0);

  await page.goto(runErrorsPath(runId));
  await expect(page.getByTestId('error-row').first()).toBeVisible();
  await expect(page.getByTestId('chart-percentiles')).toHaveCount(0);

  // The bare path is Overview, so every link that predates tabs still works.
  await page.goto(runPath(runId));
  await expect(page.getByTestId('stat-row-total')).toBeVisible();
  await expect(page.getByTestId('chart-percentiles')).toHaveCount(0);
});

test('a run that failed its SLA renders as a run, not as an error', async ({ page }) => {
  // 422 carries a full run body. Reading it as an error would tell the user
  // their most important run is unreadable.
  const admin = await seedAdmin();
  const runId = await seedRunWithFailedAssertion(admin.orgId);

  await signIn(page, admin);
  await page.goto(runPath(runId));

  await expect(page.getByRole('heading', { name: /ParitySimulation/ })).toBeVisible();
  await expect(page.getByTestId('run-verdict')).toContainText(/failed/i);
  // The specific way this breaks: apiFetch's synthetic branch, which fires
  // when a non-2xx body is not problem-shaped — and a 422 run body never is.
  await expect(page.getByText(/CLIENT_UNREADABLE_ERROR|could not be parsed/i)).toHaveCount(0);
  // The run is readable AND the failure is legible: the rule that failed is
  // in the table, not merely summarised in the header.
  await expect(page.getByTestId('assertion-outcome')).toHaveText(/failed/i);
});

test('switching tabs does not remount the shell', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // The heading is the shell's, not the panel's. If the layout route were
  // three sibling routes instead, this node would be destroyed and rebuilt on
  // every tab click — which is the whole reason for the layout route.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  const before = await heading.textContent();

  await page.getByRole('link', { name: 'Charts' }).click();
  await expect(page.getByTestId('chart-percentiles')).toBeVisible();
  expect(await heading.textContent()).toBe(before);
});

test('a processing run shows no tab strip', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedPendingRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // A tab strip over a run nobody has parsed yet is three doors onto three
  // empty rooms — the same mistake the Processing branch already refuses to
  // make with a table of dashes.
  await expect(page.getByRole('navigation', { name: 'Run sections' })).toHaveCount(0);
  await expect(page.getByText(/still processing/i)).toBeVisible();
});

test('the errors tab counts distinct messages, not failed requests', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // Spec §9-4. On the reference run these are 2 and 24 — distinct error
  // messages versus failed requests. Both are derived from the page's own
  // payloads rather than written down, so a re-captured fixture moves them
  // together: the count must follow the errors table's row count, and must
  // NOT follow the statistics row's KO column.
  //
  // `stat-row-total` is read HERE, on the Overview tab, not after navigating
  // to `/errors`: `RunShell` is a layout route, and `RunOverviewTab` — the
  // only tab that renders `StatisticsTable` — unmounts the moment the
  // `<Outlet/>` swaps to `RunErrorsTab`. Reading it after the navigation
  // waits forever for a node the errors tab never renders (confirmed at this
  // file's "each tab is its own URL" test, which asserts `stat-row-total`
  // has count 0 off the Overview tab).
  const tab = page.getByRole('link', { name: /Errors/ });
  const ko = Number(
    (await page.getByTestId('stat-row-total').locator('td').nth(2).textContent())?.trim(),
  );

  await page.goto(`/runs/${runId}/errors`);
  // `.count()` reads the DOM as it stands, with none of `expect(locator)`'s
  // auto-retry — unlike the `ko` read above, whose `.textContent()` DOES
  // auto-wait for its locator to attach. Without this, `.count()` can run
  // before the errors table's own fetch has resolved and read back 0 rows,
  // same pattern as "each tab is its own URL, reachable directly" above.
  await expect(page.getByTestId('error-row').first()).toBeVisible();
  const distinct = await page.getByTestId('error-row').count();
  expect(distinct).toBeGreaterThan(0);
  expect(distinct).not.toBe(ko);

  await page.goto(`/runs/${runId}`);
  await expect(tab).toHaveText(`Errors (${distinct})`);
});
