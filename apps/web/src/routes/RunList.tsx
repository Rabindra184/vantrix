import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import { fetchRuns, runsQueryKey } from '../api/runs';

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
      <p role="status" className="text-[var(--color-text-muted)]">
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
        {problem !== null && <p className="text-[var(--color-text-muted)]">{problem.remediation}</p>}
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
          <caption className="pb-3 text-left text-sm text-[var(--color-text-muted)]">
            Every run in your organisation, newest first. “Started” is the load test’s own start
            time; rows marked <em>ingest time</em> have not been parsed yet, so they fall back to
            when PerfPortal received the run.
          </caption>
          <thead>
            <tr className="border-b border-[var(--color-border)]">
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
            className="rounded border border-[var(--color-border)] px-3 py-2"
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
          className="rounded border border-[var(--color-border)] px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Next
        </button>
        {/* Disabled rather than hidden: a control that vanishes at the end of
            the list leaves the reader wondering whether it was ever there.
            `disabled` alone is silent for a sighted user, so the reason is
            spelled out — and tied to the button by aria-describedby so a
            screen reader hears it with the control, not adrift after it. */}
        {nextCursor === null && (
          <p id="no-more-runs" className="text-sm text-[var(--color-text-muted)]">
            You have reached the end of the list.
          </p>
        )}
      </nav>
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
          className="rounded border border-[var(--color-border)] px-3 py-2"
        >
          Back to the first page
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p>No runs yet.</p>
      <p className="text-[var(--color-text-muted)]">
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
      className="border-b border-[var(--color-border)]"
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
          <span className="ml-2 text-sm text-[var(--color-text-muted)]">ingest time</span>
        )}
      </td>
      <td className="py-2 pr-4">{run.tool}</td>
      <td className="py-2 pr-4">
        <Marked mark={STATUS[run.status]} />
      </td>
      <td className="py-2 pr-4">
        <Marked mark={VERDICT[run.verdict ?? 'none']} />
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

/** A shape, a word, and a colour — in that order of importance. */
type Mark = { glyph: string; label: string; colour: string };

/**
 * Text plus SHAPE, never colour alone (brief; WCAG 2.2 AA 1.4.1). Colour is
 * present and useful, but it is the third signal, not the only one: a
 * colour-blind reader, a monochrome print-out, or a user with a forced-colour
 * theme still tells ✓ passed from ✕ failed, because the glyph and the word
 * both say so.
 *
 * The glyph is `aria-hidden` — the word beside it already carries the
 * meaning, and a screen reader announcing "white heavy check mark passed"
 * says it twice, once badly.
 */
function Marked({ mark }: { mark: Mark }) {
  return (
    <span style={{ color: mark.colour }}>
      <span aria-hidden="true">{mark.glyph}</span> {mark.label}
    </span>
  );
}

const STATUS: Record<RunListItem['status'], Mark> = {
  pending: { glyph: '○', label: 'pending', colour: 'var(--color-status-pending)' },
  parsing: { glyph: '◐', label: 'parsing', colour: 'var(--color-status-pending)' },
  complete: { glyph: '●', label: 'complete', colour: 'var(--color-status-passed)' },
  failed: { glyph: '✕', label: 'failed', colour: 'var(--color-status-failed)' },
};

/**
 * `none` is a NULL verdict, which is not the same thing as `not_evaluated`:
 * null means the run never got far enough to be judged, while
 * `not_evaluated` means it finished and no SLA rule applied to it. Flattening
 * the two would tell a user their still-pending run had been assessed.
 */
const VERDICT: Record<NonNullable<RunListItem['verdict']> | 'none', Mark> = {
  passed: { glyph: '✓', label: 'passed', colour: 'var(--color-status-passed)' },
  failed: { glyph: '✕', label: 'failed', colour: 'var(--color-status-failed)' },
  not_evaluated: {
    glyph: '○',
    label: 'not evaluated',
    colour: 'var(--color-status-not-applicable)',
  },
  none: { glyph: '–', label: 'no verdict yet', colour: 'var(--color-status-not-applicable)' },
};

/**
 * Formatted in the reader's own locale and time zone — a performance run's
 * start is read against the reader's day, not the server's. Nothing sorts or
 * compares this string; the `datetime` attribute beside it is the value that
 * carries meaning to machines.
 */
const STARTED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatStarted(iso: string): string {
  return STARTED_FORMAT.format(new Date(iso));
}
