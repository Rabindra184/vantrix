import { compareUnit, isChangeGood, type CompareMetric } from '../charts/transforms/compare';
import { figureIsExact, toCompareMatrix, type CompareStats } from '../tables/buildCompareMatrix';

export interface CompareSummaryModel {
  readonly selectedCount: number;
  /**
   * The run the delta is stated FOR: the run being read, unless the reader
   * pinned it as the reference — then the first other selected run, so the
   * tile states a change rather than a self-comparison of 0%.
   */
  readonly currentLabel: string;
  /** The REFERENCE's label (the run the table measures every change against).
   *  The name predates the reference; it is kept so callers did not churn. */
  readonly baselineLabel: string | null;
  readonly currentValue: number | null;
  readonly baselineValue: number | null;
  readonly deltaPercent: number | null;
  /**
   * WHY there is no delta, when there is none.
   *
   * `deltaPercent === null` covered three different facts: nothing was
   * selected to compare against, a value could not be measured, and the
   * baseline is ZERO so a relative change is undefined. The UI rendered all
   * three as "Waiting for baseline".
   *
   * That is false for the last, and false in the case that matters most:
   * errors rising from 0 to 2/s is the regression an engineer most needs to
   * see, and it is precisely when the baseline is zero. `null` here means the
   * delta is real.
   */
  readonly deltaUnavailable: 'no-baseline' | 'not-measured' | 'zero-baseline' | null;
  /**
   * Whether the delta is an improvement — the table's own cell `good` for the
   * same comparison, so the tile and the table cannot colour it differently.
   *
   * `null` MEANS "NO JUDGEMENT", AND IT HAS THREE CAUSES THAT ALL RENDER THE
   * SAME: no delta at all (`deltaUnavailable` says why, and the tile's text
   * differs), no change (an unchanged figure is not an improvement — the
   * table's muted `=`), and a metric with no direction (users, CPU;
   * `directional` says which). All three draw the delta in the muted colour,
   * and none needs telling apart by colour, so the type does not split them;
   * `directional` and `deltaUnavailable` carry the difference where the tile
   * needs it. A zero baseline is NOT among them: 0 → 12 failed has no
   * percentage and still has a direction, and the table colours it.
   */
  readonly deltaGood: boolean | null;
  /**
   * Whether the metric has a better and a worse at all (`isChangeGood`).
   * `false` for users and CPU: more users or more CPU is not an improvement or
   * a regression, so there is no "best" run — `bestLabel`/`bestValue` are
   * `null` for that reason rather than for want of figures.
   */
  readonly directional: boolean;
  /** The best selected run by the metric's direction, read off the same first
   *  row; `null` when no run has a figure, or the metric has no direction. */
  readonly bestLabel: string | null;
  readonly bestValue: number | null;
  /**
   * The unit of the tiles' values — the first table row's, not the overlay's.
   * The same as `compareUnit` except for errors, whose first row is `Count`
   * (failed requests), where the overlay plots KO per second: "/s" beside a
   * count would be a false label.
   */
  readonly unit: string;
  /**
   * Whether the delta's figures are exact: BOTH the current run's and the
   * baseline's (`figureIsExact`), since a difference is no more exact than
   * its least exact term. True where the tile states no figure — no baseline
   * selected, or a value not measured — since there is then nothing to
   * qualify. `false` puts ≈ before the delta. The whole rule lives HERE: the
   * tile reads it as it is, rather than patching the no-figure cases in.
   */
  readonly deltaExact: boolean;
  /** Whether the best run's figure is exact; true where there is none. */
  readonly bestExact: boolean;
}

/**
 * The summary tiles, stated off the comparison table.
 *
 * EACH RUN'S VALUE IS ITS CELL IN `toCompareMatrix`'S FIRST ROW, and the
 * delta is that cell's change against `referenceRunId` — the same reference
 * the table is built with. The tiles used to compare "the first other run"
 * whatever the reader had pinned, and read the run row themselves, so after a
 * pin the table and the tiles directly above it described two different
 * comparisons, and for errors two different quantities (a count against a
 * rate). One source makes that unrepresentable.
 *
 * `referenceRunId` is `resolveReference`'s answer and REQUIRED, for the
 * matrix's reason: an id not among `runs` (or `null`) is no reference and no
 * delta, never a delta against a guess.
 */
export function buildCompareSummary(
  runs: readonly CompareStats[],
  currentRunId: string,
  referenceRunId: string | null,
  metric: CompareMetric,
): CompareSummaryModel {
  const matrix = toCompareMatrix(runs, metric, referenceRunId);
  const firstRow = matrix.rows[0];
  const cellOf = (run: CompareStats) => {
    const column = matrix.columns.findIndex((col) => col.id === run.id);
    return firstRow?.cells[column] ?? null;
  };

  const reference = runs.find((run) => run.id === referenceRunId) ?? null;
  // The current run, unless it IS the reference — then the first other run.
  const subject =
    runs.find((run) => run.id === currentRunId && run !== reference) ??
    runs.find((run) => run !== reference) ??
    null;
  // With nothing to compare it against, the reference is not a baseline.
  const baseline = subject === null ? null : reference;

  const subjectCell = subject === null ? null : cellOf(subject);
  const currentValue = subjectCell?.value ?? null;
  const baselineValue = baseline === null ? null : cellOf(baseline)?.value ?? null;
  const change = subjectCell?.change ?? null;

  const deltaUnavailable: CompareSummaryModel['deltaUnavailable'] =
    baseline === null
      ? 'no-baseline'
      : change === null
        ? 'not-measured'
        : change.percent === null
          ? 'zero-baseline'
          : null;

  /* The direction rule is `isChangeGood`'s alone: asked of a rise of one, it
     answers whether higher is better, lower is better, or neither. */
  const higherIsBetter = isChangeGood(1, metric);
  const comparable = runs
    .map((run) => ({ run, value: cellOf(run)?.value ?? null }))
    .filter((entry): entry is { run: CompareStats; value: number } => entry.value !== null);
  const best =
    higherIsBetter === null
      ? null
      : (comparable.sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value))[0] ?? null);

  return {
    selectedCount: runs.length,
    currentLabel: subject?.label ?? 'Current run',
    baselineLabel: baseline?.label ?? null,
    currentValue,
    baselineValue,
    deltaPercent: deltaUnavailable === null ? change!.percent : null,
    deltaUnavailable,
    deltaGood: change?.good ?? null,
    directional: higherIsBetter !== null,
    bestLabel: best?.run.label ?? null,
    bestValue: best?.value ?? null,
    unit: metric === 'errors' ? 'failed' : compareUnit(metric),
    deltaExact:
      deltaUnavailable === 'no-baseline' ||
      deltaUnavailable === 'not-measured' ||
      ((subject === null || figureIsExact(subject.exact, metric)) &&
        (baseline === null || figureIsExact(baseline.exact, metric))),
    bestExact: best === null || figureIsExact(best.run.exact, metric),
  };
}
