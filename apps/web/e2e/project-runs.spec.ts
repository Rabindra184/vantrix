import { expect, test } from '@playwright/test';
import { seedAdmin, seedProjectWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * `/projects/:slug` — the run list narrowed to one project.
 *
 * This file exists separately from run-list.spec.ts (rather than appending
 * to it) because this spec seeds TWO extra projects into the org, and
 * fixtures.ts's `projectFor` resolves the org's project by
 * `findFirst`/`orderBy: createdAt asc` — sharing a file with tests that rely
 * on that resolution would risk exactly the contamination that helper's own
 * docstring warns about.
 *
 * What this file proves, against a real build behind a real Postgres: the
 * route exists, `?project=` actually narrows the server response to one
 * project (not a merge of both), and the heading names itself from
 * `GET /v1/projects`.
 *
 * What it does NOT prove, despite its name and the `page.goto` calls below
 * looking like a page-forward-then-switch scenario: it does not exercise
 * `key={slug}` on `<RunList>` in `ProjectRuns.tsx`. `page.goto` is always a
 * full top-level browser navigation — a document load — which Playwright
 * cannot avoid and React Router cannot intercept, so every call here tears
 * down and remounts the whole app regardless of whether that key is
 * present. `key={slug}`'s falsifiability is proven in jsdom instead, in
 * `apps/web/test/ProjectRuns.test.tsx`, via a real client-side transition
 * (`<Link>` + `history.pushState`) — the only kind of navigation the bug in
 * design spec §8.3 can actually occur under. See that file's docstring for
 * why the guard cannot live here.
 */

test('switching projects after paging forward shows the second project\'s first page', async ({ page }) => {
  const admin = await seedAdmin();
  // PAGE_SIZE is 25, so 26 runs in the first project guarantee a Next.
  const alpha = await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha', 26);
  await seedProjectWithRuns(admin.orgId, 'beta', 'Beta', 3);

  await signIn(page, admin);
  await page.goto(`/projects/${alpha.slug}`);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('run-row')).toHaveCount(1); // 26 = 25 + 1

  // A fresh document load, not a client-side transition (see this file's
  // docstring) — so this next assertion is about `?project=` filtering the
  // SERVER response correctly, not about `key={slug}` surviving anything.
  await page.goto('/projects/beta');
  await expect(page.getByTestId('run-row')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Beta' })).toBeVisible();
});
