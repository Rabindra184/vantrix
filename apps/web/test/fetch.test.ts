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

  // A reverse proxy or gateway in front of the API can return a non-2xx
  // response that never went through the API's own error handling at all —
  // an HTML error page is the classic case. apiFetch must still reject with
  // a ProblemError, not a raw SyntaxError from a failed res.json().
  it('synthesizes a ProblemError for a non-2xx response with a non-JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html><body>502 Bad Gateway - nginx</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rejection = apiFetch(RunListResponseSchema, '/v1/runs');
    await expect(rejection).rejects.toBeInstanceOf(ProblemError);
    await expect(rejection).rejects.toMatchObject({ status: 502, code: 'CLIENT_UNREADABLE_ERROR' });
    const error = await rejection.catch((err: ProblemError) => err);
    expect(error.remediation).toEqual(expect.any(String));
    expect(error.remediation.length).toBeGreaterThan(0);
  });

  // A non-2xx body can also be valid JSON that simply isn't problem-shaped —
  // a JSON error page from infrastructure, or a response that lost its
  // problem envelope somewhere upstream. Same guarantee applies.
  it('synthesizes a ProblemError for a non-2xx response with non-problem-shaped JSON', async () => {
    stubFetch(503, { message: 'upstream unavailable' });

    const rejection = apiFetch(RunListResponseSchema, '/v1/runs');
    await expect(rejection).rejects.toBeInstanceOf(ProblemError);
    await expect(rejection).rejects.toMatchObject({ status: 503, code: 'CLIENT_UNREADABLE_ERROR' });
    const error = await rejection.catch((err: ProblemError) => err);
    expect(error.remediation).toEqual(expect.any(String));
    expect(error.remediation.length).toBeGreaterThan(0);
  });
});
