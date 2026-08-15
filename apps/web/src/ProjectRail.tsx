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
          className="shrink-0 rounded px-3 py-2 text-sm aria-[current=page]:bg-sunken"
        >
          All runs
        </NavLink>

        {items.map((project) => (
          <NavLink
            key={project.id}
            to={projectPath(project.slug)}
            className="flex shrink-0 items-center justify-between gap-2 rounded px-3 py-2 text-sm aria-[current=page]:bg-sunken"
          >
            {/* Truncated, not wrapped: a rail whose rows are two lines tall
                holds half as many projects, and the full name is on the page
                this links to. */}
            <span className="truncate">{project.name}</span>
            {badgeFor(project.latestRun)}
          </NavLink>
        ))}
      </nav>

      {/* Outside the <nav>, which contains only links. Both messages sit
          where the list would be. */}
      {projects.isError && (
        <p className="px-5 pb-3 text-sm text-muted">Projects could not be loaded.</p>
      )}
      {projects.isSuccess && items.length === 0 && (
        <p className="px-5 pb-3 text-sm text-muted">No projects yet.</p>
      )}
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
