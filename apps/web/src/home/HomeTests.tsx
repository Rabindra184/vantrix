import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { attentionReasons, needsAttention, type OrgTestSummary } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import { fetchOrgTests, orgTestsPageQueryKey } from '../api/tests';
import Button from '../components/Button';
import CopyIdButton from '../components/CopyIdButton';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/icons';
import SectionHeading from '../components/SectionHeading';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { useDebouncedValue } from '../palette/useDebouncedValue';
import { projectTestPath } from '../routes/paths';
import useIsCompact from '../useIsCompact';
import LastRunCell from './LastRunCell';
import Sparkline from './Sparkline';

/**
 * ═══ EVERY TEST IN THE ORGANISATION, A PAGE AT A TIME (home page) ═══
 *
 * The lower half of the portfolio home: `GET /v1/tests`, 25 to a page, with a
 * box that narrows it. Each row is a test, its project, how its latest run
 * went, and a sparkline of its last ten p95s. The attention card above is the
 * question "which of my tests should I look at"; this is the answer to "what
 * tests do I have", and the two read different windows of the same data.
 *
 * ═══ ONE FILTER, TWO PLACES, AND ONLY ONE OF THEM IS A DECISION ═══
 *
 * The box holds what has been TYPED; `q` is what has been settled on — the
 * typed text, trimmed, once it has stopped changing for a quarter of a second.
 * Only `q` goes anywhere: it is written to the address as `?q=` (replacing the
 * history entry, so Back leaves the page instead of walking back through every
 * word, and removed when blank, so an unfiltered page has a clean URL), it is
 * what is asked of the server, and it is what a cursor belongs to. A request
 * per keystroke would ask for `c`, `ch` and `che` when only the last was ever
 * wanted, and the slowest answer is free to land last.
 *
 * The URL FOLLOWS the settled filter and never the other way round, after
 * the first render. That is deliberate and it has one visible consequence: a
 * same-route navigation that drops `?q=` (the rail's own link to this page,
 * while a filter is applied) does not clear the filter — the effect below puts
 * the address back, so what the reader sees and what the address says never
 * disagree. Opening the page on `?q=chec` filters it from the first request.
 *
 * ═══ A CURSOR BELONGS TO THE FILTER IT CAME FROM ═══
 *
 * A keyset cursor is a position in one particular list. Carry page two's
 * cursor across a filter change and the server is asked to continue a walk
 * through a list that no longer exists: the answer is a page of the new filter
 * that starts somewhere in the middle, or an empty one, with nothing on screen
 * saying why.
 *
 * So the cursors are a STACK in component state — not in the URL, for the
 * reason `RunList` records: a cursor is a row's position, so a bookmarked
 * `?cursor=` would mean something different the moment that row moved — and the
 * stack is tagged with the `q` it was built for. Next pushes the cursor the
 * server sent; Previous pops. The page being read is the top of the stack, and
 * the empty stack is the first page, which needs no cursor at all.
 *
 * The reset is done DURING RENDER, not in an effect. An effect would run after
 * the render in which `q` changed, and that render would already have asked
 * for the new filter with the old cursor — the exact request this exists to
 * prevent. Setting state while rendering is React's own pattern for state that
 * belongs to a value (`useLiveRun` does the same for a run id), and the stale
 * stack is discarded before anything reads it. Tagging rather than only
 * clearing is what stops `A → B → A` resuming A's old page: the stack is
 * emptied the moment `q` leaves A, so there is nothing left to revive.
 *
 * ═══ THE LIST STAYS ON SCREEN WHILE THE NEXT ANSWER LOADS ═══
 *
 * `keepPreviousData`, as the run list does: clicking Next or typing a word
 * does not blank the table to a skeleton and back. Two things follow, both
 * handled. Next is switched off while a page is in flight, or a second click
 * would advance from a cursor belonging to a page the reader is no longer
 * looking at. And an EMPTY previous answer is never kept on screen: it would
 * be captioned with the NEW filter's name ("No tests match “zz”" over the
 * answer for `zzz`), which is a claim about a list nobody has asked about yet.
 * That one falls back to the loading state instead.
 *
 * ═══ A PROJECT NAME IS TEXT HERE, NEVER A LINK ═══
 *
 * The rail names every project, and a second link with the same name and a
 * different destination is the collision CLAUDE.md records twice. The test is
 * what the row links to; its project is context.
 */

export const HOME_TESTS_LIMIT = 25;
export const HOME_FILTER_DEBOUNCE_MS = 250;

const LINK =
  'transition-ui w-fit max-w-full font-medium text-accent wrap-anywhere hover:underline hover:underline-offset-2';

export default function HomeTests() {
  const compact = useIsCompact();
  const [params, setParams] = useSearchParams();
  const urlQ = (params.get('q') ?? '').trim();
  const [text, setText] = useState(urlQ);
  const [q] = useDebouncedValue(text.trim(), HOME_FILTER_DEBOUNCE_MS);

  // The address follows the settled filter. `urlQ` is a dependency so that an
  // address that drifts from it is put back; when they already agree this
  // returns before touching the router, which is also what keeps the first
  // render from writing a navigation for a URL that was already right.
  useEffect(() => {
    if (q === urlQ) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q === '') next.delete('q');
        else next.set('q', q);
        return next;
      },
      { replace: true },
    );
  }, [q, urlQ, setParams]);

  const [paging, setPaging] = useState<{ readonly q: string; readonly cursors: readonly string[] }>({
    q,
    cursors: [],
  });
  let cursors = paging.cursors;
  if (paging.q !== q) {
    cursors = [];
    setPaging({ q, cursors });
  }
  const cursor = cursors.at(-1) ?? null;

  const tests = useQuery({
    queryKey: orgTestsPageQueryKey(q, HOME_TESTS_LIMIT, cursor),
    queryFn: () => fetchOrgTests({ q, limit: HOME_TESTS_LIMIT, cursor }),
    placeholderData: keepPreviousData,
  });

  let body: ReactNode;
  if (tests.isPending || (tests.isPlaceholderData && tests.data.items.length === 0)) {
    body = (
      <LoadingState label="Loading tests…">
        {/* The placeholder has the table's four columns, so nothing moves when
            the rows arrive (the 09-13 review's slow-loading item). */}
        <SkeletonTable columns={4} rows={6} />
      </LoadingState>
    );
  } else if (tests.isError) {
    // Inside THIS section: a failed list never blanks the attention card, nor
    // the reverse. The heading and the filter stay, so the reader can retry by
    // changing what they asked for.
    const problem = tests.error instanceof ProblemError ? tests.error : null;
    body = (
      <ErrorState
        title="The tests could not be loaded"
        detail={problem?.detail ?? tests.error.message}
        remediation={problem?.remediation}
      />
    );
  } else if (tests.data.items.length === 0) {
    body = <EmptyState title={q === '' ? 'No tests yet' : `No tests match “${q}”`} />;
  } else {
    body = compact ? (
      <TestCards items={tests.data.items} />
    ) : (
      <TestTable items={tests.data.items} />
    );
  }

  // The pager exists only when there is a page to turn. With no rows there is
  // nothing to page through, and Previous/Next under "No tests yet" would be
  // controls for a list the reader has not got.
  const page = tests.isSuccess && tests.data.items.length > 0 ? tests.data : null;

  return (
    <section aria-labelledby="home-tests-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading id="home-tests-heading">Tests</SectionHeading>
        <label className="w-full sm:w-64">
          <span className="sr-only">Filter tests</span>
          <input
            type="search"
            className={INPUT}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder="Filter tests"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {body}

      {page !== null && (
        <nav aria-label="Test pages" className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={cursors.length === 0}
            onClick={() => setPaging({ q, cursors: cursors.slice(0, -1) })}
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            Previous
          </Button>
          <Button
            size="sm"
            // `isPlaceholderData` is true while the NEXT page is in flight:
            // without it a second click would advance from a cursor belonging
            // to a page the reader is no longer looking at.
            disabled={page.nextCursor === null}
            loading={tests.isPlaceholderData}
            onClick={() => {
              if (page.nextCursor !== null) setPaging({ q, cursors: [...cursors, page.nextCursor] });
            }}
          >
            Next
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </Button>
        </nav>
      )}
    </section>
  );
}

/**
 * A test's name and where it leads, with its slug and a copy button beneath.
 *
 * The slug is what an upload's or a runner job's `test` field takes, and until
 * the catalogue showed it the only way to learn it was to read the address
 * bar. `size` is the button's: 24 px in a table cell, fingertip-sized on a card.
 */
function TestName({ test, size }: { readonly test: OrgTestSummary; readonly size: 'row' | 'touch' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Link to={projectTestPath(test.project.slug, test.slug)} className={LINK}>
        {test.name}
      </Link>
      <p className="text-[0.75rem] text-muted">
        <span className="sr-only">Slug: </span>
        <code data-testid="home-test-slug" className="break-all">
          {test.slug}
        </code>
        <CopyIdButton value={test.slug} label={`Copy test slug ${test.slug}`} size={size} />
      </p>
    </div>
  );
}

/** The latest run, tinted by how it went; or, for a test that has none, the plain fact. */
function LastRun({ test }: { readonly test: OrgTestSummary }) {
  const run = test.latestRun;
  if (run === null) return <span className="text-[0.8125rem] text-muted">Never run</span>;
  return <LastRunCell run={run} reasons={attentionReasons(run)} />;
}

/**
 * The p95 history, with its last point coloured as failed when — and only when
 * — the run that needs attention IS that point.
 *
 * Both halves are needed. A test whose latest run failed to ingest has no p95
 * for it, so the history's last point is an older run that was perfectly fine;
 * colouring it would tell a reader the healthy run they are looking at failed.
 * `p95History` holds completed runs with a p95 and `latestRun` is by arrival,
 * so they are the same run only when the newest arrival is itself one of those.
 */
function Trend({ test }: { readonly test: OrgTestSummary }) {
  const history = test.p95History;
  const last = history.at(-1);
  const latest = test.latestRun;
  const lastNeedsAttention =
    latest !== null && last !== undefined && last.runId === latest.id && needsAttention(latest);
  return <Sparkline points={history} lastNeedsAttention={lastNeedsAttention} />;
}

/**
 * The table, named "Tests" — the section's own word — and not "Needs
 * attention", which is the attention card's table. Cells wrap anywhere: a test
 * is named by whoever wrote it, and an unbroken name would otherwise take the
 * page's width with it.
 */
function TestTable({ items }: { readonly items: readonly OrgTestSummary[] }) {
  return (
    <TableFrame name="Tests" label="Tests table">
      <table className={TABLE}>
        <caption className="sr-only">Tests</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Name
            </th>
            <th scope="col" className={TH}>
              Project
            </th>
            <th scope="col" className={TH}>
              Last run
            </th>
            <th scope="col" className={TH}>
              p95 · last 10
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((test) => (
            <tr key={test.id} data-testid="home-test-row" className={ROW}>
              <td className={`${TD} align-top`}>
                <TestName test={test} size="row" />
              </td>
              <td data-testid="home-test-project" className={`${TD} align-top wrap-anywhere`}>
                {test.project.name}
              </td>
              <td className={`${TD} align-top`}>
                <LastRun test={test} />
              </td>
              <td className={`${TD} align-top`}>
                <Trend test={test} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

/**
 * The same rows as cards, below 768px: a list claims to be what it is, and
 * every field the table row had is here. The p95 column's header is gone with
 * the table, so the sparkline is named in words instead.
 */
function TestCards({ items }: { readonly items: readonly OrgTestSummary[] }) {
  return (
    <ul aria-label="Tests" data-testid="home-tests-cards" className="flex flex-col gap-2">
      {items.map((test) => (
        <li
          key={test.id}
          data-testid="home-test-row"
          className="flex flex-col gap-3 rounded-lg border border-default p-3"
        >
          <div className="min-w-0">
            <TestName test={test} size="touch" />
            <p data-testid="home-test-project" className="text-[0.75rem] text-muted wrap-anywhere">
              {test.project.name}
            </p>
          </div>
          <LastRun test={test} />
          <div className="flex flex-col gap-1">
            <p className="text-[0.75rem] text-muted">p95 · last 10</p>
            <Trend test={test} />
          </div>
        </li>
      ))}
    </ul>
  );
}
