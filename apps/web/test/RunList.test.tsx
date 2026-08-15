import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunList from '../src/routes/RunList';

afterEach(cleanup);

function renderList(items: RunListResponse['items']) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ROWS: RunListResponse['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    toolStartedAt: '2026-08-15T09:00:00.000Z',
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: 'example.ParitySimulation',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    verdict: null,
    tool: 'gatling',
    startedAt: '2026-08-15T11:00:00.000Z',
    toolStartedAt: null,
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: null,          // the worker has not parsed it
  },
];

describe('RunList columns', () => {
  it('names each row by its project and simulation', async () => {
    renderList(ROWS);
    expect(await screen.findByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.getAllByText('Checkout')).toHaveLength(2);
    expect(screen.getByText('example.ParitySimulation')).toBeInTheDocument();
  });

  it('has no Tool column — TOOL_IDS has one member, so it read "gatling" on every row', async () => {
    renderList(ROWS);
    await screen.findByRole('columnheader', { name: 'Project' });
    expect(screen.queryByRole('columnheader', { name: 'Tool' })).toBeNull();
  });

  it('falls back to the short id when the run has no simulation yet', async () => {
    renderList(ROWS);
    // Derived from the row, not written down: re-slicing the id here the way
    // the component does would just restate the implementation. Assert
    // instead that the accessible name carries the WHOLE id while the visible
    // text is a strict prefix of it.
    const link = await screen.findByRole('link', { name: `View run ${ROWS[1]!.id}` });
    const visible = link.textContent!;
    // Non-empty FIRST, and it is load-bearing: `''.startsWith` is vacuously
    // true and `'' !== id` is too, so without this an implementation that
    // rendered nothing for a null simulation — `run.simulation && …` instead
    // of `run.simulation ?? …`, since `null && x` is `null` — would satisfy
    // both assertions below. `findByRole` would still match it, because the
    // aria-label supplies the accessible name whatever the content is. A
    // test for a fallback that passes when the fallback is gone is worse
    // than no test.
    expect(visible.length).toBeGreaterThan(0);
    expect(ROWS[1]!.id.startsWith(visible)).toBe(true);
    expect(visible).not.toBe(ROWS[1]!.id);
  });
});
