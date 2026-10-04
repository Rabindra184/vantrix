import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import Button, { linkButtonClasses } from '../components/Button';
import CopyIdButton from '../components/CopyIdButton';
import { ChevronLeftIcon, ChevronRightIcon, FilterIcon, PlusIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import InfoTip from '../components/InfoTip';
import RunTally from './RunTally';
import SimulationName from './SimulationName';
import TableFrame from '../components/TableFrame';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import useIsCompact from '../useIsCompact';
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
import { formatInstant, formatListInstant, zoneLabel } from './format';
import { STATUS, VERDICT } from './marks';
import { NEW_PROJECT_ROUTE, runPath } from './paths';
import useDocumentTitle from '../useDocumentTitle';
import { runName } from '../runNumber';

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
 * THE TABLE'S NAME IS "Runs" AND ITS CAVEAT IS BEHIND AN INFO (clean UI).
 * The caption used to be a paragraph printed above the list — what "Started"
 * means, and what the since-removed Focus column was — met on every visit. It
 * is the frame's `InfoTip` now, the same on both layouts, and the sentence that only restated the scope
 * ("Every run in this project, newest first") is gone.
 *
 * Filters are URL state and API parameters. That is the important boundary:
 * the list is keyset-paginated, so narrowing only the page in hand would
 * silently hide matching runs on every other page.
 */
export default function RunList({
  projectSlug = null,
  testSlug = null,
  heading = 'Runs',
  showHeading = true,
  titlesDocument = true,
  emptyBody,
  action,
}: {
  /** Narrows the list to one project. Null is the org-wide list. */
  readonly projectSlug?: string | null;
  /**
   * Narrows further, to one test's runs. Meaningless without `projectSlug`
   * and silently dropped without it — see `fetchRuns`, and the API's own
   * TEST_NEEDS_PROJECT for why a test slug alone names nothing.
   */
  readonly testSlug?: string | null;
  readonly heading?: string;
  /**
   * Whether to draw the `<h1>`. `false` says THE CALLER ALREADY HAS ONE, and
   * is the only correct value for a page that does — `TestRuns` renders a
   * breadcrumb, a heading and a metadata strip of its own above this list, and
   * a second `<h1>` in that document is a real defect rather than a cosmetic
   * one: a screen-reader user navigating by heading meets the page twice.
   *
   * `heading` is STILL REQUIRED when this is false, because it does two other
   * jobs — it titles the document (one `useDocumentTitle` call, here, so two
   * components never race for `document.title`) and it names the table's
   * scroll region. Suppressing the element is not the same as having no name
   * for the thing.
   */
  readonly showHeading?: boolean;
  /**
   * Whether to name the DOCUMENT after `heading`. False when a caller above
   * has already done it — `ProjectRuns` sits inside `ProjectShell`, which
   * titles the page `Runs · <project>` and would be racing this one.
   *
   * Separate from `showHeading` because the two are genuinely independent:
   * `TestRuns` suppresses the `<h1>` and still wants the title from here (one
   * call, in the component that holds the name), while `ProjectRuns`
   * suppresses both. Folding them into one flag would force whichever page
   * came second to take a title it does not want.
   *
   * Passing `null` to `useDocumentTitle` is a no-op by design, which is what
   * makes this a two-line change rather than a branch around the hook.
   */
  readonly titlesDocument?: boolean;
  /** What "no runs yet" means in this scope — a test's page knows more than the default. */
  readonly emptyBody?: string;
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
  /* §22.6's one JS breakpoint. Below 768px this list is a stack of cards and
     its filters are collapsed — see `CompactFilters` and `RunCards` below for
     why each of those is a different component rather than a class. */
  const compact = useIsCompact();
  const controls = compact ? (
    <CompactFilters active={filtersActive || ignored.length > 0} filters={filters}>
      <RunListControls
        filters={filters}
        ignored={ignored}
        active={filtersActive || ignored.length > 0}
        onApply={applyFilters}
        onClear={clearFilters}
      />
    </CompactFilters>
  ) : (
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

  // `heading` is the literal "Runs" on the org-wide list and the TEST's name
  // on `/projects/:slug/tests/:testSlug`, so one call covers both. The
  // project's run list is the exception and says so: `ProjectShell` titles
  // that page, because it owns the heading there too.
  useDocumentTitle(titlesDocument ? heading : null);

  const runs = useQuery({
    queryKey: runsQueryKey(cursor, projectSlug, filters, testSlug),
    queryFn: () => fetchRuns(cursor, projectSlug, filters, testSlug),
    // Keeps the current page on screen while the next one loads, instead of
    // blanking the table back to a loading state on every click of Next.
    placeholderData: keepPreviousData,
  });

  if (runs.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading show={showHeading} heading={heading} action={headingAction} />
        {controls}
        <LoadingState label="Loading runs…">
          {/* ═══ THE SKELETON HAS TO HAVE THE TABLE'S COLUMNS ═══
              (the 09-13 review's acceptance list: slow loading)

              This said `columns={6}` while the table it stands in for renders
              EIGHT on the org-wide list — Project, Simulation, Status, Verdict,
              p95, Errors, Started, Environment — and seven on a project's,
              where the constant Project column is dropped. A
              placeholder whose shape is not the arriving content's is a
              layout jump dressed as a loading state: the whole point of
              drawing one is that nothing moves when the data lands.

              DERIVED FROM THE SAME CONDITION THE HEADER USES
              (`projectSlug === null`), so the two cannot drift — a literal
              here is what let it be wrong by three for as long as it was,
              through two column changes that never thought to look at it. */}
          <SkeletonTable columns={projectSlug === null ? 8 : 7} rows={6} />
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
        <PageHeading show={showHeading} heading={heading} action={headingAction} />
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
  /* THE ZONE ONCE, IN STARTED'S HEADER (clean UI, PR 3). Every cell used to
     carry it, and the year — 239px of a table that needed 1078. The header
     names the first row's zone; a row in another (a daylight-saving change
     between two runs) keeps its own beside its time. Empty when there are no
     rows, which is when no table is drawn. */
  const headerZone =
    items[0] === undefined ? '' : zoneLabel(items[0].toolStartedAt ?? items[0].startedAt);

  /* What a reader needs to read two of the columns, behind the list's info
     (the clean-UI text rule). True of every scope, which is why no caller
     overrides it any more: the override existed only because the old
     opening sentence named the wrong scope on a test's page. */
  const info = (
    <>
      “Started” is the load test’s own start time; rows marked <em>ingest time</em> have not been
      parsed yet, so they fall back to when PerfPortal received the run.
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        show={showHeading}
        heading={heading}
        count={items.length}
        hasMore={nextCursor !== null}
        action={headingAction}
      />
      {controls}

      {items.length === 0 ? (
        <EmptyPage
          cursor={cursor}
          projectSlug={projectSlug}
          emptyBody={emptyBody}
          filtered={filtersActive}
          onFirstPage={() => setCursor(null)}
          onClearFilters={clearFilters}
        />
      ) : (
        <>
          <RunTally items={items} showTotal={!showHeading} />
          {/* ═══ EIGHT COLUMNS DO NOT FIT ON A PHONE, AND SCROLLING THEM
              SIDEWAYS IS NOT A FIX (review M18) ═══

              The TABLE scrolls horizontally inside its box — so a reader
              at 375px sees Started and Project and has to drag to reach the
              two columns triage actually turns on, p95 and Errors. Measured
              there, the first row began at y=908 on an 812px screen: nothing
              about any run was visible without scrolling.

              A card stacks the same fields per run, which is the shape that
              fits. Same data, same links, same testids — see `RunCards`. */}
          {compact ? (
            <RunCards
              items={items}
              showProject={projectSlug === null}
              identifyByRunId={testSlug !== null}
              info={info}
            />
          ) : (
          /* The short name is the table's `sr-only` caption; the caveat rides
             behind the frame's info — see `TableFrame`'s docstring. */
          <TableFrame name="Runs" label={`${heading} table`} info={info}>
              <table className={TABLE}>
                <caption className="sr-only">Runs</caption>
                {/* No Tool column. TOOL_IDS has exactly one member, so it read
                    "gatling" on every row this platform can produce. It returns
                    the day a second tool ships, at which point it carries
                    information; the field stays in the contract meanwhile.

                    ═══ AND THE SAME ARGUMENT NOW APPLIES PER SCOPE ═══

                    That reasoning was never specific to the tool. A column
                    whose every cell reads the same thing costs horizontal room
                    on a table that is already wide and gives a reader nothing
                    to compare — and on a project's run list the PROJECT is
                    constant by construction, exactly as `tool` is.

                    `Simulation` is the same on a TEST's list, but it cannot
                    simply go: it holds the only link to the run. So it becomes
                    `Run` there and shows the short id, which is what actually
                    distinguishes one of this test's runs from another. See
                    `RunRow`. */}
                <thead className={THEAD}>
                  <tr>
                    {projectSlug === null && (
                      <th scope="col" className={TH}>
                        Project
                      </th>
                    )}
                    {/* `pr-9` RESERVES THE COPY BUTTON'S TRACK (backlog #4):
                        the header's own 0.75rem plus the button's 24px. See
                        `IdentityCell` for why the header is where it has to
                        go. */}
                    <th scope="col" className={`${TH} pr-9`}>
                      {testSlug === null ? 'Simulation' : 'Run'}
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <th scope="col" className={TH}>
                      Verdict
                    </th>
                    {/* THE TRIAGE COLUMNS. Without them "is this run
                        interesting" could only be answered by opening it. */}
                    <th scope="col" className={TH}>
                      p95
                    </th>
                    <th scope="col" className={TH}>
                      Errors
                    </th>
                    {/* ═══ CONTEXT AFTER TRIAGE ═══
                        (review 09-13's acceptance list; clean UI, PR 3)

                        The table wanted 1078px on the org-wide list and fitted
                        only at 1440, so it scrolled sideways on most screens —
                        allowed ("table-local horizontal scroll is acceptable
                        when row identity, headers, and controls remain
                        usable"), as long as p95 and Errors are not what falls
                        off the end. So identity, outcome and the two
                        measurements come first, and WHEN and WHERE are what a
                        reader scrolls to.

                        Removing Focus and shortening Started (the zone once,
                        in its header; the year only when it is not this
                        year's) took it down to the width MEASURED on the
                        developer database's real runs: 896px on All runs and
                        828px on a project's list. It fits without scrolling at
                        1280 (950px of box) and 1440 (1110); at 1100 (770) and
                        1024 (694, where the project rail opens) it still
                        scrolls, with Errors' right edge at 596px on All runs —
                        on screen. Collapsing the rail returns ~270px. */}
                    <th scope="col" className={TH}>
                      Started ({headerZone})
                    </th>
                    <th scope="col" className={TH}>
                      Environment
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      showProject={projectSlug === null}
                      identifyByRunId={testSlug !== null}
                      headerZone={headerZone}
                    />
                  ))}
                </tbody>
              </table>
          </TableFrame>
          )}
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
            onClick={() => setCursor(nextCursor)}
          >
            Next
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </Button>
          {/* ═══ DISABLED, AND NOTHING ELSE (review 09-13 N04) ═══
           *
           * Disabled rather than hidden, which is the half that was never in
           * doubt: a control that vanishes at the end of a list leaves the
           * reader wondering whether it was ever there.
           *
           * WHAT TOOK TWO ATTEMPTS IS THE SENTENCE BESIDE IT. This read "You
           * have reached the end of the list", and the first pass at N04 cut
           * it to "No more runs." — three words instead of eight — arguing
           * that `disabled` is silent for a sighted reader and that
           * `aria-describedby` pointing at an empty node would say less than
           * the disabled state alone.
           *
           * Both halves of that were wrong. `disabled={nextCursor === null}`
           * dates to 87d36fa, a MONTH BEFORE the review — so the reviewer was
           * already looking at a disabled button with a sentence beside it,
           * and "use disabled pagination" can only have meant "let the
           * disabled state carry it". And dropping the sentence means
           * dropping the `aria-describedby` with it, not aiming it at an
           * empty node: a disabled button is announced as disabled, by every
           * screen reader, without being told.
           *
           * **A SHORTER VERSION OF A SENTENCE THE FINDING ASKS YOU TO DELETE
           * IS NOT THE CORRECTION.** The count above the table already says
           * how many runs there are, and it stops saying ", more available"
           * at the end — so the fact is on screen twice over before this
           * paragraph says it a third time. */}
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
  /** False inside `CompactFilters`, whose own summary carries these words. */
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
      /* ═══ A TOOLBAR, NOT A PANEL (review.md 8) ═══
         "The filter area has a card, 'Filter runs', 'Search runs', multiple
         labels, and an Apply action before the rows begin… give routine filters
         less visual weight than the data."

         The border, the surface fill and the shadow are how this app says "this
         is a thing to read" — the treatment `Card`, the statistics table and the
         decision band all carry. Spending it on the controls ABOVE the data gave
         a routine filter the same weight as the run it exists to help you find.
         The layout is unchanged; only the frame goes.

         BEHAVIOUR IS UNTOUCHED, which the finding asks for in as many words: "do
         not change search behavior merely for appearance". Apply still submits,
         and Clear still appears only when something is filtering. */
      className="@container flex flex-col gap-3"
    >
      {/* NO "Filter runs" ROW. The compact viewport already dropped it —
          `CompactFilters`' own `<summary>` says it, and two identical labels
          eight pixels apart was the duplicate-heading problem
          `ProjectRules.showTitle` solves one page over. The DESKTOP kept it,
          which is review.md 8's "over-framed" in one line, and M02's lesson
          that A FIX APPLIED AT ONE BREAKPOINT IS NOT APPLIED.

          Nothing is lost to assistive technology: the `<form>`'s own
          `aria-label="Run filters"` names the region — which is how
          `RunList.test.tsx` has always found it — and every control inside
          carries its own visible label. */}

      {ignored.length > 0 && (
        // NO `role="status"`, deliberately. This is not an announcement — it
        // is present on first paint, because it describes the URL the page
        // was opened with. `LoadingState` already owns the one live region
        // on this screen, and a second `status` in the same document while
        // the list loads is two things a screen reader has to arbitrate
        // between for no gain.
        <p data-testid="run-filter-ignored" className="text-[0.75rem] leading-relaxed text-muted">
          Ignored {ignored.join(' and ')} in the address bar — not {ignored.length > 1 ? 'values' : 'a value'} this
          list can filter by. Everything else on this page is unfiltered.
        </p>
      )}

      {/* ═══ THE TRACKS ARE rem AND THE QUESTION IS THE FORM'S OWN WIDTH ═══
       *
       * This was `md:grid-cols-[minmax(220px,1fr)_180px_180px_auto]`, and both
       * halves of that were wrong once a reader doubles their text.
       *
       * A PIXEL TRACK CANNOT HOLD REM TEXT. At a 32px root a `<select>` in the
       * 180px track needs about 360, and a fixed track does not grow — so the
       * control spilled out of a parent with `overflow: visible` and widened
       * the DOCUMENT. Measured at 1280: the run list's page scrollWidth was
       * 1421. The type-scale branch made every font size relative for exactly
       * this reason; the boxes around the text had to follow.
       *
       * AND `md:` ASKS ABOUT THE VIEWPORT, WHICH SAYS NOTHING ABOUT WHETHER
       * FOUR COLUMNS FIT. It is the same wrong question `RunDecisionBand`
       * already records — it went three-up at `lg:`, which is also where the
       * rail appears, so it took its widest layout at the moment it lost
       * ~270px. `@container` asks what this form actually HAS, and Tailwind's
       * container thresholds are in rem, so the switch point scales with the
       * reader's font: `@2xl` is 672px at a 16px root and 1344px at 32px, and
       * the form never gets that much — so it stacks instead of spilling. */}
      <div className="grid gap-3 @2xl:grid-cols-[minmax(13.75rem,1fr)_11.25rem_11.25rem_auto] @2xl:items-end">
        <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-muted">
          Search runs
          <input
            className={INPUT}
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="Simulation, project, branch, note"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-muted">
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

        <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-muted">
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
 * The page's `<h1>` and, when there is a list under it, how much of one.
 *
 * The count is deliberately "6 runs" and not "6 of 42": keyset pagination
 * never learns a total, and inventing one from `items.length + (nextCursor ?
 * 1 : 0)` would put a number on screen that is wrong for every org with more
 * than one page. `hasMore` is rendered as "more available", which is exactly
 * what the cursor actually tells us.
 */
function PageHeading({
  show = true,
  heading,
  count,
  hasMore = false,
  action,
}: {
  /**
   * False when the CALLER owns the page's `<h1>` — see `showHeading` on
   * `RunList`. Returning null from here rather than branching at the three
   * call sites keeps the three loading/error/loaded branches identical, which
   * is the same reason `controls` is built once above them.
   */
  readonly show?: boolean;
  readonly heading: string;
  readonly count?: number;
  readonly hasMore?: boolean;
  readonly action?: ReactNode;
}) {
  if (!show) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
        {count !== undefined && count > 0 && (
          <p className="text-[0.8125rem] text-muted">
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
  emptyBody,
  filtered,
  onFirstPage,
  onClearFilters,
}: {
  cursor: string | null;
  projectSlug: string | null;
  emptyBody: string | undefined;
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
        emptyBody ??
        (projectSlug === null
          ? 'Runs appear here once a test bundle is uploaded to one of this organisation’s projects.'
          : 'Runs appear here once a test bundle is uploaded to this project.')
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

/**
 * The filter form, folded away on a phone — review M18.
 *
 * ═══ WHY THIS IS A DISCLOSURE AND NOT A CLASS ═══
 *
 * Measured at 375px: the expanded form is 314px — a search box, two selects
 * and an Apply button — sitting between the heading and a list whose first row
 * then began at y=908 on an 812px screen. Hiding it with `hidden` would cost
 * the same DOM and give back the height; a `<details>` gives back the height
 * AND keeps every control one tap away, with the browser's own keyboard
 * behaviour.
 *
 * ═══ IT OPENS ITSELF WHEN A FILTER IS ON ═══
 *
 * Collapsed-by-default is right for the ordinary case and wrong for a reader
 * who followed a filtered link: a shortened list under a closed control is a
 * list that looks like it is missing runs. `open` therefore tracks whether
 * anything is actually narrowing the view — including a query parameter this
 * list had to ignore, which is the case where the explanation matters most and
 * lives inside the form.
 *
 * The summary says WHICH filters are on rather than that some are, because
 * "Filters (2)" is a number a reader then has to open the panel to read.
 */
function CompactFilters({
  active,
  filters,
  children,
}: {
  readonly active: boolean;
  readonly filters: RunListFilters;
  readonly children: ReactNode;
}) {
  /* ═══ `q` IS `undefined` WHEN ABSENT, NOT `null` ═══
   *
   * `filtersFromParams` spells it `params.get('q') ?? undefined`, so the first
   * version of this — which tested for `null` and `''` — rendered the literal
   * summary `Filter runs “undefined”` on every unfiltered list. Nothing threw,
   * no test failed, and it was found by opening the page at 375px.
   *
   * A `typeof` check rather than another value in the comparison chain: this
   * field has now been three things (absent, empty, a string) and a list of
   * falsy spellings is exactly how it came to be wrong once. */
  const query = typeof filters.q === 'string' ? filters.q.trim() : '';
  const on = [
    query === '' ? null : `“${query}”`,
    filters.status,
    filters.verdict === null ? null : VERDICT_FILTERS.find((v) => v.value === filters.verdict)?.label,
  ].filter((value): value is string => value != null && value !== '');

  return (
    <details open={active} data-testid="compact-filters" className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-lg border border-default bg-surface px-3 py-2 text-[0.8125rem] font-medium text-primary">
        <FilterIcon className="h-3.5 w-3.5 text-muted" />
        Filter runs
        {on.length > 0 && <span className="font-normal text-muted">{on.join(' · ')}</span>}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

/* ======================================================================== *
 * THE LIST, AS CARDS (review M18)
 * ======================================================================== */

/**
 * One card per run, for viewports where eight columns cannot be columns.
 *
 * ═══ THE SAME FIELDS, RE-STACKED — NOTHING IS DROPPED ═══
 *
 * Started, project, simulation, status, verdict (with any failed simulation
 * assertion), p95, errors and environment are all here. A phone list that quietly showed fewer facts than a
 * desktop one would be the harder failure to notice: the reader has no way to
 * know what they are not being shown, and triage decisions would differ by
 * device.
 *
 * What changes is the ORDER, because a card is read top-to-bottom and a row is
 * scanned left-to-right. The link and the two triage numbers come first; the
 * provenance a reader checks second (project, environment, when) follows.
 *
 * ═══ A LIST, NOT A TABLE WITH `display: block` ═══
 *
 * Restyling the `<table>` responsively is the tempting move and it breaks the
 * semantics: cells stripped of their row and column lose the header
 * association that makes a data table readable at all with a screen reader.
 * A `<ul>` of cards claims to be what it is. The table's caveat travels with
 * it, behind the same info, so it is not desktop-only either.
 *
 * The testids are UNCHANGED from `RunRow` on purpose — `run-row`, `run-p95`,
 * `run-error-rate` and the rest are a contract this file's own docstring
 * records, and a compact layout is not a reason for a spec to have to know
 * which one it is looking at.
 */
function RunCards({
  items,
  showProject,
  identifyByRunId,
  info,
}: {
  readonly items: readonly RunListItem[];
  readonly showProject: boolean;
  readonly identifyByRunId: boolean;
  /** The same caveat the table's frame carries, behind the same kind of info. */
  readonly info: ReactNode;
}) {
  return (
    <section aria-label="Runs" className="flex flex-col gap-3">
      {/* A list of cards has no `<caption>`, so the caveat rides on an info
          beside it — the same one the desktop table's frame carries. */}
      <div className="flex justify-end">
        <InfoTip label="About Runs">{info}</InfoTip>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            showProject={showProject}
            identifyByRunId={identifyByRunId}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The run's note, as one muted line under its simulation — the TEXT alone,
 * since a list answers "is this one to ignore" and the author and time belong
 * to the run's page.
 *
 * `max-w-[32ch]` and `line-clamp-2` are NOT what keeps the Simulation column
 * narrow — MEASURED, with both removed: p95/Errors still land at 500/565 of
 * 726 px visible at 768, 500/565 of 694 at 1024, and 612/678 of 1110 at
 * 1440. What actually holds the column is that the note WRAPS: prose breaks
 * between words (`[word-break:normal]`, kept from when the cell above it was
 * `break-all` and `word-break` was inherited; harmless now that the name is
 * drawn in no-wrap pieces), inside a `min-w-0` cell (`run-simulation`, above)
 * — so this note's min-content is tiny, and the table's automatic layout
 * shrinks the column and wraps the note to fit rather than growing the
 * table.
 *
 * AN UNBROKEN TOKEN — A URL, A STACK-TRACE FRAGMENT, A PATH — IS THE HAZARD,
 * AND IT WAS REAL, MEASURED IN A BROWSER RATHER THAN ASSUMED. A 300-character
 * token with no spaces has no break opportunity for `overflow-wrap:
 * break-word` (`break-words`) to use: that property adds none to a box's
 * MIN-CONTENT width, only `overflow-wrap: anywhere` does. `run-note.spec.ts`'s
 * unbroken-token case caught it exactly where the docstring here used to
 * (wrongly) call it "untouched": Errors reached 737px of 726px visible at
 * 768, and 737px of 694px at 1024 — p95 stayed inside bounds at both. It is
 * `wrap-anywhere` now (Tailwind's name for `overflow-wrap: anywhere`), which
 * only takes effect once every other break opportunity is exhausted, so it
 * changes nothing about how a note of ordinary words wraps.
 *
 * So `max-w-[32ch]` and `line-clamp-2` are the DESIGN, not the guard: a
 * readable measure and at most two lines, so a noted row stays compact next
 * to one without a note. `run-note.spec.ts` pins exactly that — the note's
 * own height and width, alongside the reach both the long-sentence and the
 * unbroken-token cases measure.
 *
 * WHERE EACH ONE BINDS, measured, because "the design" is not "decoration":
 * the clamp binds everywhere (a 500-character note is 954 px tall at 768
 * without it). The measure does NOT bind in the table today — the note is
 * 70-183 px wide there against 32ch's 242 — and DOES on a phone's card
 * (`RunCard`, block layout), where an uncapped note runs 317 px, the card's
 * full width. That phone case is the spec's proof the measure can fail.
 */
function NoteLine({ note }: { readonly note: string | null | undefined }) {
  if (note == null) return null;
  return (
    <p
      data-testid="run-note-line"
      className="mt-0.5 line-clamp-2 max-w-[32ch] text-[0.75rem] font-normal text-muted [word-break:normal] wrap-anywhere"
    >
      <span className="sr-only">Note: </span>
      {note}
    </p>
  );
}

/**
 * ═══ THE NAME AND ITS COPY BUTTON, AS TWO TRACKS ═══ (backlog #4)
 *
 * MEASURED, the obvious markup — the button inline after the link — made rows
 * 19 to 24 px taller at every width from 768 to 1440 while p95 and Errors did
 * not move: the button fell onto a line of its own. Below ~1400px this table
 * is wider than its box, so every column sits at its MINIMUM, and the
 * Simulation column's minimum was its header word ("Simulation", 61px,
 * `whitespace-nowrap`), because a `break-all` name could shrink to one
 * character. The
 * column never grew for the button, so the button took its width out of the
 * name's.
 *
 * THE FIX HAS TWO HALVES AND NEEDS BOTH. The header reserves the button's
 * 24px (`pr-9` on it, in the table head above), which moves the column's
 * minimum; this grid gives the button a track the name cannot flow under, so
 * the name keeps exactly the width it had. The grid ALONE measured worse: the
 * name lost 28 of its 61px and rows at 768 went from 75 to 134px.
 *
 * `minmax(min-content, 1fr)`, NOT `minmax(0, 1fr)` (clean UI, PR 3). The name
 * was `break-all`, so a zero minimum let it break anywhere to fit. It is drawn
 * in no-wrap pieces now (`SimulationName`), and a zero minimum let the widest
 * piece run under the button — "simulations." did, at 768. The track's
 * minimum is its longest piece instead, which is about one word: the column
 * can still shrink as far as a line that ends between words allows.
 *
 * WHAT IT STILL COSTS, measured with the 56-character class beside short ones:
 *
 *   768 / 1024   rows unchanged; p95 490 -> 514, Errors 556 -> 580 (of 726 / 694)
 *   1440         the table fits its box and this column gets the leftover, so
 *                a name within 24px of its edge gains a line (41 -> 56px)
 *   375, cards   the name shares a line with the badges; a card whose name
 *                wraps once more grows 15px (155 -> 170)
 *
 * Those figures predate the clean-UI pass, whose package line puts every
 * simulation name on at least two lines; re-measure before quoting them.
 *
 * Inherent to putting the button beside the name, which is where a reader
 * looks for the id of the thing they are reading.
 */
function IdentityCell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(min-content,1fr)_auto] items-start">{children}</div>
  );
}

function RunCard({
  run,
  showProject,
  identifyByRunId,
}: {
  readonly run: RunListItem;
  readonly showProject: boolean;
  readonly identifyByRunId: boolean;
}) {
  // The value the API ORDERS BY, spelled the same way here as in `RunRow` —
  // see that component for why displaying anything else renders a
  // correctly-sorted list that reads as mis-sorted.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;
  const label =
    identifyByRunId && run.runNumber !== null && run.runNumber !== undefined ? (
      runName(run.runNumber)
    ) : identifyByRunId || run.simulation === null || run.simulation === undefined ? (
      run.id.slice(0, 8)
    ) : (
      <SimulationName name={run.simulation} />
    );

  return (
    <li
      data-testid="run-row"
      data-run-id={run.id}
      className="flex flex-col gap-2 rounded-xl border border-default bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div data-testid="run-simulation" className="min-w-0">
          <IdentityCell>
            <Link
              to={runPath(run.id)}
              aria-label={`View run ${run.id}`}
              className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
            >
              {label}
            </Link>
            {/* A finger has to hit it on a phone, so the card takes the touch
                size; the value is the WHOLE id either way (backlog #4). */}
            <CopyIdButton value={run.id} label={`Copy run id ${run.id}`} size="touch" />
          </IdentityCell>
          <NoteLine note={run.note} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge mark={STATUS[run.status]} />
          <Badge mark={VERDICT[run.verdict ?? 'none']} />
          <AssertionLine checks={run.checks} />
        </div>
      </div>

      {/* THE TWO TRIAGE NUMBERS, SIDE BY SIDE AND FIRST. On the table they
          follow identity and outcome, and a phone had to scroll sideways to
          reach them; they are the whole reason a reader looks at this list without
          opening a run. `—` rather than `0` for anything unavailable, exactly
          as in `RunRow`: a zero in a latency column is a measurement. */}
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.8125rem]">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted">p95</dt>
          <dd data-testid="run-p95" className="tabular-nums text-primary">
            {run.metrics?.p95Ms == null ? '—' : `${Math.round(run.metrics.p95Ms)} ms`}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted">Errors</dt>
          <dd data-testid="run-error-rate" className="tabular-nums">
            {run.metrics == null ? (
              <span className="text-primary">—</span>
            ) : (
              <span
                /* The status palette as data — those tokens live on `:root`
                   and NOT in `@theme`, so `text-status-failed` emits nothing
                   at all. Same route `RunRow` and `Badge` take. */
                style={
                  run.metrics.errorRate > 0
                    ? { color: 'var(--color-status-failed)' }
                    : undefined
                }
                className={run.metrics.errorRate > 0 ? undefined : 'text-primary'}
              >
                {`${(run.metrics.errorRate * 100).toFixed(2)}%`}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/* PROVENANCE LAST: which project, which environment, and when. The
          reader who needs these is confirming a row they have already picked
          out by the numbers above. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-muted">
        {showProject && (
          <>
            {/* `break-all`, because unlike a class name it has no word to break at:
                a project name is free text up to 120 characters and may
                contain no space at all, and this card is the WHOLE layout
                below 768px. MEASURED at 320px with a 120-character unbroken
                name: the document's scrollWidth reached 815px against a 320px
                viewport — every page acquiring a horizontal scrollbar because
                one project was named badly. */}
            <span className="break-all text-primary">{run.project.name}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span data-testid="run-environment">
          {run.environment == null || run.environment === '' ? 'no environment' : run.environment}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="run-started">
          <time dateTime={startedAt} className="tabular-nums">
            {formatInstant(startedAt)}
          </time>
          {isIngestTime && <span className="ml-1">(ingest time)</span>}
        </span>
      </p>
    </li>
  );
}

function RunRow({
  run,
  showProject,
  identifyByRunId,
  headerZone,
}: {
  readonly run: RunListItem;
  /** False on a project-scoped list, where every row's project is the same. */
  readonly showProject: boolean;
  /**
   * True on a TEST-scoped list, where every row's simulation is the same. The
   * column keeps its place and its link — it is the row's only route to the
   * run — and shows the short id instead, which is the thing that actually
   * tells two runs of one test apart.
   */
  readonly identifyByRunId: boolean;
  /** The zone Started's header names; this row shows its own only if it differs. */
  readonly headerZone: string;
}) {
  // The value the API ORDERS BY, spelled the same way here — RunRepository.list
  // sorts on COALESCE(tool_started_at, started_at) DESC. Displaying anything
  // else (startedAt alone, say) renders a correctly-sorted list that reads as
  // mis-sorted, which is worse than an obvious bug because nothing looks broken.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;
  const rowZone = zoneLabel(startedAt);

  return (
    <tr data-testid="run-row" data-run-id={run.id} className={ROW}>
      {showProject && <td className={TD}>{run.project.name}</td>}
      {/* The testid stays `run-simulation` in both modes, deliberately: the
          e2e suite and `helpers.ts` reach for it as "the cell holding the row's
          link to its run", which is what it has always been and still is. What
          changes is the value shown, not the cell's job. */}
      {/* ═══ A CLASS NAME CANNOT WRAP, SO IT IS DRAWN IN PIECES ═══
          (the 09-13 review's acceptance list: long names; clean UI, PR 3)

          UAX#14 gives no break after a full stop followed by a letter, so
          `com.acme.checkout.simulations.CheckoutPeakLoadSimulation` is one
          56-character word. In a plain cell it took its width out of the
          columns beside it — MEASURED at 768px it pushed Errors' right edge to
          885px of 726px visible. `break-all` fixed that and broke the name
          anywhere ("example.P / aritySimul / ation"). `SimulationName` breaks
          it only between whole pieces — after a package dot or between
          camelCase words — so the column is no wider than `break-all` let it
          be and a line never ends mid-word.

          `min-w-0` is not optional: a table cell's min-content width is its
          longest unbreakable run, and without it the cell refuses to shrink
          whatever the text inside allows. */}
      <td data-testid="run-simulation" className={`${TD} min-w-0`}>
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
        <IdentityCell>
          <Link
            to={runPath(run.id)}
            aria-label={`View run ${run.id}`}
            className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
          >
            {/* On a test's list the simulation is the page's own heading, so
                repeating it down every row says nothing; what distinguishes
                these runs from each other is its number — `Run 12`, spec
                2026-09-27-run-number — once it has one, else the short id, the
                same fallback this column showed before numbering existed.
                Elsewhere the simulation is what a reader is scanning for,
                falling back to the short id for a run the worker has not
                parsed. Either way the accessible name above carries the WHOLE
                id, because a column of numbers or eight-character prefixes
                names nothing on its own. */}
            {identifyByRunId && run.runNumber !== null && run.runNumber !== undefined ? (
              runName(run.runNumber)
            ) : identifyByRunId || run.simulation === null || run.simulation === undefined ? (
              <code className="text-[0.75rem]">{run.id.slice(0, 8)}</code>
            ) : (
              <SimulationName name={run.simulation} />
            )}
          </Link>
          {/* The FULL id, whatever the link shows: a test's list displays its
              number, or its short id when it has none, and nothing that takes
              a run id accepts either (backlog #4). Beside the link rather than
              inside it, so a click meant for the button never navigates. */}
          <CopyIdButton value={run.id} label={`Copy run id ${run.id}`} size="row" />
        </IdentityCell>
        <NoteLine note={run.note} />
      </td>
      <td className={TD}>
        <Badge mark={STATUS[run.status]} />
      </td>
      <td className={TD}>
        <Badge mark={VERDICT[run.verdict ?? 'none']} />
        <AssertionLine checks={run.checks} />
      </td>

      {/* ═══ THE TRIAGE CELLS ═══
       *
       * `—` for anything unavailable, never `0`. A run still parsing, or one
       * whose bundle produced no statistics, HAS no p95 — and a zero in a
       * latency column is a measurement, which is the wrong claim entirely.
       * The em dash is the same absence the statistics table draws.
       *
       * `tabular-nums` so the digits line up down the column; these exist to
       * be scanned against each other rather than read one at a time. */}
      <td className={`${TD} tabular-nums whitespace-nowrap`} data-testid="run-p95">
        {run.metrics?.p95Ms == null ? '—' : `${Math.round(run.metrics.p95Ms)} ms`}
      </td>
      <td className={`${TD} tabular-nums whitespace-nowrap`} data-testid="run-error-rate">
        {run.metrics == null ? (
          '—'
        ) : (
          <span
            /* The status palette as data, the `Badge`/`StatTile` route: those
               tokens live on `:root` and NOT in `@theme`, so a
               `text-status-failed` utility emits nothing at all. */
            style={
              run.metrics.errorRate > 0
                ? { color: 'var(--color-status-failed)' }
                : undefined
            }
          >
            {`${(run.metrics.errorRate * 100).toFixed(2)}%`}
          </span>
        )}
      </td>
      <td data-testid="run-started" className={`${TD} whitespace-nowrap`}>
        {/* <time dateTime> carries the machine-readable instant next to the
            human one. That is the correct markup for a rendered date
            regardless of testing — and it is also what lets the e2e suite
            assert the ORDER of what is displayed, since the formatted text is
            localised and does not sort. The attribute is the API's own ISO
            string, unmodified. */}
        <time dateTime={startedAt} className="tabular-nums">
          {formatListInstant(startedAt)}
        </time>
        {rowZone !== headerZone && (
          <span data-testid="run-started-zone" className="ml-1 text-muted">
            {rowZone}
          </span>
        )}
        {isIngestTime && <span className="ml-2 text-[0.75rem] text-muted">ingest time</span>}
      </td>
      <td className={TD} data-testid="run-environment">
        {run.environment == null || run.environment === '' ? '—' : run.environment}
      </td>
    </tr>
  );
}

/**
 * ═══ THE ONE FACT FOCUS CARRIED THAT NOTHING ELSE DID (clean UI, PR 3) ═══
 *
 * Focus read "investigate" when a run failed, stopped early, failed its SLA
 * verdict, or its SIMULATION had a failing assertion — and the first three are
 * what Status and Verdict already say, on every row. Only the fourth was
 * Focus's own: a platform verdict of "passed" over a Gatling assertion that
 * failed. So Focus is gone and that fact sits under the verdict it qualifies,
 * drawn only when it happened.
 *
 * `checks` is null for a run that reported no assertions, which is not a
 * failure. The colour is the status palette's own route — those tokens live on
 * `:root` and not in `@theme`, so a `text-status-failed` utility emits
 * nothing. `basis-full` puts it on its own line inside the card's badge group;
 * in a table cell it is simply a block.
 */
function AssertionLine({ checks }: { readonly checks: RunListItem['checks'] }) {
  if (checks == null || checks.failed <= 0) return null;
  return (
    <span
      data-testid="run-assertions-failed"
      className="mt-1 block basis-full text-[0.75rem] font-medium"
      style={{ color: 'var(--color-status-failed)' }}
    >
      {checks.failed} {checks.failed === 1 ? 'assertion' : 'assertions'} failed
    </span>
  );
}
