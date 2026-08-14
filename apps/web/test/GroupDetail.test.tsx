import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import GroupDetail, { groupRow } from '../src/routes/GroupDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof groupRow>[0];

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

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/runs/r1/groups/Catalog%2FRecommendations']}>
        <Routes>
          <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

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
});
