import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedTestWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * `ProjectShell` — the one navigation every project page shares, review M10.
 *
 * ═══ WHAT THE REVIEW FOUND ═══
 *
 * A project had two disjoint navigation systems. `/projects/:slug` drew a row
 * of three links (Project runs, Add results, New on-prem run);
 * `/projects/:slug/runs` drew a DIFFERENT row of three for the same
 * relationship (All tests, Add results, New on-prem run); and the three
 * configuration pages drew a tab strip naming none of the first two. So SLA
 * rules and API tokens were reachable ONLY by first landing on Add results,
 * and the way back up the hierarchy had two different names depending on which
 * end you were standing at.
 *
 * ═══ WHY THIS IS AN e2e CASE AND NOT A COMPONENT ONE ═══
 *
 * The claim is "the same five sections, on all five pages" — five real routes,
 * three of them behind `lazy()` imports, mounted by the real router. A jsdom
 * case renders one page at a time under a hand-written `<Route>`, so it can
 * prove the strip's contents (`ProjectShell.test.tsx` does) and cannot prove
 * that every destination in it resolves to a page that draws the strip back.
 *
 * And the collision half is invisible anywhere but here. `ProjectRail` is in
 * every authenticated document with an "All runs" row and one row per project;
 * Playwright matches accessible names as a case-insensitive SUBSTRING. A nav
 * of five labels is five new chances to shadow one of the rail's, and jsdom
 * renders one component at a time so it can never see it — the same reason
 * CLAUDE.md records this costing a strict-mode failure twice already.
 */

/** Every section, its label, and the URL it belongs to. */
const SECTIONS = [
  { label: 'Tests', path: '/projects/checkout' },
  { label: 'Runs', path: '/projects/checkout/runs' },
  { label: 'Add results', path: '/projects/checkout/setup' },
  { label: 'SLA rules', path: '/projects/checkout/rules' },
  { label: 'API tokens', path: '/projects/checkout/access' },
] as const;

const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });

test('every project page carries the same five sections, under the project’s own name', async ({
  page,
}) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'payments-sweep',
    name: 'Payments sweep',
    simulationClass: 'shop.PaymentsSimulation',
    runs: 2,
  });
  await signIn(page, admin);

  for (const { label, path } of SECTIONS) {
    await page.goto(path);

    const nav = sections(page);
    await expect(nav).toBeVisible();

    // The same five, in the same order, everywhere. Asserted as a LIST rather
    // than five presence checks: a strip that silently lost a section — or
    // reordered so the configuration pages sat before the project's own data —
    // would satisfy every individual check.
    expect(await nav.getByRole('link').allTextContents()).toEqual(
      SECTIONS.map((s) => s.label),
    );

    // EXACTLY ONE current, and it is this page's own. `aria-current` is the
    // whole answer to "where am I" now that no section repeats its name as a
    // heading, so a strip with none — or with two — is the navigation failing
    // at its only job. A `NavLink` with no `end` would mark Tests current on
    // all five of these, since every project URL starts with `/projects/:slug`.
    const current = nav.getByRole('link').and(page.locator('[aria-current="page"]'));
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(label);

    // ONE `<h1>`, and it names the PROJECT rather than the section. `exact`
    // because Playwright's default is a case-insensitive substring and the
    // shell falls back to the SLUG ('checkout') until `GET /v1/projects`
    // lands — a loose match would pass against the fallback and prove nothing
    // about the name ever arriving.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Checkout');

    // Launch stays an ACTION, which M10 asks for explicitly: the five are
    // places you can sit on and bookmark, this is a thing you do. Asserted as
    // a pair, because "not in the nav" alone passes just as well against a
    // page that lost the action altogether.
    await expect(page.getByRole('link', { name: 'New on-prem run', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'New on-prem run' })).toHaveCount(0);

    // THE RAIL'S VOCABULARY IS STILL THE RAIL'S. "All runs" is the org-wide
    // list on every authenticated page; one element with that name, and it is
    // not in this strip.
    await expect(page.getByRole('link', { name: 'All runs', exact: true })).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'All runs' })).toHaveCount(0);
  }
});

/**
 * ═══ THE OUTLINE, WHICH IS WHAT THE `<h1>` MOVE ACTUALLY CHANGED ═══
 *
 * Three of these pages used to take the SECTION name as their `<h1>` — "Add
 * results", "SLA rules", "API tokens" — with the project demoted to a
 * breadcrumb above it. That reads correctly on one page and stops being true
 * the moment there are five: the thing the reader is looking at is the
 * project, and which of its faces is showing is what the strip is for.
 *
 * So the rule is `RunShell`'s, one rung up: the shell owns the single `<h1>`
 * and NO section repeats its own name as a heading. The failure that guards
 * against is a section quietly re-adding one — invisible on screen, where it
 * looks like a section title, and met twice by a screen-reader user navigating
 * by heading.
 */
test('no section repeats its own name as a heading', async ({ page }) => {
  const admin = await seedAdmin();
  await signIn(page, admin);

  for (const { label, path } of SECTIONS) {
    await page.goto(path);
    await expect(sections(page)).toBeVisible();

    const headings = await page.getByRole('heading').allTextContents();
    expect(headings.filter((h) => h.trim() === label)).toEqual([]);
  }
});
