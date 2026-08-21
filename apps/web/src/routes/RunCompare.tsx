import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { seriesQuery, statsQuery, trendsQuery } from '../api/metrics';
import CompareChart from '../charts/CompareChart';
import {
  COMPARE_METRICS,
  compareUnit,
  compareLabels,
  type CompareMetric,
  type CompareRun,
} from '../charts/transforms/compare';
import { formatCell } from '../charts/DataTable';
import { EmptyState } from '../components/States';
import CompareMatrix from '../tables/CompareMatrix';
import type { CompareStats } from '../tables/buildCompareMatrix';
import { Payload, type Slot } from './payload';
import DesktopOnly from './DesktopOnly';
import LiveNotice from './LiveNotice';
import { useRunTerminal } from './useRunWindow';
import useIsCompact from '../useIsCompact';
import {
  MAX_COMPARE,
  parseCompareSelection,
  serialiseCompareSelection,
} from './compareSelection';
import { buildCompareSummary, type CompareSummaryModel } from './compareSummary';

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

const OVERLAY: Slot = { id: 'compare-overlay', title: 'Comparison' };

export default function RunCompare() {
  const { runId } = useParams<{ runId: string }>();
  const [params, setParams] = useSearchParams();
  const [metric, setMetric] = useState<CompareMetric>('p95');

  // MINOR 5: gated the same way every tab is — a live run has no `RunStat`
  // rows of its own to plot a cohort point from (`RunTrends.tsx`'s own
  // docstring makes the identical argument for `/trends`), and before
  // `RunShell` mounted for every status this route was unreachable for one
  // anyway (`RunTrends` only ever links here once it has cleared its own
  // `!terminal` return). It is reachable now, by a hand-typed URL, so it
  // gets the same `terminal` gate rather than a bespoke live view of its own.
  const { terminal } = useRunTerminal(runId);

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
    setParams({ runs: serialiseCompareSelection(next) }, { replace: true });
  }

  const seriesResults = useQueries({
    queries: selected.map((id) => ({ ...seriesQuery(id), enabled: true })),
  });
  const statsResults = useQueries({
    queries: selected.map((id) => ({ ...statsQuery(id), enabled: true })),
  });

  /**
   * Labels for the WHOLE COHORT, not just the selection.
   *
   * Computed across every candidate so a run's label does not change when a
   * neighbour is selected or dropped — a chip that renames itself as the
   * selection moves is one a reader cannot navigate by. `compareLabels` adds a
   * short id suffix only where two runs would otherwise collide, which they do
   * whenever two runs start in the same minute.
   */
  const labels = useMemo(() => {
    const runs = cohort.data?.runs ?? [];
    const computed = compareLabels(
      runs.map((run) => ({ id: run.id, at: run.toolStartedAt ?? run.startedAt })),
    );
    return new Map(runs.map((run, i) => [run.id, computed[i]!]));
  }, [cohort.data]);

  const labelFor = (id: string): string => labels.get(id) ?? id.slice(0, 8);

  const overlayRuns: CompareRun[] = selected.flatMap((id, i) => {
    const data = seriesResults[i]?.data;
    return data === undefined ? [] : [{ id, label: labelFor(id), series: data }];
  });

  const matrixRuns: CompareStats[] = selected.flatMap((id, i) => {
    const data = statsResults[i]?.data;
    return data === undefined ? [] : [{ id, label: labelFor(id), stats: data }];
  });

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
    (_, i) => seriesResults[i]?.isError === true || statsResults[i]?.isError === true,
  );

  const metricLabel = COMPARE_METRICS.find((m) => m.value === metric)?.label ?? metric;

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
      <DesktopOnly compact what="Comparing runs" onShow={() => setShown(true)}>
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
              <p className="text-[13px] text-muted">
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
              <p role="alert" className="text-[13px] font-medium text-primary">
                {failed.length === 1 ? 'One run could not be loaded' : `${failed.length} runs could not be loaded`}
                {' '}({failed.map(labelFor).join(', ')}), so {failed.length === 1 ? 'it is' : 'they are'}{' '}
                missing from the chart and the table below. Reload to try again.
              </p>
            )}

            {data.runs.length < 2 ? (
              // A cohort of one has no comparison to draw, which is genuinely
              // nothing rather than a chart with one line in it — unlike
              // Trends, where a single point is still a measurement worth
              // showing. `body` says which simulation, so a reader who
              // expected peers knows which name to look for.
              <EmptyState
                title="Nothing to compare yet"
                body={`This is the only completed run of ${
                  data.simulation === null ? 'this unnamed simulation' : data.simulation
                }. Compare becomes available once a second run of it has been ingested.`}
              />
            ) : (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-[13px] font-medium text-primary">
                    Runs to compare
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {data.runs.map((run) => {
                      const on = selected.includes(run.id);
                      const atCap = !on && selected.length >= MAX_COMPARE;
                      return (
                        <button
                          key={run.id}
                          type="button"
                          aria-pressed={on}
                          disabled={atCap || run.id === runId}
                          data-testid={`compare-run-${run.id}`}
                          onClick={() => toggle(run.id)}
                          // The run the page was opened from cannot be
                          // deselected: it is the reason this comparison
                          // exists, and a set that excluded it would compare a
                          // run against peers it is not among.
                          title={run.id === runId ? 'The run you came from is always included' : undefined}
                          className={`transition-ui inline-flex h-8 touch-manipulation items-center rounded-lg border px-2.5 text-[13px] font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 ${
                            on
                              ? 'border-accent bg-accent/10 text-accent shadow-panel'
                              : 'border-default bg-surface text-muted shadow-panel hover:bg-sunken hover:text-primary'
                          }`}
                        >
                          {labelFor(run.id)}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                {matrixRuns.length > 0 && (
                  <CompareSummary
                    summary={buildCompareSummary(matrixRuns, runId ?? '', metric)}
                    metricLabel={metricLabel}
                    unit={compareUnit(metric)}
                  />
                )}

                <CompareChart runs={overlayRuns} metric={metric} onMetricChange={setMetric} />

                <CompareMatrix runs={matrixRuns} metric={metric} metricLabel={metricLabel} />
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

function CompareSummary({
  summary,
  metricLabel,
  unit,
}: {
  readonly summary: CompareSummaryModel;
  readonly metricLabel: string;
  readonly unit: string;
}) {
  const deltaText =
    summary.deltaPercent === null
      ? 'Waiting for baseline'
      : `${summary.deltaPercent > 0 ? '+' : ''}${formatCell(summary.deltaPercent)}%`;
  const deltaColour =
    summary.deltaGood === null
      ? 'var(--color-status-not-applicable)'
      : summary.deltaGood
        ? 'var(--color-status-passed)'
        : 'var(--color-status-failed)';

  return (
    <section aria-label="Comparison summary" className="grid gap-3 md:grid-cols-3">
      <CompareSummaryTile
        label="Selected runs"
        value={String(summary.selectedCount)}
        detail={`${metricLabel} across the active selection`}
      />
      <CompareSummaryTile
        label="Current vs baseline"
        value={deltaText}
        detail={
          summary.baselineLabel === null
            ? 'Select another run to establish a baseline'
            : `${summary.currentLabel} against ${summary.baselineLabel}`
        }
        colour={deltaColour}
      />
      <CompareSummaryTile
        label="Best selected"
        value={summary.bestValue === null ? '-' : `${formatCell(summary.bestValue)} ${unit}`}
        detail={summary.bestLabel ?? 'Waiting for run statistics'}
      />
    </section>
  );
}

function CompareSummaryTile({
  label,
  value,
  detail,
  colour = 'var(--color-text-primary)',
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly colour?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-surface px-3 py-3 shadow-panel">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold leading-none tabular-nums" style={{ color: colour }}>
        {value}
      </p>
      <p className="mt-2 text-[11px] leading-snug text-muted">{detail}</p>
    </div>
  );
}
