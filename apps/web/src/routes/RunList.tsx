import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import Button from '../components/Button';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { fetchRuns, runsQueryKey } from '../api/runs';
// Status and verdict share one vocabulary with the run detail page — the
// same Mark data, from the same STATUS/VERDICT tables in ./marks — so a
// status that changes a word or a glyph updates both screens from one edit
// rather than two that can drift. The two screens render that shared Mark
// differently on purpose: this page as a Badge pill, the run detail page as
// Marked's plain inline text. Same for the start-time formatter: the two
// screens must agree about when a run started, and one definition is the
// only way that is guaranteed.
import { formatStarted } from './format';
import { STATUS, VERDICT } from './marks';
import { runPath } from './paths';
import useDocumentTitle from '../useDocumentTitle';

type RunListItem = RunListResponse['items'][number];

/**
 * The org's runs — the first screen that shows a user their own data.
 *
 * A real `<table>` with real `<th scope="col">` headers, not a div grid: this
 * is tabular data, the header/cell relationship is what makes a row
 * comprehensible to a screen reader announcing its fifth column, and the e2e
 * suite selects by ARIA role precisely so that markup cannot silently
 * regress to `<div>`s.
 *
 * Every row carries `data-testid="run-row"` and `data-run-id` — a contract
 * declared ahead of this file in `apps/web/e2e/helpers.ts` (`firstRowId`) and
 * relied on by Task 7, so it is deliberately independent of visible text and
 * column order.
 *
 * THE TABLE IS IN A `Card` WITH `padding="none"`, and the `<caption>` sits
 * ABOVE it rather than inside. Two reasons, and the second is the real one: a
 * caption inside a `padding="none"` card has no gutter, so it reads as a
 * sentence jammed against the header fill; and this caption is a paragraph of
 * explanation about what "Started" means, which the reader needs BEFORE
 * meeting the column, not as part of the table's own frame. It keeps
 * `<caption>` semantics — it is still the table's programmatic description —
 * by staying the table's first child with `caption-side: top` stated
 * explicitly (`CAPTION`), because the default side varies by engine.
 *
 * NO CLIENT-SIDE FILTER BOX, deliberately. The obvious addition to a run list
 * is a search field, and it would be wrong here: the list is KEYSET-PAGINATED
 * six rows at a time, so a filter could only narrow the page in hand and would
 * silently hide matching runs on every other page — a search that lies. It
 * belongs in the API's query, not in this component.
 */
export default function RunList({
  projectSlug = null,
  heading = 'Runs',
  action,
}: {
  /** Narrows the list to one project. Null is the org-wide list. */
  readonly projectSlug?: string | null;
  readonly heading?: string;
  readonly action?: ReactNode;
} = {}) {
  // The cursor is component state, not a URL query parameter. Keyset
  // pagination has no stable notion of "page 3": a cursor is the id of a row
  // on the previous page, so a bookmarked or shared ?cursor= would silently
  // mean something different the moment that row moved or was deleted. The
  // URL stays honest about what it can address — the list itself — and the
  // walk forward lives where the walk happens.
  const [cursor, setCursor] = useState<string | null>(null);

  // `heading` is the project's name on `/projects/:slug` and the literal
  // "Runs" on the org-wide list, so one call covers both — and on the project
  // page it resolves from the slug to the real name as the rail's query lands,
  // which is exactly the behaviour `ProjectRuns` documents for the `<h1>`.
  useDocumentTitle(heading);

  const runs = useQuery({
    queryKey: runsQueryKey(cursor, projectSlug),
    queryFn: () => fetchRuns(cursor, projectSlug),
    // Keeps the current page on screen while the next one loads, instead of
    // blanking the table back to a loading state on every click of Next.
    placeholderData: keepPreviousData,
  });

  if (runs.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading heading={heading} action={action} />
        <LoadingState label="Loading runs…">
          <SkeletonTable columns={5} rows={6} />
        </LoadingState>
      </div>
    );
  }

  if (runs.isError) {
    // AuthGate already resolved the bootstrap's 401/403; anything failing
    // HERE is a later page, or the API going down while the user reads. Show
    // what the server said — including the `remediation` every `/v1` error is
    // required to carry — rather than a generic apology.
    const error = runs.error;
    const problem = error instanceof ProblemError ? error : null;
    // The page keeps its own `<h1>` above the alert. Without it this branch
    // renders a document with no level-1 heading at all, and `ErrorState`'s
    // title defaults to a paragraph precisely so it does not silently become
    // a second one.
    return (
      <div className="flex flex-col gap-4">
        <PageHeading heading={heading} action={action} />
        <ErrorState
          title="The runs could not be loaded"
          detail={problem?.detail ?? error.message}
          remediation={problem?.remediation}
        />
      </div>
    );
  }

  const { items, nextCursor } = runs.data;

  const caption = (
    <>
      {projectSlug === null ? 'Every run in your organisation' : 'Every run in this project'},
      newest first, with the project it belongs to. “Started” is the load test’s own start time;
      rows marked <em>ingest time</em> have not been parsed yet, so they fall back to when
      PerfPortal received the run.
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeading heading={heading} count={items.length} hasMore={nextCursor !== null} action={action} />

      {items.length === 0 ? (
        <EmptyPage cursor={cursor} projectSlug={projectSlug} onFirstPage={() => setCursor(null)} />
      ) : (
        // ONE `caption` NODE, rendered visibly outside the scroll box and
        // programmatically inside the table — see `TableFrame`'s docstring for
        // why a `<caption>` inside `overflow-x-auto` stops wrapping and runs
        // off the side of a phone.
        <TableFrame caption={caption} label={`${heading} table`}>
            <table className={TABLE}>
              <caption className="sr-only">{caption}</caption>
              {/* No Tool column. TOOL_IDS has exactly one member, so it read
                  "gatling" on every row this platform can produce. It returns
                  the day a second tool ships, at which point it carries
                  information; the field stays in the contract meanwhile. */}
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>
                    Started
                  </th>
                  <th scope="col" className={TH}>
                    Project
                  </th>
                  <th scope="col" className={TH}>
                    Simulation
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Verdict
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
        </TableFrame>
      )}

      {/* Page controls exist only when there is a page to control. Rendering
          them unconditionally told a brand-new org "You have reached the end
          of the list" beneath "No runs yet" — the end of a list it had never
          walked, next to a disabled Next and a First page button pointing at
          the page it was already on. An empty result also means the ONE route
          back out of a stale cursor is EmptyPage's own button, rather than
          three pieces of chrome competing for one dead end. */}
      {items.length > 0 && (
        <nav aria-label="Run list pages" className="flex flex-wrap items-center gap-3">
          {/* No offset paging exists (RunRepository.list is keyset), so there
              is no page number to go back to — but a list you can only walk
              forward is a trap. Returning to the first page needs no cursor at
              all, which is the one backwards move keyset pagination gives for
              free. */}
          {/* The chevrons are decorative (`aria-hidden` via icons.tsx), so
              both buttons keep the accessible names the e2e suite clicks. */}
          {cursor !== null && (
            <Button size="sm" onClick={() => setCursor(null)}>
              <ChevronLeftIcon />
              First page
            </Button>
          )}
          <Button
            size="sm"
            // `runs.isPlaceholderData` is true while the NEXT page is in
            // flight: without it a second click would advance from a cursor
            // belonging to a page the user is no longer looking at.
            disabled={nextCursor === null}
            loading={runs.isPlaceholderData}
            aria-describedby={nextCursor === null ? 'no-more-runs' : undefined}
            onClick={() => setCursor(nextCursor)}
          >
            Next
            <ChevronRightIcon />
          </Button>
          {/* Disabled rather than hidden: a control that vanishes at the end
              of the list leaves the reader wondering whether it was ever
              there. `disabled` alone is silent for a sighted user, so the
              reason is spelled out — and tied to the button by
              aria-describedby so a screen reader hears it with the control,
              not adrift after it. */}
          {nextCursor === null && (
            <p id="no-more-runs" className="text-[13px] text-muted">
              You have reached the end of the list.
            </p>
          )}
        </nav>
      )}
    </div>
  );
}

/**
 * The page's `<h1>` and, when there is a list under it, how much of one.
 *
 * The count is deliberately "6 runs" and not "6 of 42": keyset pagination
 * never learns a total, and inventing one from `items.length + (nextCursor ?
 * 1 : 0)` would put a number on screen that is wrong for every org with more
 * than one page. `hasMore` is rendered as "more available", which is exactly
 * what the cursor actually tells us.
 */
function PageHeading({
  heading,
  count,
  hasMore = false,
  action,
}: {
  readonly heading: string;
  readonly count?: number;
  readonly hasMore?: boolean;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
        {count !== undefined && count > 0 && (
          <p className="text-[13px] text-muted">
            {count} {count === 1 ? 'run' : 'runs'}
            {hasMore && ', more available'}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * An org (or project) with no runs gets a sentence, not a table with a
 * header row and nothing under it — an empty table looks like a list that
 * failed to load.
 */
function EmptyPage({
  cursor,
  projectSlug,
  onFirstPage,
}: {
  cursor: string | null;
  projectSlug: string | null;
  onFirstPage: () => void;
}) {
  if (cursor !== null) {
    // Reachable only if rows vanished between the request that produced this
    // cursor and this one (RunRepository.list returns an empty page for a
    // cursor it can no longer resolve, rather than silently restarting).
    return (
      <EmptyState
        title="These runs are no longer here"
        body="The list may have changed since you started paging."
        action={
          <Button size="sm" variant="primary" onClick={onFirstPage}>
            Back to the first page
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      // Lower-cased "no runs yet" is what `run-list.spec.ts` matches
      // (case-insensitively), and the sentence below is what tells a reader
      // with an empty org what to actually do about it.
      title="No runs yet"
      body={
        projectSlug === null
          ? 'Runs appear here once a test bundle is uploaded to one of this organisation’s projects.'
          : 'Runs appear here once a test bundle is uploaded to this project.'
      }
    />
  );
}

function RunRow({ run }: { run: RunListItem }) {
  // The value the API ORDERS BY, spelled the same way here — RunRepository.list
  // sorts on COALESCE(tool_started_at, started_at) DESC. Displaying anything
  // else (startedAt alone, say) renders a correctly-sorted list that reads as
  // mis-sorted, which is worse than an obvious bug because nothing looks broken.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;

  return (
    <tr data-testid="run-row" data-run-id={run.id} className={ROW}>
      <td data-testid="run-started" className={`${TD} whitespace-nowrap`}>
        {/* <time dateTime> carries the machine-readable instant next to the
            human one. That is the correct markup for a rendered date
            regardless of testing — and it is also what lets the e2e suite
            assert the ORDER of what is displayed, since the formatted text is
            localised and does not sort. The attribute is the API's own ISO
            string, unmodified. */}
        <time dateTime={startedAt} className="tabular-nums">
          {formatStarted(startedAt)}
        </time>
        {isIngestTime && <span className="ml-2 text-[12px] text-muted">ingest time</span>}
      </td>
      <td className={TD}>{run.project.name}</td>
      <td data-testid="run-simulation" className={TD}>
        {/* The simulation is what a reader is looking for, so it is the
            link. Falls back to the short id for a run the worker has not
            parsed (or never will), which is what this column showed before
            the simulation was available at all. The accessible name carries
            the WHOLE id either way, because "View" repeated down a column
            names nothing.

            `underline` moved to hover only, and the accent carries the
            affordance at rest. A column of eight permanently-underlined
            fully-qualified class names is a wall of rules that competes with
            the row borders; the colour still distinguishes it from the plain
            text beside it, and `underline-offset` keeps the rule off the
            descenders when it does appear. */}
        <Link
          to={runPath(run.id)}
          aria-label={`View run ${run.id}`}
          className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
        >
          {run.simulation ?? <code className="text-[12px]">{run.id.slice(0, 8)}</code>}
        </Link>
      </td>
      <td className={TD}>
        <Badge mark={STATUS[run.status]} />
      </td>
      <td className={TD}>
        <Badge mark={VERDICT[run.verdict ?? 'none']} />
      </td>
    </tr>
  );
}
