import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectListResponse } from '@perfportal/contracts';
import Badge from './components/Badge';
import { fetchProjects, projectsQueryKey } from './api/projects';
import { DEFAULT_ROUTE, projectPath } from './routes/paths';
import { STATUS, VERDICT, type Mark } from './routes/marks';

type ProjectItem = ProjectListResponse['items'][number];

/**
 * What this organisation contains, on every authenticated page.
 *
 * A `<div>`, not an `<aside>`: `aside` carries the `complementary` role,
 * meaning content tangentially related to the page, and a primary navigation
 * rail is not that. The landmark that matters is the `<nav>` below.
 *
 * The brand is a `<Link>` rather than a heading so it does not compete with
 * the `<h1>` every page renders inside `<main>` — and as a link it doubles as
 * the way back to the org-wide list.
 *
 * Below `lg` the same `<nav>` lays out horizontally and scrolls. Deliberately
 * NOT a drawer: a toggle overlay needs focus management, an escape handler, a
 * scrim and return-focus-on-close to be correct, and this repo runs Playwright
 * with a single `Desktop Chrome` project — so every one of those would ship
 * unverified. A plainer nav that is always in the document cannot trap a
 * keyboard user.
 */
export default function ProjectRail() {
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const items = projects.data?.items ?? [];

  // TanStack Query keeps the last-known-good `data` across a failed refetch,
  // so `isError` and a non-empty `items` can both be true at once — the
  // ordinary shape of "loaded fine, then a later refetch failed". Blanking
  // the rows in that case would throw away information the reader can still
  // act on, so the rows stay and the message names what actually happened
  // rather than claiming nothing loaded (the same overclaim the D-14
  // sentence fix corrected on the run page, one level up in the tree).
  const message = projects.isError
    ? items.length > 0
      ? 'Projects may be out of date.'
      : 'Projects could not be loaded.'
    : projects.isSuccess && items.length === 0
      ? 'No projects yet.'
      : null;

  return (
    <div className="flex flex-col border-b border-default bg-sidebar lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
      <Link to={DEFAULT_ROUTE} className="px-4 py-3 font-semibold">
        PerfPortal
      </Link>

      <nav
        aria-label="Projects"
        className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-4"
      >
        {/* `end` is load-bearing: without it React Router marks this active
            for /runs/:runId too, so the rail would claim the reader is on the
            org-wide list while they are reading one run. */}
        <NavLink
          to={DEFAULT_ROUTE}
          end
          className="shrink-0 rounded px-3 py-2 text-sm hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:font-medium"
        >
          All runs
        </NavLink>

        {items.map((project) => (
          <NavLink
            key={project.id}
            to={projectPath(project.slug)}
            className="flex shrink-0 items-center justify-between gap-2 rounded px-3 py-2 text-sm hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:font-medium"
          >
            {/* Truncated, not wrapped: a rail whose rows are two lines tall
                holds half as many projects, and the full name is on the page
                this links to. `title` is for the sighted, truncated case
                specifically — a screen reader already gets the whole name,
                since truncation is CSS-only and the accessible name is the
                untouched `project.name`. */}
            <span className="truncate" title={project.name}>
              {project.name}
            </span>
            {/* The badge is the FIXED element and the name is the flexible
                one. Without `shrink-0 whitespace-nowrap` the badge is just
                another shrinkable flex item, so a long label — `no verdict
                yet` and `ingest failed` are the only two that reach this —
                breaks across two lines and its row grows 20px taller than
                its neighbours (measured: 62px against 42px). That is the
                two-line row the comment above says the rail cannot afford,
                arriving through the badge instead of through the name.

                Wrapped here rather than fixed in `Badge` itself, for the
                same reason `RAIL_INGEST_FAILED` is rail-local: `Badge` is
                shared with the run list and the run header, where it sits
                in a table cell with room to spare and nothing to fix. */}
            <span className="shrink-0 whitespace-nowrap">{badgeFor(project.latestRun)}</span>
          </NavLink>
        ))}

        {/* INSIDE <nav>, not outside it. <nav> is flow content and may hold
            a <p> — nothing in HTML or ARIA restricts it to links. Outside,
            a screen-reader user who landed on the *Projects* landmark heard
            "All runs" and nothing else, and a keyboard user tabbing forward
            went straight to Sign out without ever meeting the message.
            The wrapper is rendered unconditionally and carries the
            `aria-live` region, so it is registered before its content ever
            changes — a transition into or out of an error, or from "out of
            date" back to normal, gets announced, not just whatever state
            happened to be present at first paint. */}
        <div aria-live="polite" className="shrink-0">
          {message != null && <p className="px-3 py-2 text-sm text-muted">{message}</p>}
        </div>
      </nav>
    </div>
  );
}

/**
 * A rail-local override of `STATUS.failed`, for this component only.
 *
 * `STATUS.failed` and `VERDICT.failed` (`routes/marks.tsx`) are identical in
 * glyph, label and colour — deliberately: `RunList` and `RunHeader` render
 * status and verdict in separate columns/chips, so the column header (or
 * `NamedBadge`'s accessible name) disambiguates "could not be ingested" from
 * "ingested and failed its SLA" wherever those live. The rail renders ONE
 * badge with no column header, so nothing here disambiguates them — exactly
 * the conflation `marks.tsx`'s own docstring calls the worst class of UI bug,
 * because nothing looks broken. This reintroduces that conflation on the one
 * surface now visible from every page, unless the rail says something
 * different for the two cases.
 *
 * Do not "fix" this by editing `STATUS.failed` in `marks.tsx`: that label is
 * correct for the two-column contexts that use it, and changing it there
 * would relabel the run list and the run header too. This is a rail-local
 * rendering of the SAME underlying fact (`status: 'failed'` — the bundle
 * never parsed), not a change to the shared vocabulary.
 *
 * `pending` and `parsing` need no such override: neither's word or glyph
 * collides with anything `VERDICT` renders, so their shared marks already
 * read unambiguously here.
 */
const RAIL_INGEST_FAILED: Mark = {
  glyph: STATUS.failed.glyph,
  label: 'ingest failed',
  colour: STATUS.failed.colour,
};

/**
 * Status first, verdict second — and the contract carries both fields
 * precisely so this decision can be made here.
 *
 * A pending run has `verdict: null`, so reading `VERDICT[verdict ?? 'none']`
 * unconditionally would render "no verdict yet" for a run nobody has measured
 * — the same overclaim the D-14 sentence fix corrected on the run page.
 *
 * A project with no runs gets NO badge rather than a neutral one: absence is
 * the honest rendering of "nothing has been ingested here".
 *
 * `status === 'failed'` renders `RAIL_INGEST_FAILED`, not `STATUS.failed`
 * itself — see that constant's docstring for why the rail cannot reuse the
 * shared mark here, the way it safely does for `pending`/`parsing`/`complete`.
 */
function badgeFor(latestRun: ProjectItem['latestRun']) {
  if (latestRun === null) return null;
  if (latestRun.status !== 'complete') {
    const mark = latestRun.status === 'failed' ? RAIL_INGEST_FAILED : STATUS[latestRun.status];
    return <Badge mark={mark} />;
  }
  return <Badge mark={VERDICT[latestRun.verdict ?? 'none']} />;
}
