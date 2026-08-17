import type { SeriesResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * `GET /v1/runs/:id/series` → the two rate charts §13.2 draws from it:
 * requests per second ⑩ (Appendix A G-23) and responses per second ⑪ (G-24).
 *
 * Pure data in, pure data out — no React, no ECharts, nothing that needs a DOM
 * — so every number below is asserted in the node environment against the
 * captured payload fixture.
 *
 * WHY THESE ARE TWO CHARTS AND NOT ONE. §13.2 ⑪ is explicit: responses/s is
 * "plotted separately from requests/s — their divergence reveals back-pressure".
 * A run whose service slows keeps starting requests at the offered rate while
 * finishing fewer of them, and the gap between the two lines IS that fact. The
 * reference run contains it in miniature: 33 of its 62 seconds started a
 * different number of requests than they finished, and its last second started
 * none at all while finishing one.
 */

/**
 * All, OK and KO, in SERIES order.
 *
 * The app-wide status colours, not the categorical palette. OK and KO here mean
 * "succeeded" and "did not succeed" — the same claim the donut ④ and the
 * distribution ⑧ make about the very same requests — and red has to mean on
 * this chart what it means on those. `All` is neither outcome, so it takes the
 * neutral token rather than borrowing a categorical hue that would read as a
 * third outcome. See `MarkRole` in `theme.ts`.
 *
 * Consumed PER SERIES (`ChartProps.roles`), so this array is aligned with
 * `series` and not with `axisLabels`. It is longer than the series list when the
 * start-edge split is unavailable — one series, three roles — which is correct
 * and not an accident: ECharts takes `color[i]` for series `i`, so the All line
 * keeps the neutral token it has when all three are drawn, instead of shifting
 * to whichever colour happened to be first in a shortened array.
 *
 * A module-level constant rather than a fresh array at the call site: it lands
 * in a `useEffect` dependency list.
 */
export const RATE_ROLES: readonly StatusRole[] = ['neutral', 'passed', 'failed'];

/** The three series' names, and Gatling's own for these charts. */
const ALL = 'All';
const OK = 'OK';
const KO = 'KO';

/** Heads the label column, and names the shared category axis. */
const TIME_COLUMN = 'Elapsed (s)';

type Bucket = SeriesResponse['buckets'][number];

/**
 * WHICH EDGE A CHART COUNTS ON — the one thing this file exists to keep
 * straight, expressed once as data so the two charts cannot drift into reading
 * each other's counters.
 *
 * `startedCount`/`startedOkCount`/`startedKoCount` are incremented when a
 * request BEGINS; `endedCount`/`okCount`/`koCount` when it FINISHES. A request
 * that starts at 10.9 s and ends at 11.2 s lands in bucket 10 for one chart and
 * bucket 11 for the other. Crossing them yields a chart that is smooth,
 * plausible and wrong — the totals still match (both sum to 895 on the
 * reference run) and only the per-bucket alignment differs.
 */
interface Edge {
  readonly all: (bucket: Bucket) => number;
  readonly ok: (bucket: Bucket) => number | null;
  readonly ko: (bucket: Bucket) => number | null;
  /**
   * Is the outcome split recorded at all for this run?
   *
   * The END edge always is — `okCount`/`koCount` have been written since the
   * first migration and are non-nullable. The START edge is not: see
   * `splitNote`.
   */
  readonly splitAvailable: (series: SeriesResponse) => boolean;
  readonly empty: string;
  readonly widthNote: (widthMs: number) => string;
}

const START_EDGE: Edge = {
  all: (b) => b.startedCount,
  ok: (b) => b.startedOkCount,
  ko: (b) => b.startedKoCount,
  splitAvailable: (s) => s.startedSplitAvailable,
  empty: 'No requests were recorded for this run, so there is no request rate to show.',
  widthNote: (widthMs) => widthNote(widthMs, 'requests were started'),
};

const END_EDGE: Edge = {
  all: (b) => b.endedCount,
  ok: (b) => b.okCount,
  ko: (b) => b.koCount,
  // Always. `okCount` and `koCount` are `z.number().int()`, not nullable, and
  // the migration that introduced the START-edge columns did not touch them.
  // Consulting `startedSplitAvailable` here would drop a split this chart has.
  splitAvailable: () => true,
  empty: 'No responses were recorded for this run, so there is no response rate to show.',
  widthNote: (widthMs) => widthNote(widthMs, 'responses were recorded'),
};

/**
 * Said in prose, because dividing silently would be its own kind of dishonesty:
 * the chart is titled "per second" and its points are then an average across a
 * window that is not a second, so a one-second spike inside a wide bucket is
 * flattened and cannot be recovered from what is drawn.
 */
function widthNote(widthMs: number, what: string): string {
  return (
    `This run is long enough that ${what} in ${widthMs} ms buckets rather than one-second ` +
    'ones, so each point is an average across that window. A shorter spike inside a bucket ' +
    'is not visible at this resolution.'
  );
}

/**
 * The sentence design §9's falsification checkpoint 7 exists for.
 *
 * `startedSplitAvailable` is false for runs ingested before the migration that
 * added `started_ok_count`/`started_ko_count`. Drawing OK and KO as flat zero
 * lines for those runs would state, in the most legible way a chart can, that
 * nothing failed — when what is true is that nobody wrote it down. That is the
 * entire reason those two columns are nullable and the reason the flag is on
 * the response at all; it has had no consumer until this chart.
 */
const SPLIT_UNAVAILABLE =
  'This run was ingested before the platform recorded which requests SUCCEEDED at the ' +
  'moment they started, so only the combined line is drawn. The OK/KO split is not ' +
  'recorded for this run — that is not the same as no failures; see responses per second ' +
  'for the outcome split, which is recorded for every run.';

/**
 * WHICH SHAPE THE X AXIS TAKES — the one thing about these charts that is a
 * property of the CALLER rather than of the data.
 *
 * `'category'` is what §13.2 ⑩ and ⑪ draw: one value per label, the labels
 * being elapsed seconds, so the crosshair `Chart`'s `group` shares with
 * concurrent users and the percentile bands reads the same on all of them.
 *
 * `'ms'` is what `TimeBrush` draws, and it is not a matter of taste. That
 * component carries the dataZoom slider, which reports its handles in the x
 * axis' OWN UNITS and whose committed window is milliseconds (`Chart`'s
 * `brush` contract, and the URL's). Handed the category form on a value axis,
 * ECharts maps each scalar onto both axes: the strip plotted requests/s
 * against requests/s — a straight 45° line, both axes reading 0..21 — and a
 * drag across the first third of a 63 s run committed `?from=0&to=7`, seven
 * MILLISECONDS, because the handles were reporting rate values.
 *
 * Only the DRAWN series change. The data table is the parity surface and stays
 * in seconds in both forms, because what a reader quotes does not move with
 * the renderer's arithmetic.
 */
export interface RateOptions {
  readonly x?: 'category' | 'ms';
}

/**
 * Both charts, from one builder: same axis, same three series, same table,
 * differing only in which pair of counters is read.
 */
function rateChart(series: SeriesResponse, edge: Edge, options: RateOptions = {}): ChartData {
  const pairs = options.x === 'ms';
  /**
   * THE DIVISOR IS THE PAYLOAD'S, and this is the single most important line in
   * the file. `BucketSeries` halves its resolution in place once a run exceeds
   * its bucket cap (`packages/statistics/src/buckets.ts`), so the width is 2000
   * or 4000 ms for a long run and the server sends what it actually used
   * (design §3). Assuming 1000 scales every point of both charts by the same
   * power of two — the curve's SHAPE is unchanged, the axis is unlabelled by
   * count, and nothing about the rendered chart looks wrong. It is a silent,
   * plausible, wholly-incorrect chart, and the reference run's width is 1000,
   * which means it cannot be caught by looking at the one payload anybody tests
   * against.
   */
  const perSecond = series.bucketWidthMs / 1000;

  /**
   * Whether the outcome split is drawn at all. The FLAG decides, never a scan
   * of the counters: the API derives it (`metrics.controller.ts`) from both
   * columns being non-null in every bucket, and re-deriving it here would be a
   * second definition of one fact, free to disagree with the first.
   */
  const split = edge.splitAvailable(series);

  const columns = split ? [TIME_COLUMN, ALL, OK, KO] : [TIME_COLUMN, ALL];

  if (series.buckets.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Not a flat zero line: "this run sent nothing" and "this run has not
      // been parsed yet" are different facts a reader acts on differently, and
      // an empty chart cannot tell them apart.
      empty: edge.empty,
    };
  }

  /**
   * A count as a rate — or `null` where the count is missing.
   *
   * `?? 0` is what this must NOT do, and `read.ts` says so on the persistence
   * side for the same reason: a missing start-edge count drawn as zero reads as
   * "nothing failed in this second". `ChartData` is explicit that null is a gap
   * and must not be drawn as one. Unreachable through today's API — the flag is
   * false whenever any bucket is null, and the whole split is then dropped —
   * but the flag and the columns are separate fields and a partial backfill is
   * exactly where they would disagree.
   */
  const rate = (count: number | null): number | null =>
    count === null ? null : count / perSecond;

  /**
   * The values, before either axis shape is chosen — so the drawing and the
   * table are built from ONE array of numbers rather than the table reading
   * them back out of whatever the drawing happened to be shaped into. That
   * read-back is what made the row builder below depend on the series being
   * scalar, and it is exactly the coupling a second shape would break.
   */
  const measured: readonly { readonly name: string; readonly data: readonly (number | null)[] }[] =
    [
      { name: ALL, data: series.buckets.map((b) => rate(edge.all(b))) },
      ...(split
        ? [
            { name: OK, data: series.buckets.map((b) => rate(edge.ok(b))) },
            { name: KO, data: series.buckets.map((b) => rate(edge.ko(b))) },
          ]
        : []),
    ];

  const drawn: ChartSeries[] = measured.map(({ name, data }) => ({
    name,
    // A null y is preserved, never dropped: see `ChartSeries.data`. A point
    // omitted from a value axis is not a gap, it is a line drawn across one.
    data: pairs
      ? series.buckets.map((b, i) => [b.startOffsetMs, data[i] ?? null] as [number, number | null])
      : data,
  }));

  const rows: ChartTableRow[] = series.buckets.map((bucket, i) => ({
    label: String(bucket.startOffsetMs / 1000),
    // The same numbers the chart draws, so the table cannot show a count where
    // the chart shows a rate. A gap is a dash, never a zero — same reason as
    // above, and the table is the more quotable of the two surfaces.
    values: measured.map((s) => s.data[i] ?? '—'),
  }));

  const notes: string[] = [];
  if (!split) notes.push(SPLIT_UNAVAILABLE);
  if (series.bucketWidthMs !== 1000) notes.push(edge.widthNote(series.bucketWidthMs));

  return {
    series: drawn,
    // Elapsed SECONDS, from the bucket's own offset — what Gatling's axis shows,
    // and what makes the crosshair these charts share with concurrent users and
    // the percentile bands (`Chart`'s `group`) read the same on all of them.
    //
    // EMPTY in the pair form, on purpose and for the reason `toErrorSeries`
    // gives: x is a measured quantity there and each point carries its own, so
    // a category axis alongside is a second, disagreeing answer to where a
    // point sits.
    axisLabels: pairs ? [] : series.buckets.map((b) => b.startOffsetMs / 1000),
    columns,
    rows,
    limitation: notes.length > 0 ? notes.join(' ') : undefined,
  };
}

/**
 * ⑩ — requests per second, All/OK/KO, bucketed by START time (G-23).
 *
 * READS THE START-EDGE COUNTERS ONLY. `okCount`/`koCount` are the END-edge
 * split and belong to `toResponseRate`; they are the ones that have always
 * existed, which makes them the ones a hurried implementation reaches for.
 *
 * Gatling's own report draws this chart with a single "All" series — the
 * split is a platform addition required by Appendix A G-23, and the columns
 * feeding it were added by Task 2 for exactly that. Where a run predates them
 * the All series is drawn alone and `SPLIT_UNAVAILABLE` says why.
 */
export function toRequestRate(series: SeriesResponse, options?: RateOptions): ChartData {
  return rateChart(series, START_EDGE, options);
}

/**
 * ⑪ — responses per second, All/OK/KO, bucketed by END time (G-24).
 *
 * READS THE END-EDGE COUNTERS ONLY, and its split is never unavailable.
 */
export function toResponseRate(series: SeriesResponse, options?: RateOptions): ChartData {
  return rateChart(series, END_EDGE, options);
}
