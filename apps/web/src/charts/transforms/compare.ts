import type {
  AgentInjectorsResponse,
  SeriesResponse,
  TelemetryResponse,
  UsersResponse,
} from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';
import { clampPercentile } from '../../percentile';
import { runMinuteLabel } from './runLabel';
import { runName, runTag } from '../../runNumber';

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
 *     needs the underlying histograms, and `SeriesBucket` carries only the
 *     percentiles computed from them.
 *     Resampling here would have produced a number wrong by an unbounded
 *     amount that looks entirely plausible on a chart.
 *
 * WHAT MAKES DIFFERING WIDTHS HONEST INSTEAD is the x-axis: each run plots at
 * its own `startOffsetMs` on a VALUE axis, so two runs meet at real elapsed
 * times rather than being indexed against each other by bucket position. A
 * coarser run simply has fewer points. That is visible, it is true, and it is
 * said in `limitation` as well.
 */

export type CompareMetric =
  | 'users'
  | 'cpu'
  | 'errors'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'p99.9'
  | 'p99.99'
  | 'max'
  | 'throughput';

/**
 * Which way is an improvement, for one metric — or `null` where neither is.
 *
 * ═══ ONE PLACE, BECAUSE IT HAS SEVERAL READERS ═══
 *
 * The summary tiles and the per-request matrix both colour a change by this,
 * and a second copy is how the tiles above a table come to disagree with the
 * table. It lives beside `CompareMetric` rather than in either consumer, so
 * neither owns a decision the other depends on.
 *
 * Throughput going up is good; every latency metric and the error rate are
 * better going down. CONCURRENT USERS AND CPU ARE NEITHER: more users is the
 * load the test was told to apply, and a generator's CPU says how hard the
 * MACHINE worked, not whether the system under test got better. A coloured
 * chip on either would be a judgement nobody configured, so they answer
 * `null` and their chips are neutral.
 *
 * TAKES A SIGNED CHANGE, not specifically a percentage. Only the sign is read,
 * and the matrix has a case the summary does not: a reference of ZERO has no
 * percentage at all — errors rising from 0 to 2/s is the regression an
 * engineer most needs to see — while the ABSOLUTE change is still perfectly
 * signed.
 */
export function isChangeGood(signedChange: number, metric: CompareMetric): boolean | null {
  if (metric === 'users' || metric === 'cpu') return null;
  return metric === 'throughput' ? signedChange >= 0 : signedChange <= 0;
}

/**
 * What the selector offers, in Gatling Enterprise's order, in this product's
 * words. Users come from `/users` and CPU from the agent or the telemetry
 * agent, so choosing either changes which endpoints the page reads — that is
 * the page's job (only the selected metric's extra reads are fetched), and
 * this list is only what can be asked.
 */
export const COMPARE_METRICS: readonly { value: CompareMetric; label: string }[] = [
  { value: 'users', label: 'Concurrent users' },
  { value: 'cpu', label: 'CPU usage' },
  { value: 'errors', label: 'Errors' },
  { value: 'p50', label: '50th percentile' },
  { value: 'p90', label: '90th percentile' },
  { value: 'p95', label: '95th percentile' },
  { value: 'p99', label: '99th percentile' },
  { value: 'p99.9', label: '99.9th percentile' },
  { value: 'p99.99', label: '99.99th percentile' },
  { value: 'max', label: 'Max response time' },
  { value: 'throughput', label: 'Throughput' },
];

/**
 * The exact rank `/stats` is asked for, per percentile metric — EVERY one of
 * them, sent as `?percentiles=`.
 *
 * `/stats` with no `?percentiles=` answers the project's configured set, and
 * that set can omit any rank — a project configured `[90, 99]` has no p95. So
 * a percentile left to the configured set read `—` in the table and the tiles
 * for an EXACT run, while the overlay drew the same rank's line from the
 * bucket bands; and the info tip's "a figure it did not record" was false,
 * because the histograms answer it. Asking for every rank makes each answer
 * an exact rank whatever the project configured (final review m1). The cost
 * is that p50, p95 and p99 stop sharing the run page's `/stats` cache entry,
 * which p90 had already given up.
 *
 * Per BUCKET only `p99.9` and `p99.99` need `/series?percentiles=`: the series
 * histograms always carry a fixed band set that includes the rest. The key the
 * server answers under is `p<rank>`, so `p99.9` maps to `99.9` and back.
 */
export const STATS_RANKS: Partial<Record<CompareMetric, number>> = {
  p50: 50,
  p90: 90,
  p95: 95,
  p99: 99,
  'p99.9': 99.9,
  'p99.99': 99.99,
};

/** The unit each metric carries, for the axis, the tooltip and the table. */
const UNIT: Record<CompareMetric, 'ms' | '/s' | 'users' | '%'> = {
  users: 'users',
  cpu: '%',
  errors: '/s',
  p50: 'ms',
  p90: 'ms',
  p95: 'ms',
  p99: 'ms',
  'p99.9': 'ms',
  'p99.99': 'ms',
  max: 'ms',
  throughput: '/s',
};

export const compareUnit = (metric: CompareMetric): string => UNIT[metric];

/** One overlay point: elapsed milliseconds within its own run, and the value. */
export type ComparePoint = readonly [offsetMs: number, value: number];

/**
 * A run in the selection: its identity, how to label it, and the points its
 * source yielded for the selected metric.
 *
 * `points: null` MEANS NOT RECORDED — a run with no CPU source at all — and is
 * a different fact from `[]`, which is a source that answered and measured
 * nothing in this span. BOTH are named under the chart, in different words:
 * a run with no line and no sentence is indistinguishable from a run that was
 * left out (final review m2). The one exception is `ended`, below.
 *
 * `ended` is a run that finished before the window began: its `[]` is named by
 * the page already ("Run 2 ended before this window."), so a second sentence
 * here would say the same thing twice.
 *
 * `bucketWidthMs` is the resolution the points were taken at, for the note
 * that runs bucketed differently have different densities; `null` where the
 * run has no points to describe.
 */
export interface CompareRun {
  readonly id: string;
  readonly label: string;
  readonly points: readonly ComparePoint[] | null;
  readonly bucketWidthMs: number | null;
  readonly ended?: boolean;
}

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
 * An extra rank (`p99.9`, `p99.99`) is read from the same map, under the key
 * `/series?percentiles=` answers it with. A bucket without that key — the run
 * was read without asking, or a legacy row never stored it — has no value,
 * never a neighbouring rank and never zero.
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
 * `transforms/percentiles.ts` argues at length: the histograms are fed on the
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
  // from one population over one slice. A bucket written since 2026-10-15
  // holds exact nearest-rank values, already inside that range, so the clamp
  // is a no-op for it; a LEGACY bucket holds sketch estimates, which can lie
  // outside the sample they were taken from, and is still projected back.
  // `max` above is deliberately read BEFORE this, and is exact.
  return raw === undefined ? null : clampPercentile(raw, bucket);
}

/**
 * One run's `/series` read as overlay points for one metric.
 *
 * NOT PLOTTED AT ALL rather than plotted as null where a bucket has no value:
 * on a value axis a point carries its own x, so an unmeasured bucket is simply
 * absent and the line joins its neighbours. A `[x, null]` pair would be a
 * point at an unknown height.
 *
 * Concurrent users and CPU are not `/series` metrics — `usersPoints` and
 * `cpuPoints` read them — so this has nothing to say for either and answers
 * `[]` rather than inventing a value from a payload that does not carry one.
 */
export function seriesPoints(series: SeriesResponse, metric: CompareMetric): ComparePoint[] {
  if (metric === 'users' || metric === 'cpu') return [];
  const perSecond = series.bucketWidthMs / 1000;
  const out: ComparePoint[] = [];
  for (const bucket of series.buckets) {
    const value = valueOf(bucket, metric, perSecond);
    if (value !== null) out.push([bucket.startOffsetMs, value]);
  }
  return out;
}

/**
 * Concurrent users over the run: the all-scenario `maxConcurrent` at each
 * offset — the same "All users" line the run page draws, which Gatling's own
 * report sums per scenario (see `UsersResponseSchema.total`).
 */
export function usersPoints(users: UsersResponse): ComparePoint[] {
  return users.total.map((bucket): ComparePoint => [bucket.startOffsetMs, bucket.maxConcurrent]);
}

/**
 * The load generator's CPU over the run, from the best source the run has.
 *
 *   1. The Gatling agent's MACHINE collector — `cpuUserPct + cpuSysPct`, the
 *      generator's whole CPU — when it ran. A bucket with neither reading
 *      (the first sample, or a counter that did not move) is skipped, never
 *      read as an idle machine.
 *   2. Else the telemetry agent: `cpuTotalPct` per host, averaged at each
 *      offset over the hosts that read one. A host whose interval could not
 *      be measured is left out of that offset's mean rather than counted as
 *      zero, and an offset no host read is skipped.
 *   3. Else `null` — NOT RECORDED. The agent off or without its machine
 *      collector, and no telemetry agent reporting, is a run whose CPU nobody
 *      measured, and the chart names it rather than drawing a flat line.
 *
 * A source that answered but holds nothing in the asked window yields `[]`:
 * the CPU was recorded, just not there.
 */
export function cpuPoints(
  injectors: AgentInjectorsResponse | null,
  telemetry: TelemetryResponse | null,
): ComparePoint[] | null {
  if (injectors !== null && injectors.available && injectors.machine.available) {
    return injectors.buckets.flatMap((bucket): ComparePoint[] =>
      bucket.cpuUserPct === null && bucket.cpuSysPct === null
        ? []
        : [[bucket.startOffsetMs, (bucket.cpuUserPct ?? 0) + (bucket.cpuSysPct ?? 0)]],
    );
  }

  if (telemetry !== null && telemetry.available) {
    const sums = new Map<number, { total: number; hosts: number }>();
    for (const host of telemetry.hosts) {
      for (const point of host.points) {
        if (point.cpuTotalPct === null) continue;
        const acc = sums.get(point.startOffsetMs) ?? { total: 0, hosts: 0 };
        acc.total += point.cpuTotalPct;
        acc.hosts += 1;
        sums.set(point.startOffsetMs, acc);
      }
    }
    return [...sums.entries()]
      .sort(([a], [b]) => a - b)
      .map(([offset, { total, hosts }]): ComparePoint => [offset, total / hosts]);
  }

  return null;
}

/**
 * Which responses the drawn values are computed from.
 *
 * Stated rather than assumed: latency read over every response is a different
 * quantity from latency read over successful ones, and a failing run is
 * exactly when they diverge most. Rates, users and CPU carry no population
 * question, so they get no note.
 */
function populationNote(metric: CompareMetric): string | undefined {
  if (UNIT[metric] !== 'ms') return undefined;
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

const metricLabel = (metric: CompareMetric): string =>
  COMPARE_METRICS.find((m) => m.value === metric)?.label ?? metric;

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

  const recorded = runs.filter(
    (run): run is CompareRun & { points: readonly ComparePoint[] } => run.points !== null,
  );

  /*
   * A RUN THAT DID NOT RECORD THIS METRIC DRAWS NOTHING AND IS NAMED. No line
   * is the honest drawing — a flat zero would read as an idle generator — and
   * no line alone is indistinguishable from a run that was left out, so the
   * note says which run and why.
   */
  const unrecorded = runs
    .filter((run) => run.points === null)
    .map((run) => `${metricLabel(metric)} was not recorded for ${run.label}.`);

  /*
   * A RUN THAT RECORDED THE METRIC AND HAS NO READING IN THIS SPAN is named too
   * — a CPU source that answered with nothing in a narrow window, or a series
   * over a stretch where the run made no requests. Not "not recorded", which
   * would be false of it; and not left as a legend entry with no line, which
   * reads as a run whose data failed to arrive.
   */
  const unread = recorded
    .filter((run) => run.points.length === 0 && run.ended !== true)
    .map((run) => `${metricLabel(metric)} has no reading for ${run.label} in this span.`);

  const drawn: ChartSeries[] = recorded.map((run) => ({
    name: run.label,
    data: run.points,
  }));

  /**
   * THE UNION OF EVERY RUN'S OFFSETS, so the table holds every measurement any
   * run made — a run bucketed more finely than its neighbours must not lose
   * rows to them, and the table is the parity surface and the screen-reader
   * route to the same data.
   */
  const offsets = [...new Set(recorded.flatMap((run) => run.points.map(([x]) => x)))].sort(
    (a, b) => a - b,
  );

  const byOffset = runs.map((run) => new Map(run.points ?? []));

  const rows: ChartTableRow[] = offsets.map((offset) => ({
    label: String(offset / 1000),
    // `—` for a run that has no value at this offset — it ended earlier, is
    // bucketed more coarsely, or did not record the metric at all. Not zero,
    // which would read as a measured collapse to nothing.
    values: byOffset.map((lookup) => lookup.get(offset) ?? '—'),
  }));

  const limitation =
    [
      populationNote(metric),
      widthNote(
        recorded.flatMap((run) => (run.bucketWidthMs === null ? [] : [run.bucketWidthMs])),
      ),
      ...unrecorded,
      ...unread,
    ]
      .filter((note): note is string => note !== undefined)
      .join(' ') || undefined;

  return {
    series: drawn,
    // EMPTY ON PURPOSE: x is a measured quantity here, so each point carries
    // its own. See `ChartSeries.data`'s pair form and `ChartXAxis.type`.
    axisLabels: [],
    columns,
    rows,
    // `undefined` rather than an empty string when no note applies: the field
    // is optional, and a rate metric on runs of one width genuinely has
    // nothing to say. An empty string would render an empty paragraph beside
    // the chart.
    limitation,
    // Nothing to draw at all: say so rather than draw empty axes. The per-run
    // sentences stay in `limitation`, so this does not repeat them. Every
    // recorded run reading nothing in this span is the same bare-axes case
    // one step on, and is said as plainly.
    empty:
      recorded.length === 0
        ? `${metricLabel(metric)} was not recorded for any selected run.`
        : recorded.every((run) => run.points.length === 0)
          ? `${metricLabel(metric)} has no reading for any selected run in this span.`
          : undefined,
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

/**
 * A label per run: its NUMBER where it has one, and exactly `compareLabels`'
 * minute label where it does not.
 *
 * Numbers never collide within a test (a unique index says so), so a numbered
 * run needs no suffix. The numberless runs are passed to `compareLabels` as a
 * group of their own, so its collision suffix is decided among them alone —
 * and a minute label (`08-07 11:00`) can never equal `Run 12` or `#12`, so the
 * two populations cannot collide with each other either.
 */
export function runLabels(
  runs: readonly { id: string; at: string; runNumber?: number | null }[],
  form: 'name' | 'tag',
): string[] {
  const numberless = runs.flatMap((run, index) =>
    run.runNumber === null || run.runNumber === undefined ? [{ id: run.id, at: run.at, index }] : [],
  );
  const fallback = compareLabels(numberless);
  const fallbackAt = new Map(numberless.map((run, k) => [run.index, fallback[k]!]));
  return runs.map((run, index) =>
    run.runNumber === null || run.runNumber === undefined
      ? fallbackAt.get(index)!
      : form === 'name'
        ? runName(run.runNumber)
        : runTag(run.runNumber),
  );
}
