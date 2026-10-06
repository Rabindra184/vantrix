import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_RUNS_ROUTE,
  NEW_PROJECT_ROUTE,
  projectAccessPath,
  projectNewRunnerRunPath,
  projectPackagesPath,
  projectPath,
  projectRulesPath,
  projectRunsPath,
  projectSetupPath,
} from '../src/routes/paths.js';
import {
  currentProjectSlug,
  goToDestinations,
  matchPages,
  matchProjects,
  projectPages,
  type ProjectRef,
} from '../src/palette/destinations.js';

const checkout: ProjectRef = { slug: 'checkout', name: 'Checkout' };
const searchCheckout: ProjectRef = { slug: 'search-checkout', name: 'Search Checkout' };
const billing: ProjectRef = { slug: 'billing', name: 'Billing' };

const labels = (ds: readonly { label: string }[]): string[] => ds.map((d) => d.label);

describe('currentProjectSlug', () => {
  it.each([
    ['/projects/checkout/rules', 'checkout'],
    ['/projects/checkout', 'checkout'],
    ['/projects/checkout/tests/soak', 'checkout'],
    ['/projects/checkout/run/new', 'checkout'],
  ])('reads the project out of %j', (pathname, slug) => {
    expect(currentProjectSlug(pathname)).toBe(slug);
  });

  it('answers null for the create-a-project page, whose "slug" is not a project', () => {
    expect(currentProjectSlug(NEW_PROJECT_ROUTE)).toBeNull();
    expect(currentProjectSlug('/projects/_new')).toBeNull();
  });

  it.each(['/runs/abc', '/runs', '/projects', '/', '/login'])(
    'answers null where there is no project: %j',
    (pathname) => {
      expect(currentProjectSlug(pathname)).toBeNull();
    },
  );

  it('decodes the slug the way the router does, which matchPath alone does not', () => {
    expect(currentProjectSlug('/projects/caf%C3%A9/rules')).toBe('café');
    // An encoded slash stays inside ONE segment; it reads back as `a/b`, which is
    // what `useParams` answers for it and what no project's slug can equal.
    expect(currentProjectSlug('/projects/a%2Fb')).toBe('a/b');
  });

  it('keeps a malformed escape as typed, as the router does', () => {
    expect(currentProjectSlug('/projects/%E0%A4%A/rules')).toBe('%E0%A4%A');
  });
});

describe('goToDestinations', () => {
  it('offers All runs and New project when no project is current', () => {
    const ds = goToDestinations(null);
    expect(labels(ds)).toEqual(['All runs', 'New project']);
    expect(ds.map((d) => d.to)).toEqual([ALL_RUNS_ROUTE, NEW_PROJECT_ROUTE]);
  });

  it('adds the current project’s seven pages after them', () => {
    const ds = goToDestinations(checkout);
    expect(labels(ds)).toEqual([
      'All runs',
      'New project',
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'Add results · Checkout',
      'SLA rules · Checkout',
      'API tokens · Checkout',
      'New on-prem run · Checkout',
    ]);
    expect(ds[4]?.to).toBe(projectPackagesPath('checkout'));
    expect(ds[6]?.to).toBe(projectRulesPath('checkout'));
  });

  it('gives every destination its own stable id', () => {
    const ids = goToDestinations(checkout).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(goToDestinations(checkout).map((d) => d.id)).toEqual(ids);
    // Two projects must not share an id either: cmdk keys items on it.
    const other = goToDestinations(billing).map((d) => d.id);
    expect(ids.filter((id) => other.includes(id))).toEqual(['go:all-runs', 'go:new-project']);
  });
});

describe('projectPages', () => {
  it('labels each page for its project, in the order ProjectShell draws them', () => {
    expect(labels(projectPages(checkout))).toEqual([
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'Add results · Checkout',
      'SLA rules · Checkout',
      'API tokens · Checkout',
      'New on-prem run · Checkout',
    ]);
  });

  it('takes every destination from paths.ts', () => {
    expect(projectPages(checkout).map((d) => d.to)).toEqual([
      projectPath('checkout'),
      projectRunsPath('checkout'),
      projectPackagesPath('checkout'),
      projectSetupPath('checkout'),
      projectRulesPath('checkout'),
      projectAccessPath('checkout'),
      projectNewRunnerRunPath('checkout'),
    ]);
  });

  it('encodes a slug the way paths.ts does, because it builds nothing itself', () => {
    const odd: ProjectRef = { slug: 'a b', name: 'A B' };
    expect(projectPages(odd)[0]?.to).toBe(projectPath('a b'));
    expect(projectPages(odd)[0]?.to).toBe('/projects/a%20b');
  });
});

describe('matchProjects', () => {
  const all = [billing, searchCheckout, checkout];

  it('puts a prefix match before an inner one', () => {
    expect(matchProjects('che', all, 5).map((p) => p.slug)).toEqual([
      'checkout',
      'search-checkout',
    ]);
  });

  it('puts a prefix match first even when an inner match sorts ahead of it by name', () => {
    // "Admin Checkout" is alphabetically before "Checkout", so only the prefix
    // rule — not the name order — can put Checkout first.
    const admin: ProjectRef = { slug: 'admin-checkout', name: 'Admin Checkout' };
    expect(matchProjects('che', [admin, searchCheckout, checkout], 5).map((p) => p.slug)).toEqual([
      'checkout',
      'admin-checkout',
      'search-checkout',
    ]);
  });

  it('matches case-insensitively, on the name or the slug', () => {
    expect(matchProjects('CHECKOUT', all, 5).map((p) => p.slug)).toEqual([
      'checkout',
      'search-checkout',
    ]);
    // "search" is the start of the search-checkout slug and name, and nothing else.
    expect(matchProjects('search', all, 5).map((p) => p.slug)).toEqual(['search-checkout']);
    const renamed: ProjectRef = { slug: 'pay', name: 'Payments' };
    expect(matchProjects('pay', [renamed], 5)).toEqual([renamed]);
    expect(matchProjects('ments', [renamed], 5)).toEqual([renamed]);
  });

  it('matches a project whose slug starts with the query even when its name does not', () => {
    const odd: ProjectRef = { slug: 'zeta', name: 'Alpha service' };
    const other: ProjectRef = { slug: 'omega', name: 'Beta zeta' };
    // `zeta` leads one slug and sits inside the other's name.
    expect(matchProjects('zet', [other, odd], 5).map((p) => p.slug)).toEqual(['zeta', 'omega']);
  });

  it('orders matches of the same kind by name', () => {
    const a: ProjectRef = { slug: 'che-b', name: 'Che B' };
    const b: ProjectRef = { slug: 'che-a', name: 'Che A' };
    expect(matchProjects('che', [a, b], 5).map((p) => p.name)).toEqual(['Che A', 'Che B']);
  });

  it('stops at the limit', () => {
    expect(matchProjects('che', all, 1).map((p) => p.slug)).toEqual(['checkout']);
  });

  it('finds nothing for nothing, and for a miss', () => {
    expect(matchProjects('zzz', all, 5)).toEqual([]);
    expect(matchProjects('', all, 5)).toEqual([]);
    expect(matchProjects('   ', all, 5)).toEqual([]);
  });

  it('does not reorder or mutate what it was given', () => {
    const input = [billing, searchCheckout, checkout];
    matchProjects('che', input, 5);
    expect(input.map((p) => p.slug)).toEqual(['billing', 'search-checkout', 'checkout']);
  });
});

describe('matchPages', () => {
  it('finds a page by its label', () => {
    expect(labels(matchPages('rules', checkout))).toEqual(['SLA rules · Checkout']);
  });

  it('needs every word, in any order, across the page and the project', () => {
    expect(labels(matchPages('tokens checkout', checkout))).toEqual(['API tokens · Checkout']);
    expect(labels(matchPages('checkout tokens', checkout))).toEqual(['API tokens · Checkout']);
    expect(matchPages('tokens billing', checkout)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(labels(matchPages('SLA', checkout))).toEqual(['SLA rules · Checkout']);
  });

  it('reads the slug as well as the name', () => {
    const p: ProjectRef = { slug: 'pay-svc', name: 'Payments' };
    expect(labels(matchPages('rules pay-svc', p))).toEqual(['SLA rules · Payments']);
  });

  it('returns no more than five pages', () => {
    // Every page matches the project's own name, so the cap is what limits it.
    const ds = matchPages('checkout', checkout);
    expect(ds).toHaveLength(5);
    expect(labels(ds)[0]).toBe('Tests · Checkout');
  });

  it('answers nothing without a project to be a page of', () => {
    expect(matchPages('rules', null)).toEqual([]);
  });

  it('answers nothing for a blank query', () => {
    expect(matchPages('', checkout)).toEqual([]);
    expect(matchPages('   ', checkout)).toEqual([]);
  });

  it('returns destinations that point where projectPages points', () => {
    expect(matchPages('rules', checkout)).toEqual(
      projectPages(checkout).filter((d) => d.to === projectRulesPath('checkout')),
    );
  });
});

/**
 * `ProjectShell`'s list of sections is private to the component that draws it,
 * so the palette keeps a copy of its keys and labels. A copy is a second
 * opinion unless something compares it, and nothing but a reader's eye would
 * notice a section added there and missing here — so this reads the component's
 * SOURCE and fails when the two stop agreeing.
 *
 * Comments are stripped first, because that list is surrounded by prose that
 * quotes the very labels being matched, and a source scan has to read code
 * only.
 */
describe('the palette\u2019s pages follow ProjectShell', () => {
  const source = readFileSync(new URL('../src/routes/ProjectShell.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const sections = [
    ...source.matchAll(/section:\s*'([a-z]+)',\s*label:\s*'([^']+)'/g),
  ].map((m) => ({ key: m[1], label: m[2] }));

  it('found the sections it is meant to compare against', () => {
    // A scan that matches nothing would pass every assertion below it.
    expect(sections.length).toBeGreaterThanOrEqual(6);
  });

  it('offers the same pages, under the same names, in the same order, then the launch form', () => {
    const pages = projectPages(checkout);
    expect(pages.slice(0, sections.length).map((d) => d.id)).toEqual(
      sections.map((s) => `page:checkout:${s.key}`),
    );
    expect(pages.slice(0, sections.length).map((d) => d.label)).toEqual(
      sections.map((s) => `${s.label} \u00b7 Checkout`),
    );
    expect(pages).toHaveLength(sections.length + 1);
    expect(pages[sections.length]?.label).toBe('New on-prem run \u00b7 Checkout');
  });
});
