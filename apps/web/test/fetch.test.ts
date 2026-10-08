import { RunListResponseSchema } from '@perfportal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiFetchNoContent, ProblemError } from '../src/api/fetch.js';

/**
 * Returns the rejection as a genuinely-typed ProblemError.
 *
 * `p.catch((err: ProblemError) => err)` looks equivalent but is not: the
 * annotation is unchecked, and the expression's type is the UNION of the
 * resolved value and the caught one, so `.remediation` below was never
 * actually verified against anything. Narrowing here means the assertions
 * are typechecked, and a non-ProblemError rejection fails by name instead of
 * as an undefined-property read.
 */
async function rejectionOf(p: Promise<unknown>): Promise<ProblemError> {
  const err: unknown = await p.then(() => null, (e: unknown) => e);
  if (!(err instanceof ProblemError)) {
    throw new Error(`expected the call to reject with a ProblemError, got: ${String(err)}`);
  }
  return err;
}

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
    const error = await rejectionOf(rejection);
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
    const error = await rejectionOf(rejection);
    expect(error.remediation).toEqual(expect.any(String));
    expect(error.remediation.length).toBeGreaterThan(0);
  });
});

/**
 * ═══ A 204 HAS NO BODY, AND `apiFetch` READS ONE ═══
 *
 * `apiFetch` ends in `res.json()`, so a success with no content — every
 * `PUT /v1/me/password` — would reject with a `SyntaxError` over a change that
 * had succeeded. The helper keeps `apiFetch`'s two guarantees (credentials
 * forced, every non-2xx a `ProblemError`) and drops the third: it never reads
 * a success's body at all.
 */
describe('apiFetchNoContent', () => {
  it('resolves on a 204 with no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetchNoContent('/v1/me/password', { method: 'PUT' })).resolves.toBeUndefined();
  });

  /** NOT READ, not merely tolerated: a helper that parsed the body and threw
   *  the result away would still reject a 2xx that is not JSON. */
  it('never reads the body of a success', async () => {
    const res = new Response('not json at all', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    await apiFetchNoContent('/v1/me/password', { method: 'PUT' });
    expect(res.bodyUsed).toBe(false);
  });

  it('rejects a non-2xx as a ProblemError carrying the server’s detail and remediation', async () => {
    stubFetch(
      400,
      {
        code: 'INVALID_CURRENT_PASSWORD',
        detail: 'The current password is not correct.',
        remediation: 'Type the password you signed in with.',
      },
      'application/problem+json',
    );
    const error = await rejectionOf(apiFetchNoContent('/v1/me/password', { method: 'PUT' }));
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_CURRENT_PASSWORD',
      detail: 'The current password is not correct.',
      remediation: 'Type the password you signed in with.',
    });
  });

  /** After `init`, as `apiFetch` does: a caller passing its own `credentials`
   *  cannot drop the session cookie by accident. */
  it('forces credentials: same-origin over whatever the caller passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetchNoContent('/v1/me/password', { method: 'PUT', credentials: 'omit' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/me/password',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    );
  });
});
