import { expect, type Page } from '@playwright/test';

/**
 * Drives the real login form through the browser. The account itself is
 * created ahead of time by one of fixtures.ts's seed*() functions, via
 * Better Auth's server API — never through this page.
 *
 * This is the CONTRACT Task 5's /login page must satisfy, not an assumption
 * about markup that already exists (it doesn't yet — apps/web today renders
 * only `<h1>PerfPortal</h1>`): an email field and a password field with
 * accessible names "Email" and "Password", and a submit button named
 * "Sign in". A successful sign-in is expected to navigate away from
 * /login once the session cookie is set — that's what this waits on, so a
 * caller can act on an authenticated page immediately afterward instead of
 * racing the redirect.
 */
export async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * The id of the first row in whatever run list the current page is showing.
 * Another forward-declared contract: Task 6's run list must render each row
 * with `data-testid="run-row"` and a `data-run-id` attribute carrying the
 * run's id, so Task 7's tests (and any other later consumer) have a stable
 * hook that doesn't depend on visible text or column order.
 */
export async function firstRowId(page: Page): Promise<string> {
  const row = page.getByTestId('run-row').first();
  await expect(row).toBeVisible();
  const id = await row.getAttribute('data-run-id');
  if (!id) {
    throw new Error('firstRowId: the first run-row element has no data-run-id attribute');
  }
  return id;
}
