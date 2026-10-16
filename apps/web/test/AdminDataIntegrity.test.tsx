// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataIntegrity } from '@perfportal/contracts';
import AdminDataIntegrity from '../src/routes/AdminDataIntegrity';
import { ADMIN_DATA_INTEGRITY_ROUTE, ADMIN_USERS_ROUTE, runPath } from '../src/routes/paths';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const RUN_A = '0b5a1c3e-1111-4111-8111-111111111111';
const RUN_B = '7d9c2e4f-2222-4222-8222-222222222222';

const DATA: DataIntegrity = {
  recompute: { total: 0, remaining: 0, failed: 0 },
  verification: { verified: 812, mismatch: 2, unverifiable: 5, pending: 0 },
  problems: [
    { runId: RUN_A, projectSlug: 'checkout', status: 'mismatch', reason: null, mismatchCount: 3, checkedAt: '2026-10-16T09:30:00.000Z' },
    { runId: RUN_B, projectSlug: 'search', status: 'unverifiable', reason: 'raw_log_deleted', mismatchCount: 0, checkedAt: null },
  ],
  rawLogRetentionDays: 90,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers the page's own endpoint with `body`; counts every call to it. */
function stub(body: DataIntegrity): { calls: () => number; seen: string[] } {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return Promise.resolve(url === '/v1/admin/data-integrity' ? json(200, body) : json(404, {}));
  });
  return { calls: () => seen.filter((u) => u === '/v1/admin/data-integrity').length, seen };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ADMIN_DATA_INTEGRITY_ROUTE]}>
        <AdminDataIntegrity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const counts = () => screen.findByTestId('verification-counts');

describe('AdminDataIntegrity', () => {
  it('is the Data integrity section of Administration', async () => {
    stub(DATA);
    renderPage();
    await counts();
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(within(nav).getAllByRole('link', { current: 'page' }).map((l) => l.textContent)).toEqual(['Data integrity']);
    expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute('href', ADMIN_USERS_ROUTE);
    expect(document.title).toBe('Data integrity · Administration · PerfPortal');
  });

  it('counts the runs in each verification state', async () => {
    stub(DATA);
    renderPage();
    const block = await counts();
    expect(block).toHaveTextContent(/Verified\s*812/);
    expect(block).toHaveTextContent(/Verification failed\s*2/);
    expect(block).toHaveTextContent(/Not verified\s*5/);
    expect(block).toHaveTextContent(/Verifying\s*0/);
  });

  it.each([
    [90, 'Raw logs are kept for 90 days'],
    [1, 'Raw logs are kept for 1 day'],
    [0, 'Raw logs are kept indefinitely'],
  ])('states the retention setting (%i days)', async (days, words) => {
    stub({ ...DATA, rawLogRetentionDays: days });
    renderPage();
    await counts();
    expect(screen.getByTestId('raw-log-retention')).toHaveTextContent(words);
  });

  it('lists each problem run, linked to the run', async () => {
    stub(DATA);
    renderPage();
    const table = await screen.findByRole('table', { name: 'Runs with problems' });
    const [first, second] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(within(first).getByRole('link')).toHaveAttribute('href', runPath(RUN_A));
    expect(first).toHaveTextContent('checkout');
    expect(first).toHaveTextContent('Verification failed');
    expect(first).toHaveTextContent('3 figures differ');
    expect(within(second).getByRole('link')).toHaveAttribute('href', runPath(RUN_B));
    expect(second).toHaveTextContent('Not verified');
    expect(second).toHaveTextContent(/raw log was deleted/i);
  });

  it('says so when no run has a problem, and draws no table', async () => {
    stub({ ...DATA, problems: [] });
    renderPage();
    await counts();
    expect(screen.getByText('No mismatched or unverified runs')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /** The page owns the backfill line, reading it off its own answer — the
   *  shell's line would say the same thing a second time. */
  it('shows the backfill’s progress once, from its own answer', async () => {
    const { seen } = stub({ ...DATA, recompute: { total: 40, remaining: 10, failed: 2 } });
    renderPage();
    await counts();
    expect(screen.getAllByText(/Recomputing exact statistics: 30 of 40 runs/)).toHaveLength(1);
    expect(screen.getByTestId('recompute-progress')).toHaveTextContent('2 could not be recomputed');
    expect(seen).not.toContain('/v1/admin/recompute');
  });

  it('polls while runs are waiting to be verified', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stub({ ...DATA, verification: { ...DATA.verification, pending: 4 } });
    renderPage();
    await counts();
    const before = calls();
    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(calls()).toBeGreaterThan(before);
  });

  it('polls while the backfill is still recomputing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stub({ ...DATA, recompute: { total: 40, remaining: 10, failed: 0 } });
    renderPage();
    await counts();
    const before = calls();
    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(calls()).toBeGreaterThan(before);
  });

  it('does not poll once nothing is pending or recomputing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stub(DATA);
    renderPage();
    await counts();
    const before = calls();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(calls()).toBe(before);
  });
});
