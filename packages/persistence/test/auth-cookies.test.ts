import { describe, expect, it } from 'vitest';
import { cookiesAreSecure } from '../src/auth.js';

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
});
