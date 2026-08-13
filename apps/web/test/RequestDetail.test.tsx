import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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
});
