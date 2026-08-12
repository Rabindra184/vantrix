import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedUserWithoutOrg } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * The cookie round trip in a real browser — the reason this sub-project
 * exists (design §1). Everything here drives the shipped, built SPA served
 * same-origin by the API (playwright.config.ts), so a session cookie that is
 * `secure`/`sameSite: 'strict'` is exercised exactly as production sets it.
 *
 * Seeded per WORKER, not per test: playwright.config.ts sets
 * `fullyParallel: true`, so this hook runs once in every worker process that
 * picks up a test from this file, and each worker gets its own admin in its
 * own org. That isolation is deliberate — no test here depends on another's
 * data, so nothing has to run serially.
 */
let admin: { email: string; password: string; orgId: string };

test.beforeAll(async () => {
  admin = await seedAdmin();
});

test('signing in lands on the run list', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/runs$/);
});

// The cookie round trip - the reason this sub-project exists.
test('the session survives a full page reload', async ({ page }) => {
  await signIn(page, admin);
  await page.reload();
  await expect(page).toHaveURL(/\/runs$/);
  // The authenticated marker Task 5 owns. Task 6 adds the table assertion
  // here when the run list lands.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('an unauthenticated deep link redirects to login and comes back', async ({ page }) => {
  // seedRunWithData posts the real reference bundle and runs the ingest
  // pipeline synchronously (~51s, design R-3). It is seeded HERE rather than
  // in beforeAll because this is the only test that needs a run id, and
  // beforeAll runs once per worker — hoisting it would pay that cost in
  // every worker instead of once.
  test.setTimeout(180_000);
  const runId = await seedRunWithData(admin.orgId);

  await page.goto(`/runs/${runId}`);
  await expect(page).toHaveURL(/\/login/);
  // Already on /login. Filling in place — NOT signIn(), which re-navigates to
  // a bare /login and discards the remembered destination.
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
});

test('signing out clears the session', async ({ page }) => {
  await signIn(page, admin);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/login/);
});

// A valid session with no org must NOT bounce to login - that loops forever.
test('a user with no organisation sees an explanation, not a login loop', async ({ page }) => {
  const orphan = await seedUserWithoutOrg();
  await signIn(page, orphan);
  await expect(page.getByText(/not a member of any organisation/i)).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});
