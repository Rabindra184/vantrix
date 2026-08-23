import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { linkButtonClasses } from '../components/Button';
import { PlayIcon, SetupIcon, TestIcon } from '../components/icons';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import RunList from './RunList';
import { projectNewRunnerRunPath, projectPath, projectSetupPath } from './paths';

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
 * `key={slug}` IS THE POINT, not styling. `RunList` holds its cursor in
 * `useState`. Moving from `/runs` to `/projects/a` swaps one route element
 * for another and remounts — but `/projects/a` to `/projects/b` matches the
 * SAME route, so React reuses the component instance and the cursor
 * survives into a scope where it no longer resolves. `RunRepository.list`
 * answers an unresolvable cursor with an empty page, deliberately, so the
 * reader would get a blank list for no visible reason. A different project
 * is a different component.
 *
 * The name comes from `GET /v1/projects` rather than from the first run's
 * `project.name`, because a project with no runs has no first run and still
 * has a name. Until it resolves the heading is the slug, which is a real
 * name for the project rather than a placeholder.
 */
export default function ProjectRuns() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;

  return (
    <RunList
      key={slug}
      projectSlug={slug}
      heading={project?.name ?? slug}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {/* The way back UP the hierarchy, and the first control in the row
              for that reason: this page is a child of the project's test list
              now, and without it the only route back is the rail row that
              brought the reader here. */}
          <Link to={projectPath(slug)} className={linkButtonClasses}>
            <TestIcon className="h-3.5 w-3.5" />
            All tests
          </Link>
          <Link to={projectSetupPath(slug)} className={linkButtonClasses}>
            <SetupIcon className="h-3.5 w-3.5" />
            Setup
          </Link>
          <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
            <PlayIcon className="h-3.5 w-3.5" />
            New on-prem run
          </Link>
        </div>
      }
    />
  );
}
