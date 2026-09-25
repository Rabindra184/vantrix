import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { describeSlaOutcome, formatSlaValue } from '@perfportal/contracts';
import type {
  Assertion, LiveDelta, SeriesResponse, StatRow, ToolAssertion,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import SectionHeading from '../components/SectionHeading';
import { failingRequestNames } from './errorRequestFilter';
import { FinalizedVerdictNotice } from './WholeRunNotice';
import { Skeleton, SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import StatTile from '../components/StatTile';
import TableFrame from '../components/TableFrame';
import { ChevronLeftIcon, DownloadIcon } from '../components/icons';
import { ROW, TABLE, TD, TD_NUM, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { useLiveRun } from '../api/live';
import {
  distributionQuery,
  errorSeriesQuery,
  errorsQuery,
  seriesQuery,
  statsQuery,
  trendsQuery,
  usersQuery,
} from '../api/metrics';
import { POLL_CAP_MS, pollIntervalFor } from '../api/run';
import { formatActual, toolAssertionParts } from './toolAssertion';
import DistributionChart from '../charts/DistributionChart';
import ErrorsChart from '../charts/ErrorsChart';
import PercentileDistributionChart from '../charts/PercentileDistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import RequestCountChart from '../charts/RequestCountChart';
import { RequestRateChart, ResponseRateChart } from '../charts/RatesChart';
import { ConcurrentUsersChart, UserStartRateChart } from '../charts/UsersChart';
import ErrorsTable from '../tables/ErrorsTable';
import { STATISTICS_SKELETON_COLUMNS } from '../tables/StatisticsTable';
import { ERRORS_TABLE_COLUMNS } from '../tables/ErrorsTable';
import StatisticsTable, { formatCount, formatMs } from '../tables/StatisticsTable';
import { downloadCsv } from '../tables/csv';
import { assertionsCsv } from './assertionExport';
import { describeAssertionRuleForReader } from './assertions';
import { baselineRun, cohortRun } from './runBaseline';
import { formatDuration } from './format';
import { ASSERTION_OUTCOME, Marked } from './marks';
import { DEFAULT_ROUTE, projectRulesPath } from './paths';
import { Payload, TableSection, type Slot } from './payload';
import {
  useLiveFromShell,
  useRunTerminal,
  useTimeDomainFromShell, useWarmupFromShell,
  useWindowFromShell,
  useWindowSuffix,
} from './useRunWindow';
import DesktopOnly from './DesktopOnly';
import LiveNotice from './LiveNotice';
import RunShell from './RunShell';
import useIsCompact from '../useIsCompact';
import RunGlossary from './RunGlossary';
import RunStats from './RunStats';
import WaitingPanel from './WaitingPanel';

/**
 * This module's default export renders ONE SHELL for every run state; it
 * renders neither a header nor the SLA rules itself any more. Those moved out
 * when the run page grew tabs: the header is `RunHeader`, rendered by
 * `RunShell`, and the assertions live on `RunOverviewTab`. What is left here
 * is four route components sharing one run — `RunDetail` itself, `RunOverviewTab`,
 * `RunChartsTab` and `RunErrorsTab` (`RunShell`'s tab children) — plus the
 * pieces they share: `Assertions`, the Charts tab's chart-slot constants, and
 * `describeRule`.
 *
 * The last screen of the parity shell, and the end of the definition of done
 * — a person signs in, sees their org's runs, opens one, and reads it.
 *
 * `GET /v1/runs/:id` has three answers (see `fetchRun`): a readable run, a
 * run still being processed, and a problem. Loading and error still get their
 * own early returns below — there is no header to show and no tabs to hand a
 * window to until a run has resolved one way or the other. But a resolved,
 * non-error run — `ready` OR `processing` — now renders the SAME `RunShell`,
 * on the SAME code path, differing only in what `identity`/`status`/`verdict`/
 * `windowable`/`live` it is handed. `RunShell` is a layout route: mounting it
 * for a processing run is what makes `/runs/:id/charts` and the other four tab
 * URLs resolve to anything at all while a run is live, which they could not
 * do when a processing run rendered a standalone `Processing`/`Live` screen
 * with no `<Outlet/>` in it. `verdict`/`windowable` are `undefined` for a
 * processing run rather than branched on — a non-terminal run genuinely has
 * neither, and `undefined` is what `RunShell`/`RunHeader` already read as "not
 * evaluated yet" rather than "no verdict", which is what stops `0s` and "no
 * verdict yet" from appearing on screen as though they were measurements.
 */
export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();

  // The polling cap, held as state rather than computed at render time. A
  // derived `Date.now() - start > CAP` would be correct only at the moments
  // something else happens to re-render — and the whole point of the cap is
  // the moment polling STOPS, when by definition nothing else is happening.
  // A timer that sets state is what makes the message appear when it is true
  // rather than at the next unrelated render.
  const [capReached, setCapReached] = useState(false);

  // `useRunTerminal` is every tab's own read of this same query (see its own
  // docstring, `useRunWindow.ts`); this is the one copy that also needs
  // `refetchInterval` — the decision lives in api/run.ts as a pure function
  // so the cap is testable without waiting two real minutes in a browser.
  // That function also holds the OTHER half of the live exemption below: a
  // `running` run is polled whatever `capReached` says.
  const { detail: run } = useRunTerminal(runId, {
    refetchInterval: (query) => pollIntervalFor(query.state.data, capReached),
  });

  // Gated on the design's own rule (part 2b §4.1), literally:
  // `run.status === 'running' && !useIsCompact()`. `run.data` may still be
  // `undefined` on first paint, or already `ready` — `running` is false in
  // both, correctly, since there is nothing to stream for a run this page
  // is not CURRENTLY showing as running. §22.6: below 768px this page is a
  // read-only summary, and a socket held open to receive a delta every 5s
  // and draw none of it is exactly the "degrading badly" that rule exists
  // to prevent.
  const compact = useIsCompact();
  const running = run.data?.state === 'processing' && run.data.run.status === 'running';
  const live = useLiveRun(runId ?? '', running && !compact);

  // The polling cap, held as state rather than computed at render time. A
  // derived `Date.now() - start > CAP` would be correct only at the moments
  // something else happens to re-render — and the whole point of the cap is
  // the moment polling STOPS, when by definition nothing else is happening.
  // A timer that sets state is what makes the message appear when it is true
  // rather than at the next unrelated render.
  useEffect(() => {
    // Reset the FLAG as well as the timer. `[runId]` already says this
    // component instance can outlive the run it was showing (two /runs/:runId
    // locations in a row, no unmount); without this line, a second run opened
    // after the first hit the cap renders "stopped checking automatically" on
    // its first paint and never polls once.
    //
    // COVERED, finally, by `apps/web/test/RunDetail.polling.test.tsx` — both
    // halves: the timer that sets the flag, and this line that resets it for a
    // second run. That test mounts this component in jsdom and advances fake
    // timers past POLL_CAP_MS, which is what makes the two real minutes the
    // cap needs cost nothing. Until the DOM environment existed this effect
    // had no test that could fail; deleting it left every suite green.
    setCapReached(false);
    // ═══ NO TIMER AT ALL WHILE THE RUN IS STREAMING, AND `running` IS A DEP ═══
    // `pollIntervalFor`'s own exemption keeps a `running` run polling past the
    // cap, but that alone leaves a worse bug one state over: a two-hour soak
    // would trip this timer in its third minute, and the instant it stopped
    // streaming — the exact moment REST finally has something new to say —
    // polling would be capped ALREADY, so the finalizing page would never
    // reach the finished report. Arming the timer on the `running` ->
    // `!running` transition instead gives the frozen page a full, honest cap
    // window measured from when the run actually stopped.
    if (running) return;
    const timer = setTimeout(() => setCapReached(true), POLL_CAP_MS);
    return () => clearTimeout(timer);
  }, [runId, running]);

  // Not reachable through the router — `/runs/:runId` cannot match without a
  // segment — but `useParams` is typed as optional and silently rendering an
  // empty page for `undefined` would be worse than saying so.
  if (runId === undefined) return <NotARun />;

  if (run.isPending) {
    return (
      <LoadingState label="Loading run…">
        <div className="flex flex-col gap-6">
          {/* The shape the run page actually takes: heading block, tab strip,
              stat row, table. Reserving it is what stops the whole page
              jumping when the payload lands. */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-7 w-80 max-w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-9 w-64" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[92px]" />
            ))}
          </div>
          <SkeletonTable columns={STATISTICS_SKELETON_COLUMNS} rows={5} />
        </div>
      </LoadingState>
    );
  }

  if (run.isError) {
    // Show what the server said — including the `remediation` every `/v1`
    // error is required to carry — rather than inventing copy. The 404 for a
    // run in another org arrives here, and the API's own sentence ("No run
    // <id> in this project.") is a better answer than a guess at one.
    const error = run.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      // `titleAs="h1"`: this branch replaces the entire page, so its title IS
      // the document's heading. `ErrorState` defaults to a paragraph for the
      // commoner case where a page keeps its own `<h1>` above the alert.
      <ErrorState
        titleAs="h1"
        title="This run could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
        remediationTestId="problem-remediation"
        action={<BackToRuns />}
      />
    );
  }

  // ONE SHELL FOR EVERY STATE. `RunDetail` used to return `Processing` or
  // `Live` INSTEAD of the shell, which is what made the run-section URLs resolve
  // to nothing while a run was live — `RunShell` is the layout route, so no
  // `<Outlet/>` mounted for them at all. Rendering it here is the whole
  // reachability fix, and it needs no router change.
  const detail = run.data;
  // Both arms of the union satisfy `Partial<RunIdentity> & { id }` — a ready
  // run supplies every field, a processing one supplies what it knows — so
  // this needs no branch, only the shared type.
  const identity = detail.run;

  return (
    <RunShell
      identity={identity}
      status={detail.run.status}
      // THE ONE PLACE THIS BOOLEAN IS DECIDED (IMPORTANT 3) — the same
      // discriminant `useRunTerminal` hands every tab, passed through rather
      // than left for `RunShell` to re-derive from `status` against its own
      // allowlist. See `RunShell`'s own `terminal` docstring for why the two
      // deciding it separately is the trap.
      terminal={detail.state === 'ready'}
      // `undefined`, not `null`, for a non-terminal run: the header omits the
      // badge rather than rendering "no verdict" over a run nobody has finished
      // measuring.
      verdict={detail.state === 'ready' ? detail.run.verdict : undefined}
      assertions={detail.state === 'ready' ? detail.run.assertions : undefined}
      toolAssertions={detail.state === 'ready' ? detail.run.toolAssertions : undefined}
      windowable={detail.state === 'ready' ? detail.run.windowable : undefined}
      live={detail.state === 'processing' ? live : null}
      capReached={capReached}
      onRetry={() => void run.refetch()}
    />
  );
}

function NotARun() {
  return (
    <ErrorState
      titleAs="h1"
      title="No run was named"
      detail="This address does not identify a run."
      action={<BackToRuns />}
    />
  );
}

/**
 * A `<Link>` wearing the secondary button's look — never a `<button>` with an
 * `onClick` that navigates. It is a destination, so it must middle-click into
 * a new tab and show its target in the status bar, which only a real anchor
 * does (see `Button`'s docstring on why there is no `asChild` escape hatch).
 */
function BackToRuns() {
  return (
    <Link to={DEFAULT_ROUTE} className={`${linkButtonClasses} mt-1`}>
      <ChevronLeftIcon className="h-3.5 w-3.5" />
      Back to all runs
    </Link>
  );
}

/**
 * The live wire's own headline numbers, read DIRECTLY from a delta's
 * `summary` — never laundered through a `StatRow`.
 *
 * `RunStats`' six REST tiles read `throughputRps`/`meanMs`/`maxMs`, and
 * `LiveSummarySchema` has no source for any of the three: not a missing
 * field, a missing COMPUTATION (`useLiveRun`'s own module docstring). So
 * this is not `RunStats` fed a partial payload — it is a different, honest
 * set of six numbers, built only from what `count`/`okCount`/`koCount`/
 * `errorRate`/`percentiles`/`maxUsers`/`durationMs` actually are. This run's
 * Overview equivalent once it completes is `RunStats`, not this component,
 * and the two tile sets are deliberately not shape-compatible so they can
 * never be mistaken for one another mid-migration.
 *
 * NEVER WITHHELD, on any viewport — the same rule `RunOverviewTab`'s own
 * comment states for its REST tiles: these are cheap, already-fetched (by
 * the socket, not by this component) numbers, and it is the per-request
 * TABLE a phone cannot usefully render, not a handful of tiles.
 *
 * `frozen` is the same `status !== 'running'` flag that decides whether
 * `LiveNotice[kind="finalizing"]` renders — without it the "Duration So Far"
 * tile said "still streaming" unconditionally, including in a render where a
 * banner elsewhere on the page says streaming has stopped, the tile and the
 * banner disagreeing about the run's own state on the same screen.
 *
 * EXPORTED for the tab that wires it in (design part 2b's Overview tab); this
 * module no longer renders it itself.
 */
export function LiveSummary({
  summary,
  frozen,
}: {
  readonly summary: LiveDelta['summary'];
  readonly frozen: boolean;
}) {
  return (
    <section aria-label="Run totals so far">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          /* ═══ THE LIVE TWIN OF `RunStats`' TILES, AND IT MOVES WITH THEM ═══
             Review N01 renamed the terminal row's vocabulary; this row shows
             the SAME six quantities for a run that is still going, so leaving
             it behind makes the live and finished views of one run disagree
             about what its numbers are called. "So Far" stays — that is a
             fact about this row, not drift. */
          label="Requests so far"
          value={formatCount(summary.count)}
          hint={`${formatCount(summary.okCount)} successful, ${formatCount(summary.koCount)} failed`}
          data-testid="live-stat-total-requests"
        />
        <StatTile
          label="Error rate"
          // Same field and expression `RunStats`' own tile uses
          // (`errorRate * 100`, two decimals) — never `koCount / count`,
          // a second definition of the one number a few tiles away.
          value={`${(summary.errorRate * 100).toFixed(2)}%`}
          hint={`${formatCount(summary.koCount)} of ${formatCount(summary.count)} requests`}
          data-testid="live-stat-error-rate"
        />
        <StatTile
          label="Peak users"
          value={formatCount(summary.maxUsers)}
          hint="concurrent, so far"
          data-testid="live-stat-peak-users"
        />
        <StatTile
          label="Duration so far"
          value={formatDuration(summary.durationMs)}
          hint={frozen ? 'when streaming stopped' : 'still streaming'}
          data-testid="live-stat-duration"
        />
        <StatTile
          label="p95"
          value={livePercentileValue(summary, 'p95')}
          hint="an estimate, so far"
          data-testid="live-stat-p95"
        />
        <StatTile
          label="p99"
          value={livePercentileValue(summary, 'p99')}
          hint="an estimate, so far"
          data-testid="live-stat-p99"
        />
      </dl>
    </section>
  );
}

/**
 * A percentile tile's value, straight off the wire — unlike `RunStats`' own
 * `percentileValue`, this has no `clampPercentile` step, and it no longer
 * needs one.
 *
 * That was not always true and the reason it gave was the wrong one. This
 * comment used to end "a live summary carries neither" — accurate about
 * `LiveSummary`, which has no `minMs`/`maxMs`, and it read as though the live
 * tile therefore had to print whatever arrived. It did: the same p99 that read
 * 2515 while a run streamed read 2503 once it finished, one run, one quantity,
 * two answers split by nothing but whether the run was still going.
 *
 * The conclusion survives, and the mechanism named here used to be wrong too.
 * `Sketch.quantile` does NOT project an interior estimate onto anything: that
 * fix was written, and reverted, because a RELOADED sketch's extremes are
 * bucket-reconstructed rather than exact, so clamping against them clamps
 * against the wrong range. It returns `getValueAtQuantile` unmodified for
 * every rank but the two ends.
 *
 * What actually clamps is `RollupBuilder.finish`, against the row's own
 * exactly-tracked `minMs`/`maxMs` — so `runStat.percentiles` really is inside
 * the range before `delta.ts` copies it onto the wire, and there is nothing
 * left for this function to correct and no range on this payload to do it
 * with. Say the mechanism precisely: a reader who believes the projection
 * lives in `Sketch` concludes every `sketch.quantile()` caller is safe, and
 * that belief is exactly how `tool-assertions.ts` came to judge a Gatling
 * assertion against an estimate 12.46 ms above the run's own maximum.
 *
 * `—`, never `0`, for a project configured with no such percentile: a gap in
 * `summary.percentiles` is not a measurement of zero.
 */
function livePercentileValue(summary: LiveDelta['summary'], key: string): string {
  const raw = summary.percentiles[key];
  if (raw === undefined || !Number.isFinite(raw)) return '—';
  return `${formatMs(raw)} ms`;
}

/* ------------------------------------------------------------------ *
 * The Overview tab (index), §13.2 ⑤ and the assertions — design §6
 * ------------------------------------------------------------------ */

/**
 * `/runs/:runId`, the index child under `RunShell` (design §3, §6).
 *
 * Assertions, then the stat tiles, then the statistics table: the numbers a
 * reader came to read and the SLA verdict beside them, all on the tab that
 * opens first. `RunChartsTab` and `RunErrorsTab` hold the eight figures and
 * the errors table respectively — moved out to their own tabs rather than
 * left on this one, which is what keeps the landing tab to the reading order
 * `RunDetail.tsx` already argued for: "scrolling past eight figures to reach
 * the p99 of one request is the reading order nobody wants."
 *
 * READS `runId` FROM `useParams`, not a prop — the same pattern
 * `RequestDetail` and `GroupDetail` already use, and the reason `RunShell`'s
 * `<Outlet/>` carries no context (see its own docstring). Assertions live
 * only on the run body, so this re-asks for `runQueryKey(runId)` — the SAME
 * key `RunDetail` already holds warm from its own poll, so this PAINTS from
 * that cache immediately rather than showing its own loading state.
 *
 * IT STILL FIRES A SECOND `GET /v1/runs/:id`, though — measured, on Overview's
 * first paint. `runQueryKey` carries no `staleTime` (`run.ts`), on purpose:
 * `pollIntervalFor` re-polls a `processing` run, and a query that never went
 * stale would never be eligible to. Data is stale on arrival by TanStack's own
 * default, so this second mount — a different component, mounted strictly
 * after `RunDetail`'s own fetch already resolved, never in the same commit —
 * refetches in the background even though it renders the cached value with no
 * spinner. This docstring used to claim the SAME free reuse `statsQuery` gets
 * across this page's components; `statsQuery` earns that honestly, with its
 * own `staleTime: Infinity` (`api/metrics.ts`, correct because a completed
 * run's stats never change). This key is not a candidate for the same fix —
 * a pending run's status is precisely a value that changes — so the sentence
 * was wrong rather than merely stale, and is corrected instead of matched.
 *
 * GENUINELY REACHABLE FOR A PROCESSING RUN NOW, too (Task 7) — `RunShell`
 * mounts this index tab for every status, not only `ready`. `WaitingPanel` is
 * what it shows there (fix round 1): Task 7 first left this tab rendering
 * `null` for a processing run, because wiring `WaitingPanel` in required a
 * `capReached` flag it could not safely learn without contradicting
 * `LiveStatusStrip`'s own capped block. `capReached`'s own "checks again" /
 * "stopped checking" copy moved INTO `LiveStatusStrip` instead (fix round 1),
 * which is what makes it safe to mount `WaitingPanel` here: it now says only
 * "this run is still processing" and carries no polling claim of its own to
 * contradict anything.
 *
 * ALSO WHY THIS TAB'S OTHER QUERIES ARE GATED ON `terminal`, NOT MERELY
 * `runId !== undefined` — `apiFetch` has no 202 branch, so before this fix
 * round `statsQuery`/`seriesQuery` fired against a processing run's rows,
 * which do not exist yet, and the reader got error panels instead of
 * `WaitingPanel`. `RunChartsTab` and `RunErrorsTab` carry the identical gate
 * for the identical reason.
 *
 * `WaitingPanel` IS NOT THE ONLY NON-TERMINAL BRANCH ANY MORE (Task 8). Once
 * a delta has arrived this session (`live?.lastDelta`), this tab draws
 * `LiveSummary` — the same six headline tiles the deleted standalone `Live`
 * page drew — under a real header on a real tab, plus a stated notice that
 * the statistics table is withheld rather than a silent gap: it needs
 * per-endpoint rows the live wire excludes on every path, so there is no live
 * version of it at any width.
 */
export function RunOverviewTab() {
  const { runId } = useParams<{ runId: string }>();
  const { detail: run, terminal } = useRunTerminal(runId);
  // The live socket's state, as `RunShell` observed it — read here rather
  // than opened again, per `useLiveFromShell`'s own docstring.
  const live = useLiveFromShell();
  const window = useWindowFromShell();
  const compact = useIsCompact();
  // `terminal`, not merely `runId !== undefined` (fix round 1, Critical 1's
  // fix applied here too) — `apiFetch` has no 202 branch, so firing `/stats`
  // (and, when compact, `/series`) against a processing run's rows, which do
  // not exist yet, is the same defect the brief flagged on `RunChartsTab` and
  // `RunErrorsTab`. This tab was simply unreachable for a processing run
  // before Task 7, which is why the bug had no chance to surface here first.
  const stats = useQuery({ ...statsQuery(runId ?? '', window), enabled: terminal });
  // THE COHORT, FOR ONE NEIGHBOUR — and deliberately NOT on this file's
  // default terms.
  //
  // `trendsQuery` is the one factory in `api/metrics.ts` with no
  // `staleTime`, and its docstring argues that correctly: the Trends TAB
  // draws the whole cohort, and a cohort answer changes when any run of the
  // same simulation is ingested. This consumer wants one entry out of it —
  // the run immediately before this one — which cannot change once it
  // exists. Left on the default, every switch back to Overview re-issued the
  // heaviest read in the app (up to 21 DDSketch blobs deserialised and
  // re-quantiled server-side) to relabel six tiles.
  //
  // `staleTime` is per-OBSERVER in TanStack, so this override buys Overview
  // its cache without touching the Trends tab's own refetch-on-mount, even
  // though both observe the identical key.
  //
  // `window === null` in `enabled`: the deltas are withheld under a brush
  // (see `RunStats` below), so a brushed reader should not pay for the
  // payload either.
  const trends = useQuery({
    ...trendsQuery(runId ?? ''),
    enabled: terminal && window === null,
    staleTime: OVERVIEW_TRENDS_STALE_MS,
  });
  // §22.6's summary needs a SHAPE beside the numbers. The same key the charts
  // tab uses, so a reader who widens the window pays for it once.
  const series = useQuery({
    ...seriesQuery(runId ?? '', 'run', '', 'response_time', window),
    enabled: terminal && compact,
  });

  // Not reachable through the router with `run.data` still `undefined` past
  // first paint — `RunShell` mounts this tab only once `RunDetail` has
  // resolved SOME state for this `runId`, and the query above is then served
  // from that same warm cache entry.
  if (runId === undefined || run.data === undefined) return null;

  // NOT TERMINAL (Task 8): either an honest wait, or the live wire's own
  // headline numbers. `run.data.state === 'processing'`, not `!terminal`,
  // narrows `run.data` to `RunProcessing` directly, which is what lets
  // `run.data.run.status` below type as `RunProcessing['status']` with no
  // assertion — see `useRunTerminal`'s own docstring on why it does not also
  // expose a separate `status` field.
  if (run.data.state === 'processing') {
    const delta = live?.lastDelta ?? null;
    // No delta this session: the ordinary wait, same as any other tab.
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        <LiveSummary summary={delta.summary} frozen={run.data.run.status !== 'running'} />
        {/* Gated exactly as the REAL statistics table is on a finished run
            below — same `what` text — because the table needs per-endpoint
            rows the live wire excludes, so there is no live version of it at
            any width. */}
        <DesktopOnly
          compact={compact}
          what="The per-request statistics table"
          // Review M18 names this wording. It says what the button opens
          // rather than judging the reader for opening it.
          action="Open detailed table"
        >
          {() => <LiveNotice kind="withheld" subject="Statistics" />}
        </DesktopOnly>
      </div>
    );
  }

  // Captured HERE, not read inside `TableSection`'s children callback below:
  // TypeScript drops the narrowing that proved this run is terminal once the
  // expression moves into a closure, and a terminal run is the only shape
  // that carries assertions at all.
  const runAssertions = run.data.run.assertions;

  return (
    <>
      {/* ═══ THE NUMBERS FIRST, THEN THE FAILURES, THEN THE DETAIL ═══
       *
       * Measured at 1440x900 before this: the run's own totals began at
       * y=1570 and the statistics table at y=1745, behind two assertion
       * sections and a 460px time selector. An engineer opening a run to ask
       * "how fast was it, and did anything break" scrolled past everything
       * that answers neither.
       *
       * `RunStats` used to render inside `TableSection`'s callback so that a
       * failed `/stats` explained itself exactly once. That property is kept
       * rather than traded: the tiles are gated on the data being PRESENT and
       * say nothing when it is not, and the `TableSection` below — which owns
       * the "Statistics" heading — is still the single place the failure is
       * explained. What changes is only where the numbers sit when they
       * arrive.
       *
       * The sparklines come with them: §22.6 names "key tiles, sparklines,
       * verdict, error summary" as the mobile summary, and splitting that pair
       * across two screens is what the rule exists to prevent. */}
      {stats.data !== undefined && (
        <>
          <RunStats
            stats={stats.data}
            baseline={window === null ? baselineRun(trends.data, runId) : null}
            /* This run's own cohort row, so the note under the tiles can say
               whether the baseline it names was run under comparable
               conditions. Withheld under a window for the same reason
               `baseline` is: there are no deltas to qualify. */
            current={window === null ? cohortRun(trends.data, runId) : null}
            assertions={runAssertions}
            /* Three things inside change with a window: the empty branch says
               so instead of vanishing, the percentile note names the right
               population, and the SLA tint is withheld because the gate judged
               the whole run. `baseline` already followed the same rule one line
               up — a trend against a windowed number compares two different
               things — so this is that argument applied to the rest. */
            windowed={window !== null}
          />
          {compact && <Sparklines series={series} />}
        </>
      )}

      <Assertions
        runId={runId}
        assertions={runAssertions}
        projectSlug={run.data.run.project.slug}
        windowSelected={window !== null}
      />
      {/* `stats.data` is what makes a target linkable, and it is window-scoped
          — which is the right scoping for a link that carries the window with
          it: the link exists exactly when the analysis it points at has a row
          to show. Until the query resolves there is no link, only the name. */}
      <ToolAssertions
        assertions={run.data.run.toolAssertions}
        runId={runId ?? ''}
        stats={stats.data?.stats ?? null}
        windowSelected={window !== null}
      />

      <TableSection title="Statistics" query={stats} columns={STATISTICS_SKELETON_COLUMNS}>
        {(data) => (
          <>
            {/*
                NO BASELINE UNDER A BRUSH. `stats` above is window-scoped and
                `/trends` is not, so comparing them across a brushed window
                measured a tenth of this run against the whole of the
                previous one — dragging the brush to 10s of a 63s run made
                every tile read about -84% "vs previous", a regression the
                run does not have. There is no windowed cohort endpoint to
                compare against, so the honest answer is to withhold the
                deltas rather than to restate them with a caveat.

                Otherwise: the cohort run immediately BEFORE this one. If
                `/trends` is still loading, or this run is the oldest in its
                window, the tiles omit deltas rather than inventing
                comparison copy. */}
            {/* THE TILES AND SPARKLINES MOVED ABOVE — see the block at the
                top of this return. What stays here is the per-request TABLE,
                which is the only part of this section a phone cannot usefully
                render, and so the only part behind the notice. */}
            <DesktopOnly
          compact={compact}
          what="The per-request statistics table"
          // Review M18 names this wording. It says what the button opens
          // rather than judging the reader for opening it.
          action="Open detailed table"
        >
              {() => (
                <StatisticsTable stats={data} runId={runId} runStatus={run.data.run.status} />
              )}
            </DesktopOnly>
          </>
        )}
      </TableSection>

      {/* LAST ON THE TAB, after the reader has met every word it defines —
          and a `<details>` rather than a section, so it contributes no heading
          and the outline `run-tables.spec.ts` pins stays exactly three. See
          `RunGlossary` for why it is here and not on a route of its own. */}
      <RunGlossary />
    </>
  );
}

/**
 * How far a fragment target keeps from the top of the viewport — review 09-13
 * C04's other half.
 *
 * The run page has TWO sticky bands: `AppShell`'s header at `top: 0` and
 * `RunTabs` at `top: var(--header-height)`. A fragment scrolled flush to the
 * viewport top therefore lands UNDER both of them, heading first, which is a
 * different way of not revealing the thing the link named.
 *
 * `scroll-margin-top` rather than an offset computed in the scroll call,
 * because it is also what the BROWSER honours: the same URL opened fresh is a
 * real fragment navigation that this file never sees, and it lands correctly
 * for free.
 *
 * The header is read from its token — this file may not spell `3.5rem`, and
 * `tokens.test.ts` enforces that. The tab strip's own 42px is not tokenised
 * and is measured rather than guessed; being a few pixels out here is a
 * cosmetic gap above a heading, not a defect, which is why it does not warrant
 * a second token.
 */
const FRAGMENT_SCROLL_MARGIN = 'calc(var(--header-height) + 2.625rem)';

/** Overview keeps its cohort page for five minutes; see the `trends` query. */
const OVERVIEW_TRENDS_STALE_MS = 5 * 60_000;

/**
 * §22.6's sparklines: the shape behind two of the tiles above them.
 *
 * Requests per second and the response-time percentile bands, drawn short and
 * bare — the tiles already carry the numbers, so axes and a legend would take
 * more room than the lines and repeat what is directly above. Each keeps its
 * data table, collapsed, so nothing is lost to a reader who cannot see them.
 *
 * Fetched only when compact (see the query's `enabled`), because on a desktop
 * these two charts are already on the Charts tab at full size.
 */
function Sparklines({ series }: { readonly series: UseQueryResult<SeriesResponse> }) {
  if (series.data === undefined) return null;
  return (
    <div className="grid grid-cols-1 gap-3">
      <RequestRateChart series={series.data} title="Requests per second" compact />
      <PercentilesChart series={series.data} title="Response time" compact />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The Errors tab, §13.2 ⑥ — design §6
 * ------------------------------------------------------------------ */

/**
 * `/runs/:runId/errors`, a child under `RunShell` (design §3, §6).
 *
 * Its own fetch rather than a share of `RunOverviewTab`'s: `koCount` on the
 * run-scope stats row is failed REQUESTS, a different number from the count
 * of DISTINCT error messages this tab is about, and only `/errors` knows the
 * second one.
 *
 * REACHABLE FOR A PROCESSING RUN NOW (Task 7), and its own `run` read below
 * is what this component uses to notice — `errorsQuery`/`errorSeriesQuery`
 * are gated on `terminal`, not merely `runId !== undefined` (fix round 1,
 * CRITICAL 1): `apiFetch` has no 202 branch, so before this fix a pending or
 * parsing run's `/errors` and `/errors/series` fired anyway and the reader
 * got error panels where `WaitingPanel` now renders instead.
 *
 * THE TABLE STAYS LIVE, THE CHART DOES NOT (Task 10). Once a delta has
 * arrived, `errors` above reads straight off it — `useLiveRun`'s
 * `applyDelta` writes this SAME `errorsQuery` cache key directly, a
 * field-for-field copy of `delta.errors.rows` (`errorsResponseFrom`,
 * `api/live.ts`) — so `TableSection` needs no live branch of its own. The
 * chart has no live source at all: §1.3 scopes the live errors envelope to
 * run-scope TOTALS with no time series, so it gets a stated `LiveNotice`
 * where its figure would be.
 */
/**
 * "Which request do I investigate?" as a control (review 09-13 M15).
 *
 * A `<select>` and not a row of buttons: the option count is however many
 * requests failed, which on a large simulation is not a number a toolbar can
 * hold. A native select is also the one control that is keyboard- and
 * touch-reachable without this file writing any of that itself.
 *
 * LABELLED, NOT PLACEHOLDER'D. The label is a real `<label>` tied by `id`, so
 * the control keeps its accessible name once a value is chosen — a `<select>`
 * whose only name is its first option loses it the moment the reader picks
 * something else, which is the same defect this repo records for form fields
 * whose placeholder was doing the labelling.
 *
 * RENDERS NOTHING WHEN NOTHING FAILED PER REQUEST. A filter over an empty set
 * of choices is a control that cannot do anything, and its presence implies
 * the reader has missed something. The run-scope table says what happened in
 * that case.
 */
function ErrorRequestFilter({
  names,
  value,
  onChange,
}: {
  readonly names: readonly string[];
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
}) {
  const id = useId();
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={id} className="text-[0.8125rem] text-muted">
        Investigate
      </label>
      <select
        id={id}
        data-testid="errors-request-filter"
        className="min-w-0 max-w-full rounded-md border border-default bg-surface px-2 py-1 text-[0.8125rem] text-primary"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        {/* The unfiltered view is an OPTION, not the absence of one — a filter
            a reader cannot get back out of is worse than no filter. */}
        <option value="">All requests</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function RunErrorsTab() {
  const { runId } = useParams<{ runId: string }>();
  const live = useLiveFromShell();
  const { detail: run, terminal } = useRunTerminal(runId);

  /* ═══ WHICH REQUEST TO INVESTIGATE (review 09-13 M15) ═══
   *
   * The finding: "the current raw messages and counts explain what failed but
   * not which request to investigate", with a drill-down "when mappings are
   * available". They are, and always were — `run_error` carries `scope` and
   * `name`, the engine writes a row per (scope, name), and
   * `GET /v1/runs/:id/errors` has taken `?scope=&name=` all along. Measured on
   * a real run: the same failure is stored twice, once at run scope and once
   * as `request | Cart/Add To Cart`. This tab simply never asked for the
   * second. `RequestDetail` already did, which is why `ErrorsTable` has a
   * `scopeLabel` prop waiting for exactly this caller.
   *
   * IN THE URL, NOT COMPONENT STATE, for the reason `RunCompare` records for
   * its metric: a link to "the errors for Place Order" that opens showing
   * every request's errors has dropped the question and kept only the page.
   * `replace: true` likewise — narrowing a filter refines the view rather than
   * being a place to go Back to. */
  const [params, setParams] = useSearchParams();
  const requestFilter = params.get('request');
  const setRequestFilter = (next: string | null) => {
    const updated = new URLSearchParams(params);
    if (next === null) updated.delete('request');
    else updated.set('request', next);
    setParams(updated, { replace: true });
  };

  const errors = useQuery({
    ...errorsQuery(
      runId ?? '',
      requestFilter === null ? 'run' : 'request',
      requestFilter ?? '',
    ),
    enabled: terminal,
  });
  /* The names to offer, WHOLE RUN and not the selected window — `null`, not
     `window`. `/v1/runs/:id/errors` takes no `from`/`to` (that handler's own
     comment says so, and `ErrorsTable` carries a notice about it), so the rows
     this filter narrows are always whole-run. A windowed option list would
     offer requests chosen on one basis and then filter rows chosen on
     another, and a request could vanish from the list while its errors were
     still in the table. */
  const stats = useQuery({ ...statsQuery(runId ?? '', null), enabled: terminal });
  const window = useWindowFromShell();
  // One time axis across the page (§22.5) — see `useTimeDomainFromShell`.
  const domainMs = useTimeDomainFromShell();
  // AC-STAT-4 — beside the domain, because it is a fact about that axis.
  const warmupMs = useWarmupFromShell();
  const series = useQuery({
    ...errorSeriesQuery(runId ?? '', window),
    enabled: terminal,
  });

  // Same guard `RunOverviewTab` carries, for the same reason: not reachable
  // through the router with `run.data` still `undefined` past first paint.
  if (runId === undefined || run.data === undefined) return null;

  if (run.data.state === 'processing') {
    const delta = live?.lastDelta ?? null;
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        {/* §1.3 scopes the live errors envelope to run-scope TOTALS — no time
            series — so the table has a live source (fed by `delta.errors.rows`
            through the SAME `errorsQuery` cache key `applyDelta` writes) and
            the chart, which needs a time series, does not. */}
        <LiveNotice kind="withheld" subject="Errors per second" />
        <TableSection title="Errors" query={errors} columns={ERRORS_TABLE_COLUMNS}>
          {(data) => <ErrorsTable errors={data} windowSelected={window !== null} />}
        </TableSection>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* WHEN, then WHAT. The chart answers "did this run degrade, or was it
          broken throughout" — the question a reader arrives at this tab with.
          The table below answers "what exactly failed", and holds EVERY
          message rather than only the five the palette can draw, which is why
          the chart does not replace it.

          Two fetches, not one: the flat totals and the time series are
          different endpoints, and either can fail without taking the other
          down. `Payload` keeps a failed chart visible and saying why, rather
          than leaving a gap the reader cannot see is missing. */}
      <Payload query={series} slots={[{ id: 'errors-over-time', title: 'Errors per second' }]}>
        {(data) => <ErrorsChart data={data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />}
      </Payload>

      {/* The control sits ABOVE the table it narrows, and below the chart that
          answers "when". The reader's path through this tab is when → which →
          what, and the filter is the "which". */}
      <ErrorRequestFilter
        names={stats.data === undefined ? [] : failingRequestNames(stats.data)}
        value={requestFilter}
        onChange={setRequestFilter}
      />
      <TableSection title="Errors" query={errors} columns={ERRORS_TABLE_COLUMNS}>
        {(data) => (
          <ErrorsTable
            errors={data}
            /* So the empty branch cannot say "no errors were recorded for this
               run" over a filtered view — the precise wrong sentence this prop
               was added for, met from a second caller. */
            scopeLabel={requestFilter ?? undefined}
            windowSelected={window !== null}
          />
        )}
      </TableSection>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The Charts tab, §13.2 ③④⑦⑦ᵇ⑧⑨⑩⑪ — design §6
 * ------------------------------------------------------------------ */

/**
 * THE ONE CROSSHAIR. Every chart whose x-axis is elapsed seconds carries this
 * `group`, and `Chart` calls `echarts.connect` with it, so hovering any one of
 * them moves the axis pointer on all of them.
 *
 * That linkage is not a nicety, it is the PRD's deliberate encoding change:
 * Gatling overlays active users on requests/s as a second y-axis, §22.4 forbids
 * dual axes outright, and Appendix A records the split as information parity
 * precisely BECAUSE the shared crosshair recovers the "read these two together"
 * affordance the dual axis was buying. Break the connection and the two charts
 * stop being one reading — which is what the e2e crosshair spec exists to catch.
 *
 * `PercentilesChart` and both rate charts hard-code the same string internally
 * (they have no `group` prop to pass one through); the two users charts take it
 * as a prop. Stated here as a named constant so the five agree on one spelling.
 */
const RUN_TIME = 'run-time';

const INDICATORS: Slot = { id: 'indicators', title: 'Response time ranges' };
const REQUEST_COUNTS: Slot = { id: 'request-counts', title: 'Number of requests' };
const CONCURRENT_USERS: Slot = { id: 'concurrent-users', title: 'Concurrent users over time' };
const USER_START_RATE: Slot = { id: 'user-start-rate', title: 'Users started per second' };
const DISTRIBUTION: Slot = { id: 'distribution', title: 'Response time distribution' };
/**
 * The tail's shape, beside the histogram that shows where the mass is. Both
 * are folds of the SAME `/distribution` payload — one fetch, two figures, no
 * second cache key — so they always describe the same run.
 */
const PERCENTILE_DISTRIBUTION: Slot = {
  id: 'percentile-distribution',
  title: 'Response time percentiles distribution',
};
const PERCENTILES: Slot = { id: 'percentiles', title: 'Response time percentiles over time' };
const REQUESTS_PER_SECOND: Slot = {
  id: 'requests-per-second',
  title: 'Requests per second over time',
};
const RESPONSES_PER_SECOND: Slot = {
  id: 'responses-per-second',
  title: 'Responses per second over time',
};

/**
 * `/runs/:runId/charts`, a child under `RunShell` (design §3, §6).
 *
 * Four fetches, eight charts (design §2) — and the charts do the fetching
 * nowhere: this is the only component on the page that calls a query factory,
 * and every chart below receives an already-validated payload as a prop.
 *
 * `/stats` feeds ③ and ④, `/users` feeds ⑦ and ⑦ᵇ, `/distribution` feeds ⑧, and
 * `/series` feeds ⑨, ⑩ and ⑪. That grouping is why §13.2's order can be
 * rendered as four blocks rather than eight: each payload's charts happen to be
 * adjacent in it, so no chart is displaced to keep a fetch tidy. If a future
 * chart broke that adjacency, the ORDER wins and this component grows a fifth
 * block — never the other way round.
 *
 * NAMED BY AN `<h2>`, VISUALLY HIDDEN — not `aria-label="Charts"`, which this
 * used to carry instead. That was reasoned as: a tab named Charts directly
 * above a heading that also said Charts (or, before the tab strip existed,
 * "Overview") would say it twice. True for a SIGHTED user, and irrelevant to
 * one — the tab strip is not in view once a reader has scrolled into the
 * chart stack. It was also incomplete: the eight charts below each render an
 * `<h3>` (`Chart.tsx`), and `aria-label` on this section is not a heading at
 * all, so a screen-reader user navigating by heading level jumped straight
 * from the page's one `<h1>` (`RunHeader`) to eight `<h3>`s with no `<h2>`
 * between them — a level skipped, and this section unreachable by that
 * navigation mode no matter what its `aria-label` said. An `sr-only` `<h2>`
 * both names the region (via `aria-labelledby`, so nothing is claimed twice
 * out loud for a sighted reader) and repairs the ladder, at the one cost that
 * argument was avoiding: a screen-reader user who tabs through headings
 * hears "Charts" once from `RunTabs`' link and, later, again on arrival —
 * the same trade `RunHeader`'s badges and countless real sites make
 * routinely, and a smaller cost than a heading level a screen reader cannot
 * jump to at all.
 *
 * REACHABLE FOR A PROCESSING RUN NOW (Task 7), and gated the same way
 * `RunOverviewTab` and `RunErrorsTab` are (fix round 1, CRITICAL 1): `on`
 * below requires `terminal` in addition to `runId`/`wanted`, because
 * `apiFetch` has no 202 branch — before this fix, opening this tab on a
 * pending run fired all four queries against rows that do not exist yet and
 * the reader got four error panels instead of `WaitingPanel`.
 *
 * DRAWS FIVE LIVE FIGURES NOW TOO (Task 9), once a delta has arrived for a
 * non-terminal run. `users`/`series` below stay `enabled: on` — never
 * fetched while live — and are READ anyway: `useLiveRun`'s `applyDelta`
 * writes these SAME `usersQuery`/`seriesQuery` cache keys directly while the
 * run streams (`window` is always `null` for a live view, which is exactly
 * what makes the keys agree), and a `useQuery` still subscribes to its cache
 * entry regardless of `enabled`. Two of the eight terminal charts have no
 * live source on any path — the response-time distribution and its
 * percentile companion both fold the same `/distribution` payload, which
 * needs per-request or full-sketch data no delta carries — and get a stated
 * `LiveNotice` instead. Errors per second is the same shape of gap but
 * belongs on the Errors tab, where its real chart is (Task 10); the old
 * standalone page stacked all three withheld notices together only because
 * it had no tabs to distribute them across.
 */
/**
 * One investigation group on the Charts tab (review 09-13 M17).
 *
 * A `<section>` with a REAL heading, not a styled `<div>` and a bold line: the
 * point of grouping is that a screen-reader user can jump between the four
 * questions the same way a sighted reader's eye does, and only a heading in the
 * outline does that. `aria-labelledby` rather than `aria-label` so the name and
 * the visible text cannot drift apart.
 *
 * `SectionHeading`, so `<h2>` — and these REPLACE the `sr-only` <h2>Charts</h2>
 * this tab used to carry. That heading existed for one reason, stated in
 * `run-charts.spec.ts`: `aria-label` alone never let a screen-reader user
 * navigating by heading reach this section. Four named groups do that job
 * better than one invisible word, so keeping both would leave a heading whose
 * only purpose had been taken over, and the section keeps `aria-label` for its
 * own name.
 *
 * `<h3>` WAS TRIED FIRST AND THE PAGE SAID NO. `Chart` renders each figure's
 * title as an `<h3>` at 15px — so a group heading at that level is a SIBLING of
 * the charts it contains, and at that size does not read as their parent
 * either. The failure named all nine titles, which is how the collision was
 * found. `SectionHeading`'s 16px `<h2>` is the rung above, which is what these
 * are.
 *
 * THE GRID LIVES INSIDE, one per group. Two columns above 1536px was measured
 * on the ungrouped page and the reasoning is unchanged: a chart holds a 288px
 * plot plus a legend under a header row, and two of those in a 1280px window
 * leaves each ~600px — narrow enough that a 60-bucket time axis starts dropping
 * every other tick label. Above 1536px there is room for both, and halving the
 * scroll depth is worth real time to a reader comparing two figures.
 *
 * Per group rather than one grid for the whole tab because a group is the unit
 * a reader compares within; a figure pairing across a heading boundary would be
 * the layout contradicting the structure.
 */
function ChartGroup({
  id,
  heading,
  children,
}: {
  readonly id: string;
  readonly heading: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-3">
        <SectionHeading id={id}>{heading}</SectionHeading>
      </div>
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">{children}</div>
    </section>
  );
}

export function RunChartsTab() {
  const { runId } = useParams<{ runId: string }>();
  const live = useLiveFromShell();
  const { detail: run, terminal } = useRunTerminal(runId);
  // ONE WINDOW FOR THE WHOLE PAGE, from the shell — so every figure below
  // describes the same stretch of the run, and so the shell's own fetches
  // share their cache keys with these rather than quietly duplicating them.
  const window = useWindowFromShell();
  // ONE TIME AXIS, for the same reason there is one window: the six figures
  // below share a crosshair, and a pointer means one instant only if they all
  // draw the same span. See `useTimeDomainFromShell`.
  const domainMs = useTimeDomainFromShell();
  // AC-STAT-4 — beside the domain, because it is a fact about that axis.
  const warmupMs = useWarmupFromShell();
  // §22.6. `enabled` carries it as well as the render below, because the point
  // is not to DRAW less on a phone — it is not to fetch four payloads and
  // build ten ECharts instances for a screen that cannot usefully show them.
  // A reader who takes the override gets all four; nobody else pays.
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const wanted = !compact || shown;
  const on = runId !== undefined && wanted && terminal;
  const stats = useQuery({ ...statsQuery(runId ?? '', window), enabled: on });
  const users = useQuery({ ...usersQuery(runId ?? '', window), enabled: on });
  const distribution = useQuery({
    ...distributionQuery(runId ?? '', 'run', '', 'response_time', window),
    enabled: on,
  });
  const series = useQuery({
    ...seriesQuery(runId ?? '', 'run', '', 'response_time', window),
    enabled: on,
  });

  // Same guard `RunOverviewTab` and `RunErrorsTab` carry, for the same
  // reason: not reachable through the router with `run.data` still
  // `undefined` past first paint.
  if (runId === undefined || run.data === undefined) return null;

  if (run.data.state === 'processing') {
    const delta = live?.lastDelta ?? null;
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;

    // §22.6 applies here exactly as it does to the terminal 8-chart grid
    // below: five real figures plus two withheld notices is still "deep
    // analysis", and a phone that has not asked to see it should not pay to
    // build five ECharts instances for a screen too narrow to read them.
    if (compact && !shown) {
      return (
        <DesktopOnly
          compact
          what="Five charts of this run"
          action="Open the charts"
          onShow={() => setShown(true)}
        >
          {() => null}
        </DesktopOnly>
      );
    }

    return (
      <section
        aria-labelledby="live-charts-heading"
        className="grid grid-cols-1 gap-6 2xl:grid-cols-2"
      >
        <h2 id="live-charts-heading" className="sr-only">
          Charts
        </h2>
        {users.data !== undefined && (
          <>
            {/* Its OWN chart, sharing the crosshair — never an overlay on
                requests/s. See RUN_TIME above. */}
            <ConcurrentUsersChart users={users.data} group={RUN_TIME} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
            <UserStartRateChart users={users.data} group={RUN_TIME} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
          </>
        )}
        {series.data !== undefined && (
          <>
            <PercentilesChart series={series.data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
            <RequestRateChart series={series.data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
            <ResponseRateChart series={series.data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
          </>
        )}
        {/* THE TWO CHART SLOTS WITH NO LIVE SOURCE ON ANY PATH — see this
            function's own docstring. */}
        <LiveNotice kind="withheld" subject="Response time distribution" />
        <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
      </section>
    );
  }

  if (compact && !shown) {
    return (
      <DesktopOnly
        compact
        what="Eight charts of this run"
        action="Open the charts"
        onShow={() => setShown(true)}
      >
        {() => null}
      </DesktopOnly>
    );
  }

  return (
    // TWO COLUMNS FROM `2xl`, ONE BELOW IT — and the order the charts are
    // declared in is preserved either way, because CSS grid fills row-major.
    // §13.2's numbering is information (a missing ⑧ silently renumbers
    // everything after it, which is why `payload.tsx` renders undrawn charts
    // rather than nothing), so the pairing must never reorder them; it only
    // decides how many sit side by side.
    //
    // The break is at `2xl` (1536px) rather than `xl`, because each figure
    // holds a 288px-tall plot plus a legend beneath a header row, and two
    // of those in a 1280px window leaves each chart ~600px — narrow enough
    // that a 60-bucket time axis starts dropping every other tick label.
    // Above 1536px there is room for both, and halving the scroll depth of an
    // eight-figure page is worth real time to a reader comparing two of them.
    <section aria-label="Charts" className="flex flex-col gap-8">
      {/* ═══ FOUR QUESTIONS, NOT NINE FIGURES (review 09-13 M17, second half) ═══
       *
       * M17's first half moved each chart's exports behind one menu. Its second
       * half is this: "organize charts into investigation groups such as Load,
       * Latency, and Errors, with clear scope and outcome labels." Nine figures
       * in one undifferentiated grid is a page a reader scrolls rather than
       * reads — the headings are how they find the answer they came for.
       *
       * THE GROUPS WERE ALREADY IN THE ORDER, WHICH IS WHY THIS IS CHEAP. The
       * comment this replaces described the sequence as WHAT WAS APPLIED, WHAT
       * GOT THROUGH, WHAT IT COST. Those are the first three headings; the
       * reading order it established is unchanged, and the headings only name
       * what was already true.
       *
       * AND THE NAMES ARE THE CHARTS' OWN. All four response-time figures
       * literally begin "Response time" — percentiles over time, ranges,
       * distribution, percentiles distribution — so the heading is a fact about
       * them rather than a category imposed on them.
       *
       * ONE FIGURE MOVED: `request-counts` was seventh, between `indicators`
       * and `distribution`, which left the response-time run non-contiguous.
       * It is last now. `CHART_IDS` in `run-charts.spec.ts` asserts the whole
       * list precisely so a reorder cannot pass silently — it is updated with
       * this change, which is that guard working rather than being worked
       * around.
       *
       * THE TWO PROPERTIES THE PREVIOUS ORDER DEFENDED BOTH SURVIVE, and they
       * are the reason `request-counts` moved rather than `percentiles`:
       *   - the five charts sharing `RUN_TIME`'s crosshair and domain stay
       *     adjacent (positions 1-5), so one horizontal read still crosses all
       *     of them;
       *   - `distribution` and `percentile-distribution` stay adjacent, for the
       *     reason `run-charts.spec.ts` argues at length.
       *
       * OUTCOMES HOLDS ONE FIGURE AND STILL EARNS A HEADING. It is the only
       * whole-run success/failure answer on this tab, and a reader looking for
       * "how many failed" should not have to know it is drawn as a donut at the
       * bottom. `indicators` is NOT here despite carrying a `failed` band: its
       * title is "Response time ranges" and three of its four bands are
       * latency, so filing it under Outcomes would put a heading at odds with
       * the chart under it. */}
      <ChartGroup id="charts-offered-load" heading="Offered load">
        <Payload query={users} slots={[CONCURRENT_USERS, USER_START_RATE]}>
          {(data) => (
            <>
              {/* Its OWN chart, sharing the crosshair — never an overlay on
                  requests/s. See RUN_TIME above. */}
              <ConcurrentUsersChart users={data} group={RUN_TIME} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
              <UserStartRateChart users={data} group={RUN_TIME} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
            </>
          )}
        </Payload>
      </ChartGroup>

      {/* Throughput before latency: "how much got through" is the question a
          reader asks of a load number, and "what did it cost" is the question
          they ask of the throughput. */}
      <ChartGroup id="charts-throughput" heading="Throughput">
        <Payload query={series} slots={[REQUESTS_PER_SECOND, RESPONSES_PER_SECOND]}>
          {(data) => (
            <>
              <RequestRateChart series={data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
              <ResponseRateChart series={data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />
            </>
          )}
        </Payload>
      </ChartGroup>

      {/* THREE PAYLOADS, THREE QUERIES, ONE GROUP. A group is a question, and
          the answers come from different endpoints — `Payload` is a pure render
          prop over a query result and fetches nothing, so naming the same query
          in two groups costs one extra render and no extra request. The
          alternative, grouping by endpoint, is the "ordered by which query
          produced them" mistake this tab already had once. */}
      <ChartGroup id="charts-response-time" heading="Response time">
        <Payload query={series} slots={[PERCENTILES]}>
          {(data) => <PercentilesChart series={data} domainMs={domainMs} warmupMs={warmupMs ?? undefined} />}
        </Payload>
        <Payload query={stats} slots={[INDICATORS]}>
          {(data) => <IndicatorsChart stats={data} />}
        </Payload>
        <Payload query={distribution} slots={[DISTRIBUTION, PERCENTILE_DISTRIBUTION]}>
          {(data) => (
            <>
              <DistributionChart distribution={data} />
              <PercentileDistributionChart distribution={data} />
            </>
          )}
        </Payload>
      </ChartGroup>

      <ChartGroup id="charts-outcomes" heading="Outcomes">
        <Payload query={stats} slots={[REQUEST_COUNTS]}>
          {(data) => <RequestCountChart stats={data} />}
        </Payload>
      </ChartGroup>
    </section>
  );
}

/**
 * The SLA rules evaluated against this run, in a real `<table>` with real
 * `<th scope="col">` headers — tabular data, and the header/cell relationship
 * is what makes a row comprehensible to a screen reader announcing its third
 * column.
 *
 * Row order is the API's: `RunsService.toResponse` orders by outcome, which
 * puts `failed` first. The thing a reader opened an SLA-failed run to see is
 * at the top of the table without this component sorting anything.
 */
function Assertions({
  runId,
  assertions,
  projectSlug,
  windowSelected = false,
}: {
  readonly runId: string;
  readonly assertions: readonly Assertion[];
  /** A gate is decided once, at finalize, over the whole run -- so under a
   *  window it is scoped differently from the statistics beside it. See
   *  `FinalizedVerdictNotice`. Defaulted because the empty branch below, and
   *  any caller that is not the windowed run page, want nothing said. */
  readonly windowSelected?: boolean;
  /** For the empty state's own way out — see below. Optional because a run
   *  whose project is not yet known still renders the section. */
  readonly projectSlug?: string;
}) {
  const [gatesExpanded, setGatesExpanded] = useState(false);
  if (assertions.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {/* ═══ "Platform gates", NOT "Assertions" — review N01 ═══
         *
         * Two systems judge a run and both were called assertions: the
         * organisation's SLA rules, and the assertions the simulation declares
         * for itself. The section below is the FIRST; `Simulation assertions`
         * one section down is the second, and it keeps its name because that
         * name is correct — the PRD gives "Assertions table" to G-05, the
         * TOOL's own feature. It was the platform's that was misnamed.
         *
         * The word is not invented here either. `RunDecisionBand` has called
         * this system "Platform gates" since C02 (its outcome row), so this
         * heading moves onto an anchor the same page already carries rather
         * than adding a third noun.
         *
         * BOTH BRANCHES OF THIS COMPONENT CARRY IT. An empty run renders the
         * heading from here and a populated one from the branch below; leaving
         * either behind makes the tab's heading outline differ by run, which
         * `run-tables.spec.ts` asserts as an exact list. */}
        <SectionHeading overline="Evidence">Platform gates</SectionHeading>
        {/* A VALID STATE WITH AN INCOMPLETE WORKFLOW. This explained the
            absence accurately and then left the reader on a page with no way
            to do anything about it — the rules live two navigations away and
            the text did not say where. An empty state that names its own
            remedy is the difference between a dead end and a step.
            Also: the sentence says rules apply from INGEST, so a reader who
            follows this link has to know the change affects future runs.

            ═══ AND IT LED SOMEWHERE ELSE ENTIRELY (review 09-13 C03) ═══

            This pointed at `projectSetupPath`, which was the right answer when
            that page carried the rules. M15 split it — rules moved to
            `projectRulesPath` and `/setup` became "Add results" — and this
            link was not repointed, so the one remedy this empty state offers
            opened a page about uploading bundles.

            Nothing failed: the path still resolves, the page still renders,
            and no test asserted where this link GOES. **When a page is split,
            grep every caller of the old path for what it MEANT**, not for
            whether it still compiles. */}
        {/* ═══ ONE ROW, NOT A CARD (review 09-13 M03) ═══
         *
         * The decision band at the top of this page already states this —
         * "Platform gates: not configured — no SLA rule judged this run" — so
         * a full `EmptyState` card beneath it spent a third of a screen
         * repeating a fact the reader met before they scrolled. An empty state
         * earns its size when it is the first time something is said; this one
         * is the second.
         *
         * What it must NOT lose is the remedy and the caveat: where to
         * configure rules, and that doing so does not change this run. Both
         * survive, in one line. */}
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-muted">
          <span>No SLA rules judged this run — adding one affects future runs, not this one.</span>
          {projectSlug !== undefined && (
            <Link
              to={projectRulesPath(projectSlug)}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Configure SLA rules
            </Link>
          )}
        </p>
      </section>
    );
  }

  /* ═══ PASSED GATES COLLAPSE, THE WAY THE SIBLING TABLE ALREADY DID ═══
     (review.md 9: "collapse passed checks by default")

     `ToolAssertions` has split its rows into failed-and-the-rest since it was
     written; this table rendered every gate, always. So a project with twelve
     rules put twelve rows on the Overview whatever they said, which is the
     "length without equivalent additional information" the finding names —
     and the asymmetry meant the two evidence tables on ONE tab disagreed about
     whether a passing check is worth a row.

     THE RULE IS COPIED DELIBERATELY, not invented: same threshold, same
     wording, same control. Two tables answering "should this collapse?"
     differently is the defect; a second answer here would have been a third. */
  const failedGates = assertions.filter((a) => a.outcome === 'failed');
  const otherGates = assertions.filter((a) => a.outcome !== 'failed');
  const gatesCollapsible = failedGates.length > 0 || otherGates.length > 5;
  const shownGates =
    !gatesCollapsible || gatesExpanded ? [...failedGates, ...otherGates] : failedGates;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The populated branch's copy of the heading — see the empty branch
            above for why both must carry the same words. */}
        <SectionHeading overline="Evidence">Platform gates</SectionHeading>
        <Button
          size="sm"
          onClick={() => downloadCsv(`run-${runId}-assertions.csv`, assertionsCsv(assertions))}
        >
          <DownloadIcon className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
      {windowSelected && <FinalizedVerdictNotice what="Platform gates" />}
      {/* ═══ THE EVIDENCE PANEL IS GONE (review.md 9) ═══
          "SLA outcomes appear in the decision band, an evidence summary,
          individual assertion cards, and a full table… this creates length
          without equivalent additional information."

          MEASURED BEFORE DELETING, because a summary carrying one unique fact
          would be worth keeping. It carried none:

            counts         the band states them as a sentence AND as three tiles
            first failure  the band links to it; the table's failed row IS it
            the rule       the table's own Rule column, through the same describer

          C01 removed those same three counts from the band's OWN duplicate
          spellings and left this panel standing — which is how one screen comes
          to state one fact three times. */}
      <TableFrame caption={ASSERTIONS_CAPTION} label="Platform gates table">
          <table className={TABLE}>
            {/* `sr-only`, with the same node drawn visibly outside the scroll
                box — see `TableFrame`. */}
            <caption className="sr-only">{ASSERTIONS_CAPTION}</caption>
            <thead className={THEAD}>
              <tr>
                <th scope="col" className={TH}>
                  Outcome
                </th>
                <th scope="col" className={TH}>
                  Rule
                </th>
                <th scope="col" className={TH}>
                  Actual
                </th>
                <th scope="col" className={TH}>
                  What happened
                </th>
              </tr>
            </thead>
            <tbody>
              {shownGates.map((assertion) => (
                <tr key={assertion.ruleId} data-testid="assertion-row" className={ROW}>
                  <td data-testid="assertion-outcome" className={`${TD} whitespace-nowrap`}>
                    <Marked mark={ASSERTION_OUTCOME[assertion.outcome]} />
                  </td>
                  <td className={TD}>{describeAssertionRuleForReader(assertion.rule)}</td>
                  {/* Null for a not_applicable assertion — there was nothing to
                      measure (AssertionSchema). A dash, never `0`: zero is a
                      measurement, and this is the absence of one. */}
                  {/* THROUGH THE SAME FORMATTER AS THE RULE COLUMN BESIDE IT.
                      This printed `assertion.actualValue` directly, so an
                      error-rate row showed `0.0223463687150838` next to a limit
                      reading `1%` — floating-point serialisation in a column
                      whose whole job is to be compared with the one before it. */}
                  <td className={TD_NUM}>
                    {formatAssertionValue(assertion.rule.metric, assertion.actualValue)}
                  </td>
                  {/* THE LAST COLUMN WAS THE ONE STILL SPEAKING SCHEMA. The
                      three cells before it have rendered from the structured
                      fields since review.md 1, 3 and 15 — `Whole-run error
                      rate`, `≤ 1%`, `2.23%` — and this one printed the stored
                      message beside them: `error_rate of the run
                      (response_time) ≤ 0.01 — actual 0.0223463687150838`. One
                      row, one fact, two vocabularies.

                      Falls back to the message for a `not_applicable` gate,
                      where there is no actual and the evaluator's sentence
                      explains what could not be checked. */}
                  <td className={`${TD} text-muted`}>
                    {describeSlaOutcome(assertion) ?? assertion.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
      </TableFrame>
        {gatesCollapsible && (
          <button
            type="button"
            data-testid="platform-gates-toggle"
            onClick={() => setGatesExpanded((open) => !open)}
            className="transition-ui w-fit text-[0.8125rem] font-medium text-accent hover:underline hover:underline-offset-2"
          >
            {/* `Other gates (N)`, the sibling's own wording one word over — it
                spells the count and lets the control's state say show-or-hide,
                rather than defining the rest by what they are NOT. */}
            {gatesExpanded ? `Hide other gates (${otherGates.length})` : `Other gates (${otherGates.length})`}
          </button>
        )}
    </section>
  );
}

function formatAssertionValue(metric: string, value: number | null): string {
  return value === null ? '—' : formatSlaValue(metric, value);
}

/**
 * The assertions the SIMULATION declared — Appendix A G-05.
 *
 * ═══ ITS OWN SECTION, BESIDE THE SLA TABLE, NEVER MERGED WITH IT ═══
 *
 * `Assertions` above is this platform's SLA rules: configured per project,
 * edited over time, and the thing the 200/422 verdict gates on. These belong to
 * whoever wrote the simulation, are fixed at run time, and can express
 * comparisons (`between`, `in`) the SLA comparator set has no member for.
 * Showing them in one table would mean either inventing a rule id or implying a
 * threshold edit could change what the load test asserted.
 *
 * ═══ THE EXPRESSION IS THE TOOL'S OWN SENTENCE ═══
 *
 * Rendered verbatim, in mono, because G-05's tolerance is exact on the WORDING
 * as well as the numbers — a reader holding the two reports side by side is
 * comparing strings. The threshold is inside it ("… is less than 30000.0"),
 * which is why there is no separate Expected column.
 *
 * ═══ NULL AND [] ARE DIFFERENT, AND ONLY ONE OF THEM DRAWS ═══
 *
 * `[]` is a fact: the simulation declared none, and the empty state says so.
 * `null` is the absence of one — the run was ingested before the decoder
 * existed, so its definitions were discarded and survive only in the raw
 * bundle. Nothing true can be said about it, so the section is omitted rather
 * than showing an empty table that would read as "this simulation had none".
 */
function ToolAssertions({
  assertions,
  runId,
  stats,
  windowSelected = false,
}: {
  readonly assertions: readonly ToolAssertion[] | null | undefined;
  readonly runId: string;
  /** This run's statistics rows as currently scoped, or null until they load. */
  readonly stats: readonly StatRow[] | null;
  /** The simulation's own checks are decided by Gatling when the run finishes,
   *  so like the platform gates they do not narrow with a window. Defaulted:
   *  only the windowed run page has anything to say. */
  readonly windowSelected?: boolean;
}) {
  // BEFORE the early returns: a hook cannot sit behind one. CLAUDE.md records
  // this exact shape — "Rendered more hooks than during the previous render"
  // — being shipped twice on this page.
  const [expanded, setExpanded] = useState(false);
  /* ═══ THE TOOL'S SENTENCE, ONE CLICK AWAY (review 09-13 M13) ═══
   *
   * It was a sixth column on every row, repeating in prose what Target,
   * Metric, Bound and Actual now carry in four scannable cells — "Search: 95th
   * percentile of response time is less than 100.0" beside `Search`, `95th`,
   * `< 100 ms`. The reason it EXISTS is unchanged and is not cosmetic: G-05's
   * tolerance is exact WORDING, so somebody holding this report beside
   * Gatling's own is comparing strings, and it is the only thing that can
   * describe an assertion shape this build does not recognise. So it is
   * withheld, not deleted — and withheld for the whole column at once rather
   * than per row, because the reader who wants it is diffing all of them.
   */
  const [wording, setWording] = useState(false);
  const windowSuffix = useWindowSuffix();

  /* ═══ WHICH NAMES THIS RUN CAN ACTUALLY DRILL INTO ═══
   *
   * A Gatling `details(...)` path can name a request or a group and the log
   * does not say which — `rowFor` in `@perfportal/statistics` resolves it by
   * trying `request <name>` and then `group <name>` against the run's own
   * statistics, and this mirrors that exactly so a link cannot disagree with
   * the evaluation it sits beside. A name in neither gets NO link, which is
   * the honest answer: that is the `not_applicable` row, and sending a reader
   * to a page that will tell them the request does not exist is the dead end
   * this finding is about, moved one click along.
   *
   * ═══ THE FAMILY FILTER IS PART OF THE MIRROR, NOT A TIDY-UP ═══
   *
   * A request and the run live in `response_time`; a GROUP has no row in that
   * family at all, because `engine.ts` files a group's timings under
   * `group_cumulated` and `group_duration`. `rowFor` reads BOTH — one family
   * per scope — and so does this.
   *
   * IT READ ONE FAMILY UNTIL THE EVALUATOR DID TOO. While the evaluator
   * filtered to `response_time` alone, a group-scoped assertion could never
   * resolve and always reported `not_applicable`, so linking it to
   * `/groups/<name>` would have put a working link on a row whose own status
   * said this run had no data for that name. Both moved together, which is the
   * only arrangement in which the link and the verdict cannot disagree — see
   * `evaluateToolAssertions`, whose comment carries the measurements.
   */
  const recorded = useMemo(() => {
    const byName = new Map<string, 'requests' | 'groups'>();
    for (const row of stats ?? []) {
      // REQUEST WINS, in the same order `rowFor` tries them: a name that is
      // both resolves to the request, so the link has to go there too.
      if (row.scope === 'request' && row.family === 'response_time') {
        byName.set(row.name, 'requests');
      } else if (
        row.scope === 'group' &&
        row.family === 'group_cumulated' &&
        !byName.has(row.name)
      ) {
        byName.set(row.name, 'groups');
      }
    }
    return byName;
  }, [stats]);

  if (assertions === null || assertions === undefined) return null;

  if (assertions.length === 0) {
    return (
      /* `id` is the target of the decision band's "See the failed simulation
         check" link — the band is the first screen and these rows are far
         below it, which is the whole reason that link exists. */
      <section
        id="simulation-assertions"
        className="flex flex-col gap-3"
        style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}
      >
        <SectionHeading>Simulation assertions</SectionHeading>
        <EmptyState
          title="This simulation declared no assertions"
          body="Assertions are written in the simulation itself and are read from the result file. This run's tool reported none."
        />
      </section>
    );
  }

  /* ═══ FAILED FIRST, PASSED BEHIND A DISCLOSURE ═══
   *
   * This was a flat list in the tool's own order, so the parity run showed two
   * PASSING checks above its failing one and the assertion corpus buried a
   * handful of failures in a hundred-odd rows. The reader's question is "what
   * broke", and the answer was wherever the simulation author happened to put
   * it.
   *
   * The rest is hidden only when hiding it HELPS: once something has failed,
   * or once there are more than a handful to wade through. A run with three
   * passing checks and nothing else has no signal to prioritise, and
   * collapsing it would be ceremony.
   *
   * ONE TABLE, not two. A second table needs a second caption, and a caption
   * is a table's accessible NAME — `run-tables.spec.ts` reaches these by name,
   * and CLAUDE.md records five specs breaking at once the last time a new
   * caption shared a distinctive word with an existing one.
   */
  const failed = assertions.filter((a) => a.outcome === 'failed');
  const rest = assertions.filter((a) => a.outcome !== 'failed');
  const collapsible = failed.length > 0 || rest.length > 5;
  const shown = !collapsible || expanded ? [...failed, ...rest] : failed;

  /* A ROW WHOSE STRUCTURE DID NOT DECODE HAS FOUR DASHES AND NOTHING ELSE, so
     for that row the sentence is not an alternative rendering — it is the only
     one. The column is therefore forced on whenever a SHOWN row needs it, and
     the toggle withdrawn, rather than offering a control that would empty the
     table of its only content. (`assertion` is `.optional()` on the wire: a
     run ingested before the decoder, or an API pod that predates it.) */
  const undecoded = shown.some((a) => a.assertion === undefined);
  const showWording = wording || undecoded;

  return (
    // Same anchor as the empty branch above — the band links here whichever
    // branch renders, so the id cannot live on only one of them.
    <section
        id="simulation-assertions"
        className="flex flex-col gap-3"
        style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}
      >
      <SectionHeading>Simulation assertions</SectionHeading>
      {windowSelected && <FinalizedVerdictNotice what="Simulation assertions" />}
      <TableFrame
        caption={TOOL_ASSERTIONS_CAPTION}
        summary="Every assertion the simulation declared, re-checked against this run."
        label="Simulation assertions table"
      >
        <table className={TABLE}>
          <caption className="sr-only">{TOOL_ASSERTIONS_CAPTION}</caption>
          <thead className={THEAD}>
            {/* COLUMNS FROM THE DECODED STRUCTURE (review M10), not from
                parsing the sentence. See `toolAssertion.ts` for why that
                distinction is the whole design. The tool's own wording is one
                column further on and behind a toggle (review 09-13 M13) —
                kept, because G-05's tolerance is exact wording and because it
                is the only thing that can describe an assertion shape this
                build does not recognise. */}
            <tr>
              {/* "Outcome", not "Status" — review N01. `Status` is this
                  product's word for a RUN's execution state (pending, running,
                  complete), which the run list gives a column of its own and
                  the decision band reports on its own row. A check does not
                  have an execution state; it has a result. The platform table
                  one section up has spelled this column `Outcome` all along,
                  so the two tables now agree. */}
              <th scope="col" className={TH}>
                Outcome
              </th>
              <th scope="col" className={TH}>
                Target
              </th>
              <th scope="col" className={TH}>
                Metric
              </th>
              <th scope="col" className={TH}>
                Bound
              </th>
              <th scope="col" className={TH}>
                Actual
              </th>
              {showWording && (
                <th scope="col" className={TH}>
                  Assertion
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((assertion, i) => (
              <tr
                // The expression is not unique — a simulation may assert the
                // same thing twice, and `forAll` expands to one row per request
                // with only the name differing. Index is the row's identity
                // here because the list is a fixed, ordered projection that is
                // never re-sorted after the failed-first split below.
                key={`${assertion.expression}-${i}`}
                data-testid="tool-assertion-row"
                className={ROW}
              >
                <td data-testid="tool-assertion-outcome" className={`${TD} whitespace-nowrap`}>
                  <Marked mark={ASSERTION_OUTCOME[assertion.outcome]} />
                </td>
                {/* An em dash wherever the structure is absent — a run ingested
                    before the decoder, or a Path this build does not know. The
                    sentence still says what it is (and forces its own column
                    open for exactly those rows), which is why these cells can
                    be honest about knowing nothing rather than guessing. */}
                <td className={`${TD} whitespace-nowrap`}>
                  <AssertionTarget
                    assertion={assertion}
                    runId={runId}
                    recorded={recorded}
                    windowSuffix={windowSuffix}
                  />
                </td>
                <td className={`${TD} whitespace-nowrap`}>
                  {toolAssertionParts(assertion).metric ?? '—'}
                </td>
                <td className={`${TD} whitespace-nowrap tabular-nums`}>
                  {(() => {
                    const { operator, threshold } = toolAssertionParts(assertion);
                    return operator === null || threshold === null
                      ? '—'
                      : `${operator} ${threshold}`;
                  })()}
                </td>
                {/* WITH ITS UNIT. A bare 2643 beside a bare 100 left the
                    reader to know that one is milliseconds and the other a
                    percentage — and `not_applicable` still renders a dash,
                    never a zero, because nothing was measured. */}
                <td className={`${TD_NUM} whitespace-nowrap`}>{formatActual(assertion)}</td>
                {showWording && (
                  <td className={`${TD} font-mono text-[0.75rem]`}>{assertion.expression}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>

      {(collapsible || !undecoded) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {collapsible && (
            <button
              type="button"
              data-testid="tool-assertions-toggle"
              onClick={() => setExpanded((open) => !open)}
              className="transition-ui w-fit text-[0.8125rem] font-medium text-accent hover:underline hover:underline-offset-2"
            >
              {/* `Other checks (N)` (review 09-13 N04). "Show 2 checks that
                  did not fail" spends eight words on a control whose own
                  state already says show-or-hide, and defines the rest of the
                  table by what they are NOT. The count is the useful part and
                  it stays; the statuses are one column away in the rows this
                  opens, which is where a reader wanting them is going. */}
              {expanded ? `Hide other checks (${rest.length})` : `Other checks (${rest.length})`}
            </button>
          )}
          {/* No aria state attribute, deliberately: the label names the action
              it will perform, exactly as the sibling control beside it does,
              and a `pressed` announcement on top of "Hide …" only says the
              same thing twice. Withdrawn entirely while `undecoded` forces
              the column open, because a toggle that cannot change anything is
              worse than no toggle. */}
          {!undecoded && (
            <button
              type="button"
              data-testid="tool-assertions-wording"
              onClick={() => setWording((open) => !open)}
              className="transition-ui w-fit text-[0.8125rem] font-medium text-accent hover:underline hover:underline-offset-2"
            >
              {wording ? 'Hide the tool’s own wording' : 'Show the tool’s own wording'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The Target cell — a link into that request's or group's own analysis when
 * this run recorded one, and plain text when it did not. (review 09-13 M13)
 *
 * ═══ WHY THIS IS NOT JUST `<Link to={...}>` ═══
 *
 * Three of the four target shapes have nowhere to go. `global` is the run,
 * which is the page the reader is already on; `forAll` ranges over every
 * request rather than naming one, and the row's own request name survives only
 * in the tool's prose, which `toolAssertion.ts` exists specifically not to
 * parse. Only a `details` path names something, and even then only when this
 * run has a row for it — a `not_applicable` row names a request that is not
 * there, and a link is the last thing it should offer.
 *
 * The reader's analysis window travels, the same way the statistics table's
 * own drill-down carries it, so an investigation that started inside a brushed
 * interval stays inside it.
 */
function AssertionTarget({
  assertion,
  runId,
  recorded,
  windowSuffix,
}: {
  readonly assertion: ToolAssertion;
  readonly runId: string;
  readonly recorded: ReadonlyMap<string, 'requests' | 'groups'>;
  readonly windowSuffix: string;
}) {
  const label = toolAssertionParts(assertion).target;
  if (label === null) return <>—</>;

  /* THE IDENTITY IS JOINED WITH NO SPACES and the LABEL with them — `Cart /
     Search` reads as a path and `Cart/Search` is one. `rowFor` in
     `@perfportal/statistics` and `buildTree`'s own `SEPARATOR` both use the
     bare form, so that is what a row is keyed and addressed by. */
  const parts = assertion.assertion?.path.parts;
  const name = parts === undefined || parts.length === 0 ? null : parts.join('/');
  const section = name === null ? undefined : recorded.get(name);
  if (name === null || section === undefined) return <>{label}</>;

  return (
    <Link
      to={`/runs/${encodeURIComponent(runId)}/${section}/${encodeURIComponent(name)}${windowSuffix}`}
      className="underline"
    >
      {label}
    </Link>
  );
}

/**
 * NO OCCURRENCE OF THE WORD "STATISTICS" HERE, deliberately.
 *
 * A `<table>`'s accessible name comes from its `<caption>`, and the e2e suite
 * reaches the statistics table with `getByRole('table', { name: /statistics/i })`
 * — a Playwright name match, which is a case-insensitive SUBSTRING. A caption
 * reading "…re-evaluated against this run's statistics" made that query resolve
 * to two tables and broke five specs on a strict-mode violation. Same class of
 * trap as the rail links CLAUDE.md records: the query was never wrong, the new
 * name simply collided with it.
 */
const TOOL_ASSERTIONS_CAPTION = (
  <>
    Every assertion the simulation itself declared, re-checked against this run&rsquo;s own
    measurements. <em>Not applicable</em> means the assertion named a request or group this run
    has no data for.
  </>
);

/** One node, rendered visibly by `TableFrame` and again as the table's own
 *  `sr-only` `<caption>`, so the two cannot drift. */
const ASSERTIONS_CAPTION = (
  <>
    Every SLA rule evaluated against this run, as the rule read at the time it was evaluated.{' '}
    <em>Not applicable</em> means the rule could not be checked at all — it is not a pass.
  </>
);
