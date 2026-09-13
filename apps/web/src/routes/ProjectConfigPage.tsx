import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { linkButtonClasses } from '../components/Button';
import { ErrorState, LoadingState } from '../components/States';
import { ChevronLeftIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import useDocumentTitle from '../useDocumentTitle';
import { projectAccessPath, projectPath, projectRulesPath, projectSetupPath } from './paths';

/**
 * The shell every project CONFIGURATION page shares — review M15.
 *
 * ═══ WHY THREE PAGES WHERE THERE WAS ONE ═══
 *
 * `ProjectSetup` did four unrelated jobs at once: mint a token, revoke a
 * token, learn how to get a completed report in, and author SLA rules. The
 * review's objection is not that the page was long — it is that the only
 * route to IMPORTING RESULTS was a shell snippet sitting inside token
 * management, so the one thing a new user most needs was reachable only by
 * wandering into a credentials screen and reading past it.
 *
 * They are separate destinations now, and the nav below is what makes the
 * separation legible rather than merely true: a reader on any one of them can
 * see the other two exist. Splitting without a switcher would have replaced
 * one crowded page with three pages nobody could find.
 *
 * ═══ THE SPLIT IS BY THE READER'S JOB, NOT BY DATA SOURCE ═══
 *
 *   Add results   — how a run gets into this project at all. Three explicit
 *                   entry choices, each with a guide and a status.
 *   SLA rules     — what judges a run once it is here.
 *   API tokens    — the credentials the first of those needs.
 *
 * `Add results` needs a token, and that is a dependency rather than a reason
 * to merge them: it names the prerequisite and links to it, which is what the
 * old page failed to do in the other direction.
 *
 * ═══ THE URL OF THE FIRST ONE DID NOT CHANGE ═══
 *
 * It is still `/projects/:slug/setup`, and `projectSetupPath` still spells it.
 * The page's JOB changed; renaming the segment to match would break every
 * bookmark and every link anybody has shared for the sake of a word only this
 * file says out loud. `paths.ts` already argues at length that a URL people
 * hold is worth more than a tidy one.
 */
export type ProjectConfigTab = 'setup' | 'rules' | 'access';

const TABS: readonly { tab: ProjectConfigTab; label: string; path: (slug: string) => string }[] = [
  { tab: 'setup', label: 'Add results', path: projectSetupPath },
  { tab: 'rules', label: 'SLA rules', path: projectRulesPath },
  /* "API tokens", matching the page's own heading (review 09-13 M18). A tab
     and the page it opens must not disagree about what the page is — and
     "Access" promised members and roles that do not exist here. */
  { tab: 'access', label: 'API tokens', path: projectAccessPath },
];

/**
 * Resolves the project, then draws the breadcrumb, the heading and the nav.
 *
 * `children` is a FUNCTION of the resolved project, for the reason
 * `DesktopOnly` takes one: the pages below all need the project's name and its
 * slug, and a node built before the lookup resolved would have to be built
 * from values that are not there yet.
 */
export default function ProjectConfigPage({
  current,
  heading,
  intro,
  children,
}: {
  readonly current: ProjectConfigTab;
  readonly heading: string;
  /** One sentence under the heading saying what this page is for. */
  readonly intro?: string;
  readonly children: (project: { slug: string; name: string }) => ReactNode;
}) {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  useDocumentTitle(project?.name ? `${heading} · ${project.name}` : heading);

  if (projects.isPending) return <LoadingState label="Loading project…" />;

  if (projects.isError) {
    const error = projects.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        titleAs="h1"
        title="The project could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }

  if (project === null) {
    return (
      <ErrorState
        titleAs="h1"
        title="Project not found"
        detail={`No project "${slug}" is visible to this session.`}
        action={
          <Link to={projectPath(slug)} className={linkButtonClasses}>
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            Back to project
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          to={projectPath(slug)}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-primary"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
        {intro !== undefined && <p className="text-[13px] text-muted">{intro}</p>}
      </div>

      {/* ═══ A `<nav>` WITH ITS OWN NAME, BECAUSE IT IS NOT THE ONLY ONE ═══
       *
       * `ProjectRail` is on every authenticated page and `RunTabs` is on every
       * run page, so an unnamed landmark here would be the third anonymous
       * "navigation" a screen-reader user has to tell apart by exploring it.
       * The name is the one thing that makes a landmark list useful.
       *
       * `aria-current="page"` rather than a class alone: the active tab is a
       * fact about the document, and styling it is how a SIGHTED reader learns
       * the same thing. */}
      <nav aria-label="Project configuration" className="flex flex-wrap gap-1 border-b border-divider">
        {TABS.map(({ tab, label, path }) => {
          const active = tab === current;
          return (
            <Link
              key={tab}
              to={path(slug)}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-ui ${
                active
                  ? 'border-accent text-primary'
                  : 'border-transparent text-muted hover:text-primary'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {children({ slug, name: project.name })}
    </div>
  );
}
