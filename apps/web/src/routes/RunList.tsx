import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { RunListResponse } from '@perfportal/contracts';
import Badge from '../components/Badge';
import Button, { linkButtonClasses } from '../components/Button';
import { ChevronLeftIcon, ChevronRightIcon, FilterIcon, PlusIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame, { CAPTION_LESS, CAPTION_MORE } from '../components/TableFrame';
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
  testSlug = null,
  heading = 'Runs',
  showHeading = true,
  titlesDocument = true,
  caption: captionOverride,
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
  /**
   * The table's own description. Defaults to the org/project sentence below;
   * a caller with a narrower scope supplies a truer one, because the default
   * says "every run in this project" and a test's page is showing a subset of
   * exactly that.
   */
  readonly caption?: ReactNode;
  /** What "no runs yet" means in this scope. Same reasoning as `caption`. */
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
      {/* `showHeader={false}`: the disclosure's own summary already reads
          "Filter runs", and two identical labels eight pixels apart is the
          same duplicate-heading problem `ProjectRules.showTitle` solves one
          page over. */}
      <RunListControls
        filters={filters}
        ignored={ignored}
        active={filtersActive || ignored.length > 0}
        onApply={applyFilters}
        onClear={clearFilters}
        showHeader={false}
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
              NINE on the org-wide list — Project, Simulation, Status, Verdict,
              p95, Errors, Focus, Started, Environment — and eight on a
              project's, where the constant Project column is dropped. A
              placeholder whose shape is not the arriving content's is a
              layout jump dressed as a loading state: the whole point of
              drawing one is that nothing moves when the data lands.

              DERIVED FROM THE SAME CONDITION THE HEADER USES
              (`projectSlug === null`), so the two cannot drift — a literal
              here is what let it be wrong by three for as long as it was,
              through two column changes that never thought to look at it. */}
          <SkeletonTable columns={projectSlug === null ? 9 : 8} rows={6} />
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

  /* THE SHORT LINE BOTH LAYOUTS SHOW. It was written inline on the
     `TableFrame` below as "Every run in your organisation, newest first." —
     true on `/runs` and false on a project's own list, which is the same
     scope mistake the long caption directly beneath it takes care to avoid.
     One expression now, so the two cannot disagree. */
  const summaryLine =
    projectSlug === null
      ? 'Every run in your organisation, newest first.'
      : 'Every run in this project, newest first.';

  const caption = captionOverride ?? (
    <>
      {projectSlug === null ? 'Every run in your organisation' : 'Every run in this project'},
      newest first, with the project it belongs to. “Started” is the load test’s own start time;
      rows marked <em>ingest time</em> have not been parsed yet, so they fall back to when
      PerfPortal received the run. Focus is the first operational action to take from the row.
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
          <RunListHealth items={items} />
          {/* ═══ NINE COLUMNS DO NOT FIT ON A PHONE, AND SCROLLING THEM
              SIDEWAYS IS NOT A FIX (review M18) ═══

              `TableFrame` already stops the caption running off the side, but
              the TABLE still scrolls horizontally inside its box — so a reader
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
              caption={caption}
              summary={summaryLine}
            />
          ) : (
          /* ONE `caption` NODE, rendered visibly outside the scroll box and
             programmatically inside the table — see `TableFrame`'s docstring for
             why a `<caption>` inside `overflow-x-auto` stops wrapping and runs
             off the side of a phone. */
          <TableFrame
            caption={caption}
            summary={summaryLine}
            label={`${heading} table`}
          >
              <table className={TABLE}>
                <caption className="sr-only">{caption}</caption>
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
                    <th scope="col" className={TH}>
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
                    <th scope="col" className={TH}>
                      Focus
                    </th>
                    {/* ═══ CONTEXT AFTER TRIAGE, BECAUSE THIS TABLE SCROLLS ═══
                        (review 09-13's acceptance list)

                        MEASURED on the org-wide list: the table wants 1078px
                        and the content column gives it 726 at 768, 858 at 900,
                        694 at 1024 (the rail appears at `lg:` and takes ~270),
                        770 at 1100 and 950 at 1280. It fits at 1440 and
                        NOWHERE BELOW — so this table has always scrolled
                        sideways on most real screens.

                        The scroll itself is allowed: the review says
                        "table-local horizontal scroll is acceptable when row
                        identity, headers, and controls remain usable". What
                        was not allowed is WHICH columns fell off the end.
                        Started alone is 239px — 22% of the table for a
                        timestamp carrying a year and a zone — so p95 and
                        Errors sat at 823 and 889px cumulative and were off
                        every screen narrower than 1440. Those two are the
                        columns triage turns on; `mobile.spec.ts` says so in as
                        many words for the phone layout.

                        So identity, outcome, the two measurements and the
                        suggested action come first — 742px, which is on screen
                        at 768, 900, 1100 and 1280 — and WHEN and WHERE, which
                        are context rather than triage, are what a reader
                        scrolls to. Nothing is hidden and no column is dropped.

                        1024 IS THE ONE WIDTH THIS DOES NOT FULLY FIX, and it
                        is worth knowing why: 694px there is less than 900 gets,
                        because the project rail opens at exactly that
                        breakpoint. Collapsing the rail — a control that already
                        exists — returns ~270px and the whole triage set with
                        it. */}
                    <th scope="col" className={TH}>
                      Started
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
  showHeader = true,
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
  readonly showHeader?: boolean;
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
      {showHeader && (
        <div className="flex items-center gap-2 text-[0.8125rem] font-medium text-primary">
          <FilterIcon className="h-3.5 w-3.5" />
          Filter runs
        </div>
      )}

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

      <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_180px_180px_auto] md:items-end">
        <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-muted">
          Search runs
          <input
            className={INPUT}
            value={q}
            onChange={(event) => setQ(event.currentTarget.value)}
            placeholder="Simulation, project, branch"
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
      /* ═══ A PAGE-LOCAL TALLY, DRAWN AS ONE ═══
       *
       * These counts are honest about being page-local and then took
       * dashboard-card treatment anyway — four large tiles above the work
       * list, in the position an organisation-wide health summary occupies.
       * An overview should not change meaning when the reader presses Next,
       * and this one does.
       *
       * Computing them across the filtered SET is the other repair the review
       * offers and it needs an endpoint that counts — keyset pagination never
       * learns a total, which is the same reason the heading says "6 runs" and
       * not "6 of 42". So the tally is demoted rather than inflated: the same
       * four numbers, at the weight of a caption, beside the list they
       * describe instead of above it as a dashboard. */
      className="rounded-lg border border-default bg-surface px-4 py-3"
    >
      {/* THE SECOND CAVEAT IS THE ONE THAT CHANGES A DECISION. The first says
          the counts are page-local. This one says WHICH SYSTEMS they count:
          execution state and the platform SLA verdict, which is all
          `GET /v1/runs` returns — `RunListResponseSchema` picks nine fields
          and none of them carries the simulation's own assertions.

          Without it, "Needs attention: 0" sat above a run whose simulation had
          a failing check, and a tile reading zero is a claim an engineer
          triages on. Counting those here needs a field the list endpoint does
          not have; saying so does not. */}
      {/* ═══ THE SCOPE VISIBLE, THE METHODOLOGY ONE TAP AWAY ═══
          (review 09-13, "Copy changes to make immediately")

          The row is "Long run-health caveat" -> "`On this page` + accessible
          `How counts work` disclosure with the corrected definition", under a
          preamble that says to "move methodology out of the primary reading
          path".

          M18 built half of this: below 768px the caveat became a `<details>`,
          because 117px of prose above four tiles on a 375px screen was pushing
          the first run row to y=908. On a DESKTOP it stayed a paragraph, on
          the reasoning that two lines there read as part of the tally — and
          that is the half the copy table is objecting to, on the 1440x900
          viewport the review was written against. The correctness fix that
          landed since made it longer, not shorter: 45 rendered words became
          67.

          ONE SHAPE AT EVERY WIDTH NOW. The SCOPE is the fact a reader needs
          without asking — these four numbers are about this page, not the
          list — so it is visible, short, and beside the counts it qualifies.
          Everything else is methodology and sits behind the disclosure, which
          is what "accessible" asks for: a native `<summary>` is a real control
          with real keyboard behaviour, and it contributes an ARIA group rather
          than a heading, so no page's heading outline moves.

          Nothing is deleted. Both caveats are load-bearing — one says the
          counts are page-local, the other says WHICH systems they count, and
          the second is why "Needs attention: 0" is not a claim about a
          simulation's own assertions. */}
      <p className="text-[0.75rem] font-medium text-muted" data-testid="health-scope">
        {HEALTH_SCOPE(items.length)}
      </p>
      <details className="group mt-1">
        <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
          <span className="group-open:hidden">How counts work</span>
          <span className="hidden group-open:inline">Hide how counts work</span>
        </summary>
        <p className="pt-1.5 text-[0.75rem] leading-relaxed text-muted">{HEALTH_CAVEAT()}</p>
      </details>
      {/* TWO ACROSS FROM THE NARROWEST WIDTH, not one. Measured at 375px:
          stacked one per row these four tiles were 326px, and they sit between
          the heading and the list the page is for — so the first run card
          began at y=561 on an 812px screen. Two columns halves that for four
          counts that are each a word and a number. */}
      <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
        <HealthTile
          label="Needs attention"
          value={summary.needsAttention}
          // The FOURTH condition was missing here too — see `needsAttention`,
          // which has read a simulation's own checks since M02 widened the
          // list contract.
          detail="Failed, incomplete, SLA failed, or a failed check"
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
    /* One line per count, not a card. The number leads and stays coloured —
       it is still the thing being read — but at the weight of a caption
       rather than a dashboard tile, because it describes this PAGE. */
    <div className="flex items-baseline gap-2" style={{ color: colour }}>
      <span className="font-mono text-base font-semibold tabular-nums text-primary">{value}</span>
      <span className="text-[0.75rem] text-primary">{label}</span>
      <span className="text-[0.6875rem] text-muted">{detail}</span>
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
 * The tally's two caveats, as one string both layouts render.
 *
 * A function rather than a constant because the first clause counts the page.
 * Shared so the collapsed and the expanded form cannot drift — the failure
 * that would hide is a phone quietly reading a WEAKER caveat than a desktop,
 * which nobody would notice until somebody triaged on it.
 */
/**
 * ═══ THIS SENTENCE WENT STALE UNDER ITS OWN FEATURE (review 09-13 C05) ═══
 *
 * It used to read "They count execution state and this platform's SLA verdict
 * — NOT the assertions a simulation declares for itself", and that was exactly
 * right when it was written: `RunListResponseSchema` picked nine fields and
 * none of them carried a simulation's own outcomes, so the count genuinely
 * could not see them.
 *
 * M02 then put `checks` on the list and `needsAttention` started reading it —
 * which is the whole point of that work, and is what makes "Needs attention"
 * usable. The caveat was never revisited, so the page spent two branches
 * telling the reader the opposite of what the number beneath it meant. The
 * sample makes it obvious: one complete run, no SLA verdict, "Needs attention
 * 1", under a paragraph swearing checks are not counted.
 *
 * Worse, the M18 branch MOVED this paragraph and pinned it with a test
 * asserting "the words are not weakened" — preserving a sentence that had
 * already become false. **Prose that describes a calculation has to be re-read
 * against the calculation, not carried across intact.** This file already
 * records the same lesson for `tokens.test.ts`, one layer down: a stale
 * comment naming an old spelling is exactly as misleading as a stale class.
 *
 * ═══ AND THE FOUR ARE NOT A PARTITION ═══
 *
 * Said out loud now rather than left to be discovered. `needsAttention` and
 * `unjudged` are independent questions — "is something wrong" and "did a gate
 * judge it" — so the run in the sample is counted by both, correctly. Four
 * numbers sitting in a row read as a breakdown that sums to the page, and this
 * one does not.
 */
const HEALTH_SCOPE = (count: number): string =>
  `On this page · ${count} ${count === 1 ? 'run' : 'runs'}`;

const HEALTH_CAVEAT = (): string =>
  'Paging or filtering changes these; they are not totals for the whole list. A run can be ' +
  'counted more than once — “Needs attention” asks whether anything failed, and “Unjudged” asks ' +
  'whether a gate reached a verdict, which are different questions. Failures counted here are ' +
  'execution state, this platform’s SLA verdict, and the checks a simulation declares for ' +
  'itself.';

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
 * One card per run, for viewports where nine columns cannot be columns.
 *
 * ═══ THE SAME FIELDS, RE-STACKED — NOTHING IS DROPPED ═══
 *
 * Started, project, simulation, status, verdict, p95, errors, environment and
 * focus are all here. A phone list that quietly showed fewer facts than a
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
 * A `<ul>` of cards claims to be what it is. The `caption` prose travels with
 * it, so the explanation of what the list holds is not desktop-only either.
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
  caption,
  summary,
}: {
  readonly items: readonly RunListItem[];
  readonly showProject: boolean;
  readonly identifyByRunId: boolean;
  readonly caption: ReactNode;
  readonly summary: string;
}) {
  return (
    <section aria-label="Runs" className="flex flex-col gap-3">
      {/* ═══ THE SHORT LINE, THEN THE REST ON REQUEST ═══
       *
       * `TableFrame` already does this for every table in the app and the
       * reason applies here twice over: measured at 375px, the full caption
       * was a 127px paragraph sitting directly above the list it describes —
       * on the very screen this whole change exists to shorten.
       *
       * NOT `aria-hidden`, unlike `TableFrame`'s copy. That one is hidden
       * because the table's own `<caption class="sr-only">` carries the same
       * words; a list of cards has no caption element, so hiding this would
       * simply delete the explanation for a screen-reader user. Same pattern,
       * opposite a11y contract — which is why the labels are shared and the
       * markup is not. */}
      <div>
        <p className="text-[0.8125rem] leading-relaxed text-muted">{summary}</p>
        <details className="group">
          <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
            <span className="group-open:hidden">{CAPTION_MORE}</span>
            <span className="hidden group-open:inline">{CAPTION_LESS}</span>
          </summary>
          <p className="pt-2 text-[0.8125rem] leading-relaxed text-muted">{caption}</p>
        </details>
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
    identifyByRunId || run.simulation === null || run.simulation === undefined
      ? run.id.slice(0, 8)
      : run.simulation;

  return (
    <li
      data-testid="run-row"
      data-run-id={run.id}
      className="flex flex-col gap-2 rounded-xl border border-default bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div data-testid="run-simulation" className="min-w-0">
          <Link
            to={runPath(run.id)}
            aria-label={`View run ${run.id}`}
            className="transition-ui font-medium break-all text-accent hover:underline hover:underline-offset-2"
          >
            {label}
          </Link>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge mark={STATUS[run.status]} />
          <Badge mark={VERDICT[run.verdict ?? 'none']} />
        </div>
      </div>

      {/* THE TWO TRIAGE NUMBERS, SIDE BY SIDE AND FIRST. On the table these
          are columns 6 and 7 and a phone had to scroll sideways to reach
          them; they are the whole reason a reader looks at this list without
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
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted">Focus</dt>
          <dd>
            <FocusHint focus={focusFor(run)} runId={run.id} />
          </dd>
        </div>
      </dl>

      {/* PROVENANCE LAST: which project, which environment, and when. The
          reader who needs these is confirming a row they have already picked
          out by the numbers above. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-muted">
        {showProject && (
          <>
            {/* `break-all`, for the reason the simulation link above it has it:
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
}) {
  // The value the API ORDERS BY, spelled the same way here — RunRepository.list
  // sorts on COALESCE(tool_started_at, started_at) DESC. Displaying anything
  // else (startedAt alone, say) renders a correctly-sorted list that reads as
  // mis-sorted, which is worse than an obvious bug because nothing looks broken.
  const startedAt = run.toolStartedAt ?? run.startedAt;
  const isIngestTime = run.toolStartedAt == null;

  return (
    <tr data-testid="run-row" data-run-id={run.id} className={ROW}>
      {showProject && <td className={TD}>{run.project.name}</td>}
      {/* The testid stays `run-simulation` in both modes, deliberately: the
          e2e suite and `helpers.ts` reach for it as "the cell holding the row's
          link to its run", which is what it has always been and still is. What
          changes is the value shown, not the cell's job. */}
      {/* ═══ `break-all`, BECAUSE A CLASS NAME CANNOT WRAP ═══
          (the 09-13 review's acceptance list: long names)

          UAX#14 gives no break opportunity after a full stop followed by a
          letter, so `com.acme.checkout.simulations.CheckoutPeakLoadSimulation`
          is one unbreakable 56-character word — the widest string this product
          renders. In a plain cell it took its width out of the columns beside
          it: MEASURED at 768px, it pushed the Errors column's right edge to
          885px of 726px visible, undoing the reorder that put the triage
          columns on screen in the first place. That reorder was measured
          against the reference bundle's `example.ParitySimulation`, 24
          characters, which is why nothing caught it.

          `min-w-0` is the other half and is not optional: a table cell's
          min-content width is its longest unbreakable run, so without it the
          cell refuses to shrink no matter what the text inside is allowed to
          do.

          The mobile CARD for this same value has carried `break-all` since it
          was written (`RunCard` above) — the asymmetry was visible in one
          file, which is the shape CLAUDE.md keeps recording. */}
      <td data-testid="run-simulation" className={`${TD} min-w-0 break-all`}>
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
          {/* On a test's list the simulation is the page's own heading, so
              repeating it down every row says nothing; the short id is what
              distinguishes these runs from each other. Elsewhere the
              simulation is what a reader is scanning for, falling back to the
              short id for a run the worker has not parsed. Either way the
              accessible name above carries the WHOLE id, because a column of
              eight-character prefixes names nothing on its own. */}
          {identifyByRunId || run.simulation === null || run.simulation === undefined ? (
            <code className="text-[0.75rem]">{run.id.slice(0, 8)}</code>
          ) : (
            run.simulation
          )}
        </Link>
      </td>
      <td className={TD}>
        <Badge mark={STATUS[run.status]} />
      </td>
      <td className={TD}>
        <Badge mark={VERDICT[run.verdict ?? 'none']} />
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
        <FocusHint focus={focusFor(run)} runId={run.id} />
      </td>
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
        {isIngestTime && <span className="ml-2 text-[0.75rem] text-muted">ingest time</span>}
      </td>
      <td className={TD} data-testid="run-environment">
        {run.environment == null || run.environment === '' ? '—' : run.environment}
      </td>
    </tr>
  );
}

/**
 * ═══ IT LOOKS LIKE AN ACTION, SO IT IS ONE (review 09-13 M14) ═══
 *
 * The caption calls Focus "the first operational action to take from the row",
 * and `investigate` was drawn in the failed-status colour with medium
 * weight — every affordance of a link, on a `<span>` nothing happens when you
 * click.
 *
 * The review offers both repairs: make it real, or rename it so it stops
 * pretending. Real is better here because the destination exists and is
 * exactly where the reader was going — the run, which opens on the decision
 * band that names the failed check and links to it. The other four states are
 * genuinely statuses (there is nothing to do about "processing"), so they stay
 * text: a row's Focus cell is a link exactly when it is worth following.
 *
 * The accessible name carries the RUN, not the word: "investigate" repeated
 * down a column names nothing, which is the same reason the simulation cell's
 * link spells out `View run ${id}`.
 */
function FocusHint({ focus, runId }: { readonly focus: Focus; readonly runId: string }) {
  const { label, colour } = FOCUS_MARKS[focus];
  if (focus !== 'investigate') {
    return (
      <span className="font-medium whitespace-nowrap" style={{ color: colour }}>
        {label}
      </span>
    );
  }
  return (
    <Link
      to={runPath(runId)}
      aria-label={`Investigate run ${runId}`}
      className="font-medium whitespace-nowrap underline-offset-2 hover:underline"
      style={{ color: colour }}
    >
      {label}
    </Link>
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
  return (
    run.status === 'failed' ||
    run.status === 'incomplete' ||
    run.verdict === 'failed' ||
    // THE CHECK THIS TILE USED TO MISS ENTIRELY. A run whose platform verdict
    // passed while its simulation's own assertion failed is exactly what
    // "Needs attention: 0" was hiding — the list endpoint never sent the
    // outcomes, so the count could not see them. `checks` is null for a run
    // that reported none, which is not a failure.
    (run.checks != null && run.checks.failed > 0)
  );
}

function isInFlight(run: RunListItem): boolean {
  return run.status === 'pending' || run.status === 'parsing' || run.status === 'running';
}
