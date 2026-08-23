import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import { PAGE_SIZE } from '../src/api/runs';
import ProjectRuns from '../src/routes/ProjectRuns';

afterEach(cleanup);

/**
 * `key={slug}` under a REAL client-side transition — jsdom, not Playwright.
 *
 * Design spec §8.3 states the bug this guards against in terms that only
 * make sense for client-side routing: "moving from `/projects/a` to
 * `/projects/b` matches the *same* route, so React reuses the component
 * instance and the cursor survives." That is a claim about component
 * IDENTITY across a route-param change — something only `history.pushState`
 * (what `react-router-dom`'s `<Link>` performs) can exercise.
 *
 * THE PATH GAINED A `/runs` SEGMENT and the claim is untouched by it.
 * `/projects/:slug` now lists the project's TESTS (`ProjectTests`) and the run
 * list moved one segment deeper; `/projects/a/runs` and `/projects/b/runs`
 * still match ONE route with a changing param, which is the entire
 * precondition for the bug. The same guard, at the address the page now has.
 *
 * `apps/web/e2e/project-runs.spec.ts` cannot prove this. Playwright's
 * `page.goto` is a full top-level browser navigation — a document load, the
 * same as typing a URL and pressing Enter — and cannot be intercepted by
 * React Router. Every `page.goto` therefore tears down and remounts the
 * ENTIRE React tree, including `RunList`'s `useState` cursor, regardless of
 * whether `key={slug}` is present. Confirmed directly: a `window` global set
 * after the first `page.goto` and read back after the second was already
 * `undefined`. An e2e version of this test would pass unconditionally,
 * which is exactly what happened before this file existed — the guard was
 * never actually watched fail.
 *
 * `apps/web/e2e/project-runs.spec.ts` is still worth keeping: it proves
 * `/projects/:slug` routes, filters to one project, and names the heading
 * from `GET /v1/projects` — none of which this file re-proves, and none of
 * which a stubbed-fetch jsdom test can claim about a real build. This file
 * proves the one thing the e2e spec cannot: that a same-route param change
 * does not leak a cursor across project scopes.
 */
describe('ProjectRuns — a client-side transition between two projects', () => {
  const ALPHA_PROJECT = { id: '11111111-1111-4111-8111-111111111111', slug: 'alpha', name: 'Alpha' };
  const BETA_PROJECT = { id: '22222222-2222-4222-8222-222222222222', slug: 'beta', name: 'Beta' };
  const ALPHA_NEXT_CURSOR = 'alpha-page-1-cursor';

  function runItem(id: string, project: typeof ALPHA_PROJECT): RunListResponse['items'][number] {
    return {
      id,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      startedAt: '2026-08-15T10:00:00.000Z',
      toolStartedAt: null,
      project: { id: project.id, slug: project.slug, name: project.name },
      simulation: null,
    };
  }

  // Alpha's first page: exactly PAGE_SIZE rows and a nextCursor, so "Next" is
  // enabled and clicking it puts a real cursor into RunList's useState.
  const ALPHA_PAGE_1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
    runItem(`11111111-1111-4111-8111-1111111111${String(i).padStart(2, '0')}`, ALPHA_PROJECT),
  );
  // Alpha's second page: one more row, no further cursor.
  const ALPHA_PAGE_2 = [runItem('11111111-1111-4111-8111-111111111199', ALPHA_PROJECT)];
  // Beta's OWN first page — a different count from either alpha page, so a
  // pass can only mean beta's real data rendered, not alpha's leftovers.
  const BETA_PAGE_1 = [
    runItem('22222222-2222-4222-8222-222222222221', BETA_PROJECT),
    runItem('22222222-2222-4222-8222-222222222222', BETA_PROJECT),
    runItem('22222222-2222-4222-8222-222222222223', BETA_PROJECT),
  ];

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function stubFetch() {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = new URL(String(input), 'http://localhost');

      if (url.pathname === '/v1/projects') {
        return Promise.resolve(
          jsonResponse({
            items: [
              { ...ALPHA_PROJECT, latestRun: null },
              { ...BETA_PROJECT, latestRun: null },
            ],
          }),
        );
      }

      if (url.pathname === '/v1/runs') {
        const project = url.searchParams.get('project');
        const cursor = url.searchParams.get('cursor');

        if (project === 'alpha' && cursor === null) {
          return Promise.resolve(jsonResponse({ items: ALPHA_PAGE_1, nextCursor: ALPHA_NEXT_CURSOR }));
        }
        if (project === 'alpha' && cursor === ALPHA_NEXT_CURSOR) {
          return Promise.resolve(jsonResponse({ items: ALPHA_PAGE_2, nextCursor: null }));
        }
        if (project === 'beta' && cursor === null) {
          return Promise.resolve(jsonResponse({ items: BETA_PAGE_1, nextCursor: null }));
        }
        // Mirrors RunRepository.list's real behaviour for a cursor that
        // cannot resolve under the requested scope: an EMPTY page, not an
        // error. This is the branch a leaked alpha cursor hits under beta's
        // scope if `key={slug}` is missing.
        return Promise.resolve(jsonResponse({ items: [], nextCursor: null }));
      }

      throw new Error(`unhandled request in ProjectRuns.test.tsx: ${url.pathname}${url.search}`);
    });
  }

  /** The route tree under test — the real `/projects/:slug` route wired to
   *  the real `ProjectRuns`, plus a `<Link>` standing in for whatever future
   *  UI (the sidebar spec §8.3 defers to a later sub-project) will let a
   *  reader move from one project to another without a document load. */
  function renderAtAlpha() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/alpha/runs']}>
          <Link to="/projects/beta/runs">Switch to beta</Link>
          <Routes>
            <Route path="/projects/:slug/runs" element={<ProjectRuns />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("shows the second project's own first page after paging the first forward, via a client-side transition", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderAtAlpha();

    // Alpha's first page: PAGE_SIZE rows.
    expect(await screen.findAllByTestId('run-row')).toHaveLength(PAGE_SIZE);

    // Page forward — this is what puts a cursor into RunList's useState.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(ALPHA_PAGE_2.length);
    });

    // The transition that matters: a `<Link>` click, which changes the
    // `:slug` param via `history.pushState` — NOT a document load. This is
    // the only way to reproduce the bug this test exists for; see the
    // docstring above.
    await user.click(screen.getByRole('link', { name: 'Switch to beta' }));

    // Without `key={slug}`, RunList is the SAME component instance, its
    // cursor is still `ALPHA_NEXT_CURSOR`, and the stub answers that
    // combination (project=beta, cursor=ALPHA_NEXT_CURSOR) with an EMPTY
    // page — exactly `RunRepository.list`'s real behaviour for an
    // unresolvable cursor. A blank list is not a rendering error here; it
    // would be the correct response to the wrong request.
    expect(await screen.findByRole('heading', { name: 'Beta' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(BETA_PAGE_1.length);
    });
  });
});
