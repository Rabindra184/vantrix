import { expect, test, type Page, type Request } from '@playwright/test';
import {
  seedAdmin,
  seedPackage,
  seedPersonInNoProject,
  seedProjectMember,
  seedRunWithProvenance,
  seedTestWithRuns,
} from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * ═══ EACH ROLE SEES THE PROJECT THE WAY IT MAY USE IT (project access, PR 3) ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 4)
 *
 * WHAT ONLY THIS CAN PROVE. Every gated control has a component test that
 * seeds a role straight into the query cache (`seedAccess`). That proves a
 * component reads the answer it is handed; it cannot prove the answer the
 * real API gives a real session — a non-admin's `GET /v1/projects` naming
 * their role — reaches every page through the real router, nor that a role an
 * admin changes on the Members page is the role the person's next page load
 * draws. Each journey here signs in as a FRESH account the fixture made with
 * that role (`seedProjectMember`), in an org of its own.
 *
 * ═══ AN ABSENT CONTROL PROVES NOTHING UNTIL ACCESS IS KNOWN ═══
 *
 * "Hidden until known": while the session or the project list is pending, no
 * gated control is drawn for anybody. So "a Viewer sees no New rule" passes
 * against a page that never learnt who the Viewer was. Two things keep every
 * absence here honest:
 *
 *   - each is asserted on a page where something proves access is known
 *     first: the API tokens page's refusal sentence (drawn only when access
 *     is known and refuses; every later step of that journey reads the same
 *     cached answer); a gated control the same reader IS offered on that
 *     page; on a run page, the rail's row for the project, which comes from
 *     the same `GET /v1/projects` the run's access is read from; and, for the
 *     person on no project, the no-projects sentence itself, drawn only once
 *     the session and the list have both answered;
 *   - each PROJECT control's absence is PAIRED with the same page drawing it
 *     for a role that may use it, under the same waits: the Member journey
 *     draws what the Viewer's hides, the Manager's what the Member's hides,
 *     and the admin's the Members controls (Add member, a role, Remove from
 *     project). New project is the exception: no journey here draws it — an
 *     admin's offer of it is pinned by the `AppShell`, `Home` and
 *     `AttentionCard` unit tests — so its absence here rests on the first
 *     point alone.
 *
 * `exact: true` on every name another one contains — "Role", "Remove",
 * "Add" against "Add member" and "Add results" — because Playwright's name
 * match is a case-insensitive substring (CLAUDE.md, "Conventions that bite").
 */

const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections', exact: true });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Projects', exact: true });

/** The strip's tabs in order, as each role is offered them (`routes/projectSections.ts`). */
const VIEWER_TABS = ['Tests', 'Runs', 'Packages', 'SLA rules', 'Members'];
const MEMBER_TABS = ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members'];
const MANAGER_TABS = ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members', 'API tokens'];

/** `accessRefusal('tokens:manage')` — the API's own two sentences, which `NoAccess` draws. */
const TOKENS_REFUSED = 'Managing API tokens needs the Manager role in this project.';
const ASK_AN_ADMIN = 'Ask an admin to change your role.';

const TEST = { slug: 'payments-sweep', name: 'Payments sweep', simulationClass: 'shop.PaymentsSimulation', runs: 1 };

/** What every role journey reads: a test, a package and a run with no note, in `checkout`. */
async function seedProject(orgId: string): Promise<{ packageName: string; runId: string }> {
  await seedTestWithRuns(orgId, TEST);
  const pkg = await seedPackage(orgId, { name: 'Soak jar' });
  const runId = await seedRunWithProvenance(orgId, { environment: 'staging' });
  return { packageName: pkg.name, runId };
}

test('a Viewer reads every section and is offered nothing to change', async ({ page }) => {
  const admin = await seedAdmin();
  const { packageName, runId } = await seedProject(admin.orgId);
  const viewer = await seedProjectMember(admin.orgId, admin.projectId, 'viewer', 'Rowan Reed');
  await signIn(page, viewer);

  await test.step('API tokens, reached by its address, answers in the API’s own words', async () => {
    // FIRST, because it is the one thing on screen that says access is KNOWN
    // and refuses: `NoAccess` is never drawn while either query is pending.
    // Every absence after it reads the same cached answer.
    await page.goto('/projects/checkout/access');
    await expect(page.getByText(TOKENS_REFUSED, { exact: true })).toBeVisible();
    await expect(page.getByText(ASK_AN_ADMIN, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create token', exact: true })).toHaveCount(0);

    // Five tabs, in order — no Add results, no API tokens — and no launch.
    await expect(sections(page).getByRole('link')).toHaveText(VIEWER_TABS);
    await expect(page.getByTestId('project-launch')).toHaveCount(0);
  });

  await test.step('SLA rules: the list, and no New rule', async () => {
    await sections(page).getByRole('link', { name: 'SLA rules', exact: true }).click();
    await expect(page.getByText('No rules yet.')).toBeVisible();
    await expect(page.locator('summary', { hasText: 'New rule' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add rule', exact: true })).toHaveCount(0);
  });

  await test.step('Packages: the package, and no New package or package actions', async () => {
    await sections(page).getByRole('link', { name: 'Packages', exact: true }).click();
    await expect(page.getByText(packageName, { exact: true })).toBeVisible();
    await expect(page.locator('summary', { hasText: 'New package' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `${packageName}: package actions`, exact: true })).toHaveCount(0);
  });

  await test.step('Members: the table, read only', async () => {
    await sections(page).getByRole('link', { name: 'Members', exact: true }).click();
    const own = page.getByRole('row').filter({ hasText: viewer.email });
    await expect(own).toContainText('Viewer');
    await expect(page.locator('summary', { hasText: 'Add member' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: `Role for ${viewer.name}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Remove from project ${viewer.name}`, exact: true })).toHaveCount(0);
  });

  await test.step('a run: no Add a note', async () => {
    await page.goto(`/runs/${runId}`);
    // The rail's row for Checkout comes from the same `GET /v1/projects` the
    // run page's access is read from, and the heading from the run itself: once
    // both are on screen the note's gate has its answer.
    await expect(rail(page).getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a note', exact: true })).toHaveCount(0);
  });
});

test('a Member adds results and starts runs, and is offered neither API tokens nor test management', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const { packageName, runId } = await seedProject(admin.orgId);
  const member = await seedProjectMember(admin.orgId, admin.projectId, 'member', 'Morgan Moss');
  await signIn(page, member);

  await test.step('six tabs, with Add results, and New on-prem run beside the heading', async () => {
    await page.goto('/projects/checkout');
    await expect(sections(page).getByRole('link')).toHaveText(MEMBER_TABS);
    await expect(page.getByTestId('project-launch')).toBeVisible();
    await expect(page.getByTestId('project-launch')).toHaveAttribute('href', '/projects/checkout/run/new');
  });

  await test.step('a test’s page: New rule, and no Rename or Delete test', async () => {
    // The Tests table names each row's link "View test <name>" (its
    // `aria-label` in `ProjectTests`), so the bare name never matches exactly.
    await page.getByRole('link', { name: `View test ${TEST.name}`, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: TEST.name, exact: true })).toBeVisible();
    // A Member may edit rules, so this disclosure is the proof, on THIS page,
    // that access is known — and Rename and Delete test ask for Manager.
    await expect(page.locator('summary', { hasText: 'New rule' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete test', exact: true })).toHaveCount(0);
  });

  await test.step('SLA rules and Packages draw what a Viewer’s hide', async () => {
    // By address: a test's page sits outside the project shell, so it has a
    // breadcrumb and no section strip to click.
    await page.goto('/projects/checkout/rules');
    await expect(page.getByText('No rules yet.')).toBeVisible();
    await expect(page.locator('summary', { hasText: 'New rule' })).toBeVisible();

    await sections(page).getByRole('link', { name: 'Packages', exact: true }).click();
    await expect(page.locator('summary', { hasText: 'New package' })).toBeVisible();
    await expect(page.getByRole('button', { name: `${packageName}: package actions`, exact: true })).toBeVisible();
  });

  await test.step('API tokens, reached by its address, is refused', async () => {
    await page.goto('/projects/checkout/access');
    await expect(page.getByText(TOKENS_REFUSED, { exact: true })).toBeVisible();
  });

  await test.step('a run: Add a note', async () => {
    await page.goto(`/runs/${runId}`);
    await expect(rail(page).getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a note', exact: true })).toBeVisible();
  });
});

test('a Manager is offered API tokens, and Rename and Delete test', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, TEST);
  const manager = await seedProjectMember(admin.orgId, admin.projectId, 'manager', 'Kai Kerr');
  await signIn(page, manager);

  await page.goto('/projects/checkout');
  await expect(sections(page).getByRole('link')).toHaveText(MANAGER_TABS);

  await sections(page).getByRole('link', { name: 'API tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create token', exact: true })).toBeVisible();
  await expect(page.getByText(TOKENS_REFUSED, { exact: true })).toHaveCount(0);

  await sections(page).getByRole('link', { name: 'Tests', exact: true }).click();
  await page.getByRole('link', { name: `View test ${TEST.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete test', exact: true })).toBeVisible();
});

test('a person on no project is told so, and offered no New project', async ({ page }) => {
  const admin = await seedAdmin();
  const nobody = await seedPersonInNoProject(admin.orgId, 'Noor Nash');
  await signIn(page, nobody);

  await test.step('Home and the rail say so, and nothing offers New project', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2, name: "You're not on any project yet", exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('Ask an admin to add you.', { exact: true })).toBeVisible();
    await expect(rail(page)).toContainText("You're not on any project yet. Ask an admin to add you.");
    // The org HAS a project — Checkout, the admin's. A rail that listed the
    // org rather than the reader would show it.
    await expect(rail(page).getByRole('link', { name: 'Checkout', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'New project', exact: true })).toHaveCount(0);

    await rail(page).getByRole('link', { name: 'All runs', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Runs', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New project', exact: true })).toHaveCount(0);
  });

  await test.step('on a phone, the rail’s whole sentence is on screen', async () => {
    // Below `lg` the rail is one horizontal strip: Home, All runs, then the
    // sentence. A strip that let it run off the right edge would ask the
    // reader to scroll a navigation bar sideways to learn why it is empty.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const sentence = rail(page).getByText("You're not on any project yet. Ask an admin to add you.", { exact: true });
    await expect(sentence).toBeInViewport({ ratio: 1 });
  });
});

test('an admin adds a person on Members and changes a Viewer to Member, whose next load offers Add results', async ({
  page,
  browser,
}) => {
  // Two sign-ins and two contexts.
  test.setTimeout(120_000);

  const admin = await seedAdmin();
  const viewer = await seedProjectMember(admin.orgId, admin.projectId, 'viewer', 'Rowan Reed');
  const newcomer = await seedPersonInNoProject(admin.orgId, 'Noor Nash');

  const viewerContext = await browser.newContext();
  try {
    const viewerPage = await viewerContext.newPage();
    await signIn(viewerPage, viewer);
    await viewerPage.goto('/projects/checkout');
    await expect(sections(viewerPage).getByRole('link')).toHaveText(VIEWER_TABS);

    await signIn(page, admin);
    await page.goto('/projects/checkout/members');
    await expect(sections(page).getByRole('link')).toHaveText(MANAGER_TABS);

    await test.step('Add member gives somebody with no row a role, a Viewer unless chosen otherwise', async () => {
      await page.locator('summary', { hasText: 'Add member' }).click();
      await page
        .getByLabel('Person', { exact: true })
        .selectOption({ label: `${newcomer.name} (${newcomer.email})` });
      await expect(page.getByLabel('Role', { exact: true })).toHaveValue('viewer');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('combobox', { name: `Role for ${newcomer.name}`, exact: true })).toHaveValue(
        'viewer',
      );
    });

    await test.step('the Viewer’s role changes through Save, as one request', async () => {
      const patches: string[] = [];
      const record = (req: Request): void => {
        if (req.method() === 'PATCH' && new URL(req.url()).pathname.includes('/members/')) patches.push(req.url());
      };
      page.on('request', record);
      try {
        const role = page.getByRole('combobox', { name: `Role for ${viewer.name}`, exact: true });
        await expect(role).toHaveValue('viewer');
        // The Viewer's own journey asserts this button absent; an admin is
        // offered it on the same row, which is what makes that absence mean
        // the role and not a page that never drew its controls.
        await expect(
          page.getByRole('button', { name: `Remove from project ${viewer.name}`, exact: true }),
        ).toBeVisible();
        await role.selectOption('member');
        // Picking stages a choice; Save sends it.
        const save = page.getByRole('button', { name: `Save role for ${viewer.name}`, exact: true });
        await expect(save).toBeVisible();
        // Bounded: unbounded, a Save that sends nothing waits out the whole
        // test (measured, by breaking Save) and is reported as the finally's
        // context close, which names nothing. A healthy PATCH answers in ms.
        const answered = page.waitForResponse(
          (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname.includes('/members/'),
          { timeout: 15_000 },
        );
        await save.click();
        expect((await answered).status()).toBe(200);
        await expect(save).toHaveCount(0);
        await expect(role).toHaveValue('member');
      } finally {
        page.off('request', record);
      }
      expect(patches, 'one PATCH for one Save').toHaveLength(1);
    });

    await test.step('the person’s next page load offers Add results', async () => {
      await viewerPage.reload();
      await expect(sections(viewerPage).getByRole('link')).toHaveText(MEMBER_TABS);
      await expect(viewerPage.getByTestId('project-launch')).toBeVisible();
    });
  } finally {
    await viewerContext.close();
  }
});
