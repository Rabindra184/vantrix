import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectListResponse } from '@perfportal/contracts';
import ProjectRail from '../src/ProjectRail';
import { projectsQueryKey } from '../src/api/projects';

afterEach(cleanup);

/**
 * Names are deliberately NOT substrings or case variants of each other or of
 * their slugs. `getByRole(role, { name })` is exact here but a
 * case-insensitive substring in Playwright (CLAUDE.md), and fixtures that
 * cannot collide stay correct under either matcher.
 *
 * The four latestRun shapes are the four badge branches of spec §4.3:
 * complete with a verdict, complete with NO verdict, not-complete, and none
 * at all. Spec §8 claims unit coverage of "all four branches" — until
 * `onboarding` was added here, only three were actually asserted; see the
 * "no verdict yet" test below for the one that was missing.
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
  {
    id: '44444444-4444-4444-8444-444444444444',
    slug: 'onboarding',
    name: 'Onboarding Wizard',
    latestRun: { id: 'cccccccc-4444-4444-8444-444444444444', status: 'complete', verdict: null },
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

  /**
   * ═══ THE FOUR BADGE CASES ARE GONE WITH THE BADGE (review 09-13 N03) ═══
   *
   * Four cases stood here — a complete run's verdict, a pending run's status
   * and never a verdict, "no verdict yet" asserted positively, and a project
   * with no runs having no badge beside a sibling that does. They pinned the
   * four branches of the sidebar spec's §4.3, and they were good tests: the
   * third was added precisely because `?? 'none'` could be changed to
   * `?? 'not_evaluated'` with the whole gate staying green.
   *
   * N03 offers two remedies for a badge the reader cannot attribute, and this
   * branch takes the second: omit it. There is no badge left to branch over,
   * so the cases are deleted rather than weakened — a test kept alive around a
   * deleted feature is the stale-guard shape this repo already records.
   *
   * WHAT STILL HAS TO HOLD is the row's exact textContent, and that is
   * asserted below and in the collapse describe: with the badge gone a row's
   * whole text is its project name, which is what "reads identically in both
   * collapse states" now means.
   */
  /**
   * THE RAIL MUST NOT OFFER "New project", because `RunList` already does.
   *
   * The rail renders on EVERY authenticated page, so a row here put a second
   * link with the identical accessible name into the `/runs` document.
   * Playwright matches names as a case-insensitive substring under strict
   * mode, so the first spec to reach for that link resolves two elements and
   * fails on a page nobody touched — and a screen-reader user hears one
   * action announced twice in a single view.
   *
   * Asserted here as well as in `run-list.spec.ts` because the two catch
   * different halves: the e2e case proves there is exactly ONE in a real
   * document, this one proves WHICH component dropped it, so a re-add to the
   * rail fails with the cause attached rather than as a strict-mode error
   * somewhere else.
   */
  it('offers no New project row — the run list heading owns that action', async () => {
    renderRail(PROJECTS);
    // Paired positive first: the rail really did render, so the absence
    // below is about this row and not about an empty rail.
    expect(await screen.findByRole('link', { name: 'All runs' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /new project/i })).toBeNull();
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

  /**
   * ═══ THE PROJECT ROW HAS NO `end`, AND THAT IS NOW LOAD-BEARING ═══
   *
   * `All runs` carries `end` so `/runs` does not prefix-match `/runs/:runId`.
   * The project rows deliberately do not, and until the hierarchy existed that
   * was a distinction without a difference: `/projects/:slug` had no children
   * a reader ever visited.
   *
   * It has three now — the run list, a test's run history, and setup — and a
   * reader spends most of their time on them. Adding `end` here to "match
   * All runs" would unlight the rail on every one, so the rail would claim the
   * reader is nowhere while they are two clicks inside a project.
   */
  it.each([
    ['the project run list', '/projects/checkout/runs'],
    ['a test’s run history', '/projects/checkout/tests/example-paritysimulation'],
  ])('keeps the project row current on %s, a page inside it', async (_what, route) => {
    renderRail(PROJECTS, { route });
    const checkout = await screen.findByRole('link', { name: /Checkout Flow/ });
    expect(checkout).toHaveAttribute('aria-current', 'page');
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

  /**
   * ═══ AND SO IS THE ONE COLLISION THE RAIL HAD TO SOLVE ALONE ═══
   *
   * A case here proved an INGEST failure read differently from an SLA
   * failure: `STATUS.failed` and `VERDICT.failed` are byte-identical in
   * `routes/marks.tsx` (both `✕ failed`), and the rail was the one surface
   * with a single badge and no column header to tell them apart — so
   * `ProjectRail.tsx` carried `RAIL_INGEST_FAILED` purely to relabel one of
   * them.
   *
   * That distinction existed FOR the badge. With the badge omitted the
   * override has nothing to override, and the collision is back to being
   * handled where it always was elsewhere: the run list gives the two marks
   * separate "Status" and "Verdict" columns, and `RunHeader` gives them
   * separately-named badge groups. Nothing regressed; a workaround retired
   * with the thing it worked around.
   */
  it('keeps the rows and says they may be out of date after a refetch fails', async () => {
    // Own fixture path, not an extra assertion on an existing test: this
    // sequence — a successful load, THEN a failed refetch — is a state none
    // of the tests above ever reach, since renderRail's stub answers every
    // call the same way.
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: PROJECTS }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs']}>
          <ProjectRail />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Paired positive FIRST: the initial load succeeded and the rows are on
    // screen, so what follows is about SURVIVING a failed refetch, not about
    // a rail that never rendered projects to begin with.
    expect(await screen.findByRole('link', { name: /Checkout Flow/ })).toBeInTheDocument();

    // Force the second call — wired above to fail — and wait for it to
    // settle before asserting on the result.
    await client.refetchQueries({ queryKey: projectsQueryKey });

    expect(await screen.findByText('Projects may be out of date.')).toBeInTheDocument();
    // TanStack Query keeps the last-known-good data across a failed refetch:
    // the rows must still be here, and the ORIGINAL "could not be loaded"
    // copy — which would now be false, since the rows are plainly still on
    // screen — must not appear instead.
    expect(screen.getByRole('link', { name: /Checkout Flow/ })).toBeInTheDocument();
    expect(screen.queryByText('Projects could not be loaded.')).toBeNull();
  });
});

/**
 * The desktop collapse, pinned at the exact seam most tempting to "simplify".
 *
 * The rail's collapsed state is CSS-ONLY (`lg:sr-only` on the labels,
 * `lg:hidden` on the badges), and that is a contract, not an implementation
 * detail: the obvious rewrite — conditionally RENDERING the labels the way
 * the reference design does — leaves every collapsed row an icon-only link
 * with no accessible name, and changes row textContent that this file pins
 * verbatim above. jsdom applies no CSS, which for once is the point: these
 * cases prove the DOM is IDENTICAL in both states, so what changes on a real
 * screen can only be presentation.
 */
describe('ProjectRail collapse', () => {
  afterEach(() => {
    localStorage.removeItem('perfportal-rail-collapsed');
  });

  it('renders expanded by default, with the toggle naming the action it will perform', async () => {
    renderRail(PROJECTS);
    expect(
      await screen.findByRole('button', { name: 'Collapse the projects rail' }),
    ).toBeInTheDocument();
  });

  it('keeps every row’s accessible name and textContent identical when collapsed', async () => {
    renderRail(PROJECTS);
    await screen.findByRole('link', { name: /Billing Exports/ });

    await userEvent.click(screen.getByRole('button', { name: 'Collapse the projects rail' }));

    // The control flips its own name — a screen reader always hears what the
    // NEXT activation does.
    expect(screen.getByRole('button', { name: 'Expand the projects rail' })).toBeInTheDocument();
    /* ═══ EVERY ROW'S TEXT IS ITS NAME, IN BOTH STATES (review 09-13 N03) ═══
     *
     * This used to pin one row's text as its name alone and another's as
     * carrying its badge word, which is what "identical in both states" meant
     * while the badge existed. With the badge omitted the claim is simpler and
     * strictly stronger: EVERY row's whole text is its project name, collapsed
     * or not, so the CSS-only collapse still cannot change what a row says.
     *
     * Checked over all four fixtures rather than two, because the weaker
     * spelling is what let the badge's own `lg:hidden` go unexamined here for
     * as long as it did. */
    for (const { name } of PROJECTS) {
      expect(screen.getByRole('link', { name: new RegExp(name) }).textContent).toBe(name);
    }
    expect(screen.getByRole('link', { name: 'All runs' })).toBeInTheDocument();
  });

  it('remembers the choice across a remount', async () => {
    renderRail(PROJECTS);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Collapse the projects rail' }),
    );

    cleanup();
    renderRail(PROJECTS);

    // Read in the `useState` initialiser, the way `AccountMenu` reads its
    // stored theme choice — never an effect, so the first render already
    // agrees with what the reader last chose.
    expect(
      await screen.findByRole('button', { name: 'Expand the projects rail' }),
    ).toBeInTheDocument();
  });

  /**
   * ═══ THE LIVE REGION IS MOUNTED BEFORE IT HAS ANYTHING TO SAY ═══
   *
   * A screen reader announces a live region's CHANGES, and a region that
   * arrives already holding its message has not changed — it was inserted. So
   * the wrapper is rendered unconditionally, with the message conditional
   * INSIDE it, and the rail's own comment says exactly that.
   *
   * Nothing checked it, and the refactor that breaks it is the tidier-looking
   * one: hoisting the `message != null` guard onto the wrapper deletes an
   * always-empty div, changes nothing on screen, passes every other case in
   * this file, and silences every projects-failed announcement there will ever
   * be. Same shape as the `aria-hidden` `TableFrame` defect this repo already
   * paid for — markup that reads tidier and removes something only a screen
   * reader uses.
   *
   * Asserted in the state where the region has NOTHING to announce, because
   * that is the only state that can tell the two spellings apart: with a
   * message present they are identical.
   */
  it('registers the live region before there is a message to put in it', async () => {
    const { container } = renderRail(PROJECTS);
    await screen.findByRole('link', { name: 'Checkout Flow' });

    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('');
  });

  /**
   * And the same region is the one that later carries the failure — not a
   * second element that happens to look like it. Without this, the case above
   * is satisfied by an empty decorative region beside a message announced from
   * somewhere else entirely.
   */
  it('puts the failure inside that same region', async () => {
    const { container } = renderRail([], { fail: true });
    const message = await screen.findByText('Projects could not be loaded.');

    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toContainElement(message);
  });
});
