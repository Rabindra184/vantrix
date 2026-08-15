import { expect, test } from '@playwright/test';
import { seedAdmin, seedProjectWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * `exact: true` on every name query. Playwright's default is a
 * case-insensitive SUBSTRING match (CLAUDE.md), and `seedAdmin` already
 * creates a project called "Checkout" — so a loose match for a name that
 * shared a prefix would be satisfied by the wrong row.
 */
test('Sign out exists exactly once in the document', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  await page.goto('/runs');

  // toHaveCount(1), NOT toBeVisible(): a second CSS-hidden copy is still in
  // the DOM, so strict mode would make toBeVisible() throw — reporting a real
  // regression as a harness error rather than as this assertion failing.
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
});

test('the rail navigates to a project', async ({ page }) => {
  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'billing', 'Billing Exports', 2);
  await signIn(page, admin);
  await page.goto('/runs');

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  // Not `rail.getByRole('link', { name: 'Billing Exports', exact: true })`:
  // the seeded run is complete/passed, so ProjectRail's <NavLink> also
  // renders a Badge inside the link. Badge hides only its glyph behind
  // `aria-hidden` (verified in run-list.spec.ts's "a badge does not leak its
  // glyph" test) — the label text "passed" is real, announced content, so
  // the link's real accessible name is "Billing Exports passed", not
  // "Billing Exports". An exact `name` match against the bare project name
  // would therefore never resolve. Filtering by the exact visible
  // project-name text pins the same link without caring which verdict
  // happens to be seeded.
  await rail
    .getByRole('link')
    .filter({ has: page.getByText('Billing Exports', { exact: true }) })
    .click();

  await expect(page).toHaveURL(/\/projects\/billing$/);
  await expect(page.getByRole('heading', { name: 'Billing Exports', exact: true })).toBeVisible();
});

test('the project nav reflows rather than disappearing on a narrow viewport', async ({ page }) => {
  const admin = await seedAdmin();
  // Six projects, not one. Two fit in a 480px row without ever needing to
  // scroll, so a single-project seed exercises `overflow-x-auto` in name
  // only — the row never actually overflows, and the test would pass just as
  // well against `overflow-x-hidden`. Named so the LAST one sorts last under
  // `ORDER BY p.name ASC` (spec §4.2) regardless of where `seedAdmin`'s own
  // "Checkout" project falls alphabetically, so "last" here means the same
  // row the rail itself renders last.
  await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha Analytics', 1);
  await seedProjectWithRuns(admin.orgId, 'bravo', 'Bravo Analytics', 1);
  await seedProjectWithRuns(admin.orgId, 'charlie', 'Charlie Analytics', 1);
  await seedProjectWithRuns(admin.orgId, 'delta', 'Delta Analytics', 1);
  await seedProjectWithRuns(admin.orgId, 'echo', 'Echo Analytics', 1);
  await seedProjectWithRuns(admin.orgId, 'zulu', 'Zulu Analytics', 1);
  await signIn(page, admin);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/runs');

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  await expect(rail).toBeVisible();
  // Visible is not enough — the spec's claim is that it stays USABLE, so the
  // test clicks through to the LAST row rather than stopping at presence.
  // Playwright's click auto-scrolls the target into view within its nearest
  // scrollable ancestor before clicking; that only succeeds if the row is
  // both present in the DOM and reachable by scrolling — the actual claim
  // `overflow-x-auto` makes, which a row that already fits on screen cannot
  // exercise.
  //
  // Filtered by the exact project-name text rather than
  // `getByRole('link', { name: 'Zulu Analytics', exact: true })` — see the
  // matching comment in the test above: the seeded run's Badge puts "passed"
  // in the link's real accessible name, so an exact match on the bare
  // project name would never resolve.
  await rail
    .getByRole('link')
    .filter({ has: page.getByText('Zulu Analytics', { exact: true }) })
    .click();
  await expect(page).toHaveURL(/\/projects\/zulu$/);
});

test('the rail sits left of the content column on a wide viewport', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);
  // Explicit rather than relying on the `Desktop Chrome` device default:
  // the claim under test is specifically the `lg:` breakpoint's two-column
  // grid (`lg:grid lg:grid-cols-[16rem_1fr]`, AppShell.tsx), and a config
  // default that happened to change would silently stop testing it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/runs');

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  const main = page.getByRole('main');
  const railBox = await rail.boundingBox();
  const mainBox = await main.boundingBox();
  if (!railBox || !mainBox) {
    throw new Error(
      'the rail or <main> reported no bounding box — one of them is not laid out on screen',
    );
  }
  // The sub-project's central structural claim had NO assertion in either
  // suite before this. The rail's right edge must not cross main's left
  // edge — the two columns sit side by side at a viewport above `lg`, not
  // stacked as they are below it.
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(mainBox.x);
});

test('a skip link lets a keyboard user bypass the rail', async ({ page }) => {
  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'billing', 'Billing Exports', 2);
  await signIn(page, admin);
  await page.goto('/runs');

  // `goto` resolves once navigation commits, not once AuthGate's own session
  // check settles — immediately after `goto` the document still reads
  // "Checking your session…" (AuthGate.tsx), which mounts none of AppShell,
  // so a Tab pressed that early has no skip link, no rail, nothing to land
  // on at all (measured: `document.activeElement` was plain `<body>` with
  // that loading text). Waiting for the rail confirms AppShell — and the
  // skip link that is its first child — has actually mounted.
  await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();

  // A full navigation also leaves the document with no active element at
  // all, so the very first Tab press has nothing to advance FROM.
  // Explicitly focusing <body> — a no-op for anything visible — establishes
  // the same "nothing in particular is focused yet" starting point a real
  // browser has after a fresh load, so the Tab that follows really is the
  // first stop. Before this fix it would have landed on the brand link, then
  // "All runs", then one stop per seeded project — now it must land on the
  // skip link FIRST, ahead of all of them.
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to content', exact: true });
  await expect(skipLink).toBeFocused();

  // Activating it must actually MOVE focus onto <main>, not just scroll to
  // it — <main id="main"> carries `tabIndex={-1}` for exactly this, since a
  // <main> is not natively focusable and a skip link that only scrolls
  // leaves a screen-reader user's focus behind at the link.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});
