import { RunListResponseSchema } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ProblemError } from '../src/api/fetch.js';

/**
 * Stubs the module-boundary `fetch` — the one place in this sub-project
 * mocking the network is correct (design §4/§8): there is no browser
 * involved and the subject under test is parsing, not the cookie round trip.
 */
function stubFetch(status: number, body: unknown, contentType = 'application/json'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('validates the response against the contract schema', async () => {
    stubFetch(200, { items: [], nextCursor: null });
    await expect(apiFetch(RunListResponseSchema, '/v1/runs')).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('sends credentials: same-origin on every request', async () => {
    const fetchMock = stubFetch(200, { items: [], nextCursor: null });
    await apiFetch(RunListResponseSchema, '/v1/runs');
    expect(fetchMock).toHaveBeenCalledWith('/v1/runs', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('throws ProblemError carrying the remediation', async () => {
    stubFetch(
      400,
      { code: 'PROJECT_REQUIRED', detail: 'x', remediation: 'use a token' },
      'application/problem+json',
    );
    await expect(apiFetch(RunListResponseSchema, '/v1/runs')).rejects.toMatchObject({
      code: 'PROJECT_REQUIRED',
      remediation: 'use a token',
    });
  });

  it('marks a 401 as a distinguishable ProblemError', async () => {
    stubFetch(
      401,
      { code: 'UNAUTHENTICATED', detail: 'No valid session cookie.', remediation: 'Sign in again.' },
      'application/problem+json',
    );
    const rejection = apiFetch(RunListResponseSchema, '/v1/runs');
    await expect(rejection).rejects.toBeInstanceOf(ProblemError);
    await expect(rejection).rejects.toMatchObject({ status: 401 });
  });

  // A response that does not match the contract is a bug, not data.
  it('rejects a response the schema does not accept', async () => {
    stubFetch(200, { items: 'not-an-array' });
    await expect(apiFetch(RunListResponseSchema, '/v1/runs')).rejects.toThrow();
  });
});
