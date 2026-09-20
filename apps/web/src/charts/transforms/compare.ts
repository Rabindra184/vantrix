import type { SeriesResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';
import { clampPercentile } from '../../percentile';
import { runMinuteLabel } from './runLabel';

/**
 * Two to five runs of one simulation, overlaid on a single metric.
 *
 * ═══ NO RESAMPLING, AND THE SPEC WAS WRONG TO ASK FOR IT ═══
 *
 * §1.3 originally required every selected run to be resampled to the coarsest
 * `bucketWidthMs` in the selection, on the grounds that overlaying a 1000 ms
 * run on a 2000 ms one "silently misstates the shorter one's rate". Both
 * halves of that are wrong, and the second is dangerous:
 *
 *   - A RATE IS ALREADY NORMALISED. `transforms/rates.ts` divides by
 *     `bucketWidthMs / 1000`, and the contract's own comment on that field
 *     says this is exactly why it is sent. This file does the same. There is
 *     nothing to correct.
 *
 *   - A PERCENTILE CANNOT BE RESAMPLED AT ALL. Merging two 1000 ms buckets
 *     into one 2000 ms bucket is sound for counts, which sum. It is not sound
 *     for quantiles: the 95th percentile of a union is not the mean, the max,
 *     or any function of the two buckets' 95th percentiles — recovering it
 *     needs the underlying sketches, and `SeriesBucket` carries quantiles.
 *     Resampling here would have produced a number wrong by an unbounded
 *     amount that looks entirely plausible on a chart.
 *
 * WHAT MAKES DIFFERING WIDTHS HONEST INSTEAD is the x-axis: each run plots at
 * its own `startOffsetMs` on a VALUE axis, so two runs meet at real elapsed
 * times rather than being indexed against each other by bucket position. A
 * coarser run simply has fewer points. That is visible, it is true, and it is
 * said in `limitation` as well.
 */

export type CompareMetric = 'p50' | 'p95' | 'p99' | 'max' | 'throughput' | 'errors';

/**
 * Which way is an improvement, for one metric.
 *
 * ═══ ONE PLACE, BECAUSE IT IS ABOUT TO HAVE A SECOND READER ═══
 *
 * `compareSummary` has owned this since the review-majors branch and is right
 * about it: throughput going up is good, and every other metric here — the
 * response-time percentiles, the max, the error rate — is better going down.
 * The per-request matrix now needs the identical judgement, and a second copy
 * is how the tiles above a table come to disagree with the table.
 *
 * It lives beside `CompareMetric` rather than in either consumer, so neither
 * owns a decision the other depends on.
 *
 * TAKES A SIGNED CHANGE, not specifically a percentage. Only the sign is read,
 * and the matrix has a case the summary does not: a baseline of ZERO has no
 * percentage at all — errors rising from 0 to 2/s is the regression an
 * engineer most needs to see — while the ABSOLUTE change is still perfectly
 * signed. Naming the parameter for the percentage would have quietly excluded
 * exactly that row.
 */
export function isChangeGood(signedChange: number, metric: CompareMetric): boolean {
  return metric === 'throughput' ? signedChange >= 0 : signedChange <= 0;
}

/**
 * What the selector offers, and nothing else.
 *
 * ONLY WHAT `/series` CAN ANSWER. Gatling's own comparison also offers
 * concurrent users and CPU; ours does not, because the first lives in
 * `/users` and the second is not collected at all. Adding either would make
 * the metric selector change which endpoints the page fetches — a second fetch
 * shape for one option — and a selector that promises a metric the page cannot
 * produce is worse than a shorter selector.
 */
export const COMPARE_METRICS: readonly { value: CompareMetric; label: string }[] = [
  { value: 'p50', label: '50th percentile' },
  { value: 'p95', label: '95th percentile' },
  { value: 'p99', label: '99th percentile' },
  { value: 'max', label: 'Max response time' },
  { value: 'throughput', label: 'Throughput' },
  { value: 'errors', label: 'Errors' },
];

/** A run in the selection: its identity, how to label it, and its series. */
export interface CompareRun {
  readonly id: string;
  readonly label: string;
  readonly series: SeriesResponse;
}

const IS_RATE: Record<CompareMetric, boolean> = {
  p50: false,
  p95: false,
  p99: false,
  max: false,
  throughput: true,
  errors: true,
};

/** The unit each metric carries, for the axis and the tooltip. */
export const compareUnit = (metric: CompareMetric): string => (IS_RATE[metric] ? '/s' : 'ms');

/**
 * One bucket's value for one metric, or `null` where it was not measured.
 *
 * ═══ THE COMBINED POPULATION, BECAUSE THE MATRIX HAS NO OTHER ═══
 *
 * A `SeriesBucket` carries three percentile maps — `percentiles` (every
 * response), `percentilesOk`, `percentilesKo`. A `StatRow` carries exactly
 * one, the combined set, and no OK-only variant exists on it at all.
 *
 * This read `percentilesOk` while `metricValue` — which feeds the comparison
 * matrix AND the summary tiles sitting directly above this overlay — read
 * `row.percentiles`. One word, three surfaces of one screen, two populations,
 * and nothing telling the reader which they had. The combined set is the only
 * one all three CAN share without a backend change, so it is the one they
 * share, and `limitation` says so on screen.
 *
 * ═══ `max` COMES FIRST, AND THAT ORDER IS THE FIX ═══
 *
 * `maxMs` is a COMBINED extremum, but the branch reading it used to sit behind
 * a guard on `percentilesOk` being empty. A bucket in which every request
 * failed has no OK percentiles and a perfectly real maximum — so the overlay
 * dropped the slowest measurement in exactly the buckets a regression hunt
 * cares about most, with nothing thrown and only a hole in the line to show
 * for it.
 *
 * The emptiness test is still the map's own, for the reason
 * `transforms/percentiles.ts` argues at length: the sketches are fed on the
 * START edge while `okCount` counts ends, so the two disagree, and the map
 * actually read is the only thing that cannot disagree with itself.
 *
 * Rates divide by THIS RUN'S width. See the file docstring.
 */
function valueOf(
  bucket: SeriesResponse['buckets'][number],
  metric: CompareMetric,
  perSecond: number,
): number | null {
  if (metric === 'throughput') return (bucket.okCount + bucket.koCount) / perSecond;
  if (metric === 'errors') return bucket.koCount / perSecond;

  // BEFORE the percentile guard — see the docstring. A failed-only bucket has
  // a real maximum and an empty percentile map.
  if (metric === 'max') {
    return bucket.okCount + bucket.koCount === 0 ? null : bucket.maxMs;
  }

  if (Object.keys(bucket.percentiles).length === 0) return null;
  const raw = bucket.percentiles[metric];
  // CLAMPED, as the run page clamps the same quantity. The scope here is the
  // BUCKET rather than the run — its percentiles and its `minMs`/`maxMs` come
  // from one sketch over one slice — so the invariant is the same one a
  // narrower window down: an estimate cannot lie outside the sample it was
  // taken from. `max` above is deliberately read BEFORE this, and is exact.
  return raw === undefined ? null : clampPercentile(raw, bucket);
}

/**
 * Which responses the drawn values are computed from.
 *
 * Stated rather than assumed: latency read over every response is a different
 * quantity from latency read over successful ones, and a failing run is
 * exactly when they diverge most. Rates carry no population question, so they
 * get no note.
 */
function populationNote(metric: CompareMetric): string | undefined {
  if (IS_RATE[metric]) return undefined;
  return (
    'Latency here is computed over every response, successful and failed — the same ' +
    'population as the comparison table and the summary above it.'
  );
}

function widthNote(widths: readonly number[]): string | undefined {
  const distinct = [...new Set(widths)].sort((a, b) => a - b);
  if (distinct.length <= 1) return undefined;
  return (
    `These runs were bucketed at different resolutions (${distinct.join(' ms, ')} ms), so they ` +
    'have different numbers of points. Every value is still a measurement at the elapsed time ' +
    'it is drawn at, and rates are per second in every case.'
  );
}

export function toCompare(runs: readonly CompareRun[], metric: CompareMetric): ChartData {
  const columns = ['Elapsed (s)', ...runs.map((r) => r.label)];

  if (runs.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      empty: 'Select at least one run to compare.',
    };
  }

  const drawn: ChartSeries[] = runs.map((run) => {
    const perSecond = run.series.bucketWidthMs / 1000;
    const points: [number, number][] = [];

    for (const bucket of run.series.buckets) {
      const value = valueOf(bucket, metric, perSecond);
      // NOT PLOTTED AT ALL rather than plotted as null: on a value axis a
      // point carries its own x, so an unmeasured bucket is simply absent and
      // the line joins its neighbours. A `[x, null]` pair would be a point at
      // an unknown height.
      if (value === null) continue;
      points.push([bucket.startOffsetMs, value]);
    }

    return { name: run.label, data: points };
  });

  /**
   * THE UNION OF EVERY RUN'S OFFSETS, so the table holds every measurement any
   * run made — a run bucketed more finely than its neighbours must not lose
   * rows to them, and the table is the parity surface and the screen-reader
   * route to the same data.
   */
  const offsets = [
    ...new Set(runs.flatMap((run) => run.series.buckets.map((b) => b.startOffsetMs))),
  ].sort((a, b) => a - b);

  const byOffset = runs.map((run) => {
    const perSecond = run.series.bucketWidthMs / 1000;
    return new Map(
      run.series.buckets.map((b) => [b.startOffsetMs, valueOf(b, metric, perSecond)]),
    );
  });

  const rows: ChartTableRow[] = offsets.map((offset) => ({
    label: String(offset / 1000),
    // `—` for a run that has no bucket at this offset — it ended earlier, or
    // is bucketed more coarsely. Not zero, which would read as a measured
    // collapse to nothing.
    values: byOffset.map((lookup) => lookup.get(offset) ?? '—'),
  }));

  return {
    series: drawn,
    // EMPTY ON PURPOSE: x is a measured quantity here, so each point carries
    // its own. See `ChartSeries.data`'s pair form and `ChartXAxis.type`.
    axisLabels: [],
    columns,
    rows,
    // `undefined` rather than an empty string when neither note applies: the
    // field is optional, and a rate metric on runs of one width genuinely has
    // nothing to say. An empty string would render an empty paragraph beside
    // the chart.
    limitation:
      [populationNote(metric), widthNote(runs.map((r) => r.series.bucketWidthMs))]
        .filter((note): note is string => note !== undefined)
        .join(' ') || undefined,
  };
}

/**
 * A readable, and UNIQUE, label per selected run.
 *
 * ═══ WHY UNIQUENESS IS A CORRECTNESS PROBLEM HERE ═══
 *
 * The natural label is the run's start time at minute resolution, which is
 * short enough for a legend and for a matrix column header. Two runs can
 * share one: the same minute, or — as every fixture-driven test does — the
 * same recorded simulation start.
 *
 * When they do, the failure is not cosmetic. ECharts DEDUPES SERIES BY NAME,
 * so two identically-named runs draw one legend entry and the reader cannot
 * tell which line is which; the matrix grows two columns with the same header
 * and no way to attribute a number to a run. A comparison whose columns cannot
 * be told apart is not a comparison.
 *
 * So a colliding label gains a short id suffix, and only a colliding one — the
 * common case stays a clean timestamp, and the suffix appears exactly where it
 * is needed to disambiguate.
 *
 * ═══ IN THE READER'S ZONE ═══
 *
 * `runMinuteLabel` owns the shape and the zone, and the trends axis draws its
 * ticks with the same function — the two held a copy each of the same ISO
 * slicing until they had to stop reading in UTC. See that file for why the
 * local reading, and why not `Intl`.
 *
 * The collision arithmetic below is unaffected by the zone: every UTC offset
 * is a whole number of minutes, so two runs sharing a minute in UTC share one
 * locally too.
 */
export function compareLabels(runs: readonly { id: string; at: string }[]): string[] {
  const base = runs.map((run) => runMinuteLabel(run.at));

  const seen = new Map<string, number>();
  for (const label of base) seen.set(label, (seen.get(label) ?? 0) + 1);

  return base.map((label, i) => {
    if ((seen.get(label) ?? 0) <= 1) return label;
    // The colliding group, and the shortest id prefix that separates ALL of
    // them — six characters is usually plenty and occasionally is not, and two
    // runs whose ids share a prefix AND a minute would otherwise get identical
    // labels again, which is the exact failure this function exists to prevent.
    const group = runs.filter((_, j) => base[j] === label).map((run) => run.id);
    return `${label} · ${runs[i]!.id.slice(0, shortestUniquePrefix(group))}`;
  });
}

/**
 * The shortest prefix length that tells every id in `group` apart.
 *
 * Starts at six because that is short enough to sit in a legend, and grows
 * only when it has to. Ids are unique, so the full length always separates
 * them and the loop terminates.
 */
function shortestUniquePrefix(group: readonly string[]): number {
  const longest = Math.max(...group.map((id) => id.length));
  for (let length = 6; length < longest; length += 1) {
    if (new Set(group.map((id) => id.slice(0, length))).size === group.length) return length;
  }
  return longest;
}
