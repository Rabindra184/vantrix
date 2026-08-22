import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  Assertion, LiveDelta, SeriesResponse, ToolAssertion,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import SectionHeading from '../components/SectionHeading';
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
import { formatCell } from '../charts/DataTable';
import DistributionChart from '../charts/DistributionChart';
import ErrorsChart from '../charts/ErrorsChart';
import PercentileDistributionChart from '../charts/PercentileDistributionChart';
import IndicatorsChart from '../charts/IndicatorsChart';
import PercentilesChart from '../charts/PercentilesChart';
import RequestCountChart from '../charts/RequestCountChart';
import { RequestRateChart, ResponseRateChart } from '../charts/RatesChart';
import { ConcurrentUsersChart, UserStartRateChart } from '../charts/UsersChart';
import ErrorsTable from '../tables/ErrorsTable';
import StatisticsTable, { formatCount, formatMs } from '../tables/StatisticsTable';
import { downloadCsv } from '../tables/csv';
import { assertionsCsv } from './assertionExport';
import { countAssertions, describeAssertionRule, firstFailedAssertion } from './assertions';
import { baselineRun } from './runBaseline';
import { formatDuration } from './format';
import { ASSERTION_OUTCOME, Marked } from './marks';
import { DEFAULT_ROUTE } from './paths';
import { Payload, TableSection, type Slot } from './payload';
import {
  useLiveFromShell,
  useRunTerminal,
  useTimeDomainFromShell,
  useWindowFromShell,
} from './useRunWindow';
import DesktopOnly from './DesktopOnly';
import LiveNotice from './LiveNotice';
import RunShell from './RunShell';
import useIsCompact from '../useIsCompact';
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
          <SkeletonTable columns={6} rows={5} />
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
          label="Requests So Far"
          value={formatCount(summary.count)}
          hint={`${formatCount(summary.okCount)} OK, ${formatCount(summary.koCount)} KO`}
          data-testid="live-stat-total-requests"
        />
        <StatTile
          label="Error Rate"
          // Same field and expression `RunStats`' own tile uses
          // (`errorRate * 100`, two decimals) — never `koCount / count`,
          // a second definition of the one number a few tiles away.
          value={`${(summary.errorRate * 100).toFixed(2)}%`}
          hint={`${formatCount(summary.koCount)} of ${formatCount(summary.count)} requests`}
          data-testid="live-stat-error-rate"
        />
        <StatTile
          label="Peak Users"
          value={formatCount(summary.maxUsers)}
          hint="concurrent, so far"
          data-testid="live-stat-peak-users"
        />
        <StatTile
          label="Duration So Far"
          value={formatDuration(summary.durationMs)}
          hint={frozen ? 'when streaming stopped' : 'still streaming'}
          data-testid="live-stat-duration"
        />
        <StatTile
          label="95th Percentile"
          value={livePercentileValue(summary, 'p95')}
          hint="an estimate, so far"
          data-testid="live-stat-p95"
        />
        <StatTile
          label="99th Percentile"
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
 * `percentileValue`, this has no `clampPercentile` step: that clamp projects
 * a raw estimate onto a `StatRow`'s own `minMs`/`maxMs`, and a live summary
 * carries neither. `—`, never `0`, for a project configured with no such
 * percentile: a gap in `summary.percentiles` is not a measurement of zero.
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
        <DesktopOnly compact={compact} what="The per-request statistics table">
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
      <Assertions runId={runId} assertions={runAssertions} />
      <ToolAssertions assertions={run.data.run.toolAssertions} />

      {/* `RunStats` renders INSIDE `TableSection`'s own children callback,
          from the SAME `data` the statistics table reads below it, rather
          than behind a `TableSection` of its own: a failed or still-pending
          `/stats` then explains itself once, in the one place this page
          already says so, instead of the stat row silently rendering six
          dashes above an error the reader has to notice separately. */}
      <TableSection title="Statistics" query={stats}>
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
            <RunStats
              stats={data}
              baseline={window === null ? baselineRun(trends.data, runId) : null}
              assertions={runAssertions}
            />
            {/* THE TILES ARE NEVER WITHHELD. They are the whole point of the
                mobile summary — §22.6 names "key tiles, sparklines, verdict,
                error summary" — and they are already responsive. It is the
                per-request TABLE below them that a phone cannot usefully
                render, so only that is behind the notice. */}
            {compact && <Sparklines series={series} />}
            <DesktopOnly compact={compact} what="The per-request statistics table">
              {() => <StatisticsTable stats={data} runId={runId} />}
            </DesktopOnly>
          </>
        )}
      </TableSection>
    </>
  );
}

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
export function RunErrorsTab() {
  const { runId } = useParams<{ runId: string }>();
  const live = useLiveFromShell();
  const { detail: run, terminal } = useRunTerminal(runId);
  const errors = useQuery({ ...errorsQuery(runId ?? ''), enabled: terminal });
  const window = useWindowFromShell();
  // One time axis across the page (§22.5) — see `useTimeDomainFromShell`.
  const domainMs = useTimeDomainFromShell();
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
        <TableSection title="Errors" query={errors}>
          {(data) => <ErrorsTable errors={data} />}
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
        {(data) => <ErrorsChart data={data} domainMs={domainMs} />}
      </Payload>

      <TableSection title="Errors" query={errors}>
        {(data) => <ErrorsTable errors={data} />}
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
        <DesktopOnly compact what="Reading five charts" onShow={() => setShown(true)}>
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
            <ConcurrentUsersChart users={users.data} group={RUN_TIME} domainMs={domainMs} />
            <UserStartRateChart users={users.data} group={RUN_TIME} domainMs={domainMs} />
          </>
        )}
        {series.data !== undefined && (
          <>
            <PercentilesChart series={series.data} domainMs={domainMs} />
            <RequestRateChart series={series.data} domainMs={domainMs} />
            <ResponseRateChart series={series.data} domainMs={domainMs} />
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
      <DesktopOnly compact what="Reading eight charts" onShow={() => setShown(true)} >
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
    // holds a 288px-tall plot plus a legend plus a data-table toggle, and two
    // of those in a 1280px window leaves each chart ~600px — narrow enough
    // that a 60-bucket time axis starts dropping every other tick label.
    // Above 1536px there is room for both, and halving the scroll depth of an
    // eight-figure page is worth real time to a reader comparing two of them.
    <section aria-labelledby="charts-heading" className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
      <h2 id="charts-heading" className="sr-only">
        Charts
      </h2>
      <Payload query={stats} slots={[INDICATORS, REQUEST_COUNTS]}>
        {(data) => (
          <>
            <IndicatorsChart stats={data} />
            <RequestCountChart stats={data} />
          </>
        )}
      </Payload>

      <Payload query={users} slots={[CONCURRENT_USERS, USER_START_RATE]}>
        {(data) => (
          <>
            {/* Its OWN chart, sharing the crosshair — never an overlay on
                requests/s. See RUN_TIME above. */}
            <ConcurrentUsersChart users={data} group={RUN_TIME} domainMs={domainMs} />
            <UserStartRateChart users={data} group={RUN_TIME} domainMs={domainMs} />
          </>
        )}
      </Payload>

      <Payload query={distribution} slots={[DISTRIBUTION, PERCENTILE_DISTRIBUTION]}>
        {(data) => (
          <>
            <DistributionChart distribution={data} />
            <PercentileDistributionChart distribution={data} />
          </>
        )}
      </Payload>

      <Payload query={series} slots={[PERCENTILES, REQUESTS_PER_SECOND, RESPONSES_PER_SECOND]}>
        {(data) => (
          <>
            <PercentilesChart series={data} domainMs={domainMs} />
            <RequestRateChart series={data} domainMs={domainMs} />
            <ResponseRateChart series={data} domainMs={domainMs} />
          </>
        )}
      </Payload>
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
}: {
  readonly runId: string;
  readonly assertions: readonly Assertion[];
}) {
  if (assertions.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading overline="Evidence">Assertions</SectionHeading>
        <EmptyState
          title="No SLA rules were evaluated against this run"
          body="Rules are configured per project, and only rules that existed when the run was ingested are applied to it."
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading overline="Evidence">Assertions</SectionHeading>
        <Button
          size="sm"
          onClick={() => downloadCsv(`run-${runId}-assertions.csv`, assertionsCsv(assertions))}
        >
          <DownloadIcon className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
      <AssertionEvidencePanel assertions={assertions} />
      <TableFrame caption={ASSERTIONS_CAPTION} label="Assertions table">
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
              {assertions.map((assertion) => (
                <tr key={assertion.ruleId} data-testid="assertion-row" className={ROW}>
                  <td data-testid="assertion-outcome" className={`${TD} whitespace-nowrap`}>
                    <Marked mark={ASSERTION_OUTCOME[assertion.outcome]} />
                  </td>
                  <td className={`${TD} font-mono text-[12px]`}>{describeAssertionRule(assertion.rule)}</td>
                  {/* Null for a not_applicable assertion — there was nothing to
                      measure (AssertionSchema). A dash, never `0`: zero is a
                      measurement, and this is the absence of one. */}
                  <td className={TD_NUM}>{assertion.actualValue ?? '—'}</td>
                  <td className={`${TD} text-muted`}>{assertion.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </TableFrame>
    </section>
  );
}

function AssertionEvidencePanel({ assertions }: { assertions: readonly Assertion[] }) {
  const counts = countAssertions(assertions);
  const firstFailed = firstFailedAssertion(assertions);

  return (
    <div
      data-testid="assertion-evidence-panel"
      className="grid gap-4 rounded-xl border border-default bg-surface p-4 shadow-panel lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            SLA evidence
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {firstFailed?.message ?? 'Every evaluated rule is within its configured threshold.'}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-2">
          <AssertionCount label="Passed" value={counts.passed} mark={ASSERTION_OUTCOME.passed} />
          <AssertionCount label="Failed" value={counts.failed} mark={ASSERTION_OUTCOME.failed} />
          <AssertionCount
            label="N/A"
            value={counts.not_applicable}
            mark={ASSERTION_OUTCOME.not_applicable}
          />
        </dl>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {assertions.map((assertion) => (
          <AssertionEvidenceRow key={assertion.ruleId} assertion={assertion} />
        ))}
      </div>
    </div>
  );
}

function AssertionCount({
  label,
  value,
  mark,
}: {
  readonly label: string;
  readonly value: number;
  readonly mark: (typeof ASSERTION_OUTCOME)[Assertion['outcome']];
}) {
  return (
    <div className="rounded-lg border border-default bg-sunken px-3 py-2" style={{ color: mark.colour }}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold leading-none tabular-nums text-primary">
        {value}
      </dd>
    </div>
  );
}

function AssertionEvidenceRow({ assertion }: { assertion: Assertion }) {
  const mark = ASSERTION_OUTCOME[assertion.outcome];
  const width = assertionProgress(assertion);

  return (
    <article className="rounded-lg border border-default bg-sunken px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[12px] leading-relaxed text-primary">{describeAssertionRule(assertion.rule)}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            Actual {formatAssertionValue(assertion.actualValue)}
          </p>
        </div>
        <span className="shrink-0 text-[12px] font-medium" style={{ color: mark.colour }}>
          <Marked mark={mark} />
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden="true">
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, backgroundColor: assertionBarColour(assertion.outcome) }}
        />
      </div>
    </article>
  );
}

function assertionProgress(assertion: Assertion): number {
  const actual = assertion.actualValue;
  const { comparator, threshold } = assertion.rule;
  if (actual === null || actual === undefined || !Number.isFinite(actual) || threshold <= 0) {
    return assertion.outcome === 'passed' ? 100 : 0;
  }

  const ratio = comparator === 'lte' ? threshold / Math.max(actual, threshold) : actual / threshold;
  return Math.max(4, Math.min(100, ratio * 100));
}

function assertionBarColour(outcome: Assertion['outcome']): string {
  return ASSERTION_OUTCOME[outcome].colour;
}

function formatAssertionValue(value: number | null): string {
  return value === null ? '—' : formatCell(value);
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
}: {
  readonly assertions: readonly ToolAssertion[] | null | undefined;
}) {
  if (assertions === null || assertions === undefined) return null;

  if (assertions.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading>Simulation assertions</SectionHeading>
        <EmptyState
          title="This simulation declared no assertions"
          body="Assertions are written in the simulation itself and are read from the result file. This run's tool reported none."
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Simulation assertions</SectionHeading>
      <TableFrame caption={TOOL_ASSERTIONS_CAPTION} label="Simulation assertions table">
        <table className={TABLE}>
          <caption className="sr-only">{TOOL_ASSERTIONS_CAPTION}</caption>
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={TH}>
                Assertion
              </th>
              <th scope="col" className={TH}>
                Actual
              </th>
            </tr>
          </thead>
          <tbody>
            {assertions.map((assertion, i) => (
              <tr
                // The expression is not unique — a simulation may assert the
                // same thing twice, and `forAll` expands to one row per request
                // with only the name differing. Index is the row's identity
                // here because the list is a fixed, ordered projection that is
                // never sorted or filtered in the client.
                key={`${assertion.expression}-${i}`}
                data-testid="tool-assertion-row"
                className={ROW}
              >
                <td data-testid="tool-assertion-outcome" className={`${TD} whitespace-nowrap`}>
                  <Marked mark={ASSERTION_OUTCOME[assertion.outcome]} />
                </td>
                <td className={`${TD} font-mono text-[12px]`}>{assertion.expression}</td>
                {/* A dash, never `0` — see the SLA table's own note. */}
                <td className={TD_NUM}>
                  {assertion.actualValue === null ? '—' : formatCell(assertion.actualValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </section>
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
