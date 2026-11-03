import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { isChangeGood, type CompareMetric } from '../charts/transforms/compare';

/**
 * The comparison table: Gatling Enterprise's summary rows for the chosen
 * metric, then one row per request, and one column per selected run — the
 * REFERENCE run first, every other run's cell carrying its change against it.
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

/** One selected run's figures, with the identity to label its column. */
export interface CompareStats {
  readonly id: string;
  readonly label: string;
  /**
   * Whether THIS run's statistics are exact (`isExact(statsMethod)`). Per run,
   * because a selection can span the backfill. REQUIRED, with no default: a
   * forgotten value would either mark an exact column ≈ or drop the mark from
   * an estimate, and nothing would fail.
   */
  readonly exact: boolean;
  /**
   * The run's `/stats` for the chosen window, or `null` when the run has no
   * figures for it (it ended before the window began). `null` makes EVERY
   * cell in the run's column `null` — users and CPU included — so a run that
   * was not running during the window can never show a figure for it.
   */
  readonly stats: StatsResponse | null;
  /**
   * The run's peak concurrent users over the window, or `null` where it was
   * not read. REQUIRED, with no default, for the same reason as `exact`: a
   * caller that forgot it would silently draw a dash under a run that has a
   * value.
   */
  readonly peakUsers: number | null;
  /** The run's load-generator CPU over the window (mean and max of its
   *  samples), or `null` where none was recorded or read. REQUIRED, as above. */
  readonly cpu: { readonly mean: number; readonly max: number } | null;
}

/**
 * Which compare metrics an estimated run reported from its sketch.
 *
 * Only the percentiles. `max` is the exactly tracked extreme, throughput and
 * errors are counts over a duration, and users and CPU are not statistics of
 * response times at all — all exact on every run, so a ≈ on them would mark a
 * figure that is not an estimate. A `Record` so a metric added to
 * `CompareMetric` has to answer here before anything compiles.
 */
const ESTIMATED_BY_SKETCH: Record<CompareMetric, boolean> = {
  users: false,
  cpu: false,
  errors: false,
  p50: true,
  p90: true,
  p95: true,
  p99: true,
  'p99.9': true,
  'p99.99': true,
  max: false,
  throughput: false,
};

/**
 * Whether one run's figure for one metric is exact: the run is exact, or the
 * metric is one the sketch never estimated. Shared by the matrix headers and
 * the summary tiles, so the two cannot disagree about which figures carry ≈.
 */
export function figureIsExact(runExact: boolean, metric: CompareMetric): boolean {
  return runExact || !ESTIMATED_BY_SKETCH[metric];
}

/**
 * The reference run: the one every other column's change is measured against.
 *
 * `requested` (the reader's pin, from the URL) wins only while it names a run
 * in `runs` — a run that is selected AND whose figures loaded, because
 * `RunCompare` passes only those. A pin naming a run that has since been
 * deselected, or whose statistics failed, falls back to the default rather
 * than computing changes against a column that is not there. The default is
 * the first run that is NOT the one being read, which is what "vs the
 * previous run" has always meant on this page; with nothing else selected
 * there is no reference at all.
 */
export function resolveReference(
  runs: readonly CompareStats[],
  requested: string | null,
  currentRunId: string,
): string | null {
  if (requested !== null && runs.some((run) => run.id === requested)) return requested;
  return runs.find((run) => run.id !== currentRunId)?.id ?? null;
}

export interface CompareCell {
  readonly value: number;
  /**
   * How this cell differs from the reference column's cell in the same row,
   * or `null` — on the reference column itself, and wherever the reference
   * has no value for the row (a request it never made, a rank it never
   * stored). A missing reference is never treated as zero: that would state
   * a change nobody measured.
   */
  readonly change: {
    /** This cell minus the reference, in the row's own unit. */
    readonly absolute: number;
    /**
     * The same change as a percentage of the reference, or `null` when the
     * reference is ZERO. Errors rising from 0 to 2 has no percentage and is
     * the regression an engineer most needs to see, so the absolute carries
     * it — the distinction `compareSummary`'s `deltaUnavailable` draws.
     */
    readonly percent: number | null;
    /**
     * Whether the change is an improvement (`isChangeGood`), or `null` where
     * it is neither: a metric with no direction (users, CPU), or no change at
     * all. An unchanged figure is not an improvement, and colouring it as one
     * would be a judgement the numbers do not make.
     */
    readonly good: boolean | null;
  } | null;
}

export interface CompareRow {
  /** A summary row's label (`All requests`, `Count`, …) or a request name. */
  readonly label: string;
  readonly kind: 'summary' | 'request';
  /** One per column, in `columns` order. `null` where that run has no value. */
  readonly cells: readonly (CompareCell | null)[];
}

export interface CompareMatrix {
  /**
   * One per run: the reference first, then the others in selection order.
   * `exact` is `figureIsExact` for this metric — `false` puts ≈ in the
   * header. ONE object per column rather than parallel arrays, so a header
   * cannot read past the end of one of them.
   */
  readonly columns: readonly {
    readonly id: string;
    readonly label: string;
    readonly exact: boolean;
    readonly reference: boolean;
  }[];
  readonly rows: readonly CompareRow[];
}

/** The summary row labels, in this product's words (the spec's table). */
export const SUMMARY_LABELS = {
  allRequests: 'All requests',
  value: 'Value',
  count: 'Count',
  ratio: 'Ratio',
  max: 'Max',
  mean: 'Mean',
} as const;

/**
 * One row's value for one metric in one run.
 *
 * `errors` IS A RATE here — `throughputRps * errorRate`, KO per second — the
 * quantity the overlay plots, and what the summary tiles read through this
 * function. The TABLE's errors rows are counts and a ratio instead, read
 * directly by `toCompareMatrix` (the spec's `Count` and `Ratio`), because a
 * per-second figure in a row labelled `Count` would be a false label.
 *
 * `max` reads `maxMs`, not the percentile map: no percentile map contains a
 * `max` key, and reaching for `percentiles.max` would silently yield `null`
 * for every row.
 *
 * A missing percentile key yields `null` rather than a neighbouring one. The
 * set is per project, and the extra ranks (`p90`, `p99.9`, `p99.99`) are only
 * present when the page asked for them — and never on a legacy estimated row
 * that did not store them. The nearest percentile is a different question.
 *
 * Users and CPU are not properties of a statistics row at all, so they answer
 * `null` here; the matrix reads them from `CompareStats.peakUsers`/`cpu`.
 */
export function metricValue(row: StatRow, metric: CompareMetric): number | null {
  if (metric === 'users' || metric === 'cpu') return null;
  if (metric === 'throughput') return row.throughputRps;
  if (metric === 'errors') return row.throughputRps * row.errorRate;
  if (metric === 'max') return row.maxMs;

  const value = row.percentiles[metric];
  return value === undefined || !Number.isFinite(value) ? null : value;
}

/** A row read from one run: its value, or `null` for "this run has none". */
type Reader = (run: CompareStats) => number | null;

const finite = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : value;

/** The run-scope statistics row, or `null`. */
const runRow = (run: CompareStats): StatRow | null =>
  run.stats?.stats.find((row) => row.scope === 'run') ?? null;

/** The summary rows for one metric, each a label and how to read it. */
function summaryRows(metric: CompareMetric): readonly { label: string; read: Reader }[] {
  const fromRunRow =
    (read: (row: StatRow) => number | null): Reader =>
    (run) => {
      const row = runRow(run);
      return row === null ? null : finite(read(row));
    };

  switch (metric) {
    case 'users':
      return [{ label: SUMMARY_LABELS.max, read: (run) => finite(run.peakUsers) }];
    case 'cpu':
      return [
        { label: SUMMARY_LABELS.mean, read: (run) => finite(run.cpu?.mean) },
        { label: SUMMARY_LABELS.max, read: (run) => finite(run.cpu?.max) },
      ];
    case 'errors':
      return [
        { label: SUMMARY_LABELS.count, read: fromRunRow((row) => row.koCount) },
        { label: SUMMARY_LABELS.ratio, read: fromRunRow((row) => row.errorRate) },
      ];
    case 'throughput':
      return [{ label: SUMMARY_LABELS.value, read: fromRunRow((row) => row.throughputRps) }];
    default:
      return [
        { label: SUMMARY_LABELS.allRequests, read: fromRunRow((row) => metricValue(row, metric)) },
      ];
  }
}

/**
 * How a request row reads one metric, or `null` where the metric has no
 * per-request value (users and CPU are properties of the run).
 *
 * Errors per request is the KO COUNT — the same unit as the `Count` summary
 * row above it, so the rows of one table are one quantity.
 */
function requestValue(metric: CompareMetric): ((row: StatRow) => number | null) | null {
  if (metric === 'users' || metric === 'cpu') return null;
  if (metric === 'errors') return (row) => row.koCount;
  return (row) => metricValue(row, metric);
}

export function toCompareMatrix(
  runs: readonly CompareStats[],
  metric: CompareMetric,
  /**
   * The run every change is measured against — `resolveReference`'s answer.
   *
   * REQUIRED, WITH NO DEFAULT, because every wrong answer here is silent. The
   * obvious shortcut is `runs[0]`, and `RunCompare` drops a run whose figures
   * failed to load before calling this — so on exactly the day one request
   * errors, `runs[0]` is a different run and every change silently changes
   * meaning. An id not among `runs` (or `null`) yields no reference column
   * and no changes, rather than changes against a guess.
   */
  referenceRunId: string | null,
): CompareMatrix {
  const reference = runs.find((run) => run.id === referenceRunId) ?? null;
  const ordered = reference === null ? [...runs] : [reference, ...runs.filter((run) => run !== reference)];

  const columns = ordered.map((run) => ({
    id: run.id,
    label: run.label,
    exact: figureIsExact(run.exact, metric),
    reference: run === reference,
  }));

  /**
   * One row of raw values → cells with their changes. The reference is
   * column 0 whenever there is one, which is what the ordering above is for.
   */
  const toCells = (values: readonly (number | null)[]): (CompareCell | null)[] => {
    const base = reference === null ? null : values[0] ?? null;
    return values.map((value, i) => {
      if (value === null) return null;
      if (i === 0 && reference !== null) return { value, change: null };
      if (base === null) return { value, change: null };
      const absolute = value - base;
      return {
        value,
        change: {
          absolute,
          percent: base === 0 ? null : (absolute / base) * 100,
          good: absolute === 0 ? null : isChangeGood(absolute, metric),
        },
      };
    });
  };

  /* A run with no figures for the window has no value in ANY row — users and
     CPU included — so its whole column is dashes. */
  const readAll = (read: Reader) => ordered.map((run) => (run.stats === null ? null : read(run)));

  const rows: CompareRow[] = summaryRows(metric).map(({ label, read }) => ({
    label,
    kind: 'summary',
    cells: toCells(readAll(read)),
  }));

  const perRequest = requestValue(metric);
  if (perRequest !== null) {
    /**
     * REQUEST SCOPE ONLY. `StatsResponse` carries run, group and request rows
     * in one array; including groups would list every request twice — once on
     * its own and once inside the group that contains it.
     */
    const lookups = ordered.map(
      (run) =>
        new Map(
          (run.stats?.stats ?? [])
            .filter((row) => row.scope === 'request')
            .map((row) => [row.name, row] as const),
        ),
    );

    /**
     * THE UNION, not the intersection, and not the first run's list: a
     * request that exists in only one run is precisely what a reader comparing
     * them is looking for. First-seen order across the runs in SELECTION
     * order (not column order), so moving the reference never reorders the
     * rows under the reader.
     */
    const names: string[] = [];
    const seen = new Set<string>();
    for (const run of runs) {
      for (const row of run.stats?.stats ?? []) {
        if (row.scope !== 'request' || seen.has(row.name)) continue;
        seen.add(row.name);
        names.push(row.name);
      }
    }

    for (const name of names) {
      rows.push({
        label: name,
        kind: 'request',
        // `null`, never `0`, for a request a run does not have. It did not take
        // no time — it did not run, and a zero would sort to the top of a
        // column of durations as though it were the fastest thing here.
        cells: toCells(
          lookups.map((lookup) => {
            const row = lookup.get(name);
            return row === undefined ? null : finite(perRequest(row));
          }),
        ),
      });
    }
  }

  return { columns, rows };
}
