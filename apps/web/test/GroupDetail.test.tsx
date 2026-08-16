import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GroupDetail, { groupRow } from '../src/routes/GroupDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof groupRow>[0];

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx).
// This file now renders GroupDetail more than once, so a leftover tree from an
// earlier test would sit in `document.body` alongside the next one and turn a
// unique testid into a duplicate.
afterEach(cleanup);

/**
 * The `QueryClientProvider`/`MemoryRouter`/`Routes` boilerplate every render
 * test below needs, factored out once it reached a fourth copy. `name` is the
 * DECODED group path — this encodes it, matching how every call site below
 * used to spell the URL by hand (`Catalog%2FRecommendations` for
 * `Catalog/Recommendations`).
 */
function renderGroupDetail(
  name: string,
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/r1/groups/${encodeURIComponent(name)}`]}>
        <Routes>
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('groupRow', () => {
  it('distinguishes the two families under one name', () => {
    const c = groupRow(stats, 'Cart', 'group_cumulated')!;
    const d = groupRow(stats, 'Cart', 'group_duration')!;

    // THE discriminating assertion: a lookup matching only (scope, name)
    // returns the same row twice and this fails.
    expect(c.meanMs).not.toBe(d.meanMs);
    expect(c.family).toBe('group_cumulated');
    expect(d.family).toBe('group_duration');
  });

  it('does not match a request, even on an exact name and family', () => {
    // `Cart/Add To Cart` IS a row in this run — scope 'request', family
    // 'response_time'. Without the scope predicate this lookup returns it, so
    // this is the assertion that pins scope rather than family.
    expect(groupRow(stats, 'Cart/Add To Cart', 'response_time')).toBeUndefined();
  });

  it('finds a nested group by its full path', () => {
    const row = groupRow(stats, 'Catalog/Recommendations', 'group_cumulated');
    expect(row?.name).toBe('Catalog/Recommendations');
  });

  it('is undefined for a name the run never recorded', () => {
    expect(groupRow(stats, 'Nope', 'group_cumulated')).toBeUndefined();
  });
});

it('asks for both families at group scope', () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    urls.push(String(input));
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('Catalog/Recommendations');

  const dist = urls.filter((u) => u.includes('/distribution'));
  expect(dist).toHaveLength(2);
  // Both parameters on every scoped call, and a DIFFERENT family on each —
  // two calls carrying the same family is the bug this asserts against.
  for (const url of dist) {
    expect(url).toContain('scope=group');
    expect(url).toContain(`name=${encodeURIComponent('Catalog/Recommendations')}`);
  }
  expect(dist.some((u) => u.includes('family=group_cumulated'))).toBe(true);
  expect(dist.some((u) => u.includes('family=group_duration'))).toBe(true);

  // The two percentiles-over-time charts fetch the same way: same scope and
  // name, a DIFFERENT family each. Without this, a page that passed
  // 'group_cumulated' to both `seriesQuery` calls would still make every
  // test in this file pass — `SeriesResponseSchema` had no `family` field to
  // discriminate the RESPONSE, so this asserts on the REQUEST instead.
  const series = urls.filter((u) => u.includes('/series'));
  expect(series).toHaveLength(2);
  for (const url of series) {
    expect(url).toContain('scope=group');
    expect(url).toContain(`name=${encodeURIComponent('Catalog/Recommendations')}`);
  }
  expect(series.some((u) => u.includes('family=group_cumulated'))).toBe(true);
  expect(series.some((u) => u.includes('family=group_duration'))).toBe(true);
});

it('gives each distribution its own figure identity', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/distribution')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            runId: '00000000-0000-4000-8000-000000000000',
            scope: 'group',
            name: 'Cart',
            family,
            window: null,
            labels: [0],
            okCount: [1],
            koCount: [0],
            okPercent: [100],
            koPercent: [0],
            exactValues: true,
            overflowCount: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('Cart');

  // Not one id rendered twice.
  expect(document.querySelectorAll('[data-testid="chart-distribution"]')).toHaveLength(0);

  // DISCRIMINATES DRAWN FROM UNDRAWN — `waitFor` re-queries from `screen` on
  // every poll rather than caching a node from one `findByTestId` call,
  // because `Payload` renders `Undrawn` under this SAME per-family slot id
  // while the fetch is still pending, and `Undrawn` always passes `rows: []`.
  // A single `findByTestId` per id resolves against THAT pending-state figure
  // (present from the very first render, before either mocked fetch has
  // settled) and proves nothing about whether `toDistribution` ever ran.
  // Only a drawn chart's data table has rows: the mocked payload here is one
  // bin (`labels: [0]`, one OK observation), which `toDistribution` turns
  // into exactly one row.
  await waitFor(() => {
    for (const id of ['distribution-group_cumulated', 'distribution-group_duration']) {
      const figure = screen.getByTestId(`chart-${id}`);
      const table = within(figure).getByTestId(`chart-data-${id}`);
      expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    }
  });
});

/**
 * SUPERSEDES a pre-piece-6 version of this test that stubbed `/series` as a
 * bare 500 and asserted "not recorded" text. That was only ever true because
 * GroupDetail used to render `Undrawn` unconditionally, without fetching
 * anything — piece 6 makes the fetch real, so a genuine 500 now correctly
 * surfaces `Payload`'s own generic explain() text (already covered, once, by
 * `payload.test.tsx`), not this run-specific sentence. The scenario that
 * actually reaches `NO_GROUP_SERIES` is a 200 with `groupSeriesAvailable:
 * false`, which is what the appended test above exercises for
 * `group_cumulated` alone; this one closes the `group_duration` gap that test
 * leaves, and keeps this file's original "present, in their §13.4 positions —
 * not omitted" guarantee for BOTH families.
 */
it('renders both percentile charts, stating the run-specific gap for each family', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/series')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...fixture.groupSeries,
            family,
            groupSeriesAvailable: false,
            buckets: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('Cart');

  // `waitFor`, not a single `findByTestId`: `Payload` renders `Undrawn` under
  // this SAME per-family slot id while `/series` is still pending, so a
  // single lookup can resolve against that pending-state figure before the
  // mocked fetch settles (see the `waitFor` comment above, on the distribution
  // identity test, for the same race).
  await waitFor(() => {
    for (const id of ['percentiles-group_cumulated', 'percentiles-group_duration']) {
      const figure = screen.getByTestId(`chart-${id}`);
      // The data table is the parity surface and must exist even undrawn.
      expect(within(figure).getByTestId(`chart-data-${id}`)).toBeInTheDocument();
      // Names the run, not the product — the platform records these now.
      expect(figure.textContent).toMatch(/this run/i);
      expect(figure.textContent).not.toMatch(/platform/i);
    }
  });
});

/**
 * THE LOADED PAGE, not just its error branch. Every render test above mocks
 * `/stats` as a 500, so `TableSection`'s `query.data !== undefined` branch —
 * the one every real reader hits — was exercised nowhere in this file. That
 * branch is where the two families' headings and rows actually come from
 * (`ScopedStatistics`'s `heading` prop, `GroupDetail`'s `groupRow` lookup per
 * family), and it is exactly where a swapped prop or a mistyped scope check
 * would leave one family rendering the other's numbers under a plausible
 * heading. Mirrors RequestDetail.test.tsx's own `/stats` 200 test and its
 * reasoning: "a swapped prop or a mistyped scope check would leave one of them
 * rendering plausible nonsense."
 */
it('renders each family’s own row from a loaded /stats, and both statuses when the group is not in the run', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    // `/stats` is the only endpoint this page fetches UNSCOPED — both
    // `/distribution` calls always carry `scope=group&name=...` — so
    // answering it alone isolates the branch under test, the same way
    // RequestDetail.test.tsx's equivalent does.
    if (url.includes('/stats')) {
      return Promise.resolve(new Response(JSON.stringify(fixture.stats), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // FOUND: `Cart` has a row in both families on this run. A page that
  // rendered one family's row under both headings must fail here even though
  // each heading, checked alone, would still look correct.
  const found = renderGroupDetail('Cart', client);

  // `waitFor` re-queries from `screen` on every poll rather than caching a
  // node from one `findByRole` call. `TableSection`'s OWN loading-branch
  // heading reads the identical text as `ScopedStatistics`'s loaded-branch
  // heading (`ScopedStatistics`'s docstring: `heading={title}` keeps
  // `TableSection`'s `title` prop true in both states) — so a single
  // `findByRole('heading', { name: 'Cumulated response time' })` matches on
  // the very first, still-loading render and hands back a node that the
  // `/stats` resolution then unmounts, making every later assertion against
  // it fail for the wrong reason (as happened while writing this test).
  // Polling for the STATISTICS CELL, which exists only once `ScopedStatistics`
  // has actually mounted, avoids that.
  const cells = await waitFor(() => {
    const found = screen.getAllByTestId('request-stat-meanMs');
    expect(found).toHaveLength(2);
    return found;
  });

  const headingFor = (cell: HTMLElement) => cell.closest('section')!.querySelector('h2')!;
  const cumulatedCell = cells.find((cell) => headingFor(cell).textContent === 'Cumulated response time');
  const durationCell = cells.find((cell) => headingFor(cell).textContent === 'Duration');
  if (cumulatedCell === undefined || durationCell === undefined) {
    throw new Error('expected one meanMs cell under each family heading');
  }
  // Both present AND distinct — not the same section matched twice.
  expect(headingFor(cumulatedCell)).not.toBe(headingFor(durationCell));

  const cumulatedRow = groupRow(stats, 'Cart', 'group_cumulated')!;
  const durationRow = groupRow(stats, 'Cart', 'group_duration')!;
  // The reference run's own numbers — ~141ms cumulated against ~225ms
  // duration (GroupDetail.tsx's own docstring) — so this section only passes
  // if `heading` and `family` stayed paired.
  expect(cumulatedRow.meanMs).not.toBe(durationRow.meanMs);
  expect(cumulatedCell).toHaveAttribute('data-value', String(cumulatedRow.meanMs));
  expect(durationCell).toHaveAttribute('data-value', String(durationRow.meanMs));

  found.unmount();

  // NOT FOUND: a group name this run never recorded. `row === undefined` is
  // reachable on real data too — a run where one family persisted and the
  // other did not — and was asserted nowhere, at any layer, before this test.
  renderGroupDetail('Nope', client);
  expect(
    await screen.findByText('This run recorded no cumulated response time for Nope.'),
  ).toBeInTheDocument();
  expect(screen.getByText('This run recorded no duration for Nope.')).toBeInTheDocument();
});

it('draws both percentile charts when the run has group series', async () => {
  const series = fixture.groupSeries;
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/series')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(JSON.stringify({ ...series, family }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('Cart');

  await waitFor(() => {
    expect(screen.getByTestId('chart-percentiles-group_cumulated')).toBeInTheDocument();
    expect(screen.getByTestId('chart-percentiles-group_duration')).toBeInTheDocument();
  });
  // DRAWN, not stated: the gap sentence must be gone.
  expect(screen.queryByText(/not recorded/i)).not.toBeInTheDocument();
});

it('states a RUN-specific gap when the run has no group series', async () => {
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/series')) {
      const family = url.includes('group_duration') ? 'group_duration' : 'group_cumulated';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...fixture.groupSeries,
            family,
            groupSeriesAvailable: false,
            buckets: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 500 }));
  });

  renderGroupDetail('Cart');

  await waitFor(() => {
    const figure = screen.getByTestId('chart-percentiles-group_cumulated');
    // About THIS RUN, not about the platform — the platform records these now.
    expect(figure.textContent).toMatch(/this run/i);
    expect(figure.textContent).not.toMatch(/platform/i);
  });
});
