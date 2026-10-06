import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRunByNumber, searchRuns } from '../src/api/runs';
import { fetchOrgTests, orgTestsQueryKey } from '../src/api/tests';

/**
 * The palette's three read clients, below the palette.
 *
 * The palette's own tests mock these functions, so everything they prove is
 * about what the palette DOES with an answer. What they cannot see is whether
 * the request that earns the answer is the one the routes read — which query
 * parameter carries the search text, that the cursor is passed through whole,
 * that a `#` in what somebody typed does not turn into a URL fragment and
 * silently drop the rest of the query. Those are pinned here, by reading the
 * URL the stubbed `fetch` was actually handed.
 *
 * Every stubbed body is a valid empty list, because `apiFetch` parses what
 * comes back and a malformed fixture would exercise its error path instead.
 */

const EMPTY_LIST = { items: [], nextCursor: null };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** The URL the one stubbed request was made to, split into path and params. */
function requested(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [raw] = fetchMock.mock.calls[0] as [string];
  const url = new URL(raw, 'http://localhost');
  return { raw, pathname: url.pathname, params: url.searchParams, hash: url.hash };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(json(200, EMPTY_LIST)));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('orgTestsQueryKey', () => {
  it('is one answer per (search, limit), so two searches never share a list', () => {
    expect(orgTestsQueryKey('checkout', 5)).toEqual(['org-tests', 'checkout', 5]);
    expect(orgTestsQueryKey('checkout', 5)).not.toEqual(orgTestsQueryKey('search', 5));
    expect(orgTestsQueryKey('checkout', 5)).not.toEqual(orgTestsQueryKey('checkout', 25));
  });
});

describe('fetchOrgTests', () => {
  it('sends q, limit and cursor only when given', async () => {
    await fetchOrgTests({});
    const bare = requested(fetchMock);
    expect(bare.pathname).toBe('/v1/tests');
    // No query string at all, not `?` and not an empty `q=`: the server reads
    // an empty q as no filter, but a client that sends one is one default
    // change away from asking for something it did not mean.
    expect(bare.raw).toBe('/v1/tests');

    fetchMock.mockClear();
    await fetchOrgTests({ q: 'checkout', limit: 5, cursor: 'opaque.cursor-value' });
    const full = requested(fetchMock);
    expect(full.pathname).toBe('/v1/tests');
    expect(full.params.get('q')).toBe('checkout');
    expect(full.params.get('limit')).toBe('5');
    // Passed through whole: it is the server's opaque string, not a uuid.
    expect(full.params.get('cursor')).toBe('opaque.cursor-value');

    fetchMock.mockClear();
    await fetchOrgTests({ limit: 5, cursor: null });
    const limited = requested(fetchMock);
    expect([...limited.params.keys()]).toEqual(['limit']);
  });

  it('does not send a q that is only whitespace, and trims one that is not', async () => {
    await fetchOrgTests({ q: '   ' });
    expect(requested(fetchMock).params.has('q')).toBe(false);

    fetchMock.mockClear();
    await fetchOrgTests({ q: '  checkout  ' });
    expect(requested(fetchMock).params.get('q')).toBe('checkout');
  });

  it('encodes a q with spaces and #, so neither ends the query early', async () => {
    await fetchOrgTests({ q: 'checkout soak #12' });
    const { raw, params, hash } = requested(fetchMock);
    // A raw `#` would start a fragment: the browser never sends one to the
    // server, so everything after it — and the limit — would be lost.
    expect(raw).not.toContain('#');
    expect(raw).not.toContain(' ');
    expect(hash).toBe('');
    expect(params.get('q')).toBe('checkout soak #12');
  });

  it('answers with the parsed list', async () => {
    await expect(fetchOrgTests({ q: 'x' })).resolves.toEqual(EMPTY_LIST);
  });

  it('raises the server’s own refusal as a ProblemError', async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'INVALID_CURSOR',
        detail: 'That cursor is not one this list issued.',
        remediation: 'Start again from the first page.',
      }),
    );
    await expect(fetchOrgTests({ cursor: 'junk' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CURSOR',
    });
  });
});

describe('searchRuns', () => {
  it('sends q and limit', async () => {
    await searchRuns('checkout soak', 5);
    const { pathname, params } = requested(fetchMock);
    expect(pathname).toBe('/v1/runs');
    expect(params.get('q')).toBe('checkout soak');
    expect(params.get('limit')).toBe('5');
    // A palette search is the first page of the org-wide list and nothing
    // else: a stray project or cursor would narrow what somebody typed.
    expect([...params.keys()].sort()).toEqual(['limit', 'q']);
  });

  it('encodes a q with # and %, so a literal search stays literal', async () => {
    await searchRuns('50%_off #1', 5);
    const { raw, params, hash } = requested(fetchMock);
    expect(raw).not.toContain('#');
    expect(hash).toBe('');
    expect(params.get('q')).toBe('50%_off #1');
  });
});

describe('fetchRunByNumber', () => {
  it('sends project, test, number and limit=1', async () => {
    await fetchRunByNumber('checkout', 'soak', 12);
    const { pathname, params } = requested(fetchMock);
    expect(pathname).toBe('/v1/runs');
    expect(params.get('project')).toBe('checkout');
    expect(params.get('test')).toBe('soak');
    expect(params.get('number')).toBe('12');
    expect(params.get('limit')).toBe('1');
    expect([...params.keys()].sort()).toEqual(['limit', 'number', 'project', 'test']);
  });

  it('encodes a slug, because it is data', async () => {
    await fetchRunByNumber('a/b', 'c d', 3);
    const { params } = requested(fetchMock);
    expect(params.get('project')).toBe('a/b');
    expect(params.get('test')).toBe('c d');
  });
});
