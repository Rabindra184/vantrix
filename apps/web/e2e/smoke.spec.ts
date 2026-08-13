import { expect, test } from '@playwright/test';

// Deliberately the only test in this file that needs no seeding: it proves
// the harness itself — a real browser, driven by Playwright, against the
// API serving the BUILT SPA (see playwright.config.ts) — actually works,
// before any later task's fixtures.ts-backed test asks it to prove anything
// about the product. See the Task 3 report for the falsification run: this
// assertion was changed to expect 'Nonsense' and confirmed to fail before
// being restored to this.
//
// RENAMED. It was called "serves the SPA shell", from when apps/web rendered
// nothing but `<h1>PerfPortal</h1>` at the root. Since Task 5 the heading it
// matches is the LOGIN PAGE's — an unauthenticated GET / redirects there —
// so the old name described a screen this test no longer reaches. What it
// still proves is the whole boot path, and that is what it now says: the API
// answered / with index.html rather than Nest's 404, the asset bundle loaded,
// React mounted, the router ran, and AuthGate resolved an absent session to
// /login. Every one of those is a way the harness can be broken, and each
// breaks this test.
test('the built SPA is served, boots, and routes an anonymous visitor to login', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'PerfPortal' })).toBeVisible();
});
