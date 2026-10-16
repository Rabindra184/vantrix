import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecomputeProgress } from '../src/routes/RecomputeProgress';
import { recomputeProgressQueryKey } from '../src/api/admin';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers `/v1/admin/recompute` with `answer`; records every URL asked for. */
function stub(answer: Response): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    seen.push(String(input));
    return Promise.resolve(answer.clone());
  });
  return seen;
}

function renderProgress() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RecomputeProgress />
    </QueryClientProvider>,
  );
  /** Resolves once the answer has landed — an absence read before then proves nothing. */
  const settled = (status: 'success' | 'error') =>
    waitFor(() => expect(client.getQueryState(recomputeProgressQueryKey)?.status).toBe(status));
  return { ...view, settled };
}

describe('RecomputeProgress', () => {
  it('says how far the backfill has got while runs remain', async () => {
    const seen = stub(json(200, { total: 1030, remaining: 618, failed: 0 }));
    renderProgress();
    const status = await screen.findByTestId('recompute-progress');
    // Plain integers, as every count in this app is written (`formatCount`).
    expect(status).toHaveTextContent('Recomputing exact statistics: 412 of 1030 runs');
    expect(status).not.toHaveTextContent(/could not be recomputed/);
    expect(seen).toContain('/v1/admin/recompute');
  });

  it('names the runs a recompute gave up on', async () => {
    stub(json(200, { total: 1030, remaining: 618, failed: 3 }));
    renderProgress();
    expect(await screen.findByTestId('recompute-progress')).toHaveTextContent('3 could not be recomputed');
  });

  /** A count that changes every ten seconds must not be a live region: it would
   *  re-announce itself on every Administration page while the backfill runs. */
  it('is not a live region', async () => {
    stub(json(200, { total: 1030, remaining: 618, failed: 0 }));
    renderProgress();
    await screen.findByTestId('recompute-progress');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('recompute-progress')).not.toHaveAttribute('aria-live');
  });

  it('renders nothing once no run remains', async () => {
    stub(json(200, { total: 1030, remaining: 0, failed: 0 }));
    const { container, settled } = renderProgress();
    await settled('success');
    expect(screen.queryByTestId('recompute-progress')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the progress cannot be read', async () => {
    stub(json(500, { type: 'about:blank', title: 'Error', status: 500, code: 'INTERNAL', detail: 'x', remediation: 'y' }));
    const { container, settled } = renderProgress();
    await settled('error');
    expect(screen.queryByTestId('recompute-progress')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
