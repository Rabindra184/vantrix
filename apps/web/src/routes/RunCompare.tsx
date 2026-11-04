import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Window } from '@perfportal/contracts';
import { agentInjectorsQuery } from '../api/agent';
import { seriesQuery, statsQuery, telemetryQuery, trendsQuery, usersQuery } from '../api/metrics';
import CompareChart from '../charts/CompareChart';
import {
  STATS_RANKS,
  cpuPoints,
  runLabels,
  seriesPoints,
  usersPoints,
  type CompareMetric,
  type ComparePoint,
  type CompareRun,
} from '../charts/transforms/compare';
import { runMinuteLabel } from '../charts/transforms/runLabel';
import { formatCell } from '../charts/DataTable';
import { EmptyState, LoadingState } from '../components/States';
import CompareMatrix from '../tables/CompareMatrix';
import {
  resolveReference,
  toCompareMatrix,
  type CompareStats,
} from '../tables/buildCompareMatrix';
import type { TrendRun } from '@perfportal/contracts';
import { VERDICT } from './marks';
import { Payload, type Slot } from './payload';
import DesktopOnly from './DesktopOnly';
import { linkButtonClasses } from '../components/Button';
import { projectRunsPath, projectTestPath } from './paths';
import LiveNotice from './LiveNotice';
import { useRunTerminal } from './useRunWindow';
import useIsCompact from '../useIsCompact';
import {
  DEFAULT_COMPARE_METRIC,
  MAX_COMPARE,
  parseCompareMetric,
  parseCompareReference,
  parseCompareSelection,
  serialiseCompareSelection,
} from './compareSelection';
import { parseWindow, serialiseWindow } from './window';
import { peakConcurrentUsers } from './runUsers';
import { buildCompareSummary, type CompareSummaryModel } from './compareSummary';
import { isExact } from './statsMethod';
import { Approx } from '../components/Approx';
import {
  comparability,
  needsComparabilityCheck,
  summariseConditions,
  type ComparabilityFinding,
} from './comparability';

/**
 * Compare runs — two to five runs of one simulation, overlaid.
 *
 * ═══ NO NEW ENDPOINT ═══
 *
 * `/series` and `/stats` already exist, already have contracts, and are
 * already cached per run with `staleTime: Infinity` — correctly, because a
 * completed run's own metrics never change. So a reader who has already opened
 * one of the selected runs pays nothing to include it here, and the cache
 * entries this page fills are the same ones its run pages will read.
 *
 * The COHORT comes from `trendsQuery`, which is the one thing here that can go
 * stale: ingesting a new run of the same simulation adds a candidate.
 */

/**
 * `production · main · a1b2c3d4` — the conditions a reader is choosing between.
 *
 * ONLY WHAT THE RUN RECORDED. An absent environment is omitted rather than
 * rendered as a dash or as "unknown": this is a chip in a row of chips, and the
 * comparability panel below already states missing evidence in the one place
 * where it changes what a comparison MEANS. Saying it twice would spend the
 * chip's one spare line on a non-fact.
 *
 * Eight characters of the sha, matching the run header's own short-versus-full
 * treatment of a commit.
 */
function conditionsOf(run: TrendRun): string {
  return [run.environment, run.branch, run.commitSha?.slice(0, 8)]
    .filter((part): part is string => part != null && part !== '')
    .join(' · ');
}

const OVERLAY: Slot = { id: 'compare-overlay', title: 'Comparison' };

/**
 * The ranks a bucket does not store and the overlay has to ask `/series` for.
 * Both together for either metric, so switching between the two reuses one
 * cached read. Every other percentile the overlay offers — p90 among them —
 * is in the stored bucket bands (`BUCKET_PERCENTILES`).
 */
const SERIES_EXTRA_RANKS: readonly number[] = [99.9, 99.99];

/** Which overlay source a metric reads. */
const overlaySource = (metric: CompareMetric): 'series' | 'users' | 'cpu' =>
  metric === 'users' ? 'users' : metric === 'cpu' ? 'cpu' : 'series';

/**
 * A run's load-generator CPU summarised for the table: the mean and the
 * maximum of its samples. `null` for a run that recorded none — or none in
 * the window — never a zero, which would read as an idle generator.
 */
function cpuSummary(
  points: readonly ComparePoint[] | null,
): { readonly mean: number; readonly max: number } | null {
  if (points === null || points.length === 0) return null;
  const values = points.map(([, value]) => value);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  };
}

/**
 * One selected run's slice of the comparison window.
 *
 * `ended` is a run that FINISHED BEFORE THE WINDOW BEGAN, detected explicitly
 * and before any clamping: `parseWindow` answers `null` both for "the whole
 * run" and for an empty clamped range, and reading the second as the first
 * would show that run's whole-run figures under a window it was never in —
 * exactly what narrowing must not do. Such a run is asked for nothing.
 *
 * Otherwise `window` is the comparison window held to this run's own
 * duration, so the page never asks the API for time a shorter run did not
 * have.
 */
interface RunScope {
  readonly id: string;
  readonly ended: boolean;
  readonly window: Window | null;
}

export default function RunCompare() {
  const { runId } = useParams<{ runId: string }>();
  const [params, setParams] = useSearchParams();

  /**
   * EVERY VIEW-STATE WRITE ON THIS PAGE REFINES THE CURRENT QUERY STRING.
   *
   * Both writers want the same thing — change one key, keep the rest, do not
   * push a history entry — and spelling that twice is what let them disagree:
   * `setMetric` copied `params` first while `toggle` passed an OBJECT, which
   * React Router reads as the COMPLETE new search string. So ticking a run
   * silently dropped `metric` (owned by this page, and the reason the metric is
   * in the URL at all) and `from`/`to` (the analysis window, which
   * `useWindowSuffix` reads back out of the params to build the tab links).
   *
   * The window loss was the quiet one: Compare drew no brush then, so nothing
   * on screen changed at the moment it went. It draws one now, and the window
   * is one of this page's own writers.
   *
   * One definition, every caller — the metric, the runs, the reference pin and
   * the window — and the drift is now unrepresentable here.
   */
  const refine = (mutate: (next: URLSearchParams) => void) => {
    const updated = new URLSearchParams(params);
    mutate(updated);
    setParams(updated, { replace: true });
  };

  /* ═══ THE METRIC IS PART OF THE QUESTION, SO IT LIVES IN THE URL ═══
   *
   * `runs=` was serialised and the metric was component state defaulting to
   * p95 — so a link to an ERRORS comparison opened as a p95 comparison for
   * whoever received it. The selection survived being pasted into a ticket and
   * the thing being asked about did not, which is the half that matters.
   *
   * Same `replace: true` reasoning as `toggle` below: changing metric refines
   * one view rather than being a new destination. */
  const metric = parseCompareMetric(params.get('metric'));
  const setMetric = (next: CompareMetric) => {
    refine((updated) => {
      if (next === DEFAULT_COMPARE_METRIC) updated.delete('metric');
      else updated.set('metric', next);
    });
  };

  // MINOR 5: gated the same way every tab is — a live run has no `RunStat`
  // rows of its own to plot a cohort point from (`RunTrends.tsx`'s own
  // docstring makes the identical argument for `/trends`), and before
  // `RunShell` mounted for every status this route was unreachable for one
  // anyway (`RunTrends` only ever links here once it has cleared its own
  // `!terminal` return). It is reachable now, by a hand-typed URL, so it
  // gets the same `terminal` gate rather than a bespoke live view of its own.
  // `detail` as well as `terminal`: the empty state below needs the run's
  // PROJECT to offer a way out, and the trends payload carries a test and a
  // simulation but no project at all.
  const { detail, terminal } = useRunTerminal(runId);
  const projectSlug =
    detail.data?.state === 'ready' ? detail.data.run.project.slug : null;

  // The cohort is the set of runs that can legitimately be compared, and the
  // only source of it — a client-supplied list would let a reader compare
  // runs of different simulations by editing a URL.
  // §22.6: deep analysis is a desktop task. Gated on the QUERY as well as the
  // render, so a phone does not fetch a payload it has been told not to draw.
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  const cohort = useQuery({ ...trendsQuery(runId ?? ''), enabled: runId !== undefined && terminal });

  const cohortIds = useMemo(
    () => (cohort.data?.runs ?? []).map((run) => run.id),
    [cohort.data],
  );

  const selected = useMemo(
    () => parseCompareSelection(params.get('runs'), cohortIds, runId ?? ''),
    [params, cohortIds, runId],
  );

  /* ═══ THE TIME RANGE, IN THE URL AS `from`/`to` ═══
   *
   * The run page's own parameters, so the window travels between tabs as it
   * already does and a shared comparison keeps it. The EXTENT is the longest
   * selected run's duration: a window has to be able to reach the end of
   * every run in the comparison, and a shorter run is clamped to itself
   * below rather than limiting the others. */
  const durationOf = (id: string): number | null =>
    cohort.data?.runs.find((run) => run.id === id)?.durationMs ?? null;
  const durations = selected
    .map(durationOf)
    .filter((ms): ms is number => ms !== null);
  const extentMs = durations.length === 0 ? null : Math.max(...durations);
  /* MEMOISED ON ITS INPUTS: the window control re-syncs its fields whenever
     this object changes, so a fresh one per render would wipe the reader's
     typing on every one (`useWindowControl`). */
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const window = useMemo(
    () => (extentMs === null ? null : parseWindow(rawFrom, rawTo, extentMs)),
    [rawFrom, rawTo, extentMs],
  );
  const setWindow = (next: Window | null) =>
    refine((updated) => {
      updated.delete('from');
      updated.delete('to');
      const { from, to } = serialiseWindow(next);
      if (from !== undefined) updated.set('from', from);
      if (to !== undefined) updated.set('to', to);
    });

  const scopes: RunScope[] = selected.map((id) => {
    if (window === null) return { id, ended: false, window: null };
    const duration = durationOf(id);
    if (duration !== null && window.fromMs >= duration) return { id, ended: true, window: null };
    return {
      id,
      ended: false,
      window: parseWindow(String(window.fromMs), String(window.toMs), duration ?? window.toMs),
    };
  });

  /**
   * SELECTION CHANGES GO TO THE URL, not to component state.
   *
   * A comparison someone assembled is a thing they paste into a review comment
   * or a ticket, and state that lives only in a component cannot be pasted.
   * `replace: true` because toggling a run is a refinement of one view rather
   * than a new destination — otherwise Back walks the reader through every
   * checkbox they touched instead of returning them to the run.
   */
  function toggle(id: string) {
    const next = selected.includes(id)
      ? selected.filter((selectedId) => selectedId !== id)
      : [...selected, id];
    refine((updated) => updated.set('runs', serialiseCompareSelection(next)));
  }

  /* ═══ ONLY THE SELECTED METRIC'S READS ═══
   *
   * Every run's `/stats` is read for the table and the tiles. A percentile
   * metric asks for its own exact rank (`STATS_RANKS`) and no other — even one
   * the project's set usually carries, because that set can omit it, and a
   * rank left to it would read `—` on an exact run. A non-percentile metric
   * asks for nothing extra, and so shares the cache entry its run page reads.
   * The overlay's source is read only for the metric on screen: `/series`,
   * `/users`, or the two CPU sources.
   *
   * `terminal` on every one, the rule every run section follows: a live run's
   * figures endpoints answer 202, and `selected` being empty until the
   * cohort arrives is a property of today's code, not a gate. */
  const statsRank = STATS_RANKS[metric];
  const statsRanks: readonly number[] = statsRank === undefined ? [] : [statsRank];
  const seriesRanks: readonly number[] =
    metric === 'p99.9' || metric === 'p99.99' ? SERIES_EXTRA_RANKS : [];
  const source = overlaySource(metric);

  const statsResults = useQueries({
    queries: scopes.map((scope) => ({
      ...statsQuery(scope.id, scope.window, statsRanks),
      enabled: terminal && !scope.ended,
    })),
  });
  const seriesResults = useQueries({
    queries: scopes.map((scope) => ({
      ...seriesQuery(scope.id, 'run', '', 'response_time', scope.window, seriesRanks),
      enabled: terminal && !scope.ended && source === 'series',
    })),
  });
  const usersResults = useQueries({
    queries: scopes.map((scope) => ({
      ...usersQuery(scope.id, scope.window),
      enabled: terminal && !scope.ended && source === 'users',
    })),
  });
  const injectorsResults = useQueries({
    queries: scopes.map((scope) => ({
      ...agentInjectorsQuery(scope.id, scope.window),
      enabled: terminal && !scope.ended && source === 'cpu',
    })),
  });
  const telemetryResults = useQueries({
    queries: scopes.map((scope) => ({
      ...telemetryQuery(scope.id, scope.window),
      enabled: terminal && !scope.ended && source === 'cpu',
    })),
  });

  /**
   * Labels for the WHOLE COHORT, not just the selection.
   *
   * Computed across every candidate so a run's label does not change when a
   * neighbour is selected or dropped — a chip that renames itself as the
   * selection moves is one a reader cannot navigate by. `runLabels` names a
   * numbered run by its number; a numberless one keeps its minute label, with
   * a short id suffix added only where two such runs would otherwise collide.
   */
  const labels = useMemo(() => {
    const runs = cohort.data?.runs ?? [];
    const computed = runLabels(
      runs.map((run) => ({ id: run.id, at: run.toolStartedAt ?? run.startedAt, runNumber: run.runNumber })),
      'name',
    );
    return new Map(runs.map((run, i) => [run.id, computed[i]!]));
  }, [cohort.data]);

  const labelFor = (id: string): string => labels.get(id) ?? id.slice(0, 8);

  /**
   * Each run's CPU points, or `undefined` while either source is still being
   * read. BOTH sources settle first: the agent's machine collector wins over
   * the telemetry agent (`cpuPoints`), so drawing telemetry while the agent
   * read is in flight would draw one source and then swap it for another. A
   * source that failed counts as absent — the failure itself is named below.
   */
  const cpuOf = (i: number): readonly ComparePoint[] | null | undefined => {
    const injectors = injectorsResults[i];
    const telemetry = telemetryResults[i];
    if (injectors === undefined || telemetry === undefined) return undefined;
    if (injectors.isPending || telemetry.isPending) return undefined;
    return cpuPoints(injectors.data ?? null, telemetry.data ?? null);
  };

  const overlayRuns: CompareRun[] = scopes.flatMap((scope, i): CompareRun[] => {
    const { id } = scope;
    const label = labelFor(id);
    // Not running during the window: recorded, and nothing in this span —
    // `[]`, not `null`, which would say the metric was never recorded.
    if (scope.ended) return [{ id, label, points: [], bucketWidthMs: null, ended: true }];
    if (source === 'users') {
      const data = usersResults[i]?.data;
      return data === undefined ? [] : [{ id, label, points: usersPoints(data), bucketWidthMs: null }];
    }
    if (source === 'cpu') {
      const points = cpuOf(i);
      return points === undefined ? [] : [{ id, label, points, bucketWidthMs: null }];
    }
    const data = seriesResults[i]?.data;
    return data === undefined
      ? []
      : [{ id, label, points: seriesPoints(data, metric), bucketWidthMs: data.bucketWidthMs }];
  });

  /**
   * Each run's own `statsMethod`, off the cohort. Per run, because a
   * selection can span the backfill: the matrix marks an estimated run's
   * column with ≈ and the summary its tiles, and a ≈ on an exact run is as
   * false as a missing one. A run the cohort does not carry (or an API that
   * predates the field) is not known to be exact — `isExact`'s rule.
   */
  const statsMethodOf = (id: string) => cohort.data?.runs.find((run) => run.id === id)?.statsMethod;

  const matrixRuns: CompareStats[] = scopes.flatMap((scope, i): CompareStats[] => {
    const { id } = scope;
    const identity = { id, label: labelFor(id), exact: isExact(statsMethodOf(id)) };
    // No figures for a window the run was not running in: its whole column
    // is dashes (`CompareStats.stats`), never its whole-run figures.
    if (scope.ended) return [{ ...identity, stats: null, peakUsers: null, cpu: null }];
    const data = statsResults[i]?.data;
    if (data === undefined) return [];
    const users = source === 'users' ? usersResults[i]?.data : undefined;
    return [
      {
        ...identity,
        stats: data,
        // Read only while their metric is on screen, so a dash elsewhere is
        // "not asked", which no row then shows.
        peakUsers: users === undefined ? null : peakConcurrentUsers(users),
        cpu: source === 'cpu' ? cpuSummary(cpuOf(i) ?? null) : null,
      },
    ];
  });

  /** The selected runs that finished before the window began, named under it. */
  const endedBefore = scopes.filter((scope) => scope.ended).map((scope) => scope.id);

  /**
   * RUNS WHOSE DATA FAILED TO LOAD, NAMED.
   *
   * The two `flatMap`s above drop a run whose query has no data — which is
   * right while it is still in flight and WRONG once it has errored, because
   * the run then disappears from the overlay and the matrix permanently, with
   * every remaining line looking perfectly healthy. That is the same failure
   * the "left out" notice below guards against for the URL, and it slipped
   * through because `selected.length` is unchanged by a failed fetch: the run
   * is still selected, it simply has nothing to draw.
   *
   * A reader comparing two runs and shown one, with no explanation, concludes
   * the comparison is the whole story.
   */
  const failed = selected.filter(
    (_, i) =>
      statsResults[i]?.isError === true ||
      (source === 'series' && seriesResults[i]?.isError === true) ||
      (source === 'users' && usersResults[i]?.isError === true) ||
      (source === 'cpu' &&
        (injectorsResults[i]?.isError === true || telemetryResults[i]?.isError === true)),
  );

  /**
   * ═══ A QUERY THAT HAS NOT ANSWERED HAS SEEN NOTHING ═══
   *
   * The two `flatMap`s above drop a run whose read has no data yet, and every
   * window change, Whole run, and switch to a metric needing an extra rank
   * changes those reads' keys — so for the length of one round trip every
   * `data` is `undefined`. Drawn from that, the table said "No statistics for
   * the selected runs" and the overlay "Select at least one run to compare"
   * over two pressed chips, and a pinned reference whose stats were still in
   * flight fell back to another run, so the chip and every change described a
   * comparison against the wrong run until it landed.
   *
   * So the page knows when it is still asking, from exactly the reads it
   * needs: every non-ended run's `/stats`, and the overlay's own source for
   * the metric on screen. While any is pending the summary and the table are a
   * loading state, the overlay says it is loading, and NO REFERENCE IS
   * RESOLVED. Not `keepPreviousData`: that would draw the previous window's
   * figures under the new window's handles, which is the worse lie. A read
   * that FAILED is not pending — it is named in the alert above, and the
   * comparison is drawn from what did load.
   *
   * TWO FLAGS, BECAUSE THE OVERLAY READS LESS THAN THE TABLE. `overlayPending`
   * is the overlay's own source alone; `pending` adds every run's `/stats`.
   * A percentile switch re-keys `/stats` (each metric asks its own rank) while
   * the overlay's series is usually already cached, so handing the chart the
   * page-wide flag blanked a line that was ready to draw for a round trip.
   */
  const overlayPending = scopes.some(
    (scope, i) =>
      !scope.ended &&
      ((source === 'series' && seriesResults[i]?.isPending === true) ||
        (source === 'users' && usersResults[i]?.isPending === true) ||
        (source === 'cpu' && cpuOf(i) === undefined)),
  );
  const pending =
    overlayPending ||
    scopes.some((scope, i) => !scope.ended && statsResults[i]?.isPending === true);

  /* The reference every other column is measured against: the pinned run
     (`ref`) while it is among the runs whose figures loaded FOR THIS WINDOW,
     else the first such run other than this one. A run that ended before the
     window has a column of dashes, and changes measured against it would be
     changes against nothing. Resolved only once every read has answered:
     against a partial set, a pin still loading would read as absent. */
  const referenceRunId = pending
    ? null
    : resolveReference(
        matrixRuns.filter((run) => run.stats !== null),
        parseCompareReference(params.get('ref')),
        runId ?? '',
      );
  const matrix = toCompareMatrix(matrixRuns, metric, referenceRunId);
  const setReference = (id: string) => refine((next) => next.set('ref', id));

  // AFTER the hooks, never before one: an early return above a `useQueries`
  // would change the hook count between renders the moment the viewport
  // crossed 768px, or the run this page is comparing FROM went terminal
  // mid-visit. The queries here key off `selected`, which is empty until a
  // reader picks a run, so nothing heavy is fetched merely by arriving.
  //
  // NOT TERMINAL (MINOR 5): the same withheld wording `RunTrends` shows for
  // the identical reason, and — matching that file's own ordering — AHEAD OF
  // THE COMPACT GATE below: this is cheap text, not a comparison chart and
  // matrix, so a phone reader is told the same thing a desktop is rather
  // than a second withheld notice for content that was never coming this
  // session regardless of viewport.
  if (!terminal) {
    return <LiveNotice kind="withheld" subject="Compare runs" />;
  }

  if (compact && !shown) {
    return (
      <DesktopOnly
        compact
        what="A comparison of these runs"
        action="Open the comparison"
        onShow={() => setShown(true)}
      >
        {() => null}
      </DesktopOnly>
    );
  }

  return (
    <section aria-labelledby="compare-heading" className="flex flex-col gap-6">
      <h2 id="compare-heading" className="sr-only">
        Compare runs
      </h2>

      <Payload query={cohort} slots={[OVERLAY]}>
        {(data) => (
          <>
            {/* WHAT THE URL ASKED FOR AND DID NOT GET. Silently drawing fewer
                runs than were requested is how a reader concludes two runs are
                identical when one of them was never fetched. */}
            {selected.length < countRequested(params.get('runs'), runId ?? '') && (
              <p className="text-[0.8125rem] text-muted">
                Some runs named in this link were left out: a run can only be compared with
                others of the same simulation, and at most {MAX_COMPARE} at a time.
              </p>
            )}

            {/* `role="alert"`, unlike the notice above: a run silently missing
                from a comparison changes what the chart MEANS, and a reader
                using a screen reader must not have to go looking for it.

                NOT PAINTED IN THE STATUS PALETTE. `--color-status-*` is kept
                out of `@theme` on purpose (see `components/States.tsx`), so no
                `text-status-failed` utility exists — reaching for one emits no
                CSS at all, silently, and `tokens.test.ts` exempts exactly one
                component from the rule rather than growing the exemption by a
                route every time a page learns to fail. The alert role and the
                wording carry this; colour was never allowed to be the only
                signal anyway. */}
            {failed.length > 0 && (
              <p role="alert" className="text-[0.8125rem] font-medium text-primary">
                {failed.length === 1 ? 'One run could not be loaded' : `${failed.length} runs could not be loaded`}
                {' '}({failed.map(labelFor).join(', ')}), so {failed.length === 1 ? 'it is' : 'they are'}{' '}
                missing from the chart and the table below. Reload to try again.
              </p>
            )}

            {data.runs.length < 2 ? (
              // A cohort of one has no comparison to draw, which is genuinely
              // nothing rather than a chart with one line in it — unlike
              // Trends, where a single point is still a measurement worth
              // showing. `body` names the TEST, so a reader who expected peers
              // knows what to look for.
              //
              // The fallbacks are ordered by how much they actually say: the
              // test's name is what a reader chose, the simulation is what the
              // tool reported, and a run with neither is one nothing has
              // identified yet — which is a different sentence, below.
              <EmptyState
                title="Nothing to compare yet"
                body={
                  data.test === null
                    ? 'This run is not part of a test yet, so there is nothing to compare it ' +
                      'against. A run joins a test when its simulation name is read from the log.'
                    : `This is the only completed run of ${data.test.name}. Compare becomes ` +
                      'available once a second run of it has been ingested.'
                }
                /* A VALID STATE WITH AN INCOMPLETE WORKFLOW (review M20). It
                   said what was missing and left the reader on a page with no
                   way to supply it. The route differs by CAUSE: a run with no
                   test needs the project's other runs, and a lone run of a
                   known test needs another run OF THAT TEST — which is what
                   its own page lists. Neither invents a capability; both are
                   pages that already exist. */
                action={
                  projectSlug === null ? undefined : data.test === null ? (
                    <Link to={projectRunsPath(projectSlug)} className={linkButtonClasses}>
                      See this project’s runs
                    </Link>
                  ) : (
                    <Link
                      to={projectTestPath(projectSlug, data.test.slug)}
                      className={linkButtonClasses}
                    >
                      See every run of {data.test.name}
                    </Link>
                  )
                }
              />
            ) : (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-[0.8125rem] font-medium text-primary">
                    Runs to compare
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {data.runs.map((run) => {
                      const on = selected.includes(run.id);
                      const atCap = !on && selected.length >= MAX_COMPARE;
                      /* ═══ THE SAME REFERENCE AS THE TILES AND THE TABLE ═══
                         `referenceRunId` — `resolveReference`'s answer, the
                         one both are built with — so a pin moves this chip
                         too. A chip naming a run the table does not measure
                         from would be worse than no label: it reads as
                         evidence. The run the page was opened from can be
                         both, and then says both. */
                      const roles = [
                        run.id === runId ? 'Current' : null,
                        run.id === referenceRunId ? 'Reference' : null,
                      ].filter((part): part is string => part !== null);
                      const role = roles.length === 0 ? null : roles.join(' · ');
                      const mark = VERDICT[run.verdict ?? 'none'];
                      const conditions = conditionsOf(run);
                      // A numbered chip is NAMED by its number; the start time
                      // it used to lead with becomes its second line, as in
                      // Gatling Enterprise's picker. A numberless chip keeps
                      // leading with its time, which IS its label.
                      const startedLine =
                        run.runNumber === null || run.runNumber === undefined
                          ? null
                          : runMinuteLabel(run.toolStartedAt ?? run.startedAt);
                      return (
                        <button
                          key={run.id}
                          type="button"
                          aria-pressed={on}
                          disabled={atCap || run.id === runId}
                          data-testid={`compare-run-${run.id}`}
                          onClick={() => toggle(run.id)}
                          /* ═══ A DISABLED CONTROL MUST SAY WHY, AND `title`
                               IS NOT SAYING IT ═══
                             (the 09-13 review's acceptance list: multiple comparisons)

                             At the cap every unselected chip went to
                             `disabled` and 50% opacity with NOTHING anywhere
                             explaining it — the `title` below is set only for
                             the run you came from. A reader with six eligible
                             runs and five picked met three greyed buttons and
                             no reason, and the only way to learn the rule was
                             to guess that deselecting one would free another.

                             `aria-describedby` rather than a second `title`,
                             for the reason `ChartActions` records: a `title`
                             is invisible on touch and unreachable by keyboard,
                             so it cannot be the SOLE carrier of a refusal. The
                             sentence it points at is visible text below. */
                          aria-describedby={atCap ? 'compare-cap' : undefined}
                          title={run.id === runId ? 'The run you came from is always included' : undefined}
                          /* ═══ WHAT A READER IS CHOOSING BETWEEN (review.md 17) ═══
                             The chip was a bare timestamp — `09-13 11:31` —
                             which "distinguishes records mechanically but does
                             not tell an engineer which build or environment
                             they are choosing". The LABEL stays the primary
                             line, because it is what `labelFor` also names the
                             series and the matrix columns by — the run's
                             number once it has one (spec 2026-09-27-run-number),
                             else its time. */
                          className={`transition-ui flex min-w-0 touch-manipulation flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left text-[0.8125rem] font-medium disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 ${
                            on
                              ? 'border-accent bg-accent/10 text-accent shadow-panel'
                              : 'border-default bg-surface text-muted shadow-panel hover:bg-sunken hover:text-primary'
                          }`}
                          /* The whole chip named in one string rather than left
                             to the reading order of four nodes, so a screen
                             reader hears "Run 12 · 09-13 11:31 · failed ·
                             Reference · production · main" instead of a glyph. */
                          aria-label={[labelFor(run.id), startedLine, mark.label, role, conditions]
                            .filter((part) => part != null && part !== '')
                            .join(' · ')}
                        >
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            {/* The outcome, in the product's own glyph and
                                colour — `marks.tsx` is the one place that
                                decides what a verdict looks like, and a picker
                                inventing its own would be a second answer. */}
                            <span aria-hidden="true" style={{ color: mark.colour }}>
                              {mark.glyph}
                            </span>
                            {labelFor(run.id)}
                            {role !== null && (
                              <span
                                data-testid={`compare-role-${run.id}`}
                                className="rounded border border-default px-1 text-[0.625rem] font-medium tracking-wide uppercase"
                              >
                                {role}
                              </span>
                            )}
                          </span>
                          {startedLine !== null && (
                            <span className="text-[0.6875rem] font-normal tabular-nums">
                              {startedLine}
                            </span>
                          )}
                          {conditions !== '' && (
                            <span className="max-w-[16rem] truncate text-[0.6875rem] font-normal">
                              {conditions}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Rendered only AT the cap, so it is never an empty
                      paragraph and `aria-describedby` never points at nothing
                      — the same rule `ChartActions`' export refusal follows.
                      The count is spelled out rather than left implicit,
                      because "at most five" is the fact a reader needs and the
                      chips cannot carry it. */}
                  {selected.length >= MAX_COMPARE && (
                    <p id="compare-cap" data-testid="compare-cap" className="text-[0.75rem] text-muted">
                      {MAX_COMPARE} runs is the most this overlay can draw at once. Deselect one to
                      choose another.
                    </p>
                  )}
                </fieldset>

                {/* BEFORE the numbers, deliberately. Cohort membership says
                    these runs exercised the same test and nothing about the
                    conditions — so whether a delta MEANS anything has to be
                    settled before the delta is read, not after. */}
                <Comparability
                  findings={comparability(
                    (cohort.data?.runs ?? []).filter((r) => selected.includes(r.id)),
                  )}
                />

                {/* A run that finished before the window began has no figures
                    for it, and its column and line are empty for that reason.
                    Named, because an empty column alone reads as a run whose
                    data failed to load. */}
                {endedBefore.length > 0 && (
                  <p data-testid="compare-ended" className="text-[0.8125rem] text-muted">
                    {endedBefore.map((id) => `${labelFor(id)} ended before this window.`).join(' ')}
                  </p>
                )}

                {/* While a read is still answering, a loading line in place of
                    the tiles and the table rather than a conclusion drawn from
                    whatever has arrived (see `pending`). The overlay stays
                    MOUNTED — it carries the metric selector and the window
                    fields the reader is in the middle of using — and says it
                    is loading instead of drawing while its OWN reads are.

                    ONE LIVE REGION PER LOADING STATE. When the overlay is
                    loading too, its own `role="status"` line announces it, so
                    this line is plain text — two regions mounting together
                    would be announced twice. */}
                {pending ? (
                  overlayPending ? (
                    <p data-testid="compare-loading" className="text-muted">
                      Loading the comparison…
                    </p>
                  ) : (
                    <LoadingState label="Loading the comparison…" />
                  )
                ) : (
                  matrixRuns.length > 0 && (
                    <CompareSummary
                      summary={buildCompareSummary(matrixRuns, runId ?? '', referenceRunId, metric)}
                    />
                  )
                )}

                <CompareChart
                  runs={overlayRuns}
                  pending={overlayPending}
                  metric={metric}
                  onMetricChange={setMetric}
                  window={window}
                  extentMs={extentMs ?? 0}
                  onWindow={setWindow}
                />

                {!pending && (
                  <CompareMatrix matrix={matrix} metric={metric} onReference={setReference} />
                )}
              </>
            )}
          </>
        )}
      </Payload>
    </section>
  );
}

/**
 * How many DISTINCT runs the URL actually named, including the current one.
 *
 * Used only to decide whether anything was dropped — comparing against
 * `selected.length` tells the reader their link asked for something this page
 * could not honour, rather than leaving them to count chips.
 */
function countRequested(raw: string | null, current: string): number {
  const asked = (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return new Set([current, ...asked]).size;
}

function CompareSummary({ summary }: { readonly summary: CompareSummaryModel }) {
  /* The unit is the MODEL's: the tiles' values are the table's first row, and
     for errors that row is a count, where the metric's own unit ("/s") is the
     overlay's. The metric's NAME went with the count tile: the chart's
     selector states it, and every value here carries this unit beside it. */
  const { unit } = summary;
  /* Each reason reads differently, because they are different facts. A zero
     baseline in particular is NOT a missing one: 0 → 2/s is the regression an
     engineer most needs to see, and "Waiting for baseline" hid it. */
  const deltaText =
    summary.deltaUnavailable === 'no-baseline'
      ? 'Select a reference run'
      : summary.deltaUnavailable === 'not-measured'
        ? 'Not measured'
        : summary.deltaUnavailable === 'zero-baseline'
          ? `${formatCell(summary.baselineValue ?? 0)} → ${formatCell(summary.currentValue ?? 0)} ${unit} · relative change undefined`
          : `${summary.deltaPercent! > 0 ? '+' : ''}${formatCell(summary.deltaPercent!)}%`;
  const deltaColour =
    summary.deltaGood === null
      ? 'var(--color-status-not-applicable)'
      : summary.deltaGood
        ? 'var(--color-status-passed)'
        : 'var(--color-status-failed)';

  return (
    <section aria-label="Comparison summary" className="grid gap-3 md:grid-cols-2">
      {/* ═══ THE COUNT TILE IS GONE (review.md 19) ═══
          "Summary cards then repeat the active selection and metric." It read
          `2` over "p95 across the active selection" — a number the reader gets
          by counting the pressed chips directly above, and a metric every other
          tile's unit already carries. It spent a third of the row restating the
          controls, which is why the principal delta was not the first thing
          here. */}
      {/* NOT "Current vs baseline": pinned on the current run, the tile states
          the first other run against it (`compareSummary`), so a label naming
          the current run as the subject would be false. The detail line names
          both runs either way. */}
      <CompareSummaryTile
        label="Change against the reference"
        testId="compare-delta"
        value={deltaText}
        // ≈ only over a figure: "Select a reference run" and "Not measured"
        // state no number, which `deltaExact` already says.
        exact={summary.deltaExact}
        detail={
          summary.baselineLabel === null
            ? 'Select another run to measure against'
            : `${summary.currentLabel} against ${summary.baselineLabel}`
        }
        colour={deltaColour}
      />
      <CompareSummaryTile
        label="Best selected"
        testId="compare-best"
        value={summary.bestValue === null ? '-' : `${formatCell(summary.bestValue)} ${unit}`}
        exact={summary.bestExact}
        // Users and CPU have no better or worse, so no run is best — which is
        // a fact about the metric, not a wait for figures.
        detail={
          !summary.directional
            ? 'This metric has no better or worse, so no run is best'
            : (summary.bestLabel ?? 'Waiting for run statistics')
        }
      />
    </section>
  );
}

function CompareSummaryTile({
  label,
  testId,
  value,
  exact,
  detail,
  colour = 'var(--color-text-primary)',
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  /** Whether the figure came from exact statistics; `false` puts ≈ before
   *  it. REQUIRED, for `Approx`'s reason: a default would be silent. */
  readonly exact: boolean;
  readonly detail: string;
  readonly colour?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-surface px-3 py-3 shadow-panel">
      <p className="text-[0.75rem] font-medium text-muted">{label}</p>
      <p
        data-testid={testId}
        className="mt-1 font-mono text-xl font-semibold leading-none tabular-nums"
        style={{ color: colour }}
      >
        <Approx exact={exact}>{value}</Approx>
      </p>
      <p className="mt-2 text-[0.6875rem] leading-snug text-muted">{detail}</p>
    </div>
  );
}


/**
 * Whether the selected runs can be compared, shown before their numbers.
 *
 * Nothing here decides for the reader: comparing across environments or loads
 * ON PURPOSE is legitimate, and the failure the review found is doing it
 * unknowingly. So this states the differences and stops.
 *
 * `role="status"` rather than `alert`: a difference is a fact about the
 * selection, not an error, and an alert would interrupt a screen reader to
 * announce a comparison the reader deliberately assembled.
 */
function Comparability({ findings }: { readonly findings: readonly ComparabilityFinding[] }) {
  if (findings.length === 0) return null;
  const check = needsComparabilityCheck(findings);

  return (
    <section
      aria-label="Comparability"
      data-testid="comparability"
      className="flex flex-col gap-2 rounded-xl border border-default bg-surface p-4"
    >
      {/* ═══ WHICH DIMENSIONS, NOT THAT SOME DO (review.md 19) ═══
          This opened with "These runs differ in ways that change what a
          comparison means" — true of every non-matching selection and
          actionable for none of them — above six facts shown whether or not
          they said anything.

          `summariseConditions` is the same sentence the Summary's
          comparison chip prints, off the same findings, so a reader moving
          between the two pages meets one wording rather than two. */}
      <p role="status" className="text-[0.8125rem] leading-relaxed text-primary">
        {check
          ? summariseConditions(findings.filter((finding) => finding.kind !== 'same'))
          : 'These runs match on every dimension recorded here.'}
      </p>
      {/* ═══ DETAILS AVAILABLE, WHICH IS WHAT THE FINDING ASKS FOR ═══
          All six stay — including the ones that MATCH, which is the half a
          reader needs to conclude a comparison is SOUND rather than merely
          un-flagged. They are one disclosure away instead of six lines of
          prose nobody asked for.

          OPEN when everything matches, because the headline then says so in
          six words and this is the only place the evidence for it lives;
          CLOSED when something differs, because the headline has already said
          the actionable part. A `<summary>` contributes an ARIA group and not
          a heading, so the tab's outline is untouched. */}
      <details className="group" data-testid="comparability-details" open={!check}>
        <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
          <span className="group-open:hidden">What was compared</span>
          <span className="hidden group-open:inline">Hide what was compared</span>
        </summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[0.75rem] sm:grid-cols-2">
        {findings.map((finding) => (
          <div
            key={finding.label}
            data-testid={`comparability-${finding.label.toLowerCase()}`}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <dt className="font-medium text-muted">{finding.label}</dt>
            <dd
              className="min-w-0"
              /* The status palette as data, the `Badge`/`StatTile` route: the
                 status tokens live on `:root` and NOT in `@theme`, so a
                 `text-status-*` utility emits nothing at all. */
              style={{
                color:
                  finding.kind === 'differs'
                    ? 'var(--color-status-failed)'
                    : finding.kind === 'unknown'
                      ? 'var(--color-text-muted)'
                      : 'var(--color-text-primary)',
              }}
            >
              {finding.values.join(' · ')}
              {finding.kind === 'unknown' && ' — not recorded'}
            </dd>
          </div>
        ))}
      </dl>
      </details>
    </section>
  );
}
