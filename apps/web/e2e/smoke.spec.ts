import { expect, test } from '@playwright/test';

// Deliberately the only test in this file that needs no seeding: it proves
// the harness itself — a real browser, driven by Playwright, against the
// API serving the BUILT SPA (see playwright.config.ts) — actually works,
// before any later task's fixtures.ts-backed test asks it to prove anything
// about the product. See the Task 3 report for the falsification run: this
// assertion was changed to expect 'Nonsense' and confirmed to fail before
// being restored to this.
test('serves the SPA shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PerfPortal' })).toBeVisible();
});
