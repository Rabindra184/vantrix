import { matchPath } from 'react-router-dom';
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
} from '../routes/paths.js';

/**
 * Where the command palette can take a reader without searching for it.
 *
 * Pure and DOM-free, like `parseQuery`: which destinations exist for a given
 * place in the app is a decision, and it is cheaper to pin here than through a
 * rendered dialog. Every `to` comes from `paths.ts` and none is spelled here —
 * that file is where a route's shape is decided, and a palette that wrote its
 * own `/projects/${slug}/rules` would be a second opinion about it.
 */

/** One place the palette can go. */
export interface Destination {
  /**
   * Unique and stable. The palette hands it to cmdk as the item's value, and
   * cmdk treats two items sharing one as a single item — so a duplicate here
   * is a row that silently cannot be reached.
   */
  readonly id: string;
  readonly label: string;
  readonly to: string;
}

/** What the palette needs to know about a project: how to name it and where it is. */
export interface ProjectRef {
  readonly slug: string;
  readonly name: string;
}

/** The most pages `matchPages` returns — the palette's Pages group holds five. */
const MAX_PAGES = 5;

/**
 * One pattern for the project's own page and everything under it. `end: false`
 * is what lets it cover both.
 */
const PROJECT_PATTERN = { path: '/projects/:slug', end: false } as const;

/**
 * Decodes a pathname the way the router does before it matches one.
 *
 * `matchPath` itself does NOT decode — handed `/projects/caf%C3%A9/rules` it
 * answers a slug of `caf%C3%A9`. It is the router's own `useMatch` that
 * decodes first, segment by segment, keeping an encoded slash encoded so it
 * cannot split one segment into two (`matchPath` then reads it back as a `/`
 * inside the one param). A palette that wants the slug `useParams` would give
 * the page has to do the same step, and a malformed escape falls back to the
 * raw text, as the router does.
 */
function decodePath(pathname: string): string {
  try {
    return pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/\//g, '%2F'))
      .join('/');
  } catch {
    return pathname;
  }
}

/**
 * `/projects/_new` fits that pattern and is not a project: its segment is the
 * create page's, and the slug grammar forbids `_` precisely so that no project
 * can be called that. It is read off `NEW_PROJECT_ROUTE` through the same
 * matcher rather than written down a second time, so the two cannot disagree.
 */
const NEW_PROJECT_SEGMENT = matchPath(PROJECT_PATTERN, NEW_PROJECT_ROUTE)?.params.slug;

/**
 * The slug of the project the reader is looking at, or null when they are not
 * looking at one.
 */
export function currentProjectSlug(pathname: string): string | null {
  const slug = matchPath(PROJECT_PATTERN, decodePath(pathname))?.params.slug;
  if (slug === undefined || slug === NEW_PROJECT_SEGMENT) return null;
  return slug;
}

/**
 * A project's pages, in `ProjectShell`'s order, then the launch form.
 *
 * `key` is the section's own name there (`ProjectSection`) and `label` is what
 * its nav calls it. Both are written down once more here because that file's
 * list is private to the component that draws it; `paletteDestinations.test.ts`
 * reads the component's source and fails if the two stop agreeing, which is
 * the only thing that keeps a copy from being a second opinion.
 */
const PAGES: readonly {
  readonly key: string;
  readonly label: string;
  readonly path: (slug: string) => string;
}[] = [
  { key: 'tests', label: 'Tests', path: projectPath },
  { key: 'runs', label: 'Runs', path: projectRunsPath },
  { key: 'packages', label: 'Packages', path: projectPackagesPath },
  { key: 'setup', label: 'Add results', path: projectSetupPath },
  { key: 'rules', label: 'SLA rules', path: projectRulesPath },
  { key: 'access', label: 'API tokens', path: projectAccessPath },
  /* Not a section of the shell — it is the action beside the nav — but it is
     a page a reader goes to, so it is a destination like the rest. */
  { key: 'new-run', label: 'New on-prem run', path: (slug) => projectNewRunnerRunPath(slug) },
];

/**
 * Each page as a destination, labelled "SLA rules · Checkout" so a row names
 * its project and stands alone in a list that mixes several. `page` is the
 * label without the project, which is what `matchPages` searches beside the
 * project's own name and slug.
 */
function pageDestinations(project: ProjectRef): readonly {
  readonly page: string;
  readonly destination: Destination;
}[] {
  return PAGES.map((page) => ({
    page: page.label,
    destination: {
      id: `page:${project.slug}:${page.key}`,
      label: `${page.label} · ${project.name}`,
      to: page.path(project.slug),
    },
  }));
}

/** A project's pages, each labelled with the project so a row stands alone in a mixed list. */
export function projectPages(project: ProjectRef): Destination[] {
  return pageDestinations(project).map((p) => p.destination);
}

const ALWAYS: readonly Destination[] = [
  { id: 'go:all-runs', label: 'All runs', to: ALL_RUNS_ROUTE },
  { id: 'go:new-project', label: 'New project', to: NEW_PROJECT_ROUTE },
];

/**
 * The palette's opening state: nothing typed, so nothing searched.
 *
 * All runs and New project are always there. The project's own pages follow
 * when the reader is inside one — "go to this project's rules" is the commonest
 * trip from a project page and costs no typing.
 */
export function goToDestinations(current: ProjectRef | null): Destination[] {
  return current === null ? [...ALWAYS] : [...ALWAYS, ...projectPages(current)];
}

/**
 * Projects whose name or slug contains the query, best first.
 *
 * Best means a name or slug that STARTS with what was typed, ahead of one that
 * merely contains it — typing `che` should lead with `checkout`, not with
 * `search-checkout` — and then alphabetical by name so the order is the same
 * every time the same thing is typed. A blank query matches nothing: the
 * palette's empty state is the Go to list, and "every project" is a list, not
 * a search.
 */
export function matchProjects(
  query: string,
  projects: readonly ProjectRef[],
  limit: number,
): ProjectRef[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  const ranked: { readonly project: ProjectRef; readonly rank: 0 | 1 }[] = [];
  for (const project of projects) {
    const name = project.name.toLowerCase();
    const slug = project.slug.toLowerCase();
    if (name.startsWith(q) || slug.startsWith(q)) ranked.push({ project, rank: 0 });
    else if (name.includes(q) || slug.includes(q)) ranked.push({ project, rank: 1 });
  }

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.project.name.localeCompare(b.project.name) ||
      a.project.slug.localeCompare(b.project.slug),
  );
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.project);
}

/**
 * Pages of `candidate` that the query asks for: every word of it must appear
 * somewhere in "<page> <project name> <project slug>".
 *
 * Words, not the whole string, so `tokens checkout` and `checkout tokens` find
 * the same page and a reader does not have to remember which comes first. The
 * project is part of what is searched — that is what lets `rules checkout`
 * name one page of one project — but the label's own " · " is not, so the
 * separator can never be the thing that matched.
 *
 * `candidate` is the project the caller decided the query is about: the one
 * the reader is inside, else the best project match. Null means there is no
 * such project, and then there is no page either.
 */
export function matchPages(query: string, candidate: ProjectRef | null): Destination[] {
  if (candidate === null) return [];
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [];

  const found: Destination[] = [];
  for (const { page, destination } of pageDestinations(candidate)) {
    const haystack = `${page} ${candidate.name} ${candidate.slug}`.toLowerCase();
    if (words.every((w) => haystack.includes(w))) found.push(destination);
    if (found.length === MAX_PAGES) break;
  }
  return found;
}
