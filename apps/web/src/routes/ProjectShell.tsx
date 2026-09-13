import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { linkButtonClasses } from '../components/Button';
import { ErrorState } from '../components/States';
import { ChevronLeftIcon, PlayIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import useDocumentTitle from '../useDocumentTitle';
import {
  DEFAULT_ROUTE,
  projectAccessPath,
  projectNewRunnerRunPath,
  projectPath,
  projectRulesPath,
  projectRunsPath,
  projectSetupPath,
} from './paths';

/**
 * The chrome EVERY project page shares — review M10.
 *
 * ═══ WHAT THIS REPLACES, AND WHY THREE TABS WERE NOT ENOUGH ═══
 *
 * `ProjectConfigPage` put a three-tab strip — Add results, SLA rules, API
 * tokens — on the three CONFIGURATION pages, and nothing at all on the two
 * pages a reader actually spends time on. So a project had two disjoint
 * navigation systems:
 *
 *   `/projects/:slug`        an action row: Project runs, Add results, New on-prem run
 *   `/projects/:slug/runs`   a DIFFERENT action row: All tests, Add results, New on-prem run
 *   `/projects/:slug/setup`  a tab strip: Add results, SLA rules, API tokens
 *   `/projects/:slug/rules`  the same tab strip
 *   `/projects/:slug/access` the same tab strip
 *
 * Rules and API tokens were therefore reachable ONLY by first landing on Add
 * results, because neither of the two pages with a reader on them mentioned
 * they existed. And the two action rows disagreed about how to get back up —
 * one said "Project runs", the other "All tests" — so the same relationship
 * was spelled two ways depending on which end you were standing at.
 *
 * One strip, five sections, on all five pages. The reader can see the whole
 * project from anywhere in it, and "where am I" is answered by
 * `aria-current="page"` rather than by which set of buttons happens to be on
 * screen.
 *
 * ═══ LAUNCH IS AN ACTION, NOT A SIXTH TAB ═══
 *
 * M10 asks for that explicitly, and it is right: the other five are PLACES —
 * each is a URL you can sit on, bookmark and come back to — while "New
 * on-prem run" is a thing you DO, which happens to have a form behind it.
 * Mixing the two in one strip is what makes a nav stop reading as a map. It
 * sits beside the heading instead, where it is on every project page for the
 * first time (it used to be on three of the five).
 *
 * ═══ THE `<h1>` IS THE PROJECT, AND THE SECTION IS NOT A HEADING AT ALL ═══
 *
 * This is the shape `RunShell` already uses one rung down: `RunHeader` owns
 * the single `<h1>` (the simulation), `RunTabs` names the section, and no tab
 * repeats its own name as a heading — the Overview tab's outline is
 * `Assertions / Simulation assertions / Statistics`, not `Overview` followed
 * by them.
 *
 * The three configuration pages used to take the section name AS their `<h1>`
 * ("Add results", "SLA rules", "API tokens") with the project demoted to a
 * breadcrumb above it. That reads correctly on one page and stops being true
 * the moment there are five: the thing the reader is looking at is the
 * PROJECT, and which of its five faces is showing is what the strip is for.
 * So each section's own content keeps its `<h2>`s and contributes no heading
 * naming itself — which also means no section's heading levels had to move.
 */
export type ProjectSection = 'tests' | 'runs' | 'setup' | 'rules' | 'access';

const SECTIONS: readonly {
  section: ProjectSection;
  label: string;
  path: (slug: string) => string;
}[] = [
  /* Tests first because `/projects/:slug` is the project's own page and a
     project's tests are the rung directly below it — `Organization → Project
     → Test → Run`. Runs second because it is the same data one rung flatter.
     Then the three configuration sections, in the order a project is set up:
     get results in, decide what judges them, and the credential the first of
     those needs. */
  { section: 'tests', label: 'Tests', path: projectPath },
  { section: 'runs', label: 'Runs', path: projectRunsPath },
  { section: 'setup', label: 'Add results', path: projectSetupPath },
  { section: 'rules', label: 'SLA rules', path: projectRulesPath },
  /* "API tokens", matching the page's own content (review 09-13 M18). A tab
     and the page it opens must not disagree about what the page is — and
     "Access" promised members and roles that do not exist here. */
  { section: 'access', label: 'API tokens', path: projectAccessPath },
];

/**
 * Draws the heading, the launch action and the nav, and hands the section its
 * project.
 *
 * `children` is a FUNCTION rather than a node, for the reason `DesktopOnly`
 * takes one: the sections below all need the project's name and its slug, and
 * every caller would otherwise have to resolve the project a second time to
 * build the node it passes in.
 */
export default function ProjectShell({
  current,
  intro,
  children,
}: {
  readonly current: ProjectSection;
  /** One sentence under the nav saying what THIS section is for. */
  readonly intro?: string;
  readonly children: (project: { slug: string; name: string }) => ReactNode;
}) {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  const label = SECTIONS.find((s) => s.section === current)?.label ?? '';

  /* ═══ THE SLUG IS A REAL NAME, SO NOTHING WAITS FOR THE LOOKUP ═══
   *
   * Every part of this shell — the five destinations, the launch action, the
   * heading — is derivable from the slug alone; only the DISPLAY NAME needs
   * `GET /v1/projects`. `ProjectConfigPage` blocked the whole page on that
   * query anyway, which was tolerable on three configuration screens and is
   * not on `/projects/:slug`: the project's own page would sit as a spinner
   * while its content was ready to draw. `ProjectTests` documented the
   * opposite behaviour for exactly this reason, and keeps it — until the name
   * resolves the heading is the slug, which is a real name for the project
   * rather than a placeholder. */
  const name = project?.name ?? slug;

  /* The project's own page titles as the PROJECT and nothing else: it is what
     a bookmark reading "Checkout" means, and `/projects/:slug` is the URL
     somebody shares when they mean the project rather than a view of it. The
     other four qualify, so four open tabs are told apart in the tab strip —
     which is the whole job `useDocumentTitle` exists to do.

     `null` WHILE THE LOOKUP IS IN FLIGHT rather than the slug: that is the
     hook's documented "not yet known", and it leaves the previous page's
     title in place for the moment it takes to resolve instead of flashing a
     slug between two named pages.

     ONE CALL FOR THE WHOLE PAGE, which is why `ProjectRuns` passes
     `titlesDocument={false}` to `RunList`: two components writing
     `document.title` works only by the accident of effect ordering. */
  useDocumentTitle(
    projects.isPending
      ? null
      : project === null
        ? 'Project not found'
        : current === 'tests'
          ? project.name
          : `${label} · ${project.name}`,
  );

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

  /* Only once the query has SUCCEEDED does a missing project mean anything.
     While it is pending `project` is null for a project that exists, so
     branching on it alone would render "not found" over every cold load. */
  if (!projects.isPending && project === null) {
    return (
      <ErrorState
        titleAs="h1"
        title="Project not found"
        detail={`No project "${slug}" is visible to this session.`}
        /* NOT "Back to project": every one of these five URLs carries the slug
           that just failed to resolve, so an offer to go back to the project
           is an offer to reload the same error. The org's run list is the
           nearest place that exists.

           NOT "All runs" either, however natural those words are here:
           `ProjectRail` renders a row with exactly that name on every
           authenticated page, and a second link sharing it would put two
           links with one accessible name in the document — the collision
           `project-tests.spec.ts` already caught once for "All runs" and
           `run-list.spec.ts` for "New project". */
        action={
          <Link to={DEFAULT_ROUTE} className={linkButtonClasses}>
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            Back to the run list
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-xl font-semibold tracking-tight">{name}</h1>
        <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
          <PlayIcon className="h-3.5 w-3.5" />
          New on-prem run
        </Link>
      </div>

      {/* ═══ A `<nav>` WITH ITS OWN NAME, BECAUSE IT IS NOT THE ONLY ONE ═══
       *
       * `ProjectRail` is on every authenticated page and `RunTabs` is on every
       * run page, so an unnamed landmark here would be the third anonymous
       * "navigation" a screen-reader user has to tell apart by exploring it.
       * The name is the one thing that makes a landmark list useful.
       *
       * `aria-current="page"` rather than a class alone: the active section is
       * a fact about the document, and styling it is how a SIGHTED reader
       * learns the same thing.
       *
       * PLAIN `<Link>` AND AN EXPLICIT `current`, not `NavLink`: `end` would
       * have to be set on Tests alone (every other path starts with it) and
       * `/projects/:slug/tests/:testSlug` — a TEST's page — would then light
       * up no tab at all rather than the project's. The section a page belongs
       * to is the page's own claim to make.
       *
       * `overflow-x-auto` for the reason `RunTabs` has it: five labels plus
       * their padding do not fit 375px, and a strip that wraps to two lines
       * stops reading as one control. */}
      <nav
        aria-label="Project sections"
        className="-mb-px flex gap-1 overflow-x-auto border-b border-divider"
      >
        {SECTIONS.map(({ section, label: tabLabel, path }) => {
          const active = section === current;
          return (
            <Link
              key={section}
              to={path(slug)}
              aria-current={active ? 'page' : undefined}
              className={`transition-ui shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium ${
                active
                  ? 'border-accent text-primary'
                  : 'border-transparent text-muted hover:text-primary'
              }`}
            >
              {tabLabel}
            </Link>
          );
        })}
      </nav>

      {intro !== undefined && <p className="-mt-3 text-[13px] text-muted">{intro}</p>}

      {children({ slug, name })}
    </div>
  );
}
