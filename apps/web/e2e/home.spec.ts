import { expect, test, type Page } from '@playwright/test';
import {
  renameSimulation,
  seedAdmin,
  seedProjectWithRuns,
  seedRunWithFailedAssertion,
  seedTestWithRuns,
} from './fixtures.js';
import { apiJson, signIn } from './helpers.js';

/**
 * ═══ THE PORTFOLIO HOME, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * `Home.test.tsx` and the `home/` component files prove each card renders what
 * it is handed. What only a browser can prove is the seam: that a real sign-in
 * LANDS here, that a run the pipeline judged really reaches the attention card
 * with its reason, that the page holds its width on a phone (jsdom lays out
 * nothing), that the rail's reserved link names stay the rail's in a document
 * holding every card at once, and that typing into the filter really writes the
 * address and narrows what the server sends.
 *
 * Every case seeds its own admin and therefore its own org: the attention card
 * and the tests table read the WHOLE org, so a shared org would make each
 * case's rows depend on what the others seeded, which under `fullyParallel` is
 * a race rather than a fixture.
 */

/** The run list's widest real class name: UAX#14 gives no break after a full
 *  stop followed by a letter, so this is one unbreakable 56-character word. */
const LONG_CLASS = 'com.acme.checkout.simulations.CheckoutPeakLoadSimulation';

/** The subset of `GET /v1/activity` these cases read, typed here rather than
 *  imported: this directory typechecks under `module: NodeNext`, where the
 *  contracts package's source is not what resolves. */
interface ActivityBody {
  readonly attention: readonly {
    readonly project: { readonly slug: string };
    readonly run: {
      readonly id: string;
      readonly runNumber: number | null;
      readonly checks: { readonly failed: number; readonly total: number } | null;
    };
    readonly reasons: readonly string[];
  }[];
}

function activity(page: Page): Promise<ActivityBody> {
  return apiJson<ActivityBody>(page, '/v1/activity?tz=UTC');
}

test('signing in lands on Home, and the brand link returns there', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);

  // The pathname, not a regex over the whole URL: `/runs` and `/` differ only
  // in what follows the origin, and that is the whole claim.
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toBeVisible();

  // From somewhere else, the brand is the way back. It is named after the
  // product, never "Home" — that word is the rail's.
  await page.goto('/runs');
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toHaveCount(0);
  await page.getByRole('link', { name: 'PerfPortal', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('heading', { level: 1, name: /^Hello, / })).toBeVisible();
});

test('a run whose assertion failed is listed with its reason, and its last-run link opens it', async ({
  page,
}) => {
  const admin = await seedAdmin();
  // A real ingest: the pipeline judges the run, so the reasons on screen are
  // the ones the endpoint computed rather than ones this file wrote down.
  const runId = await seedRunWithFailedAssertion(admin.orgId);
  await signIn(page, admin);

  /* THE EXPECTATION COMES FROM THE PAYLOAD. The reference simulation fails one
     of its own Gatling assertions on purpose, and the seed's rule fails the
     run's SLA gate; how many checks failed is the payload's to say. */
  const sent = (await activity(page)).attention.find((row) => row.run.id === runId);
  expect(sent, 'the failed run should be in the attention list the API sends').toBeDefined();
  if (sent === undefined) return;
  expect(sent.reasons).toContain('gate_failed');
  expect(sent.reasons).toContain('assertion_failed');
  const failedChecks = sent.run.checks?.failed ?? 0;
  expect(failedChecks, 'the run should carry at least one failed check').toBeGreaterThan(0);
  const checkLabel =
    failedChecks === 1 ? '1 assertion failed' : `${String(failedChecks)} assertions failed`;

  const table = page.getByRole('table', { name: 'Needs attention', exact: true });
  const row = table
    .getByTestId('attention-row')
    .filter({ has: page.locator(`a[href="/runs/${runId}"]`) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(checkLabel);
  await expect(row).toContainText('SLA failed');

  // The last-run cell names the run the way the run's own page does, and its
  // link opens that run — not the test, not the run list.
  const runLabel =
    sent.run.runNumber === null ? `Run ${runId.slice(0, 8)}` : `Run ${String(sent.run.runNumber)}`;
  await row.getByRole('link', { name: runLabel, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
});

test('the page never scrolls sideways at 320, 375 and 414 px', async ({ page }) => {
  const admin = await seedAdmin();
  // A second project beside seedAdmin's own `checkout`, so "Runs by project"
  // and the attention card both carry more than one project's rows.
  await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha Service', 2, 'failed');
  /* THE LONG NAME HAS TO BE DRAWN, OR THIS MEASURES NOTHING. Home names a run
     by its TEST, so renaming the simulation of a run that has one changes no
     text on this page. It is drawn in two places, and both are seeded: as a
     test's name (the attention card and the tests table), and as the label of
     a run with no test, which the attention card names by its simulation. */
  await seedTestWithRuns(admin.orgId, {
    slug: 'checkout-peak-load',
    name: LONG_CLASS,
    simulationClass: LONG_CLASS,
    runs: 2,
    verdict: 'failed',
  });
  await signIn(page, admin);

  const testless = (await activity(page)).attention.find((row) => row.project.slug === 'alpha');
  expect(testless, 'an alpha run should be in the attention list').toBeDefined();
  if (testless === undefined) return;
  await renameSimulation(testless.run.id, LONG_CLASS);

  for (const width of [320, 375, 414]) {
    await page.setViewportSize({ width, height: 800 });
    // A fresh load, so the attention list carries the rename and the compact
    // layout is the one the page chose at this width.
    await page.goto('/');
    // Drawn first: `evaluate()` is an immediate read, and a page measured
    // before its rows arrive is a narrower page than the one a reader gets.
    await expect(
      page.getByTestId('attention-row').filter({ hasText: LONG_CLASS }),
      `both long-named attention rows should be on screen at ${String(width)}px`,
    ).toHaveCount(2);
    await expect(page.getByTestId('home-test-row').filter({ hasText: LONG_CLASS })).toBeVisible();
    await expect(page.getByRole('figure', { name: 'Runs per day' })).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      scrollWidth,
      `Home is ${String(scrollWidth)}px wide in a ${String(innerWidth)}px viewport at ${String(width)}px`,
    ).toBeLessThanOrEqual(innerWidth);
  }
});

test('only the rail names a link Home or All runs', async ({ page }) => {
  const admin = await seedAdmin();
  // Every card filled: attention rows, Runs by project, the tests table — so
  // a card that grew a link with a reserved name would be in the document.
  await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha Service', 2, 'failed');
  await seedTestWithRuns(admin.orgId, {
    slug: 'checkout-smoke',
    name: 'Checkout smoke',
    simulationClass: 'shop.CheckoutSimulation',
    runs: 2,
  });
  await signIn(page, admin);

  // Counted only once every card has drawn: a count taken over a page still
  // loading is satisfied by the page that has not arrived yet.
  await expect(page.getByTestId('attention-row').first()).toBeVisible();
  await expect(page.getByTestId('by-project-row').first()).toBeVisible();
  await expect(page.getByTestId('home-test-row').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^\d+ running$/ })).toBeVisible();

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  for (const name of ['Home', 'All runs']) {
    // BOTH counts: one in the document, and that one in the rail. The rail's
    // alone would pass beside a second copy anywhere else on the page.
    await expect(page.getByRole('link', { name, exact: true }), `links named "${name}"`).toHaveCount(1);
    await expect(rail.getByRole('link', { name, exact: true })).toHaveCount(1);
  }
});

test('filtering the tests writes ?q= and narrows the table', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'checkout-smoke',
    name: 'Checkout smoke',
    simulationClass: 'shop.CheckoutSimulation',
    runs: 1,
  });
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 1,
  });
  await signIn(page, admin);

  // `exact`: the attention card's heading, "Tests that need attention",
  // contains the word.
  await expect(page.getByRole('heading', { name: 'Tests', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Tests', exact: true });
  const rows = table.getByTestId('home-test-row');
  await expect(rows).toHaveCount(2);

  await page.getByRole('searchbox', { name: 'Filter tests', exact: true }).fill('Payments');

  // The address is the filter: written once the typing settles.
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Payments');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Payments sweep');
  await expect(table).not.toContainText('Checkout smoke');

  // And because it is the address, it survives a reload.
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Filter tests', exact: true })).toHaveValue('Payments');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Payments sweep');
});
