import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TestSummary } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { linkButtonClasses } from '../components/Button';
import { LayersIcon, PlayIcon, SetupIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import { fetchProjectTests, projectTestsQueryKey } from '../api/tests';
import { STATUS, VERDICT } from './marks';
import {
  projectNewRunnerRunPath,
  projectRunsPath,
  projectSetupPath,
  projectTestPath,
  runPath,
} from './paths';
import useDocumentTitle from '../useDocumentTitle';

/**
 * A project's TESTS — the page `/projects/:slug` renders, and the rung the
 * hierarchy was missing.
 *
 * ═══ WHY THIS REPLACED THE PROJECT RUN LIST ═══
 *
 * `Organization → Project → Test → Run`. This URL showed the run list for its
 * whole life, which flattened two of those rungs into one: every run of every
 * test, interleaved in start order, with the only clue to which was which
 * being a fully-qualified class name in the Simulation column. A reader asking
 * "how is the checkout test doing" had to do the grouping in their head.
 *
 * The run list did not go away — it is one click away at `projectRunsPath`,
 * and it is still the ONLY view that can show a run belonging to no test (one
 * still pending, or one that failed before the worker could read its
 * simulation class). See `paths.ts` for why that page moved to a child segment
 * rather than this one moving off `/projects/:slug`.
 *
 * THE NAME COMES FROM `GET /v1/projects`, not from the first test's own row,
 * for the same reason `ProjectRuns` documents: a project with no tests still
 * has a name. Until that query lands the heading is the slug, which is a real
 * name for the project rather than a placeholder.
 */
export default function ProjectTests() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  const heading = project?.name ?? slug;
  useDocumentTitle(heading);

  const tests = useQuery({
    queryKey: projectTestsQueryKey(slug),
    queryFn: () => fetchProjectTests(slug),
  });

  // ONE ACTION ROW, rendered above every branch below. A reader who arrives at
  // a project whose test list is still loading — or has just failed — still
  // needs Setup and the run list, and three copies of this JSX inside three
  // returns is three places for them to drift.
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {/* ═══ "Project runs", NOT "All runs" ═══
          `ProjectRail` renders an "All runs" row — the ORG-wide list — on
          every authenticated page, so a second link with that name puts two
          links with one accessible name into this document, pointing at two
          different lists. It shipped that way and `project-tests.spec.ts`
          caught it as a strict-mode violation resolving two elements; a
          screen-reader user would have heard the same name for both. The
          words also happen to be truer: this list is one project's runs. */}
      <Link to={projectRunsPath(slug)} className={linkButtonClasses}>
        <LayersIcon className="h-3.5 w-3.5" />
        Project runs
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
  );

  if (tests.isPending) {
    return (
      <Page heading={heading} actions={actions}>
        <LoadingState label="Loading tests…">
          <SkeletonTable columns={4} rows={4} />
        </LoadingState>
      </Page>
    );
  }

  if (tests.isError) {
    const error = tests.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <Page heading={heading} actions={actions}>
        <ErrorState
          title="The tests could not be loaded"
          detail={problem?.detail ?? error.message}
          remediation={problem?.remediation}
        />
      </Page>
    );
  }

  const items = tests.data.tests;

  const caption = (
    <>
      Every test in this project, newest first. A test is created the first time PerfPortal sees a
      run of it, named by whatever that run declared — or after its simulation class, if it declared
      nothing — until somebody renames it. “Runs” counts this test’s whole history, not a page of it.
    </>
  );

  return (
    <Page heading={heading} count={items.length} actions={actions}>
      {items.length === 0 ? (
        <EmptyState
          title="No tests yet"
          body={
            'A test appears here the first time PerfPortal finishes parsing a run of it. Upload a ' +
            'run bundle with an API token, or start an on-prem run, and this list fills itself.'
          }
          action={
            <Link to={projectNewRunnerRunPath(slug)} className={linkButtonClasses}>
              <PlayIcon className="h-3.5 w-3.5" />
              New on-prem run
            </Link>
          }
        />
      ) : (
        <TableFrame caption={caption} label="Tests table">
          <table className={TABLE}>
            <caption className="sr-only">{caption}</caption>
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>
                  Test
                </th>
                <th scope="col" className={TH}>
                  Simulation class
                </th>
                <th scope="col" className={TH}>
                  Runs
                </th>
                <th scope="col" className={TH}>
                  Latest run
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((test) => (
                <TestRow key={test.id} projectSlug={slug} test={test} />
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
    </Page>
  );
}

/**
 * The page's `<h1>` and its actions, shared by all four branches above.
 *
 * The count is a plain total, unlike the run list's — `GET /v1/projects/:slug/tests`
 * is not paginated (a project has a handful of tests, and
 * `TestListResponseSchema` carries no cursor), so "4 tests" here really is
 * every test rather than the page-local number the run list is careful to
 * qualify.
 */
function Page({
  heading,
  count,
  actions,
  children,
}: {
  readonly heading: string;
  readonly count?: number;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
          {count !== undefined && count > 0 && (
            <p className="text-[13px] text-muted">
              {count} {count === 1 ? 'test' : 'tests'}
            </p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function TestRow({
  projectSlug,
  test,
}: {
  readonly projectSlug: string;
  readonly test: TestSummary;
}) {
  return (
    <tr data-testid="test-row" data-test-slug={test.slug} className={ROW}>
      <td className={TD}>
        {/* The name is the link, the same way the run list makes the
            simulation the link: it is what the reader is looking for, and
            "View" repeated down a column names nothing. The accessible name
            carries the word "test" because the row's other link — the latest
            run — is a link to a RUN, and two bare links in one row would be
            told apart only by position. */}
        <Link
          to={projectTestPath(projectSlug, test.slug)}
          aria-label={`View test ${test.name}`}
          className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
        >
          {test.name}
        </Link>
        {test.description !== null && test.description !== '' && (
          <p className="mt-1 max-w-md text-[12px] leading-snug text-muted">{test.description}</p>
        )}
      </td>
      {/* The class, not the name, and both are shown because they diverge the
          moment anybody renames a test — and the class is what a reader has to
          match against their own simulation source. `break-all` for the same
          reason `RunHeader`'s `<h1>` uses it: a fully-qualified class name is
          long by design and the END is the part that distinguishes two of
          them. */}
      <td className={`${TD} font-mono text-[12px] break-all text-muted`}>{test.simulationClass}</td>
      <td className={`${TD} font-mono tabular-nums`}>{test.runCount}</td>
      <td className={TD}>
        {test.latestRun === null ? (
          // Reachable: `ON DELETE SET NULL` keeps a test alive when its runs
          // go, so `runCount: 0` with a named test is a real row rather than a
          // half-loaded one. Says so rather than rendering an empty cell,
          // which reads as a value that failed to arrive.
          <span className="text-[13px] text-muted">No runs</span>
        ) : (
          <Link
            to={runPath(test.latestRun.id)}
            aria-label={`View the latest run of ${test.name}`}
            className="transition-ui inline-flex flex-wrap items-center gap-1.5 hover:underline hover:underline-offset-2"
          >
            <Badge mark={STATUS[test.latestRun.status]} size="compact" />
            <Badge mark={VERDICT[test.latestRun.verdict ?? 'none']} size="compact" />
          </Link>
        )}
      </td>
    </tr>
  );
}
