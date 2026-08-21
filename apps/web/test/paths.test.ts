import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SLUG_PATTERN } from '@perfportal/contracts';
import { DEFAULT_ROUTE, NEW_PROJECT_ROUTE, safeNext } from '../src/routes/paths.js';

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

/**
 * NOTHING STATIC MAY SIT WHERE A PROJECT SLUG GOES.
 *
 * React Router ranks a static segment above a dynamic one, so a literal
 * child of `/projects/` does not merely risk clashing with `/projects/:slug`
 * — it PERMANENTLY shadows any project whose slug matches it. `/projects/new`
 * shipped exactly that: `PROJECT_SLUG_PATTERN` accepts `new`,
 * `pnpm bootstrap new …` creates such a project, and from then on its rail
 * row, its bookmarks and `projectPath('new')` all opened the create form
 * while the project itself was reachable by nothing. Silent, and invisible
 * until someone picks that name.
 *
 * READ OUT OF `App.tsx` RATHER THAN LISTED HERE, because the failure this
 * guards against is a route somebody adds LATER — `/projects/import`,
 * `/projects/archive` — and a hand-maintained list in a test cannot know
 * about one. Anything the router declares directly under `/projects/` is
 * checked against the real slug grammar, so the next such route fails this
 * test the moment it is written, with the reason attached.
 *
 * The fix a failure asks for is a segment the grammar cannot produce — `_new`
 * is the existing one, since slugs forbid `_` — never a reserved-word list,
 * which cannot rescue a project that already carries the name.
 */
describe('static routes cannot shadow a project slug', () => {
  const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  it('declares at least one project route, so the scan below is not vacuous', () => {
    expect(APP).toMatch(/path=(?:"|\{)[^\n]*projects/);
  });

  it('gives every literal segment under /projects/ a name no slug can take', () => {
    // Literal `path="/projects/<segment>"` only: a `path={CONST}` form is
    // resolved through the constant instead, which the case below covers.
    const literals = [...APP.matchAll(/path="\/projects\/([^/"]+)"/g)]
      .map((match) => match[1])
      // A capture group is `string | undefined` to the type checker even
      // when the pattern guarantees it; narrowing here keeps the filter
      // below honest rather than asserting it away.
      .filter((segment): segment is string => segment !== undefined);
    const shadowing = literals.filter(
      (segment) => !segment.startsWith(':') && PROJECT_SLUG_PATTERN.test(segment),
    );
    expect(shadowing).toEqual([]);
  });

  it('keeps the create route itself unreachable as a slug', () => {
    const segment = NEW_PROJECT_ROUTE.replace('/projects/', '');
    expect(NEW_PROJECT_ROUTE.startsWith('/projects/')).toBe(true);
    expect(PROJECT_SLUG_PATTERN.test(segment)).toBe(false);
    // The regression in one line: the old value was a perfectly valid slug.
    expect(PROJECT_SLUG_PATTERN.test('new')).toBe(true);
  });
});
