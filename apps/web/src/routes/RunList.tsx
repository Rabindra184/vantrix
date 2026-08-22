import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import Button, { linkButtonClasses } from '../components/Button';
import { ChevronLeftIcon, ChevronRightIcon, FilterIcon, PlusIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import {
  fetchRuns,
  runsQueryKey,
  type RunListFilters,
  type RunListStatusFilter,
  type RunListVerdictFilter,
} from '../api/runs';
// Status and verdict share one vocabulary with the run detail page — the
// same Mark data, from the same STATUS/VERDICT tables in ./marks — so a
// status that changes a word or a glyph updates both screens from one edit
// rather than two that can drift. The two screens render that shared Mark
// differently on purpose: this page as a Badge pill, the run detail page as
// Marked's plain inline text. Same for the start-time formatter: the two
// screens must agree about when a run started, and one definition is the
// only way that is guaranteed.
import { formatInstant } from './format';
import { STATUS, VERDICT } from './marks';
import { NEW_PROJECT_ROUTE, runPath } from './paths';
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
 * Filters are URL state and API parameters. That is the important boundary:
 * the list is keyset-paginated, so narrowing only the page in hand would
 * silently hide matching runs on every other page.
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters, ignored } = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const filtersActive = hasActiveFilters(filters);

  // ONE PAIR OF HANDLERS, not one pair per return branch. The controls
  // render above the loading, error and loaded states alike — they must, or
  // the filter you just applied disappears while its own request is in
  // flight — and three inline copies of "reset the cursor, then write the
  // URL" is three places for them to drift apart.
  //
  // `setCursor(null)` FIRST, in both: a cursor is the id of a row on the
  // previous page of the PREVIOUS filter (see the cursor's own comment
  // above), so carrying it across a filter change asks the API to continue a
  // walk through a list that no longer exists.
  const applyFilters = (next: RunListFilters) => {
    setCursor(null);
    setSearchParams(paramsFromFilters(next), { replace: true });
  };
  const clearFilters = () => {
    setCursor(null);
    setSearchParams({}, { replace: true });
  };
  const controls = (
    <RunListControls
      filters={filters}
      ignored={ignored}
      active={filtersActive || ignored.length > 0}
      onApply={applyFilters}
      onClear={clearFilters}
    />
  );
  const headingAction = action ?? (projectSlug === null ? (
    <Link to={NEW_PROJECT_ROUTE} className={linkButtonClasses}>
      <PlusIcon className="h-3.5 w-3.5" />
      New project
    </Link>
  ) : undefined);

  // `heading` is the project's name on `/projects/:slug` and the literal
  // "Runs" on the org-wide list, so one call covers both — and on the project
  // page it resolves from the slug to the real name as the rail's query lands,
  // which is exactly the behaviour `ProjectRuns` documents for the `<h1>`.
  useDocumentTitle(heading);

  const runs = useQuery({
    queryKey: runsQueryKey(cursor, projectSlug, filters),
    queryFn: () => fetchRuns(cursor, projectSlug, filters),
    // Keeps the current page on screen while the next one loads, instead of
    // blanking the table back to a loading state on every click of Next.
    placeholderData: keepPreviousData,
  });

  if (runs.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading heading={heading} action={headingAction} />
        {controls}
        <LoadingState label="Loading runs…">
          <SkeletonTable columns={6} rows={6} />
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
        <PageHeading heading={heading} action={headingAction} />
        {controls}
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
      PerfPortal received the run. Focus is the first operational action to take from the row.
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeading heading={heading} count={items.length} hasMore={nextCursor !== null} action={headingAction} />
      {controls}

      {items.length === 0 ? (
        <EmptyPage
          cursor={cursor}
          projectSlug={projectSlug}
          filtered={filtersActive}
          onFirstPage={() => setCursor(null)}
          onClearFilters={clearFilters}
        />
      ) : (
        <>
          <RunListHealth items={items} />
          {/* ONE `caption` NODE, rendered visibly outside the scroll box and
              programmatically inside the table — see `TableFrame`'s docstring for
              why a `<caption>` inside `overflow-x-auto` stops wrapping and runs
              off the side of a phone. */}
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
                    <th scope="col" className={TH}>
                      Focus
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
        </>
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
              <ChevronLeftIcon className="h-3.5 w-3.5" />
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
            <ChevronRightIcon className="h-3.5 w-3.5" />
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

const STATUS_FILTERS: readonly { value: RunListStatusFilter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'parsing', label: 'Parsing' },
  { value: 'running', label: 'Running' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' },
  { value: 'incomplete', label: 'Incomplete' },
];

const VERDICT_FILTERS: readonly { value: RunListVerdictFilter; label: string }[] = [
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'not_evaluated', label: 'Not evaluated' },
  { value: 'none', label: 'No verdict' },
];

function RunListControls({
  filters,
  ignored,
  active,
  onApply,
  onClear,
}: {
  readonly filters: RunListFilters;
  /**
   * Query parameters this list understands the NAME of but not the VALUE —
   * `?status=completed`, say. Stated rather than dropped: silently ignoring
   * one rendered the whole unfiltered list under a URL that claimed a
   * filter, with no Clear control to explain it, while the API answers the
   * same value with a 400 RUN_FILTER_INVALID. Two components disagreeing
   * about one input is the part that had to go.
   */
  readonly ignored: readonly string[];
  readonly active: boolean;
  readonly onApply: (filters: RunListFilters) => void;
  readonly onClear: () => void;
}) {
  const [q, setQ] = useState(filters.q ?? '');
  const [status, setStatus] = useState(filters.status ?? '');
  const [verdict, setVerdict] = useState(filters.verdict ?? '');

  useEffect(() => {
    setQ(filters.q ?? '');
    setStatus(filters.status ?? '');
    setVerdict(filters.verdict ?? '');
  }, [filters]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply({
      q,
      status: status === '' ? null : (status as RunListStatusFilter),
      verdict: verdict === '' ? null : (verdict as RunListVerdictFilter),
    });
  }

  return (
    <form
      aria-label="Run filters"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-default bg-surface p-4 shadow-panel"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
        <FilterIcon className="h-3.5 w-3.5" />
        Filter runs
      </div>

      {ignored.length > 0 && (
        // NO `role="status"`, deliberately. This is not an announcement — it
        // is present on first paint, because it describes the URL the page
        // was opened with. `LoadingState` already owns the one live region
        // on this screen, and a second `status` in the same document while
        // the list loads is two things a screen reader has to arbitrate
        // between for no gain.
        <p data-testid="run-filter-ignored" className="text-[12px] leading-relaxed text-muted">
          Ignored {ignored.join(' and ')} in the address bar — not {ignored.length > 1 ? 'values' : 'a value'} this
          list can filter by. Everything else on this page is unfiltered.
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_180px_180px_auto] md:items-end">
        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
          Search runs
          <input
            className={INPUT}
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="Simulation, project, branch"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
          Status
          <select
            className={INPUT}
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
          >
            <option value="">Any status</option>
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
          Verdict
          <select
            className={INPUT}
            value={verdict}
            onChange={(event) => setVerdict(event.currentTarget.value)}
          >
            <option value="">Any verdict</option>
            {VERDICT_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="primary">
            Apply
          </Button>
          {active && (
            <Button size="sm" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * The four counts, and THE SENTENCE THAT MAKES THEM TRUE.
 *
 * These reduce over `items` — one keyset page — and nothing about a page of
 * 25 rows tells you anything about the 400 behind it. Shipped as "Run list
 * health" with only the fourth tile disclosing its scope, this said "Needs
 * attention: 2" over an org with 90 failed runs. That is the same defect as
 * the client-side search this component's own docstring rejects: a
 * page-local number presented as a statement about the list.
 *
 * The scope is stated ONCE, in the section's accessible name and in a line
 * above the tiles, rather than repeated into four `detail` strings — the
 * details are what each count MEANS, and a caveat repeated four times reads
 * as decoration by the third.
 *
 * `hasMore` is deliberately gone. It only says whether a NEXT page exists,
 * so it was never the right test anyway: on page three of five it is true
 * and on page five it is false, and the counts are page-local in both.
 */
function RunListHealth({ items }: { readonly items: readonly RunListItem[] }) {
  const summary = healthSummary(items);

  return (
    <section
      aria-label="Run health on this page"
      className="rounded-xl border border-default bg-surface p-4 shadow-panel"
    >
      <p className="text-[12px] leading-relaxed text-muted">
        Counted over the {items.length} {items.length === 1 ? 'run' : 'runs'} on this page. Paging or
        filtering changes them; they are not totals for the whole list.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HealthTile
          label="Needs attention"
          value={summary.needsAttention}
          detail="Failed, incomplete, or SLA failed"
          colour="var(--color-status-failed)"
        />
        <HealthTile
          label="In flight"
          value={summary.inFlight}
          detail="Pending, parsing, or live"
          colour="var(--color-status-pending)"
        />
        <HealthTile
          label="Passed gates"
          value={summary.passed}
          detail="SLA verdict passed"
          colour="var(--color-status-passed)"
        />
        <HealthTile
          label="Unjudged"
          value={summary.unjudged}
          detail="No verdict, or not evaluated"
          colour="var(--color-status-not-applicable)"
        />
      </div>
    </section>
  );
}

function HealthTile({
  label,
  value,
  detail,
  colour,
}: {
  readonly label: string;
  readonly value: number;
  readonly detail: string;
  readonly colour: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-sunken px-3 py-2" style={{ color: colour }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold leading-none tabular-nums text-primary">{value}</p>
      <p className="mt-2 text-[11px] leading-snug text-muted">{detail}</p>
    </div>
  );
}

function healthSummary(items: readonly RunListItem[]) {
  return items.reduce(
    (next, run) => ({
      needsAttention: next.needsAttention + (needsAttention(run) ? 1 : 0),
      inFlight: next.inFlight + (isInFlight(run) ? 1 : 0),
      passed: next.passed + (run.verdict === 'passed' ? 1 : 0),
      unjudged: next.unjudged + (run.verdict === null || run.verdict === 'not_evaluated' ? 1 : 0),
    }),
    { needsAttention: 0, inFlight: 0, passed: 0, unjudged: 0 },
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
  filtered,
  onFirstPage,
  onClearFilters,
}: {
  cursor: string | null;
  projectSlug: string | null;
  filtered: boolean;
  onFirstPage: () => void;
  onClearFilters: () => void;
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

  if (filtered) {
    return (
      <EmptyState
        title="No runs match these filters"
        body="The filters are applied across the run history, not just this page."
        action={
          <Button size="sm" variant="primary" onClick={onClearFilters}>
            Clear filters
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

/**
 * The URL's filters, plus WHAT THIS DROPPED. The second half is the point:
 * an unrecognised `?status=completed` used to become `null` while staying in
 * the address bar, so the page rendered the full unfiltered list, reported
 * no active filters, and offered no Clear — a shared link that reads as
 * "there are no other completed runs". The API rejects the identical value
 * with a 400, and the two must not disagree about one input.
 */
function filtersFromParams(params: URLSearchParams): {
  filters: RunListFilters;
  ignored: string[];
} {
  const status = params.get('status');
  const verdict = params.get('verdict');
  const ignored: string[] = [];
  if (status !== null && !isStatusFilter(status)) ignored.push(`status=${status}`);
  if (verdict !== null && !isVerdictFilter(verdict)) ignored.push(`verdict=${verdict}`);
  return {
    filters: {
      q: params.get('q') ?? undefined,
      status: isStatusFilter(status) ? status : null,
      verdict: isVerdictFilter(verdict) ? verdict : null,
    },
    ignored,
  };
}

function paramsFromFilters(filters: RunListFilters): Record<string, string> {
  const params: Record<string, string> = {};
  const q = filters.q?.trim();
  if (q) params.q = q;
  if (filters.status) params.status = filters.status;
  if (filters.verdict) params.verdict = filters.verdict;
  return params;
}

function hasActiveFilters(filters: RunListFilters): boolean {
  return Boolean(filters.q?.trim() || filters.status || filters.verdict);
}

function isStatusFilter(value: string | null): value is RunListStatusFilter {
  return STATUS_FILTERS.some((option) => option.value === value);
}

function isVerdictFilter(value: string | null): value is RunListVerdictFilter {
  return VERDICT_FILTERS.some((option) => option.value === value);
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
          {formatInstant(startedAt)}
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
      {/* PLAIN COLOURED TEXT, NOT A BADGE, and the distinction is what the
          column means. Status and Verdict beside it are STATES the platform
          recorded — a stamp is right for those, and the pill is what makes
          them scannable down the column. Focus is not a state; it is the
          ACTION this row suggests, derived here rather than stored. Drawing
          it as a third pill made every row read as three equal stamps and
          buried the two that came from the run itself.

          The WORD carries the meaning — investigate / watch live / clear are
          different words, not one word in different colours — so the colour
          is emphasis rather than information, and WCAG 1.4.1 is satisfied
          without the glyph the badge used to add. */}
      <td className={TD}>
        <FocusHint focus={focusFor(run)} />
      </td>
    </tr>
  );
}

function FocusHint({ focus }: { readonly focus: Focus }) {
  const { label, colour } = FOCUS_MARKS[focus];
  return (
    <span className="font-medium whitespace-nowrap" style={{ color: colour }}>
      {label}
    </span>
  );
}

type Focus = 'investigate' | 'watch' | 'processing' | 'clear' | 'review';

/**
 * `glyph` is gone with the badge — see `FocusHint`. The remaining pair is
 * deliberately the same SHAPE as a `Mark` minus that field, so the colours
 * still come from the status text palette every other signal on this page
 * reads, rather than becoming a fourth place colour is decided.
 */
const FOCUS_MARKS: Record<Focus, { label: string; colour: string }> = {
  investigate: { label: 'investigate', colour: 'var(--color-status-failed)' },
  watch: { label: 'watch live', colour: 'var(--color-status-pending)' },
  processing: { label: 'processing', colour: 'var(--color-status-pending)' },
  clear: { label: 'clear', colour: 'var(--color-status-passed)' },
  review: { label: 'review', colour: 'var(--color-status-not-applicable)' },
};

function focusFor(run: RunListItem): Focus {
  if (needsAttention(run)) return 'investigate';
  if (run.status === 'running') return 'watch';
  if (isInFlight(run)) return 'processing';
  if (run.verdict === 'passed') return 'clear';
  return 'review';
}

function needsAttention(run: RunListItem): boolean {
  return run.status === 'failed' || run.status === 'incomplete' || run.verdict === 'failed';
}

function isInFlight(run: RunListItem): boolean {
  return run.status === 'pending' || run.status === 'parsing' || run.status === 'running';
}
