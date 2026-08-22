import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The SVG root ECharts drew, within some scope — a figure, the compare
 * overlay, the time-window strip.
 *
 * ═══ WHY THIS IS NOT `scope.locator('svg')` ═══
 *
 * It was, in twenty-two places, and that spelling quietly made a design rule
 * out of a test convenience: a chart `<figure>` could contain no other SVG,
 * ever, because `toHaveCount(1)` counted every one of them. CLAUDE.md carried
 * the rule as a flat prohibition on icons inside a chart card, which is a
 * strange thing for a design system to be told by its test suite.
 *
 * `[data-chart-canvas]` is the element `Chart` renders the instance into, so
 * this asks the question the assertions always meant — "did the plot draw?" —
 * and is strictly harder to satisfy than the old form, which an icon anywhere
 * in the card could have answered.
 *
 * Use it for anything reaching into what ECharts produced: counting the root,
 * hovering a point, reading axis labels, `evaluate`-ing the SVG element.
 */
export function plot(scope: Locator): Locator {
  return scope.locator('[data-chart-canvas] svg');
}

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
  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  } catch (err) {
    // A plain timeout here reports nothing but "60s elapsed" — indistinguishable
    // from a slow network, a wrong password, or a login page that renders its
    // error in place rather than redirecting. Capture what's actually on
    // screen so the failure names its own likely cause instead of costing the
    // next implementer an hour of re-deriving it.
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '(could not read page body)');
    throw new Error(
      `signIn: still on /login for ${who.email} after clicking "Sign in" — the app never ` +
        `navigated away. Visible page text at the time of failure:\n${bodyText}`,
      { cause: err },
    );
  }
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

/**
 * Fetches an endpoint THROUGH THE PAGE'S OWN SESSION, so a parity assertion
 * reads exactly what the browser read — not a second request made with
 * different credentials, against which "the page agrees with the API" would be
 * a weaker claim than it looks.
 *
 * Byte-identical in run-charts.spec.ts and group-detail.spec.ts before this
 * moved here; run-detail.spec.ts is the third caller, and three private
 * copies of the same function is the point past which the duplication itself
 * becomes the convention.
 */
export async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${p} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }, path);
}
