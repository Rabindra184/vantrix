import type { StatRow, StatsResponse } from '@perfportal/contracts';
import type { CompareMetric } from '../charts/transforms/compare';

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

  return {
    requests,
    labels: runs.map((run) => run.label),
    // `null`, never `0`, for a request a run does not have. It did not take no
    // time — it did not run, and a zero would sort to the top of a column of
    // durations as though it were the fastest thing in the comparison.
    cells: requests.map((name) =>
      perRun.map((lookup) => {
        const row = lookup.get(name);
        return row === undefined ? null : metricValue(row, metric);
      }),
    ),
  };
}
