import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { isChangeGood, type CompareMetric } from '../charts/transforms/compare';

/**
 * The per-request comparison matrix: requests down, runs across.
 *
 * THIS IS THE HALF OF COMPARE THAT ATTRIBUTES. The overlay above it shows
 * THAT run 7 got slower; this shows that `Catalog/Product Detail` got slower
 * in run 7 and nothing else moved. A reader can reach the first conclusion
 * from a trend alone — the second is the one they came for.
 *
 * Pure, with no React and no ECharts, for the same reason `charts/transforms/*`
 * is: every decision here is about what a number means, and none of it needs a
 * DOM to be true.
 */

/** One selected run's statistics, with the identity to label its column. */
export interface CompareStats {
  readonly id: string;
  readonly label: string;
  readonly stats: StatsResponse;
}

export interface CompareMatrix {
  /** Row headers — request names, in stable order. */
  readonly requests: readonly string[];
  /** Column headers — run labels, in selection order. */
  readonly labels: readonly string[];
  /** `cells[request][run]`. `null` where that run has no such request. */
  readonly cells: readonly (readonly (number | null)[])[];
  /**
   * How the run being read changed against its baseline, per request — or
   * `null` when there is no pair to compare.
   *
   * ═══ THE COLUMN THE TABLE WAS ASKING THE READER TO COMPUTE ═══
   *
   * `review.md`'s finding 18: the matrix put one number per run per row and
   * nothing else, so `146.95` beside `2515.46` was arithmetic homework in a
   * table whose whole purpose is attribution — and the rows that did NOT move
   * looked exactly like the rows that did.
   *
   * SAME PAIR AS THE SUMMARY TILES ABOVE IT, deliberately. `buildCompareSummary`
   * defines the subject as the run the reader came from and the baseline as the
   * first other selected run; a table that chose a different pair would put two
   * different comparisons on one screen under one metric selector.
   */
  readonly change: CompareChange | null;
}

/** The per-request change between one pair of runs. */
export interface CompareChange {
  /** The run the change is ABOUT. */
  readonly subjectLabel: string;
  /** The run it is measured AGAINST. */
  readonly referenceLabel: string;
  /** Per request, in `requests` order. `null` where either side has no value. */
  readonly rows: readonly (CompareChangeRow | null)[];
}

export interface CompareChangeRow {
  /** Subject minus reference, in the metric's own unit. */
  readonly absolute: number;
  /**
   * The same change as a percentage, or `null` when the reference is ZERO.
   *
   * Not an error and not "no change": errors rising from 0 to 2/s has no
   * percentage and is the regression an engineer most needs to see, which is
   * the distinction `compareSummary`'s `deltaUnavailable` already draws. The
   * absolute value carries it, and `good` below is still decided.
   */
  readonly percent: number | null;
  /** Whether the change is an improvement — see `isChangeGood`. */
  readonly good: boolean;
}

/**
 * One request's value for one metric in one run.
 *
 * `errors` IS A RATE — `throughputRps * errorRate`, KO per second — and NOT a
 * count, deliberately. The metric selector says "Errors" above both this table
 * and the overlay, and the overlay plots `koCount` per second. One label
 * meaning a count here and a rate there is exactly the divergence that sharing
 * `formatCell` between the tooltip and the data table exists to prevent, and a
 * matrix is where it would be least visible.
 *
 * `max` reads `maxMs`, not the percentile map: no percentile map contains a
 * `max` key — the same fact that made the KO min/max on the percentiles chart
 * a lie — and reaching for `percentiles.max` would silently yield `null` for
 * every row.
 *
 * A missing percentile key yields `null` rather than a neighbouring one. The
 * set is a project setting, so a run whose project does not configure `p99`
 * genuinely has no answer, and the nearest percentile is a different question.
 *
 * EXPORTED, because the compare page's summary tiles sit between this matrix
 * and the overlay and have to mean the same thing by "Errors" as both. They
 * shipped with a line-for-line copy of this function, which is the third
 * copy of the decision this docstring exists to protect.
 */
export function metricValue(row: StatRow, metric: CompareMetric): number | null {
  if (metric === 'throughput') return row.throughputRps;
  if (metric === 'errors') return row.throughputRps * row.errorRate;
  if (metric === 'max') return row.maxMs;

  const value = row.percentiles[metric];
  return value === undefined || !Number.isFinite(value) ? null : value;
}

export function toCompareMatrix(
  runs: readonly CompareStats[],
  metric: CompareMetric,
  /**
   * The run the reader is looking at — the subject of `change` below.
   *
   * REQUIRED, WITH NO DEFAULT, because every wrong answer here is silent. The
   * obvious shortcut is `runs[0]`: selection order does put the current run
   * first (`parseCompareSelection` prepends it). But `RunCompare` drops a run
   * whose statistics failed to load before this is called, so on exactly the
   * day one request errors, `runs[0]` is a DIFFERENT run and every change in
   * the table silently changes meaning. A caller that cannot say which run is
   * the subject should get no change column, which is what `''` yields.
   */
  currentRunId: string,
): CompareMatrix {
  /**
   * REQUEST SCOPE ONLY. `StatsResponse` carries run, group and request rows in
   * one array; including groups would list every request twice — once on its
   * own and once inside the group that contains it — and including the run row
   * would put the whole run's total in a column of per-request values.
   */
  const perRun = runs.map(
    (run) =>
      new Map(
        run.stats.stats
          .filter((row) => row.scope === 'request')
          .map((row) => [row.name, row] as const),
      ),
  );

  /**
   * THE UNION, not the intersection, and not the first run's list.
   *
   * A request that exists in only one of the selected runs is precisely what a
   * reader comparing them is looking for: a request added last week, or one
   * that stopped being exercised. An intersection would hide both, and the
   * hiding would be invisible.
   *
   * First-seen order across the runs in selection order, which is stable: the
   * same payloads always produce the same rows in the same sequence, so two
   * readers looking at the same URL see the same table.
   */
  const requests: string[] = [];
  const seen = new Set<string>();
  for (const lookup of perRun) {
    for (const name of lookup.keys()) {
      if (seen.has(name)) continue;
      seen.add(name);
      requests.push(name);
    }
  }

  const cells = requests.map((name) =>
    perRun.map((lookup) => {
      const row = lookup.get(name);
      return row === undefined ? null : metricValue(row, metric);
    }),
  );

  /* The pair, resolved exactly as `buildCompareSummary` resolves it: the run
     the reader came from, against the first OTHER selected run. Both have to
     exist — a comparison of one run has nothing to change against, and saying
     so with `null` is what keeps the column out of a table that cannot fill
     it. */
  const subjectIndex = runs.findIndex((run) => run.id === currentRunId);
  const referenceIndex = runs.findIndex((run, i) => i !== subjectIndex && subjectIndex !== -1);
  const change: CompareChange | null =
    subjectIndex === -1 || referenceIndex === -1
      ? null
      : {
          subjectLabel: runs[subjectIndex]!.label,
          referenceLabel: runs[referenceIndex]!.label,
          rows: cells.map((row) => {
            const subject = row[subjectIndex];
            const reference = row[referenceIndex];
            // `null` where EITHER side is missing: a request one run never made
            // has no change, and treating the absence as zero is the same lie
            // the cells above refuse to tell.
            if (subject === null || subject === undefined) return null;
            if (reference === null || reference === undefined) return null;
            const absolute = subject - reference;
            return {
              absolute,
              percent: reference === 0 ? null : (absolute / reference) * 100,
              good: isChangeGood(absolute, metric),
            };
          }),
        };

  return {
    requests,
    change,
    labels: runs.map((run) => run.label),
    // `null`, never `0`, for a request a run does not have. It did not take no
    // time — it did not run, and a zero would sort to the top of a column of
    // durations as though it were the fastest thing in the comparison.
    cells,
  };
}
