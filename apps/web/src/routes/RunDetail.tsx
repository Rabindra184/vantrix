import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  Assertion, LiveDelta, RunProcessing, RunResponse, SeriesResponse, ToolAssertion,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import SectionHeading from '../components/SectionHeading';
import { Skeleton, SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import StatTile from '../components/StatTile';
import TableFrame from '../components/TableFrame';
import { ChevronLeftIcon, RefreshIcon } from '../components/icons';
import { ROW, TABLE, TD, TD_NUM, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { useLiveRun, type LiveRunState } from '../api/live';
import {
  distributionQuery,
  errorSeriesQuery,
  errorsQuery,
  seriesQuery,
  statsQuery,
  usersQuery,
} from '../api/metrics';
import { POLL_CAP_MS, fetchRun, pollIntervalFor, runQueryKey } from '../api/run';
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
import { formatDuration } from './format';
import { ASSERTION_OUTCOME, Marked, STATUS } from './marks';
import { DEFAULT_ROUTE } from './paths';
import { Payload, TableSection, type Slot } from './payload';
import { growingDomainMs, useTimeDomainFromShell, useWindowFromShell } from './useRunWindow';
import DesktopOnly from './DesktopOnly';
import LiveNotice from './LiveNotice';
import RunShell from './RunShell';
import SlaBanner from './SlaBanner';
import useIsCompact from '../useIsCompact';
import RunStats from './RunStats';

/**
 * This module's default export decides WHICH of a run's three states is on
 * screen; it renders neither a header nor the SLA rules itself any more.
 * Those moved out when the run page grew tabs: the header is `RunHeader`,
 * rendered by `RunShell` below, and the assertions live on `RunOverviewTab`.
 * What is left here is four route components sharing one run — `RunDetail`
 * itself (the three-state branch), `RunOverviewTab`, `RunChartsTab` and
 * `RunErrorsTab` (`RunShell`'s tab children) — plus the pieces they share:
 * `Assertions`, the Charts tab's chart-slot constants, and `describeRule`.
 *
 * The last screen of the parity shell, and the end of the definition of done
 * — a person signs in, sees their org's runs, opens one, and reads it.
 *
 * Three states, not two, because `GET /v1/runs/:id` has three answers (see
 * `fetchRun`): a readable run, a run still being processed, and a problem.
 * Collapsing the middle one into the first is what would put `0s` and "no
 * verdict yet" on screen as though they were measurements.
 *
 * THE MIDDLE STATE ITSELF NOW SPLITS IN TWO (Task 8, design part 2b). A
 * `processing` run renders `Live` once `useLiveRun` has delivered at least
 * one delta THIS SESSION — whether it is streaming right now or has just
 * stopped (§4.4's frozen dashboard) — and the unmodified `Processing`
 * screen otherwise: a run never live this session, or a compact viewport,
 * which never opens the socket at all (§4.1, §22.6).
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

  const run = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    queryFn: () => fetchRun(runId!),
    enabled: runId !== undefined,
    // The decision lives in api/run.ts as a pure function so the cap is
    // testable without waiting two real minutes in a browser. That function
    // also holds the OTHER half of the live exemption below: a `running` run
    // is polled whatever `capReached` says.
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

  if (run.data.state === 'processing') {
    const status = run.data.run.status;

    // A RETAINED DELTA — from this run being live right now, or from it
    // having been live earlier in this session — means there is a populated
    // dashboard to show, whatever `status` currently says. `live.lastDelta`
    // is never cleared on its own (`useLiveRun`'s own contract), so once a
    // delta has arrived this branch keeps rendering `Live` straight through
    // `running` -> `parsing` (design §4.4's frozen banner) -> `complete`
    // (where the render above already stops reaching this branch at all,
    // once `run.data.state` flips to `'ready'`). A run that never streamed
    // in this session — `pending`/`parsing` with no socket ever opened, or a
    // compact viewport where one never opens at all — falls straight
    // through to the unmodified `Processing` screen below.
    if (live.lastDelta !== null) {
      return (
        <Live
          status={status}
          runId={runId}
          live={live}
          compact={compact}
          capReached={capReached}
          onRetry={() => void run.refetch()}
        />
      );
    }
    return <Processing status={status} capReached={capReached} onRetry={() => void run.refetch()} />;
  }

  return <Ready run={run.data.run} />;
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
 * A run the platform has accepted but not finished parsing (HTTP 202).
 *
 * Deliberately renders NO header shell: there is no duration, no verdict and
 * no assertion to show, and a table of dashes reads as a run that was
 * measured and found empty rather than one nobody has looked at yet.
 *
 * EXPORTED for `apps/web/test/run-detail.test.ts`, which renders it directly
 * to static markup with both values of `capReached` — a cheap, node-environment
 * check that the two branches say different things. The cap's WIRING (the
 * timer in `RunDetail` that sets the flag) is covered separately, and through a
 * real mount, by `apps/web/test/RunDetail.polling.test.tsx`.
 *
 * Taking `capReached` as a prop rather than reading the timer itself is still
 * the right shape: it keeps this component renderable without a clock.
 */
export function Processing({
  status,
  capReached,
  onRetry,
}: {
  // `RunProcessing['status']` — 'pending' | 'parsing' — not `string`. The
  // contract's own union is what makes a future third processing status a
  // compile error here rather than a silent render of the 'pending' mark.
  status: RunProcessing['status'];
  capReached: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center">
      {/* The status mark IS the illustration — a pulsing ring in the pending
          colour, with the word beside it — rather than a generic spinner. A
          spinner says "something is happening"; this says which of `pending`
          and `parsing` is happening, which is the one fact the reader can act
          on (a run stuck in `pending` never reached the worker). The pulse is
          decorative and `tokens.css` turns it off under reduced-motion. */}
      {/* The colour arrives as DATA on the `Mark`, through an inline `style`,
          which is the same route `Marked` and `Badge` already take and the
          reason `routes/marks.tsx` is exempt from the arbitrary-value gate in
          `test/tokens.test.ts`. Reaching for the pending token as a Tailwind
          arbitrary value instead would trip that gate — correctly, and not
          only on a technicality: a token written in here would be a second
          place to edit on the day `parsing` and `pending` stop sharing a
          colour. `tint` then derives the wash and the ring from
          `currentColor`, so all three follow the one value.

          (The gate greps the raw file, comments included, which is why this
          paragraph describes the spelling rather than quoting it.) */}
      <span
        className="tint relative flex h-11 w-11 items-center justify-center rounded-full border"
        style={{ color: STATUS[status].colour }}
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-20" />
        <span aria-hidden="true" className="relative text-lg leading-none">
          {STATUS[status].glyph}
        </span>
      </span>

      <h1 className="text-[15px] font-semibold tracking-tight text-primary">Run in progress</h1>
      {/* `role="status"` on the sentence that changes, so a screen reader
          hears the transition rather than only the first paint. */}
      <p role="status" className="text-[13px] text-muted">
        This run is still processing.
      </p>
      <p className="text-[13px]">
        <Marked mark={STATUS[status]} />
      </p>

      {capReached ? (
        // The cap has been reached: the page has stopped asking on its own.
        // Saying so — and handing the reader the control — is the difference
        // between a page that gave up and a page that appears to be working
        // while making no requests at all.
        <>
          <p className="max-w-sm text-[13px] leading-relaxed text-muted">
            PerfPortal stopped checking automatically after two minutes. The run has not finished
            yet.
          </p>
          {/* `primary`: on a page whose only other control is "Back to all
              runs", re-checking is what the reader came to do. */}
          <Button variant="primary" size="sm" onClick={onRetry}>
            <RefreshIcon className="h-3.5 w-3.5" />
            Check again
          </Button>
        </>
      ) : (
        <p className="max-w-sm text-[13px] leading-relaxed text-muted">
          This page checks again every few seconds; there is nothing to do.
        </p>
      )}
      <BackToRuns />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The live page — design part 2b §4.1, §4.3, §4.4
 * ------------------------------------------------------------------ */

/**
 * A run currently streaming, or one that just stopped and is still showing
 * its last delta while REST finishes the report (design §4.3, §4.4).
 *
 * RENDERED ONLY ONCE A DELTA HAS ARRIVED. `RunDetail`'s own branch makes
 * that guarantee — a run that has never delivered a delta this session
 * (including every compact viewport, which never opens the socket at all)
 * still renders `Processing`, completely unmodified. Once a delta HAS
 * arrived it is never cleared (`useLiveRun`'s own contract), which is what
 * lets this one component also cover the FROZEN case — `status !==
 * 'running'` — with nothing more than a banner: the dashboard underneath it
 * does not need a separate "it just ended" render, because nothing about it
 * needs to change.
 *
 * NO `RunShell`, NO `RunHeader`, NO TABS. `GET /v1/runs/:id` answers 202 for
 * anything short of `complete` (`RunsService.statusFor`), so a running run
 * has no `RunResponse` at all — no project, no tool, no verdict — on any
 * path, for as long as it streams. `RunShell`'s header needs exactly those
 * fields; building it from invented placeholders would be the fabrication
 * this codebase's "null tiles, never zeroed ones" rule exists to forbid, one
 * level up from a stat tile.
 */
export function Live({
  status,
  runId,
  live,
  compact,
  capReached,
  onRetry,
}: {
  // `RunProcessing['status']`, not `string` — see `Processing`'s own prop
  // for the same reasoning.
  readonly status: RunProcessing['status'];
  readonly runId: string;
  readonly live: LiveRunState;
  readonly compact: boolean;
  /**
   * `RunDetail`'s own polling cap, carried here for the same reason
   * `Processing` takes it: a page that has stopped asking on its own must say
   * so and hand the reader the control. It can only be ACTED on once this run
   * has stopped streaming — `pollIntervalFor` exempts a `running` run from the
   * cap entirely, so while `status === 'running'` the page is still polling
   * whatever this flag says, and claiming otherwise would be the "appears to
   * be working while making no requests" failure inverted.
   */
  readonly capReached: boolean;
  readonly onRetry: () => void;
}) {
  const delta = live.lastDelta;
  // Unreachable through `RunDetail`'s own guard (this component is only ever
  // rendered once `live.lastDelta !== null`). Typed defensively rather than
  // asserted non-null, so a future caller mistake renders nothing instead of
  // throwing.
  if (delta === null) return null;

  const frozen = status !== 'running';
  // THE GROWING DOMAIN, computed through `growingDomainMs` directly rather
  // than through `useTimeDomainFromShell` (`useRunWindow.ts`): that hook
  // reads `RunWindowContext` off an `<Outlet/>` this page never mounts (there
  // is no `RunShell` here — see this component's own docstring), so it
  // cannot be called from here. The two sites cannot be unified into one
  // CALL, but they share one FORMULA — see `growingDomainMs`'s own comment,
  // which names this call site the way this one names it, and
  // `timeAxis.test.ts`'s "Live and useTimeDomainFromShell agree on the
  // growing-run domain formula", which pins the two to the same result for
  // the same input. No window to prefer over it here either: a live view is
  // never narrowed (`useLiveRun`'s own module docstring).
  const domainMs = growingDomainMs(delta.summary.durationMs);

  // OBSERVE THE CACHE; NEVER FETCH IT. `useLiveRun` already writes every one
  // of these three keys directly (`applyDelta`, `api/live.ts`) on every
  // delta. A normal `enabled: true` query here would ALSO hit REST — which,
  // for a run with no persisted rows yet (`MetricWriter` has not run this
  // run's pipeline), answers with an emptier payload that would then win the
  // race against whichever delta landed first, for no benefit: `staleTime:
  // Infinity` means it would only ever fire once, and TanStack still applies
  // whichever write — REST's or the socket's — resolves last.
  const users = useQuery({ ...usersQuery(runId), enabled: false });
  const series = useQuery({ ...seriesQuery(runId, 'run', '', 'response_time'), enabled: false });
  const errors = useQuery({ ...errorsQuery(runId), enabled: false });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {frozen ? 'Run finished' : 'Run in progress'}
        </h1>
        {/* `role="status"`, not `alert`: nothing here is a problem, the same
            distinction `Processing`'s own sentence and `DesktopOnly`'s own
            notice make. */}
        <p role="status" className="text-[13px] text-muted">
          {frozen
            ? 'Streaming has stopped. The numbers below are its last update.'
            : live.connected
              ? 'Live — updating as the run streams.'
              : 'Reconnecting — showing the last update received.'}
        </p>
      </div>

      {/* A banner ABOVE the still-populated dashboard, not a replacement for
          it — see `LiveNotice`'s own docstring on why falling back to
          `Processing` here was rejected.

          ONE OR THE OTHER, never both: `LiveNotice[kind="finalizing"]`
          promises "this page will refresh with the full report once they are
          ready", which is a lie the moment polling has stopped. The capped
          variant makes the same situation readable and gives the reader the
          Retry `Processing` has had all along. */}
      {frozen &&
        (capReached ? <LiveCapped onRetry={onRetry} /> : <LiveNotice kind="finalizing" />)}

      {/* THE SEED THIS VIEW WAS BUILT FROM WAS INCOMPLETE, and the gateway
          said so in the snapshot frame. Independent of `frozen` — a partial
          seed is just as partial while the run is still streaming, and the
          deltas that follow it never fill the hole in `responseTime` (an
          upsert with a short lookback). Below the finalizing banner rather
          than above it: what the page IS doing comes first, then what is
          missing from what it drew. */}
      {live.partial && <LiveNotice kind="partial" />}

      <LiveSummary summary={delta.summary} frozen={frozen} />

      {/* Which SLA rules this run is breaching right now, above the charts
          rather than beside `LiveNotice`'s own banners — those say something
          about the CONNECTION (frozen, partial seed); this says something
          about the NUMBERS the tiles just above it report. Never desktop-gated:
          `SlaBanner`'s own docstring is the reason a phone still needs to see
          this exactly as much as a phone needs the tiles, and it is cheap — a
          few strings off the delta already in hand, not a chart. */}
      <SlaBanner sla={delta.sla} frozen={frozen} />

      {/* §22.6: mounting five ECharts instances costs real work a phone
          should not pay for, even though the three withheld notices beside
          them cost nothing — so the whole grid is gated together, the same
          scope `RunChartsTab` gates its own eight figures at. No `onShow`:
          nothing behind this content is a query this page has NOT already
          fired (`users`/`series` above are cache reads, not fetches), so
          there is no second flag to keep in sync. */}
      <DesktopOnly compact={compact} what="Live charts">
        {() => (
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
                    requests/s. Same rule `RunChartsTab` follows; see its own
                    `RUN_TIME` docstring above. */}
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
            {/* THREE OF THE FOUR WITHHELD SECTIONS THAT ARE CHARTS. The first
                two fold the SAME `/distribution` payload on a finished run
                (`RunChartsTab`'s own `DISTRIBUTION`/`PERCENTILE_DISTRIBUTION`
                slots) and neither has ANY live source — §4.3: they need
                per-request or full-sketch data no delta carries, on any
                path, while the run streams.

                TASK 9 C2: errors-over-time is the same shape of gap, just
                fed by a DIFFERENT endpoint (`errorSeriesQuery`,
                `RunErrorsTab`'s own chart) that the live wire also never
                carries — §1.3 scopes the live `errors` envelope to run-scope
                TOTALS only (`LiveErrorsSchema`), with no time series. Before
                this notice the chart was simply never rendered here at all:
                silent absence, exactly what the withheld-notice pattern
                exists to replace with a stated one. The errors TABLE right
                below this section is unaffected — `delta.errors.rows` feeds
                it live, same as it always has. */}
            <LiveNotice kind="withheld" subject="Response time distribution" />
            <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
            <LiveNotice kind="withheld" subject="Errors per second" />
          </section>
        )}
      </DesktopOnly>

      {/* NOT desktop-gated — matching `RunErrorsTab`, which never gates the
          errors table either. §22.6 names "error summary" as exactly the
          kind of thing a phone's read-only view should still carry. */}
      <TableSection title="Errors" query={errors}>
        {(data) => <ErrorsTable errors={data} />}
      </TableSection>

      {/* THE FOURTH WITHHELD SECTION. Gated the same way the REAL statistics
          table is on a finished run (`RunOverviewTab`'s own `DesktopOnly`,
          same `what` text) — the table itself needs per-endpoint rows §1.3
          excludes from the live wire entirely, so there is no live version
          of it at any viewport width. */}
      <DesktopOnly compact={compact} what="The per-request statistics table">
        {() => <LiveNotice kind="withheld" subject="Statistics" />}
      </DesktopOnly>
    </div>
  );
}

/**
 * The frozen live page's version of `Processing`'s cap block — the affordance
 * `Live` shipped without.
 *
 * `Processing` has said "PerfPortal stopped checking automatically" with a
 * Check again button since the parity shell; `Live` replaced that whole screen
 * for a run that streamed, and inherited neither. So a run that finished
 * streaming and then took longer than the cap to finalize left the reader on a
 * page that had silently stopped polling while promising to refresh itself.
 *
 * NOT `LiveNotice`, and not a third `kind` on it: this one carries a `<button>`
 * (with an icon), and `LiveNotice`'s own docstring earns its "safe wherever a
 * caller places it" precisely by having no `<svg>` — nine e2e specs count SVG
 * elements inside chart `<figure>`s. Keeping the button out here keeps that
 * guarantee true for the component that needs it.
 *
 * The copy shares `Processing`'s "stopped checking automatically after two
 * minutes" sentence deliberately — one page state, one wording — and the two
 * screens are mutually exclusive branches, so no query can resolve both.
 */
function LiveCapped({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div
      role="status"
      data-testid="live-notice-capped"
      className="flex flex-col items-start gap-2.5 rounded-xl border border-default bg-surface px-4 py-3 text-[13px] text-muted"
    >
      <p className="leading-relaxed">
        This run has finished streaming. PerfPortal stopped checking automatically after two
        minutes, so the numbers below are its last live update rather than the full report.
      </p>
      <Button variant="primary" size="sm" onClick={onRetry}>
        <RefreshIcon className="h-3.5 w-3.5" />
        Check again
      </Button>
    </div>
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
 * `frozen` (TASK 9 C3) is `Live`'s own `status !== 'running'` — the same
 * flag that decides whether `LiveNotice[kind="finalizing"]` renders directly
 * above this section. Without it the "Duration So Far" tile said "still
 * streaming" unconditionally, including in the exact render where the
 * banner one section up says streaming has stopped — the tile and the
 * banner disagreeing about the run's own state on the same screen.
 */
function LiveSummary({
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

function Ready({ run }: { run: RunResponse }) {
  // The header — identity, tool, timing, duration, status and verdict — now
  // lives in `RunHeader`, rendered by `RunShell` above its tab strip (Task 3;
  // design §4). `RunShell` is a LAYOUT ROUTE: it mounts once here, inside
  // this branch only, and its `<Outlet/>` is what swaps between
  // `RunOverviewTab`, `RunChartsTab` and `RunErrorsTab` as the URL's last
  // segment changes. A processing run (202) renders `Processing` instead and
  // never reaches here — which is what keeps the tab content's metric
  // queries (and the header's own `/users` fetch) from firing against a run
  // whose rows do not exist yet (design §3c), and is why `api/metrics.ts`
  // can use `apiFetch` rather than `fetchRun`'s three-way status branch
  // (design §6).
  return <RunShell run={run} />;
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
 */
export function RunOverviewTab() {
  const { runId } = useParams<{ runId: string }>();
  const run = useQuery({
    queryKey: runQueryKey(runId ?? ''),
    queryFn: () => fetchRun(runId!),
    enabled: runId !== undefined,
  });
  const window = useWindowFromShell();
  const compact = useIsCompact();
  const stats = useQuery({ ...statsQuery(runId ?? '', window), enabled: runId !== undefined });
  // §22.6's summary needs a SHAPE beside the numbers. The same key the charts
  // tab uses, so a reader who widens the window pays for it once.
  const series = useQuery({
    ...seriesQuery(runId ?? '', 'run', '', 'response_time', window),
    enabled: runId !== undefined && compact,
  });

  // Not reachable through the router: `RunShell` mounts this tab only once
  // `RunDetail` has already resolved a `ready` run for this `runId`, and the
  // query above is then served from that same warm cache entry. Guarded
  // anyway so a render that somehow beat the cache is a blank tab rather than
  // a crash on `run.data.run`.
  if (runId === undefined || run.data === undefined || run.data.state !== 'ready') return null;

  return (
    <>
      <Assertions assertions={run.data.run.assertions} />
      <ToolAssertions assertions={run.data.run.toolAssertions} />

      {/* `RunStats` renders INSIDE `TableSection`'s own children callback,
          from the SAME `data` the statistics table reads below it, rather
          than behind a `TableSection` of its own: a failed or still-pending
          `/stats` then explains itself once, in the one place this page
          already says so, instead of the stat row silently rendering six
          dashes above an error the reader has to notice separately. */}
      {/* `RunStats` renders INSIDE `TableSection`'s own children callback,
          from the SAME `data` the statistics table reads below it, rather
          than behind a `TableSection` of its own: a failed or still-pending
          `/stats` then explains itself once, in the one place this page
          already says so, instead of the stat row silently rendering six
          dashes above an error the reader has to notice separately. */}
      <TableSection title="Statistics" query={stats}>
        {(data) => (
          <>
            <RunStats stats={data} />
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
 */
export function RunErrorsTab() {
  const { runId } = useParams<{ runId: string }>();
  const errors = useQuery({ ...errorsQuery(runId ?? ''), enabled: runId !== undefined });
  const window = useWindowFromShell();
  // One time axis across the page (§22.5) — see `useTimeDomainFromShell`.
  const domainMs = useTimeDomainFromShell();
  const series = useQuery({
    ...errorSeriesQuery(runId ?? '', window),
    enabled: runId !== undefined,
  });

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
 */
export function RunChartsTab() {
  const { runId } = useParams<{ runId: string }>();
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
  const on = runId !== undefined && wanted;
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
function Assertions({ assertions }: { assertions: readonly Assertion[] }) {
  if (assertions.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading>Assertions</SectionHeading>
        <EmptyState
          title="No SLA rules were evaluated against this run"
          body="Rules are configured per project, and only rules that existed when the run was ingested are applied to it."
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading>Assertions</SectionHeading>
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
                  <td className={`${TD} font-mono text-[12px]`}>{describeRule(assertion.rule)}</td>
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

/**
 * The rule in the same words the evaluator used when it wrote the assertion's
 * message (`describe` in packages/sla/src/evaluate.ts). Restated here rather
 * than parsed back out of that message: the structured `rule` snapshot is the
 * fact, and a UI that read prose to recover data it already has would break
 * the day the prose was reworded.
 */
function describeRule(rule: Assertion['rule']): string {
  const target = rule.targetName ?? 'the run';
  const comparator = rule.comparator === 'lte' ? '≤' : '≥';
  return `${rule.metric} of ${target} (${rule.family}) ${comparator} ${rule.threshold}`;
}

