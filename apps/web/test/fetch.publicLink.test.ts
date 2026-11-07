// A `.ts` file in the jsdom project, the way `timeAxis.test.ts` is: the
// subject reads `window.location.pathname` and the case that matters most moves
// it with `history.pushState`, and the node project has neither.
// @vitest-environment jsdom
import { PUBLIC_LINK_SECRET_PATTERN, RunListResponseSchema } from '@perfportal/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiFetchNoContent, publicLinkSecretFromPath } from '../src/api/fetch.js';
import { fetchRun } from '../src/api/run.js';

/**
 * ═══ THE CREDENTIAL FOLLOWS THE URL, ON EVERY REQUEST ═══
 *
 * A public link's page sends `Authorization: PublicLink <secret>` and no cookie;
 * every other page sends the cookie and no such header. Which one a request
 * carries is read off the CURRENT pathname when the request is made (spec 6.2).
 *
 * The URL is moved BEFORE this file imports the module under test (the
 * `vi.hoisted` below runs ahead of the hoisted imports), so a credential read
 * once at module scope would capture the share path's secret — and then go on
 * sending it after a history navigation back into the app, which is exactly
 * what the second `apiFetch` case catches (plan Review Focus 3). A credential
 * memoised on its first CALL is caught by the same case, because the share-path
 * case runs first.
 */
const SECRET = vi.hoisted(() => {
  const secret = `ppl_0123456789abcdefghijklmnopqrstuvwxyzAB-_CDE`;
  window.history.pushState(null, '', `/share/${secret}`);
  return secret;
});

const LIST = { items: [], nextCursor: null };

function stubFetch(status = 200, body: unknown = LIST): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The `RequestInit` the stub's Nth call received. */
function initOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  const args = fetchMock.mock.calls[call] as [string, RequestInit | undefined];
  return args[1] ?? {};
}

/** That call's headers, read through `Headers` whichever form they were sent in. */
function headersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers {
  return new Headers(initOf(fetchMock, call).headers);
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publicLinkSecretFromPath', () => {
  it('uses a secret the contract itself accepts, so the cases below are not vacuous', () => {
    expect(PUBLIC_LINK_SECRET_PATTERN.test(SECRET)).toBe(true);
  });

  it.each([
    [`/share/${SECRET}`],
    [`/share/${SECRET}/`],
    [`/share/${SECRET}/report`],
    [`/share/${SECRET}/logs`],
  ])('finds the secret in %s', (pathname) => {
    expect(publicLinkSecretFromPath(pathname)).toBe(SECRET);
  });

  it.each([
    [`/share/${SECRET}x`, 'one character too many'],
    [`/share/${SECRET.slice(0, -1)}`, 'one character too few'],
    ['/runs/x', 'an app path'],
    ['/share/pp_x', 'the wrong prefix'],
    ['/share/', 'no secret at all'],
    [`/runs/${SECRET}`, 'a secret-shaped segment outside /share'],
    [`/x/share/${SECRET}`, 'a /share that is not the first segment'],
    [`/share/${SECRET.slice(0, 20)}!${SECRET.slice(21)}`, 'a character outside base64url'],
  ])('finds none in %s (%s)', (pathname) => {
    expect(publicLinkSecretFromPath(pathname)).toBeNull();
  });

  /** The router matches `/share/:token/*` case-insensitively, so the page a
   *  reader gets and the credential its reads carry must agree on `/Share/…`.
   *  The SECRET is case-sensitive and is not folded. */
  it('reads the share segment the way the router matches it, and never folds the secret', () => {
    expect(publicLinkSecretFromPath(`/SHARE/${SECRET}/report`)).toBe(SECRET);
    // Still a valid secret, and a different one: it must come back as written.
    const shouted = `ppl_${SECRET.slice(4).toUpperCase()}`;
    expect(shouted).not.toBe(SECRET);
    expect(publicLinkSecretFromPath(`/share/${shouted}`)).toBe(shouted);
  });
});

describe('apiFetch on a share path', () => {
  it('sends the link and no cookie', async () => {
    window.history.pushState(null, '', `/share/${SECRET}/logs`);
    const fetchMock = stubFetch();
    await apiFetch(RunListResponseSchema, '/v1/runs');
    expect(initOf(fetchMock).credentials).toBe('omit');
    expect(headersOf(fetchMock).get('authorization')).toBe(`PublicLink ${SECRET}`);
  });

  /** Review Focus 3: back into the app in the same tab, the app's reads send
   *  the cookie again — the credential is read per request, not remembered. */
  it('sends the cookie and no link once history has left the share path', async () => {
    window.history.pushState(null, '', `/share/${SECRET}/logs`);
    const fetchMock = stubFetch();
    await apiFetch(RunListResponseSchema, '/v1/runs');
    expect(initOf(fetchMock, 0).credentials).toBe('omit');

    window.history.pushState(null, '', '/runs/abc');
    await apiFetch(RunListResponseSchema, '/v1/runs');
    expect(initOf(fetchMock, 1).credentials).toBe('same-origin');
    expect(headersOf(fetchMock, 1).has('authorization')).toBe(false);
  });

  it.each([
    ['a plain object', { 'content-type': 'application/json', 'x-trace': 't-1' }],
    ['a Headers instance', new Headers({ 'content-type': 'application/json', 'x-trace': 't-1' })],
    ['an array of pairs', [['content-type', 'application/json'], ['x-trace', 't-1']] as [string, string][]],
  ])('keeps a caller’s own headers, sent as %s', async (_form, headers) => {
    window.history.pushState(null, '', `/share/${SECRET}`);
    const fetchMock = stubFetch();
    await apiFetch(RunListResponseSchema, '/v1/runs', { method: 'GET', headers });
    const sent = headersOf(fetchMock);
    expect(sent.get('content-type')).toBe('application/json');
    expect(sent.get('x-trace')).toBe('t-1');
    expect(sent.get('authorization')).toBe(`PublicLink ${SECRET}`);
    expect(initOf(fetchMock).method).toBe('GET');
  });

  /** One credential per request: a caller's own `Authorization` beside the
   *  link would be two values, which the API refuses (plan Review Focus 2). */
  it('lets no caller header or option replace the link credential', async () => {
    window.history.pushState(null, '', `/share/${SECRET}`);
    const fetchMock = stubFetch();
    await apiFetch(RunListResponseSchema, '/v1/runs', {
      headers: { Authorization: 'Bearer pp_other' },
      credentials: 'include',
    });
    expect(headersOf(fetchMock).get('authorization')).toBe(`PublicLink ${SECRET}`);
    expect(initOf(fetchMock).credentials).toBe('omit');
  });
});

describe('apiFetch off a share path', () => {
  it('leaves the request as it always was: the caller’s init, and the cookie', async () => {
    window.history.pushState(null, '', '/runs/abc/report');
    const fetchMock = stubFetch();
    const headers = { 'content-type': 'application/json' };
    await apiFetch(RunListResponseSchema, '/v1/runs', { method: 'POST', headers });
    expect(initOf(fetchMock)).toEqual({ method: 'POST', headers, credentials: 'same-origin' });
    // The caller's own object, not a copy re-spelled as `Headers`.
    expect(initOf(fetchMock).headers).toBe(headers);
  });
});

describe('apiFetchNoContent', () => {
  it('sends the link and no cookie on a share path, and the cookie elsewhere', async () => {
    window.history.pushState(null, '', `/share/${SECRET}/report`);
    const fetchMock = stubFetch(204);
    await apiFetchNoContent('/v1/me/password', { method: 'PUT' });
    expect(initOf(fetchMock, 0).credentials).toBe('omit');
    expect(headersOf(fetchMock, 0).get('authorization')).toBe(`PublicLink ${SECRET}`);

    window.history.pushState(null, '', '/account/password');
    await apiFetchNoContent('/v1/me/password', { method: 'PUT' });
    expect(initOf(fetchMock, 1).credentials).toBe('same-origin');
    expect(headersOf(fetchMock, 1).has('authorization')).toBe(false);
  });
});

/**
 * `GET /v1/runs/:id` is read by `fetchRun`, not `apiFetch` (its own docstring
 * says why), and the public page reads its run through it (`useRunTerminal`).
 * So it takes the same credential from the same function — or the one read
 * every page starts from would arrive with a cookie and no link.
 */
describe('fetchRun', () => {
  const RUN_ID = '00000000-0000-4000-8000-000000000001';
  const PROCESSING = { id: RUN_ID, status: 'pending', statusUrl: `/v1/runs/${RUN_ID}` };

  it('sends the link and no cookie on a share path, and the cookie elsewhere', async () => {
    window.history.pushState(null, '', `/share/${SECRET}`);
    const fetchMock = stubFetch(202, PROCESSING);
    await fetchRun(RUN_ID);
    expect(initOf(fetchMock, 0).credentials).toBe('omit');
    expect(headersOf(fetchMock, 0).get('authorization')).toBe(`PublicLink ${SECRET}`);

    window.history.pushState(null, '', `/runs/${RUN_ID}`);
    await fetchRun(RUN_ID);
    expect(initOf(fetchMock, 1).credentials).toBe('same-origin');
    expect(headersOf(fetchMock, 1).has('authorization')).toBe(false);
  });
});
