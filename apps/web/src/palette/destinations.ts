import { matchPath } from 'react-router-dom';
import type { ProjectAccess } from '../access/useAccess.js';
import { ALL_RUNS_ROUTE, HOME_ROUTE, NEW_PROJECT_ROUTE } from '../routes/paths.js';
import { LAUNCH, visibleSections, type ProjectSection } from '../routes/ProjectShell.js';

/**
 * Where the command palette can take a reader without searching for it.
 *
 * Pure and DOM-free, like `parseQuery`: which destinations exist for a given
 * place in the app is a decision, and it is cheaper to pin here than through a
 * rendered dialog. Every `to` comes from `paths.ts` and none is spelled here —
 * that file is where a route's shape is decided, and a palette that wrote its
 * own `/projects/${slug}/rules` would be a second opinion about it. A
 * project's pages arrive by way of `ProjectShell`'s own table, which takes its
 * paths from there and decides which of them a reader is offered; this module
 * imports the table and its filter, which are plain data and a plain
 * function, not the component.
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

/**
 * A project the palette offers PAGES of, with what the reader may do in it —
 * `useProjectAccess`'s answer for that project, which is what decides which
 * of its pages are offered. Carried together so a project's pages can never
 * be filtered by another project's access.
 */
export interface ProjectWithAccess {
  readonly project: ProjectRef;
  readonly access: ProjectAccess;
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

/** One of a project's pages, before it is labelled for the project it belongs to. */
interface Page {
  readonly key: ProjectSection | 'new-run';
  readonly label: string;
  readonly path: (slug: string) => string;
}

/**
 * A project's pages for a reader: the sections `ProjectShell` draws for them,
 * in its order, then the launch form when they may start a run.
 *
 * Read off the shell itself — its `visibleSections` and its `LAUNCH` — and
 * never written down here. A palette that kept its own list, or decided its
 * own way which pages a role may open, would be a second opinion about both:
 * it could offer a Viewer an API tokens row the strip hides from them.
 * `paletteDestinations.test.ts` reads the shell's source and fails the day the
 * two disagree.
 *
 * `key` is the section's own name there (`ProjectSection`); the launch, which
 * is the action beside the strip rather than a section of it, is `new-run`.
 */
function pagesFor(access: ProjectAccess): readonly Page[] {
  const pages: Page[] = visibleSections(access).map(({ section, label, path }) => ({ key: section, label, path }));
  /* Not a section of the shell — it is the action beside the nav — but it is
     a page a reader goes to, so it is a destination like the rest, offered by
     the rule the shell draws it by. */
  if (access.can(LAUNCH.requires)) pages.push({ key: 'new-run', label: LAUNCH.label, path: LAUNCH.path });
  return pages;
}

/**
 * Each page as a destination, labelled "SLA rules · Checkout" so a row names
 * its project and stands alone in a list that mixes several. `page` is the
 * label without the project, which is what `matchPages` searches beside the
 * project's own name and slug.
 */
function pageDestinations(
  project: ProjectRef,
  access: ProjectAccess,
): readonly {
  readonly page: string;
  readonly destination: Destination;
}[] {
  return pagesFor(access).map((page) => ({
    page: page.label,
    destination: {
      id: `page:${project.slug}:${page.key}`,
      label: `${page.label} · ${project.name}`,
      to: page.path(project.slug),
    },
  }));
}

/**
 * A project's pages that `access` lets the reader open, each labelled with
 * the project so a row stands alone in a mixed list. `access` must be the
 * answer for THIS project.
 */
export function projectPages(project: ProjectRef, access: ProjectAccess): Destination[] {
  return pageDestinations(project, access).map((p) => p.destination);
}

/**
 * Home LEADS. It is a destination like the others — the rail's first row, and
 * the palette is "find and go" — and the first row is the one the palette
 * highlights before anything is typed (`CommandPalette.test.tsx` pins that).
 */
const ALWAYS: readonly Destination[] = [
  { id: 'go:home', label: 'Home', to: HOME_ROUTE },
  { id: 'go:all-runs', label: 'All runs', to: ALL_RUNS_ROUTE },
  { id: 'go:new-project', label: 'New project', to: NEW_PROJECT_ROUTE },
];

/**
 * The palette's opening state: nothing typed, so nothing searched.
 *
 * Home, All runs and New project are always there. The project's own pages
 * follow when the reader is inside one — "go to this project's rules" is the
 * commonest trip from a project page and costs no typing — as many of them as
 * the reader's access there offers.
 */
export function goToDestinations(current: ProjectWithAccess | null): Destination[] {
  return current === null ? [...ALWAYS] : [...ALWAYS, ...projectPages(current.project, current.access)];
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
 * Pages of `candidate` that the query asks for, among those its access offers:
 * every word of it must appear somewhere in "<page> <project name> <project
 * slug>". A page the reader may not open is not searched at all — a search
 * reaching what the strip hides would be the same false offer one step later.
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
export function matchPages(query: string, candidate: ProjectWithAccess | null): Destination[] {
  if (candidate === null) return [];
  const { project, access } = candidate;
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [];

  const found: Destination[] = [];
  for (const { page, destination } of pageDestinations(project, access)) {
    const haystack = `${page} ${project.name} ${project.slug}`.toLowerCase();
    if (words.every((w) => haystack.includes(w))) found.push(destination);
    if (found.length === MAX_PAGES) break;
  }
  return found;
}
