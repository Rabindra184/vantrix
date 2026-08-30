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

/**
 * ═══ THE HEADERS, AND THE PROOF THE CSP DOES NOT BREAK THE APP ═══
 *
 * `apps/api/test/security-headers.test.ts` pins the header VALUES against a
 * fake dist directory. It cannot answer the only question that matters about
 * a Content-Security-Policy, which is whether a real browser can still render
 * the real bundle under it — a policy that blocks the app's own script fails
 * no assertion anywhere, it just produces a blank page and a console error.
 *
 * So this case reads the console while the SPA boots. It is worth knowing
 * that every OTHER spec in this suite is also a CSP test now, implicitly: the
 * headers are on every response from the server Playwright drives, so a
 * policy that broke charts, fonts or the live socket would take those specs
 * down with it. This one exists to name the failure when it happens, instead
 * of leaving somebody to wonder why sixteen unrelated specs went red at once.
 */
test('the security headers are present, and the CSP does not block the app', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(text)) {
      violations.push(text);
    }
  });

  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const headers = response!.headers();

  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  // Free reconnaissance, and it bought nothing.
  expect(headers['x-powered-by']).toBeUndefined();

  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  // The hash of index.html's pre-paint theme script. Its ABSENCE is the
  // interesting failure: the theme would then be applied only after React
  // ran, which is the white flash in dark mode that the inline script exists
  // to prevent, and nothing else on the page would look wrong.
  expect(csp).toMatch(/script-src [^;]*'sha256-/);

  // The app really booted under that policy — same assertion as the case
  // above, so a CSP that blocked the bundle fails here with the console
  // output attached rather than as a bare missing heading.
  await expect(page.getByRole('heading', { name: 'PerfPortal' })).toBeVisible();
  expect(violations).toEqual([]);
});
