import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunList from '../src/routes/RunList';

afterEach(cleanup);

function renderList(items: RunListResponse['items'], initialEntry = '/runs') {
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RunList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, fetchSpy };
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

  it('summarizes the current page and adds a focus signal after verdict', async () => {
    renderList([
      ...ROWS,
      {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'complete',
        verdict: 'failed',
        tool: 'gatling',
        startedAt: '2026-08-15T12:00:00.000Z',
        toolStartedAt: '2026-08-15T12:00:00.000Z',
        project: { id: '55555555-5555-4555-8555-555555555555', slug: 'catalog', name: 'Catalog' },
        simulation: 'example.CatalogSimulation',
      },
    ]);

    const health = await screen.findByRole('region', { name: 'Run health on this page' });
    expect(within(health).getByText('Needs attention').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('In flight').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('Passed gates').closest('div')).toHaveTextContent('1');
    expect(within(health).getByText('Unjudged').closest('div')).toHaveTextContent('1');

    // THE COUNTS SAY WHAT THEY COUNT. They reduce over one keyset page, and
    // shipped under the name "Run list health" with only the fourth tile
    // disclosing that — so an org with 90 failed runs read "Needs attention:
    // 2" off its first page. The denominator is derived from the rows on
    // screen rather than written down, so a fixture change moves both sides.
    const rows = screen.getAllByTestId('run-row');
    expect(within(health).getByText(new RegExp(`Counted over the ${rows.length} runs on this page`, 'i')))
      .toBeInTheDocument();

    expect(screen.getByRole('columnheader', { name: 'Focus' })).toBeInTheDocument();
    expect(screen.getByText('investigate')).toBeInTheDocument();
    expect(screen.getByText('processing')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
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

  it('sends search, status, and verdict filters to the API', async () => {
    const { fetchSpy } = renderList(ROWS);
    await screen.findByRole('form', { name: 'Run filters' });

    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: 'checkout main' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'complete' } });
    fireEvent.change(screen.getByLabelText('Verdict'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('q=checkout+main'))).toBe(true);
      expect(urls.some((url) => url.includes('status=complete'))).toBe(true);
      expect(urls.some((url) => url.includes('verdict=failed'))).toBe(true);
    });
  });

  /**
   * A FILTER THE LIST CANNOT HONOUR IS STATED, NOT DROPPED.
   *
   * `?status=completed` (a plausible typo for `complete`) used to be parsed
   * to `null`, left in the address bar, and reported as no active filter —
   * so the page rendered the whole unfiltered list with no Clear control,
   * and a shared link read as "there are no other completed runs". The API
   * answers the identical value with a 400 RUN_FILTER_INVALID; the two must
   * not disagree about one input.
   */
  it('says so when the URL names a filter value this list cannot use', async () => {
    const { fetchSpy } = renderList(ROWS, '/runs?status=completed');

    expect(await screen.findByTestId('run-filter-ignored')).toHaveTextContent(
      /ignored status=completed/i,
    );
    // Offered a way out, which is the half that was missing: `hasActiveFilters`
    // was false, so no Clear button rendered at all.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();

    // And the value never reaches the API, which would refuse it.
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(0));
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('status=');
    }
  });

  it('says nothing when every filter in the URL is one it can use', async () => {
    renderList(ROWS, '/runs?status=complete');
    // Waits for the LOADED state: the notice renders above the table in
    // every branch, so asserting its absence before the rows arrive would
    // pass against a page that had not rendered the controls at all.
    await screen.findByRole('table');
    expect(screen.queryByTestId('run-filter-ignored')).toBeNull();
  });

  it('can clear active filters from the no-match state', async () => {
    const { fetchSpy } = renderList([], '/runs?q=catalog&status=complete');
    expect(await screen.findByText('No runs match these filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      const lastUrl = String(fetchSpy.mock.calls.at(-1)?.[0]);
      expect(lastUrl).not.toContain('q=');
      expect(lastUrl).not.toContain('status=');
    });
  });
});
