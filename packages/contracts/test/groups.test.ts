import { describe, expect, it } from 'vitest';
import { displayPath, innermostGroup, requestsInGroup } from '../src/index.js';

/**
 * ═══ WHICH REQUESTS A GROUP HOLDS ═══
 * (docs/superpowers/specs/2026-11-04-report-pickers-design.md §3)
 *
 * The names are the reference run's own: a request is keyed by
 * `[...groups, name].join('/')` and a group by `groups.join('/')`
 * (`packages/statistics/src/engine.ts`), so these are exactly the strings the
 * API and the web will hand these functions.
 */
const GROUPS = ['Cart', 'Catalog', 'Catalog/Recommendations'];
const REQ = [
  'Cart/Add To Cart',
  'Cart/View Cart',
  'Catalog/List Products',
  'Catalog/Product Detail',
  'Catalog/Recommendations/Related Items',
  'Place Order',
  'Search',
];

describe('requestsInGroup', () => {
  it('takes a group and its subgroups', () => {
    expect(requestsInGroup(REQ, GROUPS, 'Catalog')).toEqual([
      'Catalog/List Products',
      'Catalog/Product Detail',
      'Catalog/Recommendations/Related Items',
    ]);
  });

  it('answers the requests in no group', () => {
    expect(requestsInGroup(REQ, GROUPS, '')).toEqual(['Place Order', 'Search']);
  });

  it('keeps a slash-led top-level request in no group', () => {
    expect(requestsInGroup(['/login', '/order/1005', 'Cart/x'], ['Cart'], '')).toEqual([
      '/login',
      '/order/1005',
    ]);
  });

  it('pins the known limit: a top-level name starting with a group path is counted in it', () => {
    expect(requestsInGroup(['Cart/x'], ['Cart'], 'Cart')).toEqual(['Cart/x']);
  });

  it('answers nothing for an unknown group, and never matches a bare prefix', () => {
    expect(requestsInGroup(REQ, GROUPS, 'Car')).toEqual([]);
    expect(requestsInGroup(REQ, GROUPS, 'Nope')).toEqual([]);
    // The two lines above cannot tell the two guards apart: `Car` is refused as
    // unknown before its prefix is ever read, and nothing sits under `Nope/`.
    // So each guard gets a case only it can answer: a request under an unknown
    // group's path, and a KNOWN group that is a bare prefix of another.
    expect(requestsInGroup(['Nope/x'], GROUPS, 'Nope')).toEqual([]);
    expect(requestsInGroup(['Cart/x'], ['Car', 'Cart'], 'Car')).toEqual([]);
  });
});

describe('innermostGroup', () => {
  it('finds the innermost group', () => {
    expect(innermostGroup('Catalog/Recommendations/Related Items', GROUPS)).toBe(
      'Catalog/Recommendations',
    );
    expect(innermostGroup('/login', GROUPS)).toBe('');
    // A top-level request whose name merely begins with a group's name.
    expect(innermostGroup('CartSummary', GROUPS)).toBe('');
  });
});

describe('displayPath', () => {
  it('displays paths', () => {
    expect(displayPath('')).toBe('(no group)');
    expect(displayPath('Catalog/Recommendations')).toBe('Catalog / Recommendations');
  });
});
