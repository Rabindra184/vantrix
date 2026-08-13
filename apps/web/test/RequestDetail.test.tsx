import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import RequestDetail, { requestRow } from '../src/routes/RequestDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof requestRow>[0];

describe('requestRow', () => {
  it('finds a nested request by its full path', () => {
    const row = requestRow(stats, 'Catalog/List Products');
    expect(row?.name).toBe('Catalog/List Products');
    expect(row?.scope).toBe('request');
  });

  it('does not match a group of the same name', () => {
    // `Catalog` is a GROUP. A request lookup that fell back to a group row
    // would render group_cumulated numbers under a request heading.
    expect(requestRow(stats, 'Catalog')).toBeUndefined();
  });

  it('is undefined for a name the run never recorded', () => {
    expect(requestRow(stats, 'Nope/Not Here')).toBeUndefined();
  });
});

describe('RequestDetail', () => {
  it('heads the page with the request name from the URL', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Catalog/List Products');
  });

  it('asks for series and distribution at REQUEST scope, with the name', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // BOTH parameters on every scoped call. `?name=X` without `scope` is
    // silently ignored and answers with the RUN's totals — a 200 carrying the
    // wrong subject, which no status check would catch.
    const scoped = urls.filter((u) => u.includes('/series') || u.includes('/distribution'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const url of scoped) {
      expect(url).toContain('scope=request');
      expect(url).toContain(`name=${encodeURIComponent('Catalog/List Products')}`);
    }
  });
});
