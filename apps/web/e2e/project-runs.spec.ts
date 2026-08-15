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

  await page.goto('/projects/beta');
  // Without key={slug} the cursor survives the param change, resolves
  // against no row under the new scope, and this list comes back EMPTY —
  // a screen that looks merely idle rather than broken.
  await expect(page.getByTestId('run-row')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Beta' })).toBeVisible();
});
