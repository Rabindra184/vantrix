import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import RunList from './RunList';

/**
 * One project's runs.
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

  return <RunList key={slug} projectSlug={slug} heading={project?.name ?? slug} />;
}
