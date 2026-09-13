import ProjectShell from './ProjectShell';
import RunList from './RunList';

/**
 * One project's runs, across all of its tests — `/projects/:slug/runs`.
 *
 * IT MOVED HERE FROM `/projects/:slug`, which now lists the project's TESTS
 * (`ProjectTests`). See `paths.ts` for why the run list moved rather than the
 * test list taking a child segment. This page is still worth having and is not
 * merely the old one kept for compatibility: it is the ONLY view that shows a
 * run belonging to no test — one still pending, or one that failed before the
 * worker could read its simulation class — because such a run appears on no
 * test's page by definition.
 *
 * ═══ THE HEADING, THE NAV AND THE ACTIONS ARE THE SHELL'S — review M10 ═══
 *
 * This page used to draw its own row of three links: All tests, Add results,
 * New on-prem run. `ProjectTests` drew a different three (Project runs, Add
 * results, New on-prem run) for the same relationship, so the way back up the
 * hierarchy had two different names depending on which end you stood at, and
 * neither page mentioned that SLA rules or API tokens existed. `ProjectShell`
 * owns all of it now.
 *
 * `key={slug}` IS THE POINT, not styling. `RunList` holds its cursor in
 * `useState`. Moving from `/runs` to `/projects/a/runs` swaps one route
 * element for another and remounts — but `/projects/a/runs` to
 * `/projects/b/runs` matches the SAME route, so React reuses the component
 * instance and the cursor survives into a scope where it no longer resolves.
 * `RunRepository.list` answers an unresolvable cursor with an empty page,
 * deliberately, so the reader would get a blank list for no visible reason. A
 * different project is a different component.
 */
export default function ProjectRuns() {
  return (
    <ProjectShell current="runs">
      {({ slug, name }) => (
        <RunList
          key={`runs:${slug}`}
          projectSlug={slug}
          /* STILL REQUIRED with the `<h1>` suppressed: it names the table's
             scroll region, which is a description of the list rather than a
             heading for the page. See `RunList`'s own note. */
          heading={name}
          showHeading={false}
          /* The shell has already titled the document `Runs · <project>`, and
             two components writing `document.title` agree only by the accident
             of effect ordering — the trap `TestRuns` avoids from the other
             direction by not calling it at all. */
          titlesDocument={false}
        />
      )}
    </ProjectShell>
  );
}
