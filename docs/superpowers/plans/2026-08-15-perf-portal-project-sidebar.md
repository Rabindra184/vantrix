# Project Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a persistent project rail on every authenticated page — brand, an **All runs** entry, and one row per project carrying its latest run's badge.

**Architecture:** `AppShell` becomes a two-column grid on wide screens and one stacked column below the breakpoint. A new `ProjectRail` owns the query, the four states and the badge rule; `AppShell` owns only layout. No new fetcher, no new path helper, no new vocabulary — `fetchProjects`, `projectPath`, `Badge` and the `STATUS`/`VERDICT` marks all already exist.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, Tailwind v4, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-15-perf-portal-project-sidebar-design.md`

## Global Constraints

- **Front-end only.** No contract, OpenAPI, persistence, API or migration change may appear in this diff. If a requirement seems to need one, stop and report it rather than widening the API — the previous sub-project was shaped specifically so this one would not have to.
- **`SignOutButton` renders exactly once.** Not twice with a `lg:hidden`. Playwright's strict mode counts DOM matches, not visible ones, so two nodes make `getByRole('button', { name: 'Sign out' })` throw — and `apps/web/e2e/auth.spec.ts` both asserts it visible and clicks it. Two identical controls with one accessible name is also an a11y defect regardless of CSS.
- **Assert that with `toHaveCount(1)`, never `toBeVisible()`.** A visibility check passes on one button and *throws* on two, which reports a real regression as a harness error instead of a failed assertion.
- **Badge rule, exactly:** `latestRun === null` → no badge; `status !== 'complete'` → `STATUS[status]`; `status === 'complete'` → `VERDICT[verdict ?? 'none']`. A pending run must never render as *not evaluated*.
- **The rail wrapper is a `<div>`, not an `<aside>`.** `<aside>` means *complementary*; a primary nav rail is not that. The landmark is `<nav aria-label="Projects">`.
- **The brand is a `<Link>`, not a heading** — it must not compete with the `<h1>` each page renders in `<main>`.
- **No drawer, no toggle, no overlay, no focus trap.** Below `lg` the same `<nav>` lays out horizontally with `overflow-x-auto`.
- **Exact copy:** error is `Projects could not be loaded.` — empty is `No projects yet.` Both verbatim.
- **Every absence assertion is paired with a positive in the same file.** An absence assertion passes when the feature is correctly hidden AND when it was never built. Seven defects of that shape came out of the previous sub-project; this one has four absence assertions.
- **`getByRole(role, { name })` is EXACT in Testing Library and a case-insensitive SUBSTRING in Playwright** (`CLAUDE.md`). Pass `exact: true` in every Playwright name query here, and keep fixture names from being substrings or case variants of each other or of their slugs.
- **Run every command under Node 22.19.0.** `.nvmrc` pins it; `engines` requires `>=22`. Under Node 20 `pnpm test:unit` **exits 1** while silently collecting only a subset of files — it reads like a pass if you look at the count and not the exit code. Start with:
  ```bash
  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.19.0 && node --version
  ```
- **Narrowing forms.** Unit: `pnpm exec vitest run apps/web/test/<file>` from the repo ROOT — never `pnpm --filter @perfportal/web exec vitest`, which changes cwd to `apps/web`, finds `vite.config.ts` (no `test` block) instead of the root config, loses jsdom, and kills every component test with `ReferenceError: document is not defined`. e2e: `pnpm exec playwright test <file>` — never `pnpm test:e2e -- <file>`, which does not forward the argument.
- **Never run e2e and integration concurrently.** They share a `DATABASE_URL` and the integration harness `TRUNCATE`s all 15 tables. Port 3000 must be free for Playwright (`reuseExistingServer: false` is deliberate).
- **Full gate before completion:**
  ```bash
  pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
  ```
  Stack env for the last two is in `CLAUDE.md`. Baseline on `main` at `a0656ca`: unit 65 files/687, integration 64 files/724, e2e 58.
- **`apps/web/test/**` and `apps/web/e2e/**` are both typechecked** (each has a tsconfig in the root `typecheck` script). A type error in either fails the gate.
- Branch is `feat/project-sidebar`, already created from `main`. One PR back to `main`, merged with `--merge`, never squash.

---

### Task 1: `ProjectRail`

**Files:**
- Create: `apps/web/src/ProjectRail.tsx`
- Test: `apps/web/test/ProjectRail.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchProjects` / `projectsQueryKey` (`apps/web/src/api/projects.ts`); `DEFAULT_ROUTE` / `projectPath(slug)` (`apps/web/src/routes/paths.ts`); `Badge` (`apps/web/src/components/Badge.tsx`); `STATUS` / `VERDICT` (`apps/web/src/routes/marks.tsx`).
- Produces: default export `ProjectRail` — takes no props. Task 2 mounts it.

Reference values you will assert against, so you do not have to open the files: `STATUS.pending.label` is `'pending'`, `STATUS.complete.label` is `'complete'`, `VERDICT.passed.label` is `'passed'`, `VERDICT.none.label` is `'no verdict yet'`. `Badge` renders an `aria-hidden` glyph followed by the label text.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/ProjectRail.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectListResponse } from '@perfportal/contracts';
import ProjectRail from '../src/ProjectRail';

afterEach(cleanup);

/**
 * Names are deliberately NOT substrings or case variants of each other or of
 * their slugs. `getByRole(role, { name })` is exact here but a
 * case-insensitive substring in Playwright (CLAUDE.md), and fixtures that
 * cannot collide stay correct under either matcher.
 *
 * The three latestRun shapes are the three badge branches: complete with a
 * verdict, not-complete, and none at all.
 */
const PROJECTS: ProjectListResponse['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'checkout',
    name: 'Checkout Flow',
    latestRun: { id: 'aaaaaaaa-1111-4111-8111-111111111111', status: 'complete', verdict: 'passed' },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'search',
    name: 'Search Indexing',
    latestRun: { id: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'pending', verdict: null },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    slug: 'billing',
    name: 'Billing Exports',
    latestRun: null,
  },
];

function renderRail(
  items: ProjectListResponse['items'],
  { route = '/runs', fail = false, hang = false } = {},
) {
  vi.stubGlobal('fetch', () => {
    if (hang) return new Promise<Response>(() => {});
    if (fail) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <ProjectRail />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectRail', () => {
  it('lists every project as a link to its own page', async () => {
    renderRail(PROJECTS);
    expect(await screen.findByRole('link', { name: /Checkout Flow/ })).toHaveAttribute(
      'href',
      '/projects/checkout',
    );
    expect(screen.getByRole('link', { name: /Search Indexing/ })).toHaveAttribute(
      'href',
      '/projects/search',
    );
    expect(screen.getByRole('link', { name: /Billing Exports/ })).toHaveAttribute(
      'href',
      '/projects/billing',
    );
  });

  it("reads a complete run's verdict", async () => {
    renderRail(PROJECTS);
    // 'passed' belongs only to VERDICT — no STATUS mark uses that word — so
    // this cannot pass by accidentally rendering a status.
    expect(await screen.findByRole('link', { name: /Checkout Flow/ })).toHaveTextContent('passed');
  });

  it("reads a pending run's STATUS and never a verdict", async () => {
    renderRail(PROJECTS);
    const search = await screen.findByRole('link', { name: /Search Indexing/ });
    expect(search).toHaveTextContent('pending');
    // The obvious wrong implementation reads VERDICT[verdict ?? 'none']
    // unconditionally, which renders 'no verdict yet' for this run — a claim
    // about a run nobody has measured.
    expect(search).not.toHaveTextContent('no verdict yet');
  });

  it('gives a project with no runs no badge, while a sibling with runs has one', async () => {
    renderRail(PROJECTS);
    const billing = await screen.findByRole('link', { name: /Billing Exports/ });
    // Absence, asserted exactly: the link's whole text is the name, with no
    // glyph and no label appended.
    expect(billing.textContent).toBe('Billing Exports');
    // PAIRED POSITIVE, same test on purpose: without it this passes against a
    // rail that renders no badges at all.
    const checkout = screen.getByRole('link', { name: /Checkout Flow/ });
    expect(checkout.textContent).not.toBe('Checkout Flow');
  });

  it('marks All runs as the current page on /runs', async () => {
    renderRail(PROJECTS, { route: '/runs' });
    expect(await screen.findByRole('link', { name: 'All runs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the project, not All runs, as current on a project page', async () => {
    renderRail(PROJECTS, { route: '/projects/checkout' });
    const checkout = await screen.findByRole('link', { name: /Checkout Flow/ });
    expect(checkout).toHaveAttribute('aria-current', 'page');
    // `end` on the All runs NavLink is what makes this true.
    expect(screen.getByRole('link', { name: 'All runs' })).not.toHaveAttribute('aria-current');
  });

  it('marks nothing as current on a run detail page', async () => {
    renderRail(PROJECTS, { route: '/runs/a66548b7-2962-43ff-8b93-7149a6f2a1b8' });
    // Paired positive FIRST: the rail rendered its rows, so the absences
    // below are about aria-current and not about an empty rail.
    const checkout = await screen.findByRole('link', { name: /Checkout Flow/ });
    expect(checkout).not.toHaveAttribute('aria-current');
    // This is the assertion `end` exists for. Without it React Router treats
    // /runs as a prefix match for /runs/:runId, and the rail would claim the
    // reader is on the org-wide list while they are reading one run.
    expect(screen.getByRole('link', { name: 'All runs' })).not.toHaveAttribute('aria-current');
  });

  it('says so when the projects cannot be loaded, and keeps All runs', async () => {
    renderRail([], { fail: true });
    expect(await screen.findByText('Projects could not be loaded.')).toBeInTheDocument();
    // Paired positive: the rail degraded rather than vanished.
    expect(screen.getByRole('link', { name: 'All runs' })).toBeInTheDocument();
  });

  it('says so when the org has no projects, and keeps All runs', async () => {
    renderRail([]);
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All runs' })).toBeInTheDocument();
  });

  it('shows neither message while the query is in flight', async () => {
    renderRail([], { hang: true });
    // Paired positive FIRST — this is what proves the rail rendered at all,
    // so the two absence assertions below mean something.
    expect(await screen.findByRole('link', { name: 'All runs' })).toBeInTheDocument();
    expect(screen.queryByText('Projects could not be loaded.')).toBeNull();
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm exec vitest run apps/web/test/ProjectRail.test.tsx
```

Expected: every test FAILS at import — `Failed to resolve import "../src/ProjectRail"`. The module does not exist yet.

- [ ] **Step 3: Write the component**

Create `apps/web/src/ProjectRail.tsx`:

```tsx
import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectListResponse } from '@perfportal/contracts';
import Badge from './components/Badge';
import { fetchProjects, projectsQueryKey } from './api/projects';
import { DEFAULT_ROUTE, projectPath } from './routes/paths';
import { STATUS, VERDICT } from './routes/marks';

type ProjectItem = ProjectListResponse['items'][number];

/**
 * What this organisation contains, on every authenticated page.
 *
 * A `<div>`, not an `<aside>`: `aside` carries the `complementary` role,
 * meaning content tangentially related to the page, and a primary navigation
 * rail is not that. The landmark that matters is the `<nav>` below.
 *
 * The brand is a `<Link>` rather than a heading so it does not compete with
 * the `<h1>` every page renders inside `<main>` — and as a link it doubles as
 * the way back to the org-wide list.
 *
 * Below `lg` the same `<nav>` lays out horizontally and scrolls. Deliberately
 * NOT a drawer: a toggle overlay needs focus management, an escape handler, a
 * scrim and return-focus-on-close to be correct, and this repo runs Playwright
 * with a single `Desktop Chrome` project — so every one of those would ship
 * unverified. A plainer nav that is always in the document cannot trap a
 * keyboard user.
 */
export default function ProjectRail() {
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const items = projects.data?.items ?? [];

  return (
    <div className="flex flex-col border-b border-default bg-sidebar lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
      <Link to={DEFAULT_ROUTE} className="px-4 py-3 font-semibold">
        PerfPortal
      </Link>

      <nav
        aria-label="Projects"
        className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-4"
      >
        {/* `end` is load-bearing: without it React Router marks this active
            for /runs/:runId too, so the rail would claim the reader is on the
            org-wide list while they are reading one run. */}
        <NavLink
          to={DEFAULT_ROUTE}
          end
          className="shrink-0 rounded px-3 py-2 text-sm aria-[current=page]:bg-sunken"
        >
          All runs
        </NavLink>

        {items.map((project) => (
          <NavLink
            key={project.id}
            to={projectPath(project.slug)}
            className="flex shrink-0 items-center justify-between gap-2 rounded px-3 py-2 text-sm aria-[current=page]:bg-sunken"
          >
            {/* Truncated, not wrapped: a rail whose rows are two lines tall
                holds half as many projects, and the full name is on the page
                this links to. */}
            <span className="truncate">{project.name}</span>
            {badgeFor(project.latestRun)}
          </NavLink>
        ))}
      </nav>

      {/* Outside the <nav>, which contains only links. Both messages sit
          where the list would be. */}
      {projects.isError && (
        <p className="px-5 pb-3 text-sm text-muted">Projects could not be loaded.</p>
      )}
      {projects.isSuccess && items.length === 0 && (
        <p className="px-5 pb-3 text-sm text-muted">No projects yet.</p>
      )}
    </div>
  );
}

/**
 * Status first, verdict second — and the contract carries both fields
 * precisely so this decision can be made here.
 *
 * A pending run has `verdict: null`, so reading `VERDICT[verdict ?? 'none']`
 * unconditionally would render "no verdict yet" for a run nobody has measured
 * — the same overclaim the D-14 sentence fix corrected on the run page.
 *
 * A project with no runs gets NO badge rather than a neutral one: absence is
 * the honest rendering of "nothing has been ingested here".
 */
function badgeFor(latestRun: ProjectItem['latestRun']) {
  if (latestRun === null) return null;
  if (latestRun.status !== 'complete') return <Badge mark={STATUS[latestRun.status]} />;
  return <Badge mark={VERDICT[latestRun.verdict ?? 'none']} />;
}
```

`bg-sidebar` and `bg-sunken` are real classes here — sub-project 1's design system defines `--color-surface-sidebar` and `--color-surface-sunken` and exposes them through `@theme inline` as `--color-sidebar` and `--color-sunken` (`apps/web/src/styles/tokens.css`). It provisioned a sidebar surface before there was a sidebar; this is what it was for. Do not invent a new token.

Colour is not the only signal for the active row: `aria-current="page"` carries the semantics, which is what the tests assert and what a screen reader announces.

- [ ] **Step 4: Run them and watch them pass**

```bash
pnpm exec vitest run apps/web/test/ProjectRail.test.tsx
```

Expected: 10 passed.

- [ ] **Step 5: Prove the badge rule discriminates**

Temporarily change `badgeFor`'s middle line to `if (false)` so every run reads its verdict. Re-run. Expect `reads a pending run's STATUS and never a verdict` to FAIL on `not.toHaveTextContent('no verdict yet')`. Revert and re-run to confirm 10 passed. Put both outputs in your report — a rule nobody has watched break is not a rule.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ProjectRail.tsx apps/web/test/ProjectRail.test.tsx
git commit -m "feat(web): a project rail that reads status before verdict"
```

---

### Task 2: `AppShell` grows two columns

**Files:**
- Modify: `apps/web/src/AppShell.tsx`
- Test: `apps/web/test/AppShell.test.tsx` (create)

**Interfaces:**
- Consumes: `ProjectRail` from Task 1.
- Produces: the two-column shell Task 3's e2e asserts against.

- [ ] **Step 1: Write the failing test**

This is falsification checkpoint 3 — the rail must degrade without taking the page with it.

Create `apps/web/test/AppShell.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/AppShell';

afterEach(cleanup);

/**
 * A sentinel child route rather than the real run list. The property under
 * test is that the rail's failure does not reach `<main>`; a sentinel proves
 * it with ONE request in flight instead of two, so a red test names its own
 * cause instead of implicating the run list's own fetching.
 */
function renderShell() {
  vi.stubGlobal('fetch', (input: RequestInfo) =>
    Promise.resolve(
      String(input).includes('/v1/projects')
        ? new Response(
            JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
            { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
          )
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/runs" element={<p>page content stand-in</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell', () => {
  it('renders the page even when the rail cannot load its projects', async () => {
    renderShell();
    expect(await screen.findByText('Projects could not be loaded.')).toBeInTheDocument();
    // The point of the test: main is unaffected by the rail's failure.
    expect(screen.getByText('page content stand-in')).toBeInTheDocument();
  });

  it('renders the rail and exactly one Sign out control', async () => {
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
    // Count, not visibility. jsdom applies no CSS, so a second copy hidden by
    // a `lg:` class is fully present here — which makes this the cheapest
    // place to catch the duplication that would break auth.spec.ts.
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run apps/web/test/AppShell.test.tsx
```

Expected: both FAIL — no `Projects` navigation exists, because `AppShell` does not render the rail yet.

- [ ] **Step 3: Restructure the shell**

Replace `apps/web/src/AppShell.tsx` entirely:

```tsx
import { Outlet } from 'react-router-dom';
import ProjectRail from './ProjectRail';
import SignOutButton from './SignOutButton';

/**
 * The chrome around every authenticated page: rendered only inside
 * `AuthGate`, so its presence on screen is itself the proof that a session
 * survived — which is what the reload test asserts.
 *
 * Two columns on wide screens, one stacked column below `lg`, with DOM order
 * rail → header → main in both. No CSS reordering, so a screen reader and a
 * sighted reader traverse the same sequence.
 *
 * The brand moved into the rail; this header keeps `SignOutButton` and
 * nothing else yet. It renders ONCE — a second copy hidden by a `lg:` class
 * would make Playwright's `getByRole('button', { name: 'Sign out' })` resolve
 * to two nodes and throw under strict mode, and two identical controls
 * sharing one accessible name is a defect whatever the CSS says.
 */
export default function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <ProjectRail />
      <div>
        <header className="flex items-center justify-end border-b border-default px-6 py-3">
          <SignOutButton />
        </header>
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm exec vitest run apps/web/test/AppShell.test.tsx
```

Expected: 2 passed.

- [ ] **Step 5: Run the whole unit suite**

```bash
pnpm exec vitest run
```

Expected: every file passes. The shell's markup changed, so anything that mounted `AppShell` or asserted on the old header will surface here. Baseline was 65 files / 687 tests; you have added two files and 12 tests, so expect 67 / 699. If a pre-existing test fails, read it before changing it — it may be telling you the layout is wrong rather than that it is stale.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/AppShell.tsx apps/web/test/AppShell.test.tsx
git commit -m "feat(web): the shell grows a project rail beside its content"
```

---

### Task 3: Browser-verified facts

**Files:**
- Create: `apps/web/e2e/project-rail.spec.ts`

**Interfaces:**
- Consumes: `seedAdmin()` and `seedProjectWithRuns(orgId, slug, name, count)` from `apps/web/e2e/fixtures.ts`; `signIn(page, who)` from `apps/web/e2e/helpers.ts`.

Three facts jsdom cannot establish: a DOM count that depends on real CSS being applied, that the links really navigate against the real API, and that the responsive layout reflows rather than hides.

- [ ] **Step 1: Write the failing spec**

Create `apps/web/e2e/project-rail.spec.ts`. Model the imports on `apps/web/e2e/project-runs.spec.ts`.

```ts
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
  // NOT `rail.getByRole('link', { name: 'Billing Exports', exact: true })`.
  // `Badge` marks only its GLYPH aria-hidden, not its label, so a rail link
  // carrying a badge has the accessible name "Billing Exports passed" and an
  // exact match on the bare project name can never resolve. Filtering on the
  // exact VISIBLE text keeps the substring protection while accommodating the
  // badge — and, unlike asserting the full name, does not bake the fixture's
  // hard-coded verdict into the test.
  await rail
    .getByRole('link')
    .filter({ has: page.getByText('Billing Exports', { exact: true }) })
    .click();

  await expect(page).toHaveURL(/\/projects\/billing$/);
  await expect(page.getByRole('heading', { name: 'Billing Exports', exact: true })).toBeVisible();
});

test('the project nav reflows rather than disappearing on a narrow viewport', async ({ page }) => {
  const admin = await seedAdmin();
  await seedProjectWithRuns(admin.orgId, 'billing', 'Billing Exports', 2);
  await signIn(page, admin);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto('/runs');

  const rail = page.getByRole('navigation', { name: 'Projects', exact: true });
  await expect(rail).toBeVisible();
  // Visible is not enough — the spec's claim is that it stays USABLE, so the
  // test clicks through rather than stopping at presence.
  // NOT `rail.getByRole('link', { name: 'Billing Exports', exact: true })`.
  // `Badge` marks only its GLYPH aria-hidden, not its label, so a rail link
  // carrying a badge has the accessible name "Billing Exports passed" and an
  // exact match on the bare project name can never resolve. Filtering on the
  // exact VISIBLE text keeps the substring protection while accommodating the
  // badge — and, unlike asserting the full name, does not bake the fixture's
  // hard-coded verdict into the test.
  await rail
    .getByRole('link')
    .filter({ has: page.getByText('Billing Exports', { exact: true }) })
    .click();
  await expect(page).toHaveURL(/\/projects\/billing$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Port 3000 must be free, and the integration suite must not be running.

```bash
pnpm exec playwright test project-rail.spec.ts
```

Expected: if Tasks 1 and 2 are committed, the first test passes and the other two pass too — this spec is a regression net rather than a driver of new code. **If all three pass on the first run, say so in your report rather than implying a red-to-green cycle.** To confirm the net has teeth, temporarily change `AppShell`'s header to render `<SignOutButton />` twice, re-run, and confirm the first test fails with a count of 2; then revert.

- [ ] **Step 3: Run the whole e2e suite**

```bash
pnpm exec playwright test
```

Expected: 61 passed (58 baseline + 3). `auth.spec.ts`'s Sign out assertions and the three specs asserting `navigation` named *Run sections* has count 0 must still pass — the new nav is named *Projects*, so it does not collide.

- [ ] **Step 4: Run the complete gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Sequentially, never concurrently. Expected: typecheck and lint clean, unit 67 files/699, integration 64 files/724 (unchanged — no server code was touched), e2e 61. Report each figure. **If integration moved at all, something outside this sub-project's scope changed and you should say so rather than accepting it.**

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/project-rail.spec.ts
git commit -m "test(web): the rail navigates, reflows, and does not duplicate Sign out"
```

---

## Verification

Complete when, on a clean tree:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

is green under Node 22.19.0, and every success criterion in spec §10 holds:

- The rail renders on every authenticated page and on neither `/login` nor `/no-organisation`
- A failed projects query degrades the rail and nothing else
- `Sign out` resolves to exactly one node
- A pending run's project shows its status, never a verdict
- A project with no runs shows no badge
- **No contract, OpenAPI, persistence or API change appears in the diff** — `git diff main...HEAD --stat` should list only files under `apps/web/`, plus `docs/`
