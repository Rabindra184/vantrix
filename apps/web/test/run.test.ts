import type { RunResponse } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../src/api/fetch.js';
import { POLL_INTERVAL_MS, fetchRun, pollIntervalFor, type RunDetail } from '../src/api/run.js';

/**
 * `GET /v1/runs/:id` is the one endpoint in this app that does not go through
 * `apiFetch`, because it answers with three different bodies across three
 * status classes. These tests pin that branching, and the polling decision
 * that depends on it.
 *
 * The network is stubbed at the module boundary — the same place, and for the
 * same reason, fetch.test.ts stubs it: there is no browser involved and the
 * subject under test is status branching, not the cookie round trip.
 */
function stubFetch(status: number, body: unknown, contentType = 'application/json'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RUN_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A complete, ordinary run body — the shape BOTH 200 and 422 carry. Typed as
 * the contract's own `RunResponse` so a fixture that stopped matching the
 * contract is a compile error here rather than a test that passes against a
 * body the API could never send.
 */
function runBody(verdict: RunResponse['verdict']): RunResponse {
  return {
    id: RUN_ID,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    status: 'complete',
    verdict,
    tool: 'gatling',
    toolVersion: '3.15.1.2',
    simulation: 'example.ParitySimulation',
    description: null,
    durationMs: 61_234,
    startedAt: '2026-05-01T10:00:00.000Z',
    toolStartedAt: '2026-05-01T09:00:00.000Z',
    ingestedAt: '2026-05-01T10:00:05.000Z',
    error: null,
    assertions: [],
  };
}

describe('fetchRun', () => {
  it('reads a 200 as a ready run', async () => {
    stubFetch(200, runBody('passed'));
    const detail = await fetchRun(RUN_ID);
    expect(detail.state).toBe('ready');
    expect(detail.run).toMatchObject({ id: RUN_ID, verdict: 'passed' });
  });

  /**
   * THE test this module exists for. A complete run whose verdict is `failed`
   * comes back as 422 with a NORMAL run body (RunsService.statusFor). Routed
   * through `apiFetch` it would be a non-2xx, fail `ProblemFieldsSchema`,
   * synthesize CLIENT_UNREADABLE_ERROR, and tell the reader their SLA-failed
   * run could not be read — for a run that arrived perfectly.
   */
  it('reads a 422 as a ready run, not an error — it is a verdict, not a transport failure', async () => {
    stubFetch(422, runBody('failed'));
    const detail = await fetchRun(RUN_ID);
    expect(detail.state).toBe('ready');
    expect(detail.run).toMatchObject({ verdict: 'failed', simulation: 'example.ParitySimulation' });
  });

  it('reads a 202 as processing', async () => {
    stubFetch(202, { id: RUN_ID, status: 'pending', statusUrl: `/v1/runs/${RUN_ID}` });
    const detail = await fetchRun(RUN_ID);
    expect(detail.state).toBe('processing');
    expect(detail.run).toMatchObject({ status: 'pending' });
  });

  it('rejects a 404 as a ProblemError carrying the API detail and remediation', async () => {
    stubFetch(
      404,
      {
        code: 'NOT_FOUND',
        detail: `No run ${RUN_ID} in this project.`,
        remediation: 'Check the request against the OpenAPI description at /v1/openapi.json.',
      },
      'application/problem+json',
    );
    const rejection = fetchRun(RUN_ID);
    await expect(rejection).rejects.toBeInstanceOf(ProblemError);
    await expect(rejection).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      detail: `No run ${RUN_ID} in this project.`,
    });
  });

  // The error path is `problemFrom`'s, exported from fetch.ts rather than
  // reimplemented here, so a gateway's HTML error page is still a ProblemError.
  it('rejects a non-problem-shaped 502 as a synthesized ProblemError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    await expect(fetchRun(RUN_ID)).rejects.toMatchObject({
      status: 502,
      code: 'CLIENT_UNREADABLE_ERROR',
    });
  });

  // A 2xx the contract schema refuses is a bug, not data — the same rule
  // apiFetch's success path follows, and it must not be disguised as a
  // ProblemError.
  it('lets the contract schema throw on a 200 body it does not accept', async () => {
    stubFetch(200, { ...runBody('passed'), assertions: 'not-an-array' });
    await expect(fetchRun(RUN_ID)).rejects.not.toBeInstanceOf(ProblemError);
  });

  it('sends credentials: same-origin', async () => {
    stubFetch(200, runBody('passed'));
    await fetchRun(RUN_ID);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/runs/${RUN_ID}`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});

/**
 * The polling cap is covered HERE and not in the browser deliberately.
 * `seedPendingRun` creates a run no worker will ever pick up, so a page open
 * on it never settles and there is nothing to wait ON — only two real minutes
 * of elapsed time. Testing the cap through Playwright would mean a test that
 * sleeps for two minutes to observe one boolean.
 */
describe('pollIntervalFor', () => {
  const processing: RunDetail = {
    state: 'processing',
    run: { id: RUN_ID, status: 'pending', statusUrl: `/v1/runs/${RUN_ID}` },
  };
  const ready: RunDetail = { state: 'ready', run: runBody('passed') };

  it('polls a processing run', () => {
    expect(pollIntervalFor(processing, false)).toBe(POLL_INTERVAL_MS);
  });

  it('stops polling once the run is ready', () => {
    expect(pollIntervalFor(ready, false)).toBe(false);
  });

  // A page left open on a run that never settles must not make requests until
  // the tab is closed.
  it('stops polling a still-processing run once the cap is reached', () => {
    expect(pollIntervalFor(processing, true)).toBe(false);
  });

  // No data means the query is loading OR it failed. Polling a 404 every five
  // seconds forever is the failure mode this branch prevents.
  it('does not poll when there is no data', () => {
    expect(pollIntervalFor(undefined, false)).toBe(false);
  });
});
