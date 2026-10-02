import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gatlingManifest, writeJar } from '../../../packages/storage/test/support/jar.js';
import { packageVersionCount, seedAdmin, seedPackage } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * Packages (backlog #8) — the journey, in the one place it can be checked.
 *
 * ═══ WHY THESE ARE BROWSER CASES ═══
 *
 * Every layer under them is pinned already: the routes by integration cases,
 * the page and the New run form by component ones. What none of those can see
 * is the JOURNEY — a jar chosen in a real file input, a menu item that
 * navigates to a form that has to open on that package, a refusal that has to
 * be readable from inside a Radix menu, and six columns that have to become
 * cards on a phone. Each is a claim about two components and a router (or a
 * layout), and jsdom renders one component at a time and lays nothing out.
 *
 * ═══ NO RUNNER RUNS HERE ═══
 *
 * The webServer starts the API alone, so a job queued from a package stays
 * `queued` for the whole case. That is exactly what the second case needs — an
 * active run it can hold, and then end by cancelling through the API, the route
 * a person's Cancel button calls.
 */

let jarDir: string;
let jarPath: string;

test.beforeAll(async () => {
  // A THIN jar, as `gatlingEnterprisePackage` builds one: a manifest naming the
  // Gatling version and the simulations, and one class. It carries no framework
  // and is never run — what the page reads out of it is the manifest, and what
  // the New run form offers is the list that header holds.
  jarDir = await mkdtemp(path.join(tmpdir(), 'e2e-packages-'));
  jarPath = path.join(jarDir, 'checkout-load.jar');
  await writeJar(jarPath, [
    {
      name: 'META-INF/MANIFEST.MF',
      content: gatlingManifest({
        'Gatling-Version': '3.15.1',
        'Gatling-Simulations': 'example.BasicSimulation',
      }),
    },
    { name: 'example/BasicSimulation.class', content: 'x' },
  ]);
});

test.afterAll(async () => {
  await rm(jarDir, { recursive: true, force: true });
});

const rows = (page: Page) => page.getByTestId('package-row');

const actionsOf = (page: Page, name: string) =>
  page.getByRole('button', { name: `${name}: package actions`, exact: true });

test('a package is created, uploaded to, and started from without uploading again', async ({
  page,
}) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  await page.goto('/projects/checkout/packages');

  /* ═══ THE FORM IS ALREADY OPEN, AND CLICKING ITS SUMMARY WOULD SHUT IT ═══
   *
   * A project with no packages opens the creation form by itself — that is the
   * page's rule, and it is a fact about a SETTLED list, so the case waits for
   * the empty state before it reads the form. A click on "New package" here
   * would toggle an open disclosure closed and the next line would fail on a
   * hidden field, which reads as a broken form and is not one. */
  await expect(page.getByText('No packages yet', { exact: true })).toBeVisible();
  await expect(page.locator('details', { hasText: 'New package' })).toHaveJSProperty('open', true);

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Checkout jar');
  await page.getByLabel('File (optional)').setInputFiles(jarPath);
  await page.getByRole('button', { name: 'Create package' }).click();

  // The package this made, as the page names it: the file's own name and a
  // usage that says "nothing has run from it" in words rather than a blank.
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('Checkout jar');
  await expect(rows(page)).toContainText('checkout-load.jar');
  await expect(rows(page)).toContainText('0 tests · 0 runs');

  /* ═══ A DECOY, SO THE LINK HAS SOMETHING TO GET RIGHT ═══
   *
   * The form opens on the project's FIRST package unless it is told otherwise,
   * and with one package in the project the first is also the one the reader
   * meant — a link that dropped `?package=` altogether would pass every
   * assertion below. The list is newest-upload first, so a package seeded NOW
   * sorts above the one just made, and only the link can put the form on the
   * right one. */
  await seedPackage(admin.orgId, { name: `Decoy jar ${Date.now()}` });
  await page.reload();
  await expect(rows(page)).toHaveCount(2);

  const row = rows(page).filter({ hasText: 'Checkout jar' });
  await expect(row).toHaveCount(1);
  const packageId = await row.getAttribute('data-package-id');
  expect(packageId, 'the row carries its package id').not.toBeNull();

  // THE MENU, NOT A TYPED URL: the link is what a reader follows, and what it
  // has to carry is the package they were looking at.
  await actionsOf(page, 'Checkout jar').click();
  await page.getByRole('menuitem', { name: 'New run from this package' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/checkout/run/new\\?package=${packageId}$`));

  // The form opened ON that package — the select's value is the package's id,
  // which no label can fake — and offers its simulations as a CHOICE. A typed
  // class is only as good as its spelling, and the jar already says which ones
  // it holds.
  await expect(page.getByRole('combobox', { name: 'Package', exact: true })).toHaveValue(packageId!);
  const simulation = page.getByRole('combobox', { name: 'Simulation', exact: true });
  await expect(simulation).toHaveJSProperty('tagName', 'SELECT');
  await expect(simulation.locator('option')).toHaveText(['example.BasicSimulation']);

  await page.getByRole('textbox', { name: 'Run name', exact: true }).fill('from the package');
  await page.getByRole('button', { name: 'Queue run' }).click();

  /* ═══ THE JOB NAMES ITS PACKAGE, AND NOTHING WAS UPLOADED ═══
   *
   * The column is found by its HEADER, so a reordered table keeps asserting
   * the same relationship. Two independent witnesses to "no second upload": the
   * job sits on the version the package already had (read through the API the
   * browser's own session uses), and the package still has exactly one version
   * row — which the API cannot say, because an upload of bytes a package
   * already holds is answered with the existing version and looks identical. */
  const jobs = page.getByRole('table', { name: /on-prem runner jobs/i });
  await expect(jobs.locator('tbody tr')).toHaveCount(1);
  const headers = await jobs.locator('thead th').allTextContents();
  const packageColumn = headers.indexOf('Package');
  expect(packageColumn, 'the jobs table has a Package column').toBeGreaterThanOrEqual(0);
  await expect(jobs.locator('tbody tr').first().locator('td').nth(packageColumn)).toHaveText(
    'Checkout jar',
  );

  const listed = await page.request.get('/v1/projects/checkout/packages');
  expect(listed.ok()).toBe(true);
  const { items } = (await listed.json()) as {
    items: { id: string; current: { artifactId: string; filename: string } }[];
  };
  const made = items.find((item) => item.id === packageId);
  expect(made?.current.filename).toBe('checkout-load.jar');

  const queued = await page.request.get('/v1/projects/checkout/runner/runs');
  const { items: jobList } = (await queued.json()) as { items: { job: { artifactId: string } }[] };
  expect(jobList).toHaveLength(1);
  expect(jobList[0]?.job.artifactId).toBe(made?.current.artifactId);
  expect(await packageVersionCount(packageId!)).toBe(1);
});

test('delete is refused while a run is queued, with the reason on screen, and allowed after', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const seeded = await seedPackage(admin.orgId, { queueJob: true });
  await signIn(page, admin);
  await page.goto('/projects/checkout/packages');

  await expect(rows(page)).toHaveCount(1);
  await actionsOf(page, seeded.name).click();

  /* ═══ A REFUSAL YOU CAN READ, FROM INSIDE A MENU ═══
   *
   * Radix renders a disabled item as a `div` with `aria-disabled`, never a
   * `disabled` attribute — so `toBeDisabled()` would assert something the
   * element cannot carry. And the reason is a line of TEXT in the menu: a
   * `title` is invisible on touch and unreachable by keyboard, and a menu hides
   * its items until it is opened, so a refusal that could only be hovered is
   * not an explanation. */
  const remove = page.getByRole('menuitem', { name: 'Delete', exact: true });
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('1 run of it is queued or running', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(remove).toBeHidden();
  // Paired, because `toBeHidden` is also true of an element that was never
  // there: the menu closed, and the row it belongs to is still on the page.
  await expect(rows(page)).toHaveCount(1);

  const cancelled = await page.request.post(
    `/v1/projects/checkout/runner/runs/${seeded.jobId}/cancel`,
  );
  expect(cancelled.ok(), await cancelled.text()).toBe(true);
  // The answer, not the status code, says the job ended: a POST that answered
  // 2xx and left it queued would make the reload below prove nothing.
  expect(((await cancelled.json()) as { job: { status: string } }).job.status).toBe('cancelled');

  // RELOADED, not waited for: the menu reads the usage the list carried when it
  // loaded, so an answer that has changed since is only on screen after a read.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await actionsOf(page, seeded.name).click();
  await expect(remove).toBeVisible();
  await expect(remove).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/queued or running/)).toHaveCount(0);

  await remove.click();
  await expect(
    page.getByText(`Delete package "${seeded.name}"? Its runs keep their history.`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete package', exact: true }).click();

  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('No packages yet', { exact: true })).toBeVisible();
});

test('the page fits a phone', async ({ page }) => {
  // `test.use({ viewport })` is FILE-scoped and the other two cases are about a
  // desktop table, so this one sets its own — before the page loads, because
  // the layout is chosen by a `matchMedia` read at first render.
  await page.setViewportSize({ width: 375, height: 812 });

  const admin = await seedAdmin();
  // A real class-and-version file name is the widest unbroken string this page
  // draws: UAX#14 gives no break after a full stop followed by a letter, so
  // only the row's own break rule stands between it and a sideways scroll.
  const long = await seedPackage(admin.orgId, {
    name: 'com.acme.checkout.simulations.CheckoutPeakLoadSimulationNightlySoak',
    filename: 'acme-checkout-peak-load-simulations-1.0.0-SNAPSHOT-all.jar',
    queueJob: true,
  });
  await seedPackage(admin.orgId);
  await signIn(page, admin);
  await page.goto('/projects/checkout/packages');

  /* Six columns do not fit 375px, and a table scrolled sideways hides the one
   * it exists for (Actions) — so the rows are cards. Asserted as a pair: no
   * `<table>` alone is satisfied by a page that drew nothing, and the `li`s
   * alone by a page that drew both. */
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('li[data-testid="package-row"]')).toHaveCount(2);
  await expect(page.locator('table')).toHaveCount(0);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);

  // And the control a card exists to keep reachable is inside the screen, not
  // merely rendered somewhere to the right of it.
  const trigger = actionsOf(page, long.name);
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  expect(box, 'the actions menu has a box').not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
});
