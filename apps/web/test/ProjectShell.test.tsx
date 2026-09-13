// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectShell, { type ProjectSection } from '../src/routes/ProjectShell';

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
 * `ProjectShell` is the one strip, on all five. What this file pins is the
 * part a browser cannot cheaply prove five times over: that every section
 * resolves to its own URL for the slug in hand, that exactly one is current,
 * and that the launch action is NOT one of them.
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
  ['setup', 'Add results', '/projects/checkout/setup'],
  ['rules', 'SLA rules', '/projects/checkout/rules'],
  ['access', 'API tokens', '/projects/checkout/access'],
];

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

function renderShell(current: ProjectSection, path = '/projects/checkout') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('ProjectShell — the five sections', () => {
  it('offers every section, in order, each at its own URL', async () => {
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
   * Run over all five, because the failure mode is per-section: a `NavLink`
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
  it('keeps New on-prem run as an action beside the heading, not a sixth tab', async () => {
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
  it('draws the heading and the whole nav from the slug while the lookup is in flight', () => {
    stubProjects(null);
    renderShell('tests');

    expect(screen.getByRole('heading', { level: 1, name: 'checkout' })).toBeInTheDocument();
    expect(within(nav()).getAllByRole('link')).toHaveLength(SECTIONS.length);
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
   * Every one of the five URLs carries the slug that just failed to resolve,
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
});
