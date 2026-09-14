import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TestSummary } from '@perfportal/contracts';
import Badge from '../components/Badge';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { fetchProjectTests, projectTestsQueryKey } from '../api/tests';
import ProjectShell from './ProjectShell';
import { STATUS, VERDICT } from './marks';
import { projectTestPath, runPath } from './paths';

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
 * The run list did not go away — it is the next tab along, and it is still the
 * ONLY view that can show a run belonging to no test (one still pending, or
 * one that failed before the worker could read its simulation class). See
 * `paths.ts` for why that page moved to a child segment rather than this one
 * moving off `/projects/:slug`.
 *
 * ═══ THE HEADING AND THE ACTIONS ARE THE SHELL'S NOW — review M10 ═══
 *
 * This page used to draw its own `<h1>` and its own row of three links
 * (Project runs, Add results, New on-prem run), while `/projects/:slug/runs`
 * drew a DIFFERENT row of three and the configuration pages drew a tab strip
 * naming none of them. `ProjectShell` owns all of it, so the project's name,
 * its five sections and the one launch action are identical on every project
 * page. The name still comes from `GET /v1/projects` rather than from the
 * first test's row, for the reason that file states: a project with no tests
 * still has a name.
 */
export default function ProjectTests() {
  return <ProjectShell current="tests">{({ slug }) => <Tests slug={slug} />}</ProjectShell>;
}

function Tests({ slug }: { readonly slug: string }) {
  const tests = useQuery({
    queryKey: projectTestsQueryKey(slug),
    queryFn: () => fetchProjectTests(slug),
  });

  if (tests.isPending) {
    return (
      <LoadingState label="Loading tests…">
        <SkeletonTable columns={4} rows={4} />
      </LoadingState>
    );
  }

  if (tests.isError) {
    const error = tests.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        title="The tests could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }

  const items = tests.data.tests;

  if (items.length === 0) {
    return (
      <EmptyState
        title="No tests yet"
        /* NO ACTION LINK. It used to offer "New on-prem run", which the shell
           now renders above this on every project page — and two links with
           one accessible name in one document is the collision CLAUDE.md
           records for "All runs" and "New project". Both routes in are on
           screen already; the sentence names them rather than re-drawing
           them. */
        body={
          'A test appears here the first time PerfPortal finishes parsing a run of it. Start one ' +
          'from New on-prem run above, or post a results bundle — Add results has the command.'
        }
      />
    );
  }

  const caption = (
    <>
      Every test in this project, newest first. A test is created the first time PerfPortal sees a
      run of it, named by whatever that run declared — or after its simulation class, if it declared
      nothing — until somebody renames it. “Runs” counts this test’s whole history, not a page of it.
      An em dash under “Simulation class” means the class is the same as the name.
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* A plain total, unlike the run list's — `GET /v1/projects/:slug/tests`
          is not paginated (`TestListResponseSchema` carries no cursor), so "4
          tests" here really is every test rather than the page-local number
          the run list is careful to qualify. */}
      <p className="text-[0.8125rem] text-muted">
        {items.length} {items.length === 1 ? 'test' : 'tests'}
      </p>
      <TableFrame
        caption={caption}
        summary="Every test in this project, with its latest run."
        label="Tests table"
      >
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
          <p className="mt-1 max-w-md text-[0.75rem] leading-snug text-muted">{test.description}</p>
        )}
      </td>
      {/* The class, not the name, and both are shown because they diverge the
          moment anybody renames a test — and the class is what a reader has to
          match against their own simulation source. `break-all` for the same
          reason `RunHeader`'s `<h1>` uses it: a fully-qualified class name is
          long by design and the END is the part that distinguishes two of
          them. */}
      {/* NOT PRINTED TWICE. A test nobody has renamed takes its class AS its
          name, so both columns carried the same forty-character string and the
          row spent a third of its width saying one thing. The cell still
          exists — the two diverge the moment anybody renames a test, and the
          class is what a reader matches against their own simulation source —
          but when they are identical it says SO rather than repeating it. */}
      <td className={`${TD} font-mono text-[0.75rem] break-all text-muted`}>
        {test.name === test.simulationClass ? (
          /* ═══ AN EM DASH, WITH THE CONVENTION IN THE CAPTION (review N04) ═══
           *
           * "same as the name" was accurate and spent a sentence saying it in
           * every untouched test's row. The dash is the table convention and
           * the caption defines it once — the pattern N02 uses one component
           * over for the percentile caveat.
           *
           * IT CANNOT BE MISREAD AS "ABSENT" HERE, which is the usual reason
           * not to reach for a dash: `TestSummary.simulationClass` is
           * `z.string()`, not nullable, so no row in this column is ever
           * empty and the dash has only one possible meaning.
           *
           * The accessible name still carries the fact, because a screen
           * reader announcing a bare dash would be worse than the sentence
           * this replaces. */
          <span data-testid="test-class-same" aria-label="Same as the name">
            —
          </span>
        ) : (
          test.simulationClass
        )}
      </td>
      <td className={`${TD} font-mono tabular-nums`}>{test.runCount}</td>
      <td className={TD}>
        {test.latestRun === null ? (
          // Reachable: `ON DELETE SET NULL` keeps a test alive when its runs
          // go, so `runCount: 0` with a named test is a real row rather than a
          // half-loaded one. Says so rather than rendering an empty cell,
          // which reads as a value that failed to arrive.
          <span className="text-[0.8125rem] text-muted">No runs</span>
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
