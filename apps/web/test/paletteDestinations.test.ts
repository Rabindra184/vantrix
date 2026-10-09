import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccessAction, ProjectRole } from '@perfportal/contracts';
import { projectAccess, type ProjectAccess } from '../src/access/useAccess.js';
import {
  ALL_RUNS_ROUTE,
  HOME_ROUTE,
  NEW_PROJECT_ROUTE,
  projectAccessPath,
  projectMembersPath,
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

/*
 * Who is looking, built by the web's own access rule (`projectAccess`, the
 * decision `useProjectAccess` makes) rather than by hand: a fixture answering
 * `can` its own way would test the palette against a rule nobody else uses.
 * Each holds the role in `checkout`; an admin's answer does not depend on the
 * project at all, which is why ADMIN serves for `billing` too.
 */
const roleIn = (role: ProjectRole): ProjectAccess =>
  projectAccess(false, [{ slug: 'checkout', role }], 'checkout');
const ADMIN = projectAccess(true, undefined, 'checkout');
const MANAGER = roleIn('manager');
const MEMBER = roleIn('member');
const VIEWER = roleIn('viewer');
/** The session has not answered: nothing gated may be offered. */
const UNKNOWN = projectAccess(undefined, undefined, 'checkout');

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
  /* Home LEADS: it is a destination like the rest, the rail's first row, and
     the commonest trip from anywhere in the app — so it is also the row the
     palette highlights before anything is typed. */
  it('offers Home, All runs and New project when no project is current', () => {
    const ds = goToDestinations(null, true);
    expect(labels(ds)).toEqual(['Home', 'All runs', 'New project']);
    expect(ds.map((d) => d.to)).toEqual([HOME_ROUTE, ALL_RUNS_ROUTE, NEW_PROJECT_ROUTE]);
  });

  /* Gate by destination: the create page's one action is `projects:create`,
     an admin's alone. A non-admin is not offered it, and neither is a reader
     whose session has not answered — hidden until known. */
  it.each([
    ['a non-admin', false, MEMBER],
    ['a reader whose session has not answered', undefined, UNKNOWN],
  ] as const)('offers %s Home and All runs, and no New project', (_, isAdmin, access) => {
    expect(labels(goToDestinations(null, isAdmin))).toEqual(['Home', 'All runs']);
    expect(goToDestinations({ project: checkout, access }, isAdmin).map((d) => d.id)).not.toContain(
      'go:new-project',
    );
  });

  it('adds the current project’s pages after them — all eight for an admin', () => {
    const ds = goToDestinations({ project: checkout, access: ADMIN }, true);
    expect(labels(ds)).toEqual([
      'Home',
      'All runs',
      'New project',
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'Add results · Checkout',
      'SLA rules · Checkout',
      'Members · Checkout',
      'API tokens · Checkout',
      'New on-prem run · Checkout',
    ]);
    expect(ds[5]?.to).toBe(projectPackagesPath('checkout'));
    expect(ds[7]?.to).toBe(projectRulesPath('checkout'));
    expect(ds[8]?.to).toBe(projectMembersPath('checkout'));
  });

  it('adds only the pages the reader may open', () => {
    expect(labels(goToDestinations({ project: checkout, access: VIEWER }, false))).toEqual([
      'Home',
      'All runs',
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'SLA rules · Checkout',
      'Members · Checkout',
    ]);
  });

  it('gives every destination its own stable id', () => {
    const ids = goToDestinations({ project: checkout, access: ADMIN }, true).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(goToDestinations({ project: checkout, access: ADMIN }, true).map((d) => d.id)).toEqual(ids);
    // Two projects must not share an id either: cmdk keys items on it.
    const other = goToDestinations({ project: billing, access: ADMIN }, true).map((d) => d.id);
    expect(ids.filter((id) => other.includes(id))).toEqual(['go:home', 'go:all-runs', 'go:new-project']);
  });
});

describe('projectPages', () => {
  it('labels each page for its project, in the order ProjectShell draws them', () => {
    expect(labels(projectPages(checkout, ADMIN))).toEqual([
      'Tests · Checkout',
      'Runs · Checkout',
      'Packages · Checkout',
      'Add results · Checkout',
      'SLA rules · Checkout',
      'Members · Checkout',
      'API tokens · Checkout',
      'New on-prem run · Checkout',
    ]);
  });

  it('takes every destination from paths.ts', () => {
    expect(projectPages(checkout, ADMIN).map((d) => d.to)).toEqual([
      projectPath('checkout'),
      projectRunsPath('checkout'),
      projectPackagesPath('checkout'),
      projectSetupPath('checkout'),
      projectRulesPath('checkout'),
      projectMembersPath('checkout'),
      projectAccessPath('checkout'),
      projectNewRunnerRunPath('checkout'),
    ]);
  });

  /**
   * The shell's own table, read through its own filter: Add results needs
   * `run:upload` (Member), API tokens `tokens:manage` (Manager), and the
   * launch `runner:run` (Member). Every other page is offered to every role,
   * and nothing gated before the session has answered.
   */
  it.each([
    ['an admin', ADMIN, ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members', 'API tokens', 'New on-prem run']],
    ['a Manager', MANAGER, ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members', 'API tokens', 'New on-prem run']],
    ['a Member', MEMBER, ['Tests', 'Runs', 'Packages', 'Add results', 'SLA rules', 'Members', 'New on-prem run']],
    ['a Viewer', VIEWER, ['Tests', 'Runs', 'Packages', 'SLA rules', 'Members']],
    ['a reader not yet known', UNKNOWN, ['Tests', 'Runs', 'Packages', 'SLA rules', 'Members']],
  ] as const)('offers %s only the pages their access allows', (_, access, pages) => {
    expect(labels(projectPages(checkout, access))).toEqual(pages.map((page) => `${page} · Checkout`));
  });

  it('encodes a slug the way paths.ts does, because it builds nothing itself', () => {
    const odd: ProjectRef = { slug: 'a b', name: 'A B' };
    expect(projectPages(odd, ADMIN)[0]?.to).toBe(projectPath('a b'));
    expect(projectPages(odd, ADMIN)[0]?.to).toBe('/projects/a%20b');
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
    expect(labels(matchPages('rules', { project: checkout, access: ADMIN }))).toEqual(['SLA rules · Checkout']);
  });

  it('needs every word, in any order, across the page and the project', () => {
    expect(labels(matchPages('tokens checkout', { project: checkout, access: ADMIN }))).toEqual(['API tokens · Checkout']);
    expect(labels(matchPages('checkout tokens', { project: checkout, access: ADMIN }))).toEqual(['API tokens · Checkout']);
    expect(matchPages('tokens billing', { project: checkout, access: ADMIN })).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(labels(matchPages('SLA', { project: checkout, access: ADMIN }))).toEqual(['SLA rules · Checkout']);
  });

  it('reads the slug as well as the name', () => {
    const p: ProjectRef = { slug: 'pay-svc', name: 'Payments' };
    expect(labels(matchPages('rules pay-svc', { project: p, access: ADMIN }))).toEqual(['SLA rules · Payments']);
  });

  it('returns no more than five pages', () => {
    // Every page matches the project's own name, so the cap is what limits it.
    const ds = matchPages('checkout', { project: checkout, access: ADMIN });
    expect(ds).toHaveLength(5);
    expect(labels(ds)[0]).toBe('Tests · Checkout');
  });

  /* A page the shell hides is not one a search can reach either: typing
     `tokens checkout` as a Viewer would otherwise put a row on screen whose
     page answers "you cannot do this". */
  it('never finds a page the reader may not open', () => {
    expect(matchPages('tokens checkout', { project: checkout, access: VIEWER })).toEqual([]);
    expect(matchPages('results checkout', { project: checkout, access: VIEWER })).toEqual([]);
    expect(matchPages('on-prem checkout', { project: checkout, access: VIEWER })).toEqual([]);
    expect(labels(matchPages('members checkout', { project: checkout, access: VIEWER }))).toEqual([
      'Members · Checkout',
    ]);
  });

  it('answers nothing without a project to be a page of', () => {
    expect(matchPages('rules', null)).toEqual([]);
  });

  it('answers nothing for a blank query', () => {
    expect(matchPages('', { project: checkout, access: ADMIN })).toEqual([]);
    expect(matchPages('   ', { project: checkout, access: ADMIN })).toEqual([]);
  });

  it('returns destinations that point where projectPages points', () => {
    expect(matchPages('rules', { project: checkout, access: ADMIN })).toEqual(
      projectPages(checkout, ADMIN).filter((d) => d.to === projectRulesPath('checkout')),
    );
  });
});

/** A source file with its comments stripped: a scan has to read code, not the prose quoting it. */
const codeOf = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/**
 * The palette offers a project's pages by the strip's own table and filter
 * (`routes/projectSections.ts`, which `ProjectShell` draws from too), so the
 * two cannot disagree while it does. What this guards is the day it stops: a
 * palette that grew its own list again — the copy this file used to compare —
 * or filtered by a rule of its own would offer a tab the strip hides, or miss
 * one it shows, and nothing but a reader's eye would notice.
 *
 * So this reads the table's SOURCE — every row's key, label and `requires`,
 * and the launch action's label and `requires` — and works out, for each kind
 * of reader, what the strip draws: every row requiring nothing, and each gated
 * row the reader's access allows. The palette must offer exactly that, in that
 * order, then the launch when the reader may start a run.
 *
 * Comments are stripped first, because that table is surrounded by prose that
 * quotes the very labels being matched, and a source scan has to read code
 * only.
 */
describe('the palette\u2019s pages follow ProjectShell', () => {
  const source = codeOf('../src/routes/projectSections.ts');
  const sections = [
    ...source.matchAll(
      /section:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*path:\s*\w+(?:,\s*requires:\s*'([a-z:]+)')?\s*\}/g,
    ),
  ].map((m) => ({ key: m[1], label: m[2], requires: m[3] as AccessAction | undefined }));
  /* Lazy up to the first `= {` — the declaration's type carries an arrow
     (`=>`) before it, so "everything up to an equals sign" would stop there. */
  const launchBlock = /const LAUNCH\b[\s\S]*?=\s*\{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
  const launch = {
    label: /label:\s*'([^']+)'/.exec(launchBlock)?.[1],
    requires: /requires:\s*'([a-z:]+)'/.exec(launchBlock)?.[1] as AccessAction | undefined,
  };

  it('found the sections, the gates and the launch it is meant to compare against', () => {
    // A scan that matches nothing would pass every assertion below it, and one
    // that dropped every `requires` would expect the palette to offer a Viewer
    // everything — so the gated rows are counted as well as the rows.
    expect(sections.length).toBeGreaterThanOrEqual(7);
    expect(sections.filter((s) => s.requires !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(launch.label).toBe('New on-prem run');
    expect(launch.requires).toBeDefined();
  });

  it.each([
    ['an admin', ADMIN],
    ['a Manager', MANAGER],
    ['a Member', MEMBER],
    ['a Viewer', VIEWER],
    ['a reader not yet known', UNKNOWN],
  ] as const)('offers %s what the strip draws, in its order, then the launch form if allowed', (_, access) => {
    const drawn = sections.filter((s) => s.requires === undefined || access.can(s.requires));
    const offersLaunch = launch.requires !== undefined && access.can(launch.requires);
    const pages = projectPages(checkout, access);

    expect(pages.map((d) => d.id)).toEqual([
      ...drawn.map((s) => `page:checkout:${s.key}`),
      ...(offersLaunch ? ['page:checkout:new-run'] : []),
    ]);
    expect(pages.map((d) => d.label)).toEqual([
      ...drawn.map((s) => `${s.label} \u00b7 Checkout`),
      ...(offersLaunch ? [`${launch.label} \u00b7 Checkout`] : []),
    ]);
  });
});

/**
 * \u2550\u2550\u2550 THE PALETTE TAKES THE TABLE, NEVER THE COMPONENT \u2550\u2550\u2550
 *
 * The palette is in the entry chunk \u2014 the header mounts it on every page \u2014
 * and `ProjectShell` is not: it is drawn only by the lazily loaded project
 * pages. While `destinations.ts` read the table out of `ProjectShell.tsx`, the
 * bundler had to bring the whole module, component and all, into the entry
 * chunk for a table and a filter (measured, from two builds' logs: Ruling
 * P11). The table lives in a module of its own now, with no component in it.
 *
 * WHAT THESE SCANS CHECK IS NARROWER THAN THAT, AND SAYS SO. They read the
 * DIRECT run-time imports of two files: the palette takes the table from
 * `projectSections.ts` and never from `ProjectShell`, and the table loads
 * nothing but the paths it is built from. They do not prove `ProjectShell`
 * stays out of the entry chunk — anything else the entry reaches could import
 * it, and only a build shows that. They keep these two files from bringing it
 * back.
 *
 * A TYPE import (`import type`, `export type`) is erased before the bundler
 * sees it, so it does not count; every other `import` does, a bare
 * side-effect `import './x'` included, and so does an `export … from`.
 */
describe('the palette\u2019s table comes from a module with no component in it', () => {
  /**
   * Every module a file loads at run time, in source order.
   *
   * An `import` or `export` statement up to its first quote: for an import
   * that is the module (a side-effect `import './x'` has nothing before it),
   * and an export counts only when its clause ends in `from`. The clause
   * stops at the first quote or semicolon, so it can never run on into the
   * NEXT statement — the earlier `[\s\S]*?\sfrom` did exactly that from a
   * side-effect import, reading only the module after it. `type` right after
   * the keyword is erased and does not count.
   */
  const valueImports = (code: string): string[] =>
    [...code.matchAll(/^(import|export)\s+(type\s+)?([^'";]*?)['"]([^'"]+)['"]/gm)]
      .filter((m) => m[2] === undefined && (m[1] === 'import' || /\bfrom\s*$/.test(m[3]!)))
      .map((m) => m[4]!);

  const palette = valueImports(codeOf('../src/palette/destinations.ts'));
  const table = valueImports(codeOf('../src/routes/projectSections.ts'));

  it('reads a side-effect import and an export-from as loads, and only a type import as none', () => {
    // Each of these but the two type-only lines makes the bundler fetch the
    // module, so a scan that missed one would wave its import through.
    const code = [
      "import type { A } from './a';",
      "import './side-effect';",
      "import { b } from './b';",
      "export { c } from './c';",
      "export type { D } from './d';",
      "export const E = 'not an import';",
    ].join('\n');
    expect(valueImports(code)).toEqual(['./side-effect', './b', './c']);
  });

  it('found the imports it is meant to judge', () => {
    // A pattern that matched nothing would pass both cases below.
    expect(palette.length).toBeGreaterThanOrEqual(2);
    expect(table.length).toBeGreaterThanOrEqual(1);
  });

  it('reads the table from projectSections.ts, never from ProjectShell', () => {
    expect(palette).toContain('../routes/projectSections.js');
    expect(palette.filter((from) => /ProjectShell/.test(from))).toEqual([]);
  });

  it('builds the table from paths.ts alone: no React, no router, no component', () => {
    expect(table).toEqual(['./paths']);
  });
});
