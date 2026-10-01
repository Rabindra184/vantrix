import { useId, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { LiveDelta, SeriesResponse } from '@perfportal/contracts';
import { errorsQuery, seriesQuery, statsQuery, trendsQuery, usersQuery } from '../api/metrics';
import PercentilesChart from '../charts/PercentilesChart';
import { RequestRateChart, RequestsAndResponsesChart } from '../charts/RatesChart';
import { ErrorState } from '../components/States';
import StatTile from '../components/StatTile';
import ErrorsTable, { ERRORS_TABLE_COLUMNS } from '../tables/ErrorsTable';
import { formatCount, formatMs } from '../tables/StatisticsTable';
import useIsCompact from '../useIsCompact';
import { PlatformGatesBar, SimulationAssertionsBar } from './AssertionBars';
import { rulesRan } from './decision';
import { failingRequestNames } from './errorRequestFilter';
import { FRAGMENT_SCROLL_MARGIN } from './fragment';
import { Payload, TableSection, explain } from './payload';
import { baselineRun, cohortRun } from './runBaseline';
import RunStats from './RunStats';
import { PERCENTILES, REQUESTS_AND_RESPONSES } from './runSlots';
import { peakConcurrentUsers } from './runUsers';
import {
  useLiveFromShell,
  useRunTerminal,
  useWarmupFromShell,
  useWholeRunDomainFromShell,
} from './useRunWindow';
import WaitingPanel from './WaitingPanel';

/** The Summary keeps its cohort page for five minutes; see the `trends` query. */
const SUMMARY_TRENDS_STALE_MS = 5 * 60_000;

/**
 * `/runs/:runId` — GE's Summary (backlog #7): always the WHOLE run. With a
 * 30-second window in its URL GE's Summary still read the run's 900 requests
 * (measured), so every query here passes `null` and the axis is the run's own
 * span. The window belongs to the Report.
 *
 * Above this page the shell draws the header, the tabs, the lifecycle strip
 * and the verdict band (Summary only); then GE's four numbers, the two
 * assertion bars, GE's two charts, and the errors table.
 *
 * EVERY HOOK SITS ABOVE THE FIRST EARLY RETURN, the `trends` query included.
 * This page is one component instance from the moment a run streams to the
 * moment it is finished — the route does not remount, only the run's state
 * changes — so a hook that only some states reach is "Rendered more hooks than
 * during the previous render", which this page has shipped twice. The queries
 * are `enabled: terminal` rather than conditionally CALLED for the same reason.
 *
 * AND THE TWO BARS ARE RENDERED DIRECTLY, never wrapped so they stay mounted
 * across that flip under one key: `PlatformGatesBar` keys its own two branches
 * so that a run which finishes with a failed gate opens it, and an outer
 * wrapper holding the instance would undo that.
 */
export default function RunSummary() {
  const { runId } = useParams<{ runId: string }>();
  const { detail: run, terminal } = useRunTerminal(runId);
  const live = useLiveFromShell();
  const domainMs = useWholeRunDomainFromShell();
  const warmupMs = useWarmupFromShell() ?? undefined;
  const compact = useIsCompact();
  const id = runId ?? '';
  const stats = useQuery({ ...statsQuery(id, null), enabled: terminal });
  const users = useQuery({ ...usersQuery(id, null), enabled: terminal });
  // Read live too: the delta writes this same key, and a live view has no window.
  const series = useQuery({ ...seriesQuery(id, 'run', '', 'response_time', null), enabled: terminal });
  // THE COHORT, FOR ONE NEIGHBOUR — and deliberately NOT on this file's
  // default terms.
  //
  // `trendsQuery` is the one factory in `api/metrics.ts` with no `staleTime`,
  // and its docstring argues that correctly: the Trends TAB draws the whole
  // cohort, and a cohort answer changes when any run of the same simulation is
  // ingested. This consumer wants one entry out of it — the run immediately
  // before this one — which cannot change once it exists. Left on the default,
  // every switch back to the Summary re-issued the heaviest read in the app
  // (up to 21 DDSketch blobs deserialised and re-quantiled server-side) to
  // relabel four tiles.
  //
  // `staleTime` is per-OBSERVER in TanStack, so this override buys the Summary
  // its cache without touching the Trends tab's own refetch-on-mount, even
  // though both observe the identical key. `terminal` only: there is no window
  // to withhold the deltas under any more, because the Summary has none.
  const trends = useQuery({
    ...trendsQuery(id),
    enabled: terminal,
    staleTime: SUMMARY_TRENDS_STALE_MS,
  });

  // Not reachable through the router with `run.data` still `undefined` past
  // first paint — `RunShell` mounts this page only once `RunDetail` has
  // resolved SOME state for this `runId`, and the query above is then served
  // from that same warm cache entry.
  if (runId === undefined || run.data === undefined) return null;

  // NOT TERMINAL: either an honest wait, or the live wire's own headline
  // numbers. `run.data.state === 'processing'`, not `!terminal`, narrows
  // `run.data` to `RunProcessing` directly, which is what lets
  // `run.data.run.status` below type with no assertion.
  if (run.data.state === 'processing') {
    const delta = live?.lastDelta ?? null;
    // No delta this session: the ordinary wait, same as any other page.
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        <LiveSummary summary={delta.summary} />
        <PlatformGatesBar runId={runId} assertions={undefined} ran />
        {!compact && series.data !== undefined && (
          <OverTimeSection>
            <OverTimeCharts series={series.data} domainMs={domainMs} warmupMs={warmupMs} />
          </OverTimeSection>
        )}
        <ErrorsSection runId={runId} terminal={false} />
      </div>
    );
  }

  const body = run.data.run;
  return (
    <div className="flex flex-col gap-6">
      {/* ═══ THE NUMBERS FIRST, THEN THE VERDICTS, THEN THE SHAPE ═══
       *
       * `RunStats` is gated on the data being PRESENT, and says nothing while
       * `/stats` is still in flight — but a FAILED `/stats` is stated, in the
       * section the numbers would have been in. The old Overview left that to
       * the statistics table beside the tiles (`TableSection` explained a
       * failure once, and the tiles stayed quiet so it was not reported twice);
       * that table is in the Report now, so on this page the four numbers are
       * the only thing asking for `/stats`. Without a branch here one failed
       * request — `retry: false` app-wide — deletes the headline numbers and
       * nothing says why, which is exactly what `Payload`'s docstring rules out:
       * a figure whose fetch failed must not simply vanish. The server's own
       * sentence is relayed through `explain`, the way every other failed
       * payload on the run pages does it.
       *
       * The sparklines come with the tiles — §22.6 names "key tiles,
       * sparklines, verdict, error summary" as the mobile summary, and
       * splitting that pair across two screens is what the rule exists to
       * prevent. */}
      <div className="flex flex-col gap-3">
        {stats.data !== undefined && (
          <RunStats
            stats={stats.data}
            peakUsers={users.data === undefined ? null : peakConcurrentUsers(users.data)}
            runStatus={body.status}
            baseline={baselineRun(trends.data, runId)}
            /* This run's own cohort row, so the note under the tiles can say
               whether the baseline it names was run under comparable
               conditions. */
            current={cohortRun(trends.data, runId)}
            assertions={body.assertions}
          />
        )}
        {/* `data === undefined` as well as `isError`: a background refetch that
            fails leaves the last good numbers in place, and those are still
            the honest thing to show. */}
        {stats.data === undefined && stats.isError && (
          <section aria-label="Run totals">
            <ErrorState title="Run totals could not be loaded" detail={explain(stats.error, 'summary')} />
          </section>
        )}
        {compact && <Sparklines series={series} />}
      </div>
      <PlatformGatesBar
        runId={runId}
        projectSlug={body.project.slug}
        assertions={body.assertions}
        ran={rulesRan(body.status, body.durationMs)}
      />
      {/* `stats.data` is what makes a target linkable: whether a name is a
          request, a group or neither is a question only `/stats` can answer.
          Until it resolves there is no link, only the name. */}
      <SimulationAssertionsBar runId={runId} assertions={body.toolAssertions} stats={stats.data?.stats ?? null} />
      {!compact && (
        <OverTimeSection>
          <Payload query={series} slots={[REQUESTS_AND_RESPONSES, PERCENTILES]}>
            {(data) => <OverTimeCharts series={data} domainMs={domainMs} warmupMs={warmupMs} />}
          </Payload>
        </OverTimeSection>
      )}
      <ErrorsSection runId={runId} terminal />
    </div>
  );
}

/**
 * GE's Summary pair, side by side from `2xl` — the width this repo measured
 * two charts needing before a 60-bucket axis drops labels. "Over time" is a
 * visually hidden `<h2>`: GE draws none, but without it these charts' own
 * `<h3>`s would sit under "Simulation assertions" in a screen reader's outline.
 * The heading sits OUTSIDE `Payload`, so it is in the outline while the charts
 * load or fail too.
 */
function OverTimeSection({ children }: { readonly children: ReactNode }) {
  return (
    <section aria-labelledby="summary-over-time" className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
      <h2 id="summary-over-time" className="sr-only">Over time</h2>
      {children}
    </section>
  );
}

function OverTimeCharts({ series, domainMs, warmupMs }: { readonly series: SeriesResponse; readonly domainMs?: readonly [number, number]; readonly warmupMs?: number }) {
  return (
    <>
      <RequestsAndResponsesChart series={series} domainMs={domainMs} warmupMs={warmupMs} />
      <PercentilesChart series={series} domainMs={domainMs} warmupMs={warmupMs} />
    </>
  );
}

/**
 * The live wire's own headline numbers, read DIRECTLY from a delta's
 * `summary` — never laundered through a `StatRow`.
 *
 * `RunStats` reads a run-scope `StatRow`, and `LiveSummarySchema` has no
 * `StatRow`: this is not `RunStats` fed a partial payload, it is the same four
 * tiles built from what `count`/`okCount`/`koCount`/`errorRate`/`percentiles`/
 * `maxUsers` actually are.
 *
 * ═══ THE SAME FOUR TILES AS THE FINISHED ROW, IN THE SAME PLACES ═══
 *
 * This row and `RunStats`' are the same section of the same page —
 * `aria-label="Run totals so far"` becomes `"Run totals"` — so a reader
 * watching a run finish watches THIS `<dl>` become that one. Both show GE's four
 * numbers in GE's order (error rate, requests, peak users, p95), so the
 * transition substitutes nothing: every tile holds its place and only its
 * words change (`Requests so far` becomes `Requests`).
 *
 * THIS COMMENT HAS HAD TO BE CORRECTED TWICE FOR THE SAME REASON, and the
 * agreement is now a test, not a sentence: it used to claim the live row
 * "moved with" the terminal one while it shared four of six quantities, and
 * p95 sat fifth here and first there until a branch noticed. A comment
 * asserting that one row tracks another is exactly what stops the next reader
 * checking, so `RunStats.test.tsx` reads both files' tile ids and asserts they
 * agree exactly. The old Duration tile left this row with the six: duration is
 * in `RunHeader`'s chips, which can only show it once it stops changing.
 *
 * NEVER WITHHELD, on any viewport: these are cheap, already-fetched (by the
 * socket, not by this component) numbers, and it is the per-request TABLE a
 * phone cannot usefully render, not a handful of tiles.
 *
 * NOT EXPORTED: only this page renders it, and the cases that cover it mount
 * the page (`RunSummary.live.test.tsx`) rather than the row alone. It was
 * exported while the Overview tab imported it from `RunDetail.tsx`; an export
 * nothing reads is a claim somebody has to keep checking.
 */
function LiveSummary({ summary }: { readonly summary: LiveDelta['summary'] }) {
  return (
    <section aria-label="Run totals so far" className="@container">
      <dl className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
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
          label="Requests so far"
          value={formatCount(summary.count)}
          hint={`${formatCount(summary.okCount)} successful, ${formatCount(summary.koCount)} failed`}
          data-testid="live-stat-total-requests"
        />
        <StatTile
          label="Peak users"
          value={formatCount(summary.maxUsers)}
          hint="concurrent, so far"
          data-testid="live-stat-peak-users"
        />
        <StatTile
          label="p95"
          value={livePercentileValue(summary, 'p95')}
          hint="an estimate, so far"
          data-testid="live-stat-p95"
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

/**
 * §22.6's sparklines: the shape behind two of the tiles above them.
 *
 * Requests per second and the response-time percentile bands, drawn short and
 * bare — the tiles already carry the numbers, so axes and a legend would take
 * more room than the lines and repeat what is directly above. Each keeps its
 * data table, collapsed, so nothing is lost to a reader who cannot see them.
 *
 * Drawn only when compact: on a desktop the Summary draws the two full-size
 * charts instead (`OverTimeSection`), from the same `/series` read.
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

/**
 * The errors table, moved from the Errors tab — its endpoint takes no window,
 * so it was always the whole run, which is why it sits on the Summary as GE's
 * does. `id="errors"` is what an old `/errors` link lands on; the request
 * filter (review 09-13 M15) stays in the URL as `request`.
 *
 * The chart that tab drew above the table is not here: Errors per second is in
 * the Report's Requests section now, where it is windowed with its neighbours.
 */
function ErrorsSection({ runId, terminal }: { readonly runId: string; readonly terminal: boolean }) {
  /* ═══ WHICH REQUEST TO INVESTIGATE (review 09-13 M15) ═══
   *
   * The finding: "the current raw messages and counts explain what failed but
   * not which request to investigate", with a drill-down "when mappings are
   * available". They are, and always were — `run_error` carries `scope` and
   * `name`, the engine writes a row per (scope, name), and
   * `GET /v1/runs/:id/errors` has taken `?scope=&name=` all along. Measured on
   * a real run: the same failure is stored twice, once at run scope and once
   * as `request | Cart/Add To Cart`. This page simply never asked for the
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

  // `terminal`: `apiFetch` has no 202 branch, so asking a non-terminal run for
  // rows that do not exist yet draws an error panel where the live table
  // belongs. While a run streams the table reads the cache the delta writes —
  // `useLiveRun`'s `applyDelta` writes this SAME key — so it stays live with
  // no fetch of its own.
  const errors = useQuery({
    ...errorsQuery(runId, requestFilter === null ? 'run' : 'request', requestFilter ?? ''),
    enabled: terminal,
  });
  /* The names to offer, WHOLE RUN — which is the only kind there is on this
     page now, and was a deliberate `null` when this lived on a tab that could
     be windowed: `/v1/runs/:id/errors` takes no `from`/`to`, so the rows this
     filter narrows are always whole-run, and a windowed option list would have
     offered requests chosen on one basis and then filtered rows chosen on
     another. */
  const stats = useQuery({ ...statsQuery(runId, null), enabled: terminal });

  return (
    <div id="errors" className="flex flex-col gap-3" style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}>
      {terminal && (
        <ErrorRequestFilter
          names={stats.data === undefined ? [] : failingRequestNames(stats.data)}
          value={requestFilter}
          onChange={setRequestFilter}
        />
      )}
      <TableSection title="Errors" query={errors} columns={ERRORS_TABLE_COLUMNS}>
        {(data) => (
          <ErrorsTable
            errors={data}
            /* So the empty branch cannot say "no errors were recorded for this
               run" over a filtered view — the precise wrong sentence this prop
               was added for, met from a second caller. No `windowSelected`:
               the Summary is whole-run, so the table's whole-run notice has
               nothing to disclaim. */
            scopeLabel={requestFilter ?? undefined}
          />
        )}
      </TableSection>
    </div>
  );
}
