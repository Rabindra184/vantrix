import type { BetterAuthOptions } from 'better-auth';
import { describe, expect, it } from 'vitest';
import { cookiesAreSecure, createAuth } from '../src/auth.js';

/**
 * ═══ THE ASYMMETRY IS THE WHOLE POINT ═══
 *
 * Every case below is one of two claims, and neither is safe without the
 * other:
 *
 *   - loopback over plain HTTP does NOT get `Secure`, because WebKit refuses
 *     to store such a cookie and nobody could sign in to a local instance in
 *     Safari — measured, three engines, one plain-HTTP loopback server:
 *     chromium and firefox stored it, webkit did not.
 *   - EVERYTHING ELSE over plain HTTP still does, because a session cookie a
 *     browser will send in the clear across a real network is one an attacker
 *     on the path can read. That case failing closed is deliberate.
 *
 * A test that only asserted the first half would pass just as happily against
 * `secure: false` everywhere, which is the regression that matters.
 */
describe('cookiesAreSecure', () => {
  it.each([
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])('exempts loopback over plain HTTP: %s', (url) => {
    expect(cookiesAreSecure(url)).toBe(false);
  });

  it.each([
    'https://localhost:3000',
    'https://127.0.0.1:3000',
  ])('does not exempt loopback over HTTPS, where there is nothing to fix: %s', (url) => {
    expect(cookiesAreSecure(url)).toBe(true);
  });

  it.each([
    'http://perf.example.com',
    'http://perf.internal:3000',
    'http://192.168.1.10:3000',
    'http://10.0.0.5',
  ])('keeps Secure for a plain-HTTP deployment reachable by network: %s', (url) => {
    expect(cookiesAreSecure(url)).toBe(true);
  });

  it.each([
    'https://perf.example.com',
    'https://perf.example.com:8443',
  ])('keeps Secure over HTTPS: %s', (url) => {
    expect(cookiesAreSecure(url)).toBe(true);
  });

  /**
   * A hostname that merely CONTAINS "localhost" is a different host, and one
   * an attacker can register. `localhost.evil.com` resolves wherever its
   * owner points it.
   */
  it.each([
    'http://localhost.evil.com',
    'http://notlocalhost',
    'http://mylocalhost:3000',
    'http://127.0.0.1.evil.com',
  ])('does not exempt a host that merely looks like loopback: %s', (url) => {
    expect(cookiesAreSecure(url)).toBe(true);
  });

  it('treats an unparseable base URL as the strict case', () => {
    // A misconfiguration should not silently downgrade a cookie.
    expect(cookiesAreSecure('not a url')).toBe(true);
    expect(cookiesAreSecure('')).toBe(true);
  });

  /**
   * ═══ THE OPERATOR'S OPT-OUT ═══
   *
   * Every case above is the DEFAULT and none of them moved: the parameter
   * defaults to false, so a caller that does not know about it behaves
   * exactly as before. These four are the switch itself, and the last two
   * matter more than the first two.
   */
  describe('allowInsecure', () => {
    it.each([
      'http://perf.example.com',
      'http://perf.internal:3000',
      'http://192.168.1.10:3000',
    ])('lets a plain-HTTP deployment hold a session when asked: %s', (url) => {
      expect(cookiesAreSecure(url, true)).toBe(false);
      // …and that it is OPT-IN is the half worth pinning, because a default
      // that flipped would be invisible: everything would simply keep working.
      expect(cookiesAreSecure(url)).toBe(true);
    });

    /* IT CANNOT DOWNGRADE TLS, EVEN SET BY MISTAKE. `cookiesAreSecure`
       returns on the scheme before the flag is consulted, so an operator who
       turns this on for an internal host and later puts the same compose file
       behind HTTPS does not silently keep sending cookies in the clear. This
       is the case that makes the flag safe to ship at all. */
    it.each([
      'https://perf.example.com',
      'https://localhost:3000',
    ])('is ignored over HTTPS, where there is nothing to opt out of: %s', (url) => {
      expect(cookiesAreSecure(url, true)).toBe(true);
    });

    /* An unparseable base URL stays strict either way: the flag is a
       statement about a network, not permission to guess. */
    it('does not rescue a misconfigured base URL', () => {
      expect(cookiesAreSecure('not a url', true)).toBe(true);
      expect(cookiesAreSecure('', true)).toBe(true);
    });
  });
});

/**
 * ═══ THE SESSION COOKIE CACHE STAYS OFF ═══
 *
 * The admin flag is `user.role`, read from the session `getSession` returns.
 * With Better Auth's `cookieCache` off, that read goes to the database on
 * every request, so an admin who is demoted is an ordinary account on their
 * next request. Turned on — the obvious "performance" change — the session
 * and its user ride in a signed cookie, and a demoted admin keeps the flag
 * for the cache's maxAge. This fails that change instead of letting it ship.
 *
 * Read from the options Better Auth RUNS with, not the ones createAuth
 * passed: `auth.$context` builds them in `createAuthContext`, merging in every
 * plugin's `init().options`, and that merged object is what each request
 * reads (`ctx.context.options`). A plugin that switched the cache on would
 * leave `auth.options` untouched and slip past a check of it.
 *
 * Built against a database that is never contacted: resolving the context
 * opens no connection, and nothing here queries.
 */
describe('createAuth', () => {
  it('keeps the session cookie cache off, so a demotion lands on the next request', async () => {
    const auth = createAuth({
      databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/unused',
      baseUrl: 'http://localhost:3000',
    });

    // Typed through Better Auth's own option type, which names `cookieCache`.
    const session: BetterAuthOptions['session'] = (await auth.$context).options.session;
    expect(session?.cookieCache?.enabled).toBeFalsy();
  });
});
