import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { parseUploadedRun, referenceBundle, seedAdmin, seedProjectWithRuns } from './fixtures.js';
import { openAccountMenu, signIn } from './helpers.js';

/**
 * ═══ AN ADMINISTRATOR ADDS A PERSON, END TO END (project access, PR 2) ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 5)
 *
 * WHAT ONLY THIS CAN PROVE. Every page in the journey has its own component
 * test, each with `fetch` stubbed, and the API has its own suites. Neither
 * layer can see the seams between them, which are what this walks:
 *
 *   that `AuthGate` really puts the password step IN PLACE of the app — no
 *   rail, no header — for an account the real API created flagged;
 *
 *   that the session the step's change leaves behind really is unflagged and
 *   really is scoped to one project, so the rail and the run list narrow;
 *
 *   and that a reset really ends the person's session now: their open page's
 *   next request answers 401, not the 403 PASSWORD_CHANGE_REQUIRED a session
 *   that survived the reset would get. That one difference is what separates
 *   "signed out everywhere" from "asked to change it again".
 *
 * TWO BROWSER CONTEXTS, because the admin and the person are two people with
 * two cookies, and step 5 needs the person's page still open while the admin
 * acts.
 *
 * A SECOND PROJECT WITH A RUN OF ITS OWN, because without it "sees only
 * Checkout" and "sees only their run" are both true of a product that filters
 * nothing. The admin's rail lists it, which is what keeps its absence from the
 * person's meaningful.
 *
 * NOT HERE, and not this PR's: the spec's "a Viewer cannot edit rules" is about
 * HIDING controls by role, which PR 3 builds. The API's refusal of a Viewer is
 * PR 1's role matrix.
 */

const TEMPORARY = 'temporary-pass-1';
const CHOSEN = 'a-password-of-my-own';
const RESET_TO = 'temporary-pass-2';

function rail(page: Page) {
  return page.getByRole('navigation', { name: 'Projects', exact: true });
}

/** The full-screen step: its heading, and nothing of the app around it. */
async function expectPasswordStep(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(page.getByTestId('account-menu-trigger')).toHaveCount(0);
}

test('an admin adds a Member, who changes their password, sees one project, uploads, and is signed out by a reset', async ({
  page,
  browser,
}) => {
  // Four sign-ins, an upload, a parse and three engines in the cross-browser
  // job: the default 60 s is a budget for one page, not a journey.
  test.setTimeout(180_000);

  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'payments', 'Payments', 1);
  // The residue sweep's fixture-user shape (`<prefix>-<hex8>@example.test`).
  const person = { name: 'Robin Member', email: `person-${randomUUID().slice(0, 8)}@example.test` };
  const personRow = () => page.getByRole('row').filter({ hasText: person.email });

  await test.step('the admin adds them under Administration › Users, as a Member of Checkout', async () => {
    await signIn(page, admin);
    await expect(rail(page).getByRole('link', { name: 'Payments', exact: true })).toBeVisible();

    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Administration', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();

    await page.locator('summary', { hasText: 'Add user' }).click();
    await page.getByLabel('Email', { exact: true }).fill(person.email);
    await page.getByLabel('Name', { exact: true }).fill(person.name);
    await page.getByLabel('Temporary password', { exact: true }).fill(TEMPORARY);
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await page.getByLabel('Project 1', { exact: true }).selectOption({ label: 'Checkout' });
    await page.getByLabel('Role 1', { exact: true }).selectOption({ label: 'Member' });
    await page.getByRole('button', { name: 'Create user', exact: true }).click();

    await expect(personRow()).toContainText('Must change password');
  });

  const personContext = await browser.newContext();
  try {
    const personPage = await personContext.newPage();

    await test.step('they sign in, and meet "Choose a new password" and nothing else', async () => {
      await signIn(personPage, { email: person.email, password: TEMPORARY });
      await expectPasswordStep(personPage);
    });

    await test.step('they choose their own, and the app opens on their one project', async () => {
      await personPage.getByLabel('Current password', { exact: true }).fill(TEMPORARY);
      await personPage.getByLabel('New password', { exact: true }).fill(CHOSEN);
      await personPage.getByLabel('Repeat new password', { exact: true }).fill(CHOSEN);
      await personPage.getByRole('button', { name: 'Change password', exact: true }).click();

      await expect(rail(personPage).getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
      await expect(rail(personPage).getByRole('link', { name: 'Payments', exact: true })).toHaveCount(0);
      await expect(personPage.getByRole('heading', { name: 'Choose a new password' })).toHaveCount(0);
    });

    await test.step('they upload the reference bundle through Add results, and it is their whole run list', async () => {
      await rail(personPage).getByRole('link', { name: 'Checkout', exact: true }).click();
      await personPage
        .getByRole('navigation', { name: 'Project sections', exact: true })
        .getByRole('link', { name: 'Add results', exact: true })
        .click();
      await personPage.getByTestId('bundle-file').setInputFiles({
        name: 'results.tgz',
        mimeType: 'application/gzip',
        buffer: await referenceBundle(),
      });
      await personPage.getByRole('button', { name: 'Upload bundle', exact: true }).click();
      await expect(personPage.getByTestId('bundle-processing')).toBeVisible();

      // The worker, standing in: no worker process runs in this harness (see
      // `parseUploadedRun`). The page is not told; it finds out by polling.
      const runId = await parseUploadedRun(admin.orgId);
      await expect(personPage.getByTestId('bundle-done')).toBeVisible({ timeout: 30_000 });

      // ONE row, and it is this upload: Payments' run is in the same org, and a
      // list that filtered nothing would show two.
      await rail(personPage).getByRole('link', { name: 'All runs', exact: true }).click();
      const rows = personPage.getByTestId('run-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAttribute('data-run-id', runId);
    });

    await test.step('the admin resets their password, and their open page is refused 401 on its next request', async () => {
      // The admin's list was read before the person chose a password; read it
      // again, so "Active" is the server's word that the change cleared the
      // flag, and the reset's "Must change password" below is a change.
      await page.reload();
      await expect(personRow()).toContainText('Active');

      await page.getByRole('button', { name: `${person.name}: more actions`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Reset password', exact: true }).click();
      const block = page.getByTestId('user-details');
      await block.getByLabel(`Temporary password for ${person.name}`, { exact: true }).fill(RESET_TO);
      await block.getByRole('button', { name: 'Reset password', exact: true }).click();
      await expect(page.getByTestId('user-details')).toHaveCount(0);
      await expect(personRow()).toContainText('Must change password');

      // The person's page has made no request since the reset. Its next one —
      // any in-app navigation — must be refused as signed out: a 401, never the
      // 403 PASSWORD_CHANGE_REQUIRED a surviving session would get.
      const next = personPage.waitForResponse((res) => new URL(res.url()).pathname.startsWith('/v1/'));
      await rail(personPage).getByRole('link', { name: 'Checkout', exact: true }).click();
      expect((await next).status()).toBe(401);
      // And the page says what the API said, sign-in remediation and all. Which
      // part of the page refuses first (the project's name, or its tests) is
      // the shell's business, so the alert is found by the 401's own words.
      await expect(
        personPage
          .getByRole('main')
          .getByRole('alert')
          .filter({ hasText: 'sign in at POST /auth/sign-in/email' })
          .first(),
      ).toBeVisible();

      // A fresh load asks for the session, finds none, and lands on sign-in;
      // the admin's temporary password then leads to the step again.
      await personPage.reload();
      await expect(personPage).toHaveURL(/\/login/);
      await signIn(personPage, { email: person.email, password: RESET_TO });
      await expectPasswordStep(personPage);
    });
  } finally {
    await personContext.close();
  }
});
