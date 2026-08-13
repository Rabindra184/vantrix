import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTE, safeNext } from '../src/routes/paths.js';

/**
 * `safeNext` is a security control on a login page — the one place an open
 * redirect is worth the most to an attacker, because the victim arrives from
 * the genuine domain having just authenticated. This is the only test it
 * has, so it asserts the rejections, not the happy path alone.
 *
 * Node environment with a stubbed `window`, not jsdom: the repo has no DOM
 * environment installed and `apps/web/test/fetch.test.ts` established the
 * pattern of stubbing the single global under test (`fetch`, there) rather
 * than adopting one. `safeNext` reads exactly one property of `window`, so a
 * whole DOM implementation would be a dependency bought for nothing.
 */
const ORIGIN = 'http://app.example';

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: ORIGIN } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeNext', () => {
  it.each([
    ['/runs', '/runs'],
    ['/runs/abc-123', '/runs/abc-123'],
    ['/runs?page=2', '/runs?page=2'],
  ])('accepts the same-origin path %j and returns it intact', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['https://evil.example'],
    ['evil.example'],
    [null],
    [''],
  ])('falls back to the default route for %j', (next) => {
    expect(safeNext(next)).toBe(DEFAULT_ROUTE);
  });

  /**
   * The cases a string check cannot see. The WHATWG URL parser strips every
   * ASCII tab, LF and CR from its input BEFORE parsing, so each of these is a
   * string beginning with a single slash whose parsed form is
   * `//evil.example` — a protocol-relative URL pointing off-site. They reach
   * the app as `?next=%2F%09%2Fevil.example`; `useSearchParams().get()`
   * percent-decodes them for you.
   *
   * The assertion is the PROPERTY that matters — the returned value resolves
   * to our own origin — rather than a literal return string. Which fallback
   * or normalised form comes back is an implementation choice; not sending
   * the user to another origin is the contract.
   */
  it.each([['/\t/evil.example'], ['/\n/evil.example'], ['/\r/evil.example'], ['/\t\\evil.example']])(
    'never resolves off-origin for the control-character spelling %j',
    (next) => {
      expect(new URL(safeNext(next), ORIGIN).origin).toBe(ORIGIN);
    },
  );
});
