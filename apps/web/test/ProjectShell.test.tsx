// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole } from '@perfportal/contracts';
import ProjectShell from '../src/routes/ProjectShell';
import type { ProjectSection } from '../src/routes/projectSections';
import { seedAccess } from './support/access';

// `vitest.config.ts` sets no `globals`, so Testing Library's automatic cleanup
// never registers and every `render` here would otherwise stack in the same
// `document.body` — see CLAUDE.md on the flake that caused.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * ═══ REVIEW M10 — ONE PROJECT, TWO DISJOINT NAVIGATION SYSTEMS ═══
 *
 * `/projects/:slug` drew a row of three links, `/projects/:slug/runs` drew a
 * DIFFERENT row of three for the same relationship, and the three
 * configuration pages drew a tab strip naming none of them. SLA rules and API
 * tokens were therefore reachable only by first landing on Add results.
 *
 * `ProjectShell` is the one strip, on every project page. What this file pins
 * is the part a browser cannot cheaply prove seven times over: that every
 * section resolves to its own URL for the slug in hand, that exactly one is
 * current, that the launch action is NOT one of them — and, since project
 * access, which of them each reader is offered at all.
 *
 * THE GEOMETRY AND THE CROSS-PAGE COLLISIONS ARE `project-shell.spec.ts`'s.
 * jsdom renders one component at a time, so it cannot see this nav sharing a
 * document with `ProjectRail` — which is where a duplicated accessible name
 * would actually bite.
 */

const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'checkout',
  name: 'Checkout Flow',
  // REQUIRED by `ProjectSummarySchema`. Omitting it does not produce a project
  // with no latest run — it makes the whole `GET /v1/projects` parse throw, so
  // the query errors and every case here would test the error branch.
  latestRun: null,
};

/** Every section, its label, and the URL it must resolve to for `checkout`. */
const SECTIONS: readonly [ProjectSection, string, string][] = [
  ['tests', 'Tests', '/projects/checkout'],
  ['runs', 'Runs', '/projects/checkout/runs'],
  ['packages', 'Packages', '/projects/checkout/packages'],
  ['setup', 'Add results', '/projects/checkout/setup'],
  ['rules', 'SLA rules', '/projects/checkout/rules'],
  ['members', 'Members', '/projects/checkout/members'],
  ['access', 'API tokens', '/projects/checkout/access'],
];

/** Who is looking: what `seedAccess` writes into the cache before the shell mounts. */
type Reader = { isAdmin: boolean; roles?: Readonly<Record<string, ProjectRole>> };

/**
 * An install-wide admin, seeded by the session alone: the project list is left
 * to the fetch stub, whose project carries no role, and an admin's access does
 * not read one.
 */
const ADMIN: Reader = { isAdmin: true };

function stubProjects(projects: unknown[] | null = [PROJECT]): void {
  vi.stubGlobal('fetch', () =>
    projects === null
      ? // A PENDING promise, not an error: this is the first-paint state, and
        // it is the one the slug fallback exists for.
        new Promise<Response>(() => {})
      : Promise.resolve(
          new Response(JSON.stringify({ items: projects }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
  );
}

/**
 * Mounts the shell for `who`. The ADMIN default is deliberate rather than
 * convenient: most cases here are about what the shell is FOR — every section
 * at its own URL, exactly one current — and an admin is the reader who sees
 * all of it. The cases about who sees what name their reader explicitly.
 *
 * `who: null` seeds nothing, so the session and the project list are both
 * whatever the fetch stub answers.
 */
function renderShell(current: ProjectSection, path = '/projects/checkout', who: Reader | null = ADMIN) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (who !== null) seedAccess(client, who);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/projects/:slug/*"
            element={<ProjectShell current={current}>{({ name }) => <p>section of {name}</p>}</ProjectShell>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Project sections' });

/** The tabs the strip draws, in order. */
const tabs = (): (string | null)[] => within(nav()).getAllByRole('link').map((l) => l.textContent);

describe('ProjectShell — the seven sections', () => {
  it('offers an admin every section, in order, each at its own URL', async () => {
    stubProjects();
    renderShell('tests');
    await screen.findByRole('heading', { level: 1, name: 'Checkout Flow' });

    const links = within(nav()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(SECTIONS.map(([, label]) => label));
    for (const [, label, href] of SECTIONS) {
      expect(within(nav()).getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  /**
   * ═══ EXACTLY ONE CURRENT, AND IT IS THE ONE THE PAGE CLAIMED ═══
   *
   * `aria-current="page"` is the whole answer to "where am I" now that no
   * section repeats its name as a heading, so a strip with none — or with two
   * — is not a styling slip, it is the navigation failing to do its only job.
   *
   * Run over all seven, because the failure mode is per-section: a `NavLink`
   * with no `end` would mark Tests current on every one of these, since every
   * project URL starts with `/projects/:slug`. That is exactly why the shell
   * takes an explicit `current` instead.
   */
  it.each(SECTIONS)('marks %s and nothing else as the current section', async (current, label) => {
    stubProjects();
    renderShell(current, SECTIONS.find(([s]) => s === current)![2]);
    await screen.findByRole('heading', { level: 1, name: 'Checkout Flow' });

    expect(within(nav()).getAllByRole('link', { current: 'page' }).map((l) => l.textContent)).toEqual(
      [label],
    );
  });

  /**
   * M10 asks for launch to stay an ACTION rather than become another
   * navigation concept. Asserted as a pair — present on the page, absent from
   * the strip — because "not in the nav" alone would pass just as happily
   * against a page that had lost the action altogether.
   */
  it('keeps New on-prem run as an action beside the heading, not a seventh tab', async () => {
    stubProjects();
    renderShell('tests');
    await screen.findByRole('heading', { level: 1, name: 'Checkout Flow' });

    expect(screen.getByRole('link', { name: 'New on-prem run' })).toHaveAttribute(
      'href',
      '/projects/checkout/run/new',
    );
    expect(within(nav()).queryByRole('link', { name: 'New on-prem run' })).toBeNull();
  });

  /**
   * THE NAV HAS A NAME BECAUSE IT IS THE THIRD ONE IN THE DOCUMENT.
   * `ProjectRail` is on every authenticated page and `RunTabs` on every run
   * page; an unnamed landmark here is one a screen-reader user can only tell
   * apart by exploring it.
   */
  it('names its own landmark', async () => {
    stubProjects();
    renderShell('rules', '/projects/checkout/rules');
    await screen.findByRole('heading', { level: 1, name: 'Checkout Flow' });
    expect(nav()).toBeInTheDocument();
  });
});

/**
 * ═══ THE STRIP FOLLOWS THE READER'S ROLE ═══
 *
 * Two of the seven sections exist to take an action — Add results to upload a
 * run, API tokens to manage credentials — and so does New on-prem run beside
 * the heading. A reader who may not take the action is not offered the link:
 * the API would refuse what the page is for, so the tab would lead only to a
 * refusal. The other five are places anyone in the project may read, Members
 * included (every role holds `members:read`).
 *
 * Each row names its reader, and both admins are here on purpose: an admin
 * may do everything whatever `role` says, so one holding only a Viewer row
 * sees what a Manager sees — the case a shell reading the role before the
 * flag would get wrong.
 */
describe('ProjectShell — the sections and the launch action follow the reader', () => {
  const ALL = SECTIONS.map(([, label]) => label);
  const READERS: readonly [string, Reader, readonly string[], boolean][] = [
    ['an admin holding only a Viewer row', { isAdmin: true, roles: { checkout: 'viewer' } }, ALL, true],
    ['a Viewer', { isAdmin: false, roles: { checkout: 'viewer' } }, ['Tests', 'Runs', 'Packages', 'SLA rules', 'Members'], false],
    [
      'a Member',
      { isAdmin: false, roles: { checkout: 'member' } },
      ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members'],
      true,
    ],
    ['a Manager', { isAdmin: false, roles: { checkout: 'manager' } }, ALL, true],
  ];

  it.each(READERS)('draws for %s the sections and the launch their access allows', async (_, who, expected, launch) => {
    renderShell('tests', '/projects/checkout', who);
    // The seeded list names `checkout` "Checkout": the lookup has answered.
    await screen.findByRole('heading', { level: 1, name: 'Checkout' });

    expect(tabs()).toEqual(expected);
    if (launch) {
      expect(screen.getByTestId('project-launch')).toHaveAttribute('href', '/projects/checkout/run/new');
    } else {
      expect(screen.queryByTestId('project-launch')).toBeNull();
      expect(screen.queryByRole('link', { name: 'New on-prem run' })).toBeNull();
    }
  });

  /* A gated tab is withheld on its OWN page too — a Viewer who typed the URL
     is not offered a link to where they already are, and the page, not the
     strip, is where the refusal belongs. So nothing is marked current. */
  it("withholds a gated section's tab even on that section's page", async () => {
    renderShell('setup', '/projects/checkout/setup', { isAdmin: false, roles: { checkout: 'viewer' } });
    await screen.findByRole('heading', { level: 1, name: 'Checkout' });

    expect(tabs()).not.toContain('Add results');
    expect(within(nav()).queryAllByRole('link', { current: 'page' })).toEqual([]);
  });

  it('draws an admin every section and the launch, from the session alone', async () => {
    // The list comes from the stub and carries no role for this project; an
    // admin's access never reads one.
    stubProjects();
    renderShell('tests');
    await screen.findByRole('heading', { level: 1, name: 'Checkout Flow' });

    expect(tabs()).toEqual(ALL);
    expect(screen.getByTestId('project-launch')).toBeInTheDocument();
  });

  /**
   * ═══ ONE QUESTION PER PAGE ═══
   *
   * Every project page renders its content through this shell, and most of
   * them will ask what the reader may do. The shell has already asked, so it
   * hands the answer down rather than have each section mount the hook again
   * (each mount is another observer on the session and the project list).
   */
  it('hands its section the access it drew the strip from', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedAccess(client, { isAdmin: false, roles: { checkout: 'member' } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/checkout/rules']}>
          <Routes>
            <Route
              path="/projects/:slug/*"
              element={
                <ProjectShell current="rules">
                  {({ access }) => (
                    <p>
                      {access.known ? 'known' : 'unknown'}; rules {access.can('rules:edit') ? 'yes' : 'no'}; tokens{' '}
                      {access.can('tokens:manage') ? 'yes' : 'no'}
                    </p>
                  )}
                </ProjectShell>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('known; rules yes; tokens no')).toBeInTheDocument();
  });
});

describe('ProjectShell — what it draws before and instead of a project', () => {
  /**
   * The slug is a real name for the project, not a placeholder, so nothing
   * waits on `GET /v1/projects`. `ProjectConfigPage` blocked the whole page on
   * that query; on `/projects/:slug` that means the project's own page sits as
   * a spinner while its content is ready to draw.
   *
   * The NAV is the half that matters most here: every destination is derivable
   * from the slug alone, so there is no excuse for withholding it.
   */
  it('draws the heading and the five ungated sections from the slug while the lookup is in flight', () => {
    // Nothing seeded and every request held: the session and the project list
    // are both pending, so who is looking is not known yet.
    stubProjects(null);
    renderShell('tests', '/projects/checkout', null);

    expect(screen.getByRole('heading', { level: 1, name: 'checkout' })).toBeInTheDocument();
    expect(tabs()).toEqual(['Tests', 'Runs', 'Packages', 'SLA rules', 'Members']);
    expect(screen.queryByRole('link', { name: 'New on-prem run' })).toBeNull();
    expect(screen.getByText('section of checkout')).toBeInTheDocument();
  });

  /**
   * A project that resolved and is not there is a different fact from one that
   * has not resolved yet, and only the first may say so — branching on
   * `project === null` alone would render "not found" over every cold load.
   */
  it('says not found only once the lookup has answered', async () => {
    stubProjects([]);
    renderShell('tests');
    expect(await screen.findByRole('heading', { name: /project not found/i })).toBeInTheDocument();
    expect(screen.queryByText('section of checkout')).toBeNull();
  });

  /**
   * ═══ THE WAY OUT MUST LEAVE, AND MUST NOT BORROW THE RAIL'S NAME ═══
   *
   * Every one of the six URLs carries the slug that just failed to resolve,
   * so "Back to project" — what this offered when it was `ProjectConfigPage`,
   * a page reached only from a working project — is an offer to reload the
   * same error.
   *
   * And it cannot be called "All runs", however natural those words are for
   * the org-wide list: `ProjectRail` renders a row with exactly that name in
   * every authenticated document. CLAUDE.md records that collision costing a
   * strict-mode failure twice already.
   */
  it('offers a way out that leaves the project, under a name the rail has not taken', async () => {
    stubProjects([]);
    renderShell('access', '/projects/checkout/access');
    await screen.findByRole('heading', { name: /project not found/i });

    const out = screen.getByRole('link', { name: /back to the run list/i });
    expect(out).toHaveAttribute('href', '/runs');
    expect(screen.queryByRole('link', { name: /^all runs$/i })).toBeNull();
  });

  /** A section is named by the nav, never by a sentence under the heading:
   *  `intro` was deleted (clean UI PR 4), and this directive goes unused —
   *  failing `pnpm typecheck` — the day it comes back. */
  it('takes no intro', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/checkout/access']}>
          <Routes>
            <Route
              path="/projects/:slug/*"
              element={
                <ProjectShell
                  current="access"
                  // @ts-expect-error — `intro` was deleted (clean UI PR 4).
                  intro="An intro under the heading."
                >
                  {() => <p>section body</p>}
                </ProjectShell>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('section body')).toBeInTheDocument();
    expect(screen.queryByText('An intro under the heading.')).toBeNull();
  });
});
