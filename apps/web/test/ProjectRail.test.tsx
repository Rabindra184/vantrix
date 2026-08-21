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

  it("reads 'no verdict yet' for a complete run with no verdict", async () => {
    renderRail(PROJECTS);
    // The fourth §4.3 branch, asserted POSITIVELY: `status === 'complete'`
    // with `verdict === null` reads VERDICT.none, not STATUS.complete and not
    // no badge at all. Before this test, `?? 'none'` on ProjectRail.tsx's
    // `badgeFor` could be changed to `?? 'not_evaluated'` and the whole gate
    // stayed green — this branch's absence was asserted only negatively (by
    // the pending-run test above), never positively.
    const onboarding = await screen.findByRole('link', { name: /Onboarding Wizard/ });
    expect(onboarding).toHaveTextContent('no verdict yet');
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

  it('renders an ingest failure and an SLA failure differently', async () => {
    // A separate, small fixture rather than an addition to PROJECTS: this is
    // about ONE collision (STATUS.failed vs VERDICT.failed, both '✕ failed'
    // in routes/marks.tsx), not another §4.3 badge branch, and folding it
    // into the four-branch fixture above would blur the two concerns.
    const projects: ProjectListResponse['items'] = [
      {
        id: '66666666-6666-4666-8666-666666666666',
        slug: 'data-pipeline',
        name: 'Data Pipeline',
        // The bundle never parsed — an INGEST failure.
        latestRun: { id: 'eeeeeeee-6666-4666-8666-666666666666', status: 'failed', verdict: null },
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        slug: 'legacy-export',
        name: 'Legacy Export',
        // The run completed and its SLA rule failed — a VERDICT failure.
        latestRun: { id: 'ffffffff-7777-4777-8777-777777777777', status: 'complete', verdict: 'failed' },
      },
    ];
    renderRail(projects);
    const ingestFailed = await screen.findByRole('link', { name: /Data Pipeline/ });
    const slaFailed = screen.getByRole('link', { name: /Legacy Export/ });
    // The rail-local override: an ingest failure reads distinguishably from
    // an SLA failure, both in what is on screen and in the accessible name —
    // there is no column header here to disambiguate them the way RunList's
    // "Status"/"Verdict" columns and RunHeader's NamedBadge groups do.
    expect(ingestFailed).toHaveTextContent('ingest failed');
    expect(slaFailed).toHaveTextContent('failed');
    expect(slaFailed).not.toHaveTextContent('ingest failed');
    expect(ingestFailed.textContent).not.toBe(slaFailed.textContent);
  });

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
    // Same assertions the expanded state pins above, repeated in the
    // collapsed state on purpose: absence of a badge is still exact, and a
    // present badge is still in the row's text.
    expect(screen.getByRole('link', { name: /Billing Exports/ }).textContent).toBe(
      'Billing Exports',
    );
    expect(screen.getByRole('link', { name: /Checkout Flow/ })).toHaveTextContent('passed');
    expect(screen.getByRole('link', { name: 'All runs' })).toBeInTheDocument();
  });

  it('remembers the choice across a remount', async () => {
    renderRail(PROJECTS);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Collapse the projects rail' }),
    );

    cleanup();
    renderRail(PROJECTS);

    // Read in the `useState` initialiser, the way ThemeToggle reads its
    // stored choice — never an effect, so the first render already agrees
    // with what the reader last chose.
    expect(
      await screen.findByRole('button', { name: 'Expand the projects rail' }),
    ).toBeInTheDocument();
  });
});
