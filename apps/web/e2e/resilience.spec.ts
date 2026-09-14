import { expect, test } from '@playwright/test';
import { seedAdmin, seedProjectWithRuns, seedRunWithData } from './fixtures.js';
import { failWith, signIn, stall } from './helpers.js';

/**
 * ═══ WHAT A READER MEETS WHILE A PAGE IS LOADING, OR AFTER IT FAILED ═══
 * (the 09-13 review's acceptance list: "slow loading and retry")
 *
 * A coverage sweep found this the emptiest group on the list: until the
 * acceptance pass added one `page.route` for an expired session, there was no
 * interception anywhere in 19 spec files, so every response the suite had ever
 * seen was a real, fast, local answer. Skeletons, the bootstrap screen and
 * every error panel are reachable in under a second locally — which is exactly
 * why nobody had drawn them.
 */

test('the skeleton has the columns of the table it stands in for', async ({ page }) => {
  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha Service', 3);
  await signIn(page, admin);
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  /* ═══ WHERE THIS PLACEHOLDER IS ACTUALLY REACHABLE, WHICH TOOK FINDING ═══
   *
   * MEASURED, three ways:
   *   - a COLD load of /runs never draws it. `AuthGate` waits on the session
   *     AND on the first runs page, so stalling `/v1/runs` leaves the screen
   *     reading "Checking your session…" and the run list never renders its
   *     pending state at all.
   *   - an in-app navigation to /runs never draws it either: that query is
   *     already cached from the bootstrap, so there is no pending state to
   *     show.
   *   - a PROJECT-scoped list does. Its query key carries the slug, nothing
   *     has fetched it, and `AuthGate`'s bootstrap only awaits the org-wide
   *     page.
   *
   * That is why a skeleton declaring SIX columns for a table of nine survived
   * two column changes: on the page it was written for it is unreachable, and
   * the one place it does appear is a different column count again. */
  await page.getByRole('link', { name: 'Alpha Service' }).click();
  await stall(page, '**/v1/runs**', 1_500);
  await page.getByRole('link', { name: 'Runs', exact: true }).click();

  /* WAIT FOR THE ROUTE FIRST. `ProjectTests` draws its own four-column
     skeleton on the way through, and reading "the first skeleton on the page"
     picked that one up — a locator that does not say WHICH page it means is
     answered by whichever page is mounted. */
  await expect(page).toHaveURL(/\/projects\/alpha\/runs$/);
  const header = page.getByTestId('skeleton-table').locator('> div').first();
  await expect(header).toBeVisible();
  const placeholderColumns = await header.evaluate((el) => el.children.length);

  await expect(page.getByTestId('run-row').first()).toBeVisible({ timeout: 15_000 });
  const realColumns = await page.locator('table thead th').count();

  /* A PLACEHOLDER WHOSE SHAPE IS NOT THE CONTENT'S IS A LAYOUT JUMP DRESSED AS
     A LOADING STATE — the whole point of drawing one is that nothing moves
     when the data lands. Derived from the same condition the header uses, so
     the two cannot drift again. */
  expect(
    placeholderColumns,
    `the skeleton drew ${placeholderColumns} columns for a table of ${realColumns}`,
  ).toBe(realColumns);
});

test('a failed load shows the server’s own remediation, not a bare failure', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await failWith(page, '**/v1/runs?*', {
    status: 503,
    title: 'Service Unavailable',
    detail: 'The run store is not answering.',
    remediation: 'Try again in a few moments.',
    code: 'UPSTREAM_UNAVAILABLE',
  });
  await page.goto('/runs');

  /* `role="alert"` WRAPS THE WHOLE PANEL (`States.tsx`), so this reads the
     title, the detail and the remediation in one node — which is also what a
     screen reader is handed. */
  const panel = page.getByRole('alert');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/run store is not answering/i);

  /* THE REMEDIATION IS THE HALF THAT MATTERS. A panel that says only "the runs
     could not be loaded" leaves a reader with nothing to do; the server sent a
     next step and the page has to show it. */
  await expect(panel).toContainText(/try again in a few moments/i);

  // And no stale rows underneath it presented as current.
  await expect(page.getByTestId('run-row')).toHaveCount(0);
});

/**
 * ═══ THE ONE RENDER BEFORE THE APP KNOWS ANYTHING ═══
 *
 * `AuthGate` draws `Bootstrapping()` for both a pending session and a pending
 * first page. It has no unit file at all, and no spec had ever seen it — it
 * exists for about 40ms against a local API.
 */
test('the cold start says what it is doing rather than showing nothing', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  /* STALLS THE RUNS PAGE, NOT THE SESSION — which is what actually produces
     this screen. `AuthGate` renders `Bootstrapping()` for a pending session OR
     a pending first runs page, and on a cold load the second is the slower of
     the two. */
  await stall(page, '**/v1/runs**', 2_000);
  await page.goto('/runs');

  /* A STATUS, NOT A SPINNER ALONE. A reader who cannot see a spinner — or is
     listening — gets nothing from one, and this is the screen where the app
     genuinely knows nothing yet. It exists for about 40ms against a local API,
     which is why no spec had ever drawn it. */
  const status = page.getByRole('status').first();
  await expect(status).toBeVisible();
  await expect(status).toContainText(/checking your session/i);

  // And it resolves rather than sticking, once the stall expires.
  await expect(page.getByTestId('run-row').first()).toBeVisible({ timeout: 15_000 });
});

/**
 * ═══ A LAZY CHUNK THAT NEVER ARRIVES ═══
 * (the 09-13 review's acceptance list: "slow loading and retry")
 *
 * `App.tsx` declares seventeen `lazy()` routes and nothing caught what they
 * throw. MEASURED against the built bundle before the boundary existed:
 * blocking one chunk and navigating to its route left `#root` with ZERO
 * children, `document.body` empty, and no header and no rail — the whole tree
 * unmounted, with `Failed to fetch dynamically imported module` on the console
 * and nothing at all on screen.
 *
 * That is what every reader with the app open gets the moment a deploy
 * replaces the assets they loaded: the next link asks for a file that is no
 * longer there.
 *
 * ONLY A BROWSER CAN TEST THIS. It needs a real built bundle, real chunk
 * URLs and a real dynamic import — `pnpm test:e2e` serves exactly that, and
 * jsdom has none of it.
 */
test('a chunk that fails to load leaves a page, not a blank screen', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  // One route's chunk, not all of them: the interesting claim is that the rest
  // of the application survives.
  await page.route('**/assets/ProjectSetup*.js', (route) => route.abort());
  await page.goto('/projects/checkout/setup');

  /* THE PANEL, NOT A BLANK PAGE. `ErrorState` wraps its whole panel in
     `role="alert"`, so this reads the title, the detail and the remediation in
     one node — which is also what a screen reader is handed. */
  const panel = page.getByRole('alert');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/could not be loaded/i);
  await expect(panel).toContainText(/updated while the page was open/i);

  /* AND AN ACTION. Reloading is the only thing a reader can do from here, and
     it is the thing that actually fixes the common cause — the new index.html
     names the new files. */
  await expect(page.getByTestId('route-error-reload')).toBeVisible();

  /* THE SHELL SURVIVES, which is the difference between a broken page and a
     broken app: the boundary inside `AppShell` catches a failed PAGE chunk, so
     the header and the project rail are still there to navigate away with. */
  await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();

  /* AND THE ERROR DOES NOT OUTLIVE THE ROUTE THAT CAUSED IT. A caught error is
     state; a boundary that never resets turns one failed chunk into a dead
     application. Navigating to a route whose chunk is fine must work. */
  await page.getByRole('link', { name: 'All runs' }).click();
  await expect(page.getByTestId('run-row').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
