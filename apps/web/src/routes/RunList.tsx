import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
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
 */
export default function RunList() {
  // The cursor is component state, not a URL query parameter. Keyset
  // pagination has no stable notion of "page 3": a cursor is the id of a row
  // on the previous page, so a bookmarked or shared ?cursor= would silently
  // mean something different the moment that row moved or was deleted. The
  // URL stays honest about what it can address — the list itself — and the
  // walk forward lives where the walk happens.
  const [cursor, setCursor] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: runsQueryKey(cursor),
    queryFn: () => fetchRuns(cursor),
    // Keeps the current page on screen while the next one loads, instead of
    // blanking the table back to a loading state on every click of Next.
    placeholderData: keepPreviousData,
  });

  if (runs.isPending) {
    return (
      <p role="status" className="text-muted">
        Loading runs…
      </p>
    );
  }

  if (runs.isError) {
    // AuthGate already resolved the bootstrap's 401/403; anything failing
    // HERE is a later page, or the API going down while the user reads. Show
    // what the server said — including the `remediation` every `/v1` error is
    // required to carry — rather than a generic apology.
    const error = runs.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <div role="alert" className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">The runs could not be loaded</h1>
        <p>{problem?.detail ?? error.message}</p>
        {problem !== null && <p className="text-muted">{problem.remediation}</p>}
      </div>
    );
  }

  const { items, nextCursor } = runs.data;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Runs</h1>

      {items.length === 0 ? (
        <EmptyPage cursor={cursor} onFirstPage={() => setCursor(null)} />
      ) : (
        <table className="w-full border-collapse text-left">
          <caption className="pb-3 text-left text-sm text-muted">
            Every run in your organisation, newest first. “Started” is the load test’s own start
            time; rows marked <em>ingest time</em> have not been parsed yet, so they fall back to
            when PerfPortal received the run.
          </caption>
          <thead>
            <tr className="border-b border-default">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Started
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Tool
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Verdict
              </th>
              <th scope="col" className="py-2 font-semibold">
                Run
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}

      {/* Page controls exist only when there is a page to control. Rendering
          them unconditionally told a brand-new org "You have reached the end
          of the list" beneath "No runs yet" — the end of a list it had never
          walked, next to a disabled Next and a First page button pointing at
          the page it was already on. An empty result also means the ONE route
          back out of a stale cursor is EmptyPage's own button, rather than
          three pieces of chrome competing for one dead end. */}
      {items.length > 0 && (
        <nav aria-label="Run list pages" className="flex items-center gap-3">
          {/* No offset paging exists (RunRepository.list is keyset), so there
              is no page number to go back to — but a list you can only walk
              forward is a trap. Returning to the first page needs no cursor at
              all, which is the one backwards move keyset pagination gives for
              free. */}
          {cursor !== null && (
            <button
              type="button"
              onClick={() => setCursor(null)}
              className="rounded border border-default px-3 py-2"
            >
              First page
            </button>
          )}
          <button
            type="button"
            // `runs.isPlaceholderData` is true while the NEXT page is in
            // flight: without it a second click would advance from a cursor
            // belonging to a page the user is no longer looking at.
            disabled={nextCursor === null || runs.isPlaceholderData}
            aria-describedby={nextCursor === null ? 'no-more-runs' : undefined}
            onClick={() => setCursor(nextCursor)}
            className="rounded border border-default px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Next
          </button>
          {/* Disabled rather than hidden: a control that vanishes at the end
              of the list leaves the reader wondering whether it was ever
              there. `disabled` alone is silent for a sighted user, so the
              reason is spelled out — and tied to the button by
              aria-describedby so a screen reader hears it with the control,
              not adrift after it. */}
          {nextCursor === null && (
            <p id="no-more-runs" className="text-sm text-muted">
              You have reached the end of the list.
            </p>
          )}
        </nav>
      )}
    </div>
  );
}

/**
 * An org with no runs gets a sentence, not a table with a header row and
 * nothing under it — an empty table looks like a list that failed to load.
 */
function EmptyPage({ cursor, onFirstPage }: { cursor: string | null; onFirstPage: () => void }) {
  if (cursor !== null) {
    // Reachable only if rows vanished between the request that produced this
    // cursor and this one (RunRepository.list returns an empty page for a
    // cursor it can no longer resolve, rather than silently restarting).
    return (
      <div className="flex flex-col items-start gap-3">
        <p>These runs are no longer here. The list may have changed since you started paging.</p>
        <button
          type="button"
          onClick={onFirstPage}
          className="rounded border border-default px-3 py-2"
        >
          Back to the first page
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p>No runs yet.</p>
      <p className="text-muted">
        Runs appear here once a test bundle is uploaded to one of this organisation’s projects.
      </p>
    </div>
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
    <tr
      data-testid="run-row"
      data-run-id={run.id}
      className="border-b border-default"
    >
      <td data-testid="run-started" className="py-2 pr-4">
        {/* <time dateTime> carries the machine-readable instant next to the
            human one. That is the correct markup for a rendered date
            regardless of testing — and it is also what lets the e2e suite
            assert the ORDER of what is displayed, since the formatted text is
            localised and does not sort. The attribute is the API's own ISO
            string, unmodified. */}
        <time dateTime={startedAt}>{formatStarted(startedAt)}</time>
        {isIngestTime && (
          <span className="ml-2 text-sm text-muted">ingest time</span>
        )}
      </td>
      <td className="py-2 pr-4">{run.tool}</td>
      <td className="py-2 pr-4">
        <Badge mark={STATUS[run.status]} />
      </td>
      <td className="py-2 pr-4">
        <Badge mark={VERDICT[run.verdict ?? 'none']} />
      </td>
      <td className="py-2">
        {/* The short id is the visible text so consecutive links are told
            apart by sight; the accessible name carries the whole id, because
            "View" repeated down a column names nothing. */}
        <Link to={`/runs/${run.id}`} aria-label={`View run ${run.id}`} className="underline">
          <code>{run.id.slice(0, 8)}</code>
        </Link>
      </td>
    </tr>
  );
}
