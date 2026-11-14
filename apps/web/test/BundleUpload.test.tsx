import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BundleUpload from '../src/routes/BundleUpload';

/**
 * ═══ WHAT THE CARD SAYS AFTER THE UPLOAD HAS ARRIVED ═══
 *
 * The upload itself is `uploadBundle.test.ts`'s. This is the half after the
 * 202: the card asks `GET /v1/runs/{id}` until it has an answer, and there are
 * three kinds of answer — still processing, finished, and REFUSED, which that
 * endpoint spells as the ingest failure's own problem document.
 */
const RUN_ID = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';
const POLL_MS = 20;

vi.mock('../src/api/uploadBundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/uploadBundle')>()),
  uploadBundle: vi.fn(async () => ({ id: RUN_ID })),
}));
// The real interval is five seconds; the cases need several polls.
vi.mock('../src/api/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/run')>()),
  POLL_INTERVAL_MS: 20,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PROCESSING = () => json({ id: RUN_ID, status: 'parsing', statusUrl: `/v1/runs/${RUN_ID}` }, 202);
const READY = () =>
  json(
    {
      id: RUN_ID,
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      status: 'complete', verdict: 'not_evaluated', tool: 'gatling',
      startedAt: '2026-09-27T09:00:00.000Z', assertions: [],
    },
    200,
  );
const REJECTION = {
  type: 'https://perfportal.dev/errors/LOG_MALFORMED', title: 'LOG_MALFORMED', status: 400,
  code: 'LOG_MALFORMED',
  detail: 'simulation.log could not be decoded: needed 4 bytes at 8190, have 0',
  remediation: 'Confirm the Gatling run finished and that the whole results directory was archived.',
};
const REJECTED = () => json(REJECTION, 400);
const PROXY_PAGE = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });

/** Answers the run read with `answers` in order, the last one for ever. Returns the call count. */
function stubRun(answers: readonly (() => Response)[]): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal('fetch', (input: RequestInfo) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== `/v1/runs/${RUN_ID}`) return Promise.reject(new Error(`unexpected fetch ${url.pathname}`));
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return Promise.resolve(answer());
  });
  return { calls: () => calls };
}

async function upload(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BundleUpload slug="checkout" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByTestId('bundle-file'), {
    target: { files: [new File(['x'], 'results.tgz')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload bundle' }));
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('BundleUpload, after the upload has arrived', () => {
  it('says the bundle was refused, in the API’s words, instead of parsing for ever', async () => {
    const run = stubRun([PROCESSING, REJECTED]);
    await upload();

    const alert = await screen.findByTestId('bundle-rejected');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(REJECTION.detail);
    expect(alert).toHaveTextContent(REJECTION.remediation);
    // The pair: refused, and no longer claiming to be parsing.
    expect(screen.queryByTestId('bundle-processing')).toBeNull();
    expect(screen.queryByTestId('bundle-done')).toBeNull();

    // And it stops asking: the answer will not change.
    const asked = run.calls();
    await pause(POLL_MS * 5);
    expect(run.calls()).toBe(asked);
  });

  // The other side of the same rule. A proxy's error page is not the API
  // speaking about this run, so the card must not call the bundle refused.
  it('keeps waiting through a response that is not the API’s, then finishes', async () => {
    const run = stubRun([PROXY_PAGE, PROXY_PAGE, READY]);
    await upload();

    expect(await screen.findByTestId('bundle-done')).toHaveTextContent('Parsed.');
    expect(run.calls()).toBeGreaterThanOrEqual(3);
    expect(screen.queryByTestId('bundle-rejected')).toBeNull();
  });

  it('says it is parsing while the run is processing, then offers the run', async () => {
    stubRun([PROCESSING, PROCESSING, READY]);
    await upload();

    expect(await screen.findByTestId('bundle-processing')).toBeInTheDocument();
    const done = await screen.findByTestId('bundle-done');
    expect(done.querySelector('a')).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(screen.queryByTestId('bundle-processing')).toBeNull();
  });

  it('lets the reader choose another file after a refusal', async () => {
    stubRun([REJECTED]);
    await upload();
    await screen.findByTestId('bundle-rejected');

    fireEvent.change(screen.getByTestId('bundle-file'), {
      target: { files: [new File(['y'], 'again.tgz')] },
    });

    await waitFor(() => expect(screen.queryByTestId('bundle-rejected')).toBeNull());
    expect(screen.getByRole('button', { name: 'Upload bundle' })).toBeEnabled();
  });
});
