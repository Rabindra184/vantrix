import type { DistributionResponse } from '@perfportal/contracts';
import type { ChartData, ChartTableRow } from '../types';
import type { Outcome } from './percentiles';

/**
 * Response Time Percentiles Distribution — percentile on the x-axis, response
 * time on the y.
 *
 * DERIVED, NOT FETCHED. `DistributionResponse` already carries counts per
 * response-time bucket, and walking those buckets in ascending order while
 * accumulating the counts answers "what share of observations came in at or
 * below this response time" — which is the definition of a percentile. So this
 * chart costs no endpoint, no query and no cache key: it reads the payload the
 * Charts tab is already holding for the histogram beside it.
 *
 * IT EARNS ITS PLACE BESIDE THAT HISTOGRAM rather than replacing it. The
 * histogram shows where the mass is; this shows THE SHAPE OF THE TAIL, which
 * is what an SLO is actually written about. "p99 under 500 ms" is a question
 * about a point on this curve, and on the histogram it is a question about the
 * area under an unmarked stretch of the right-hand side.
 */

/** The percentage axis, which is the x here and needs saying. */
const PERCENTILE_COLUMN = 'Percentile (%)';

/**
 * Names which kind of number the response times are, exactly as the histogram
 * transform does and for the same reason.
 *
 * The labels are normally bin MIDPOINTS, but when the observed range is narrow
 * enough that Gatling skips bucketing (`exactValues`) a label is a millisecond
 * value some request actually took. Those are different quantities carried in
 * the same array, and a reader who takes a midpoint for an observation
 * concludes the fastest request took 28 ms when it took 16.
 */
function labelColumn(exactValues: boolean): string {
  return exactValues
    ? 'Response time (ms, exact value)'
    : 'Response time (ms, bin midpoint)';
}

/**
 * The counts this outcome is a curve of.
 *
 * `all` sums the two rather than reading a third array, because the payload
 * has no combined series — and the sum is exactly right, since `okCount` and
 * `koCount` partition the binned observations.
 */
function countsFor(d: DistributionResponse, outcome: Outcome): readonly number[] {
  if (outcome === 'ok') return d.okCount;
  if (outcome === 'ko') return d.koCount;
  return d.labels.map((_, i) => (d.okCount[i] ?? 0) + (d.koCount[i] ?? 0));
}

const SERIES_NAME: Record<Outcome, string> = { ok: 'OK', ko: 'KO', all: 'All' };

/**
 * What a run with none of the selected outcome recorded none of.
 *
 * Written out per outcome rather than pluralised from a singular noun: the
 * arithmetic version needs a special case for `all` ("no responses", not "no
 * responses" built from "response"), and a conditional inside a template
 * literal is harder to read than three finished sentences.
 */
const NOTHING_RECORDED: Record<Outcome, string> = {
  ok: 'no successful responses',
  ko: 'no failed responses',
  all: 'no responses',
};

/**
 * Said in prose, because the alternative is drawing the curve to 100% and
 * letting it look complete.
 *
 * An observation above the histogram's cap is counted but lands in no bin
 * (`Histogram#accept` returns before touching `#bins`), so this curve is a
 * percentile OF THE BINNED OBSERVATIONS and the real tail continues past its
 * right-hand end — which is the end a reader of a percentile chart looks at
 * hardest. The cap itself is not named: it is a server constant the payload
 * does not carry, and inventing a figure here would be a claim this module
 * cannot support.
 */
function overflowNote(count: number, outcome: Outcome): string {
  const times = count === 1 ? 'response time' : 'response times';
  const head =
    `${count} ${times} exceeded the range this histogram records and fall into no bin, so this ` +
    'curve stops short of 100% and the true tail extends beyond its right-hand end.';

  // `all` is exact: every binned observation plus every overflowed one is the
  // whole run, so the shortfall is precisely the unplaceable share.
  if (outcome === 'all') return head;

  return (
    `${head} The payload does not record which outcome those responses had, so they are counted ` +
    'against this curve as well — the percentiles here understate slightly rather than claim ' +
    'coverage the data cannot support.'
  );
}

export function toPercentileDistribution(
  d: DistributionResponse,
  outcome: Outcome,
): ChartData {
  const columns = [PERCENTILE_COLUMN, labelColumn(d.exactValues), 'Requests at or below'];
  // Emitted in the empty branch too: "everything overflowed" is exactly the
  // case with no curve to draw AND the case where the reader most needs to
  // know why.
  const limitation =
    d.overflowCount > 0 ? overflowNote(d.overflowCount, outcome) : undefined;

  const counts = countsFor(d, outcome);

  /**
   * ═══ THE DENOMINATOR INCLUDES THE OVERFLOW ═══
   *
   * An observation above the histogram's cap is counted but lands in no bin.
   * Dividing by the BINNED total alone puts the last point at exactly 100%
   * however much overflowed — and a percentile curve that terminates at 100%
   * reads as "and this is the maximum", which is precisely what an overflowed
   * histogram cannot tell you. Prose beside a chart does not undo a claim the
   * chart draws.
   *
   * This is also the convention the histogram beside it already follows:
   * `distribution()` divides `okPercent` / `koPercent` by a total that
   * includes the overflow, so those two series deliberately sum to less than
   * 100 and `toDistribution`'s own note says so.
   *
   * FOR `all` THE ARITHMETIC IS EXACT — binned plus overflowed is the whole
   * run. For `ok` and `ko` it is not, because the payload does not say which
   * outcome the unplaceable observations had: `overflowCount` is one combined
   * figure. Counting all of it against each single-outcome curve makes those
   * percentiles a LOWER BOUND, which is the safe direction for a chart read
   * for its tail — it can understate coverage, never overstate it. Splitting
   * the overflow by the binned OK:KO ratio was the alternative and was
   * rejected: the observations that overflowed are the slowest in the run, and
   * assuming they failed in the same proportion as the fast ones is exactly
   * the assumption a tail chart exists to test.
   */
  const binned = counts.reduce((sum, n) => sum + n, 0);
  const total = binned + d.overflowCount;

  /**
   * THE EMPTY TEST IS ON `binned`, NOT ON `total`. With the overflow in the
   * denominator, a run whose observations ALL exceeded the cap has a non-zero
   * total and not one point to plot — testing `total` there would fall through
   * to the drawing branch and return a series with an empty `data`, which
   * renders as axes with nothing on them: the exact "measured, and found to be
   * nothing" reading this branch exists to prevent.
   */
  if (d.labels.length === 0 || binned <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Two different facts, told apart because a reader acts on them
      // differently: nothing was measured at all, versus this run genuinely
      // had none of what you asked to see. Neither is a flat line at zero,
      // which would read as "every response was instant".
      empty:
        d.labels.length === 0
          ? 'No response times were recorded for this run, so there is no distribution to show.'
          : `This run recorded ${NOTHING_RECORDED[outcome]}, so there is no curve to draw.`,
      limitation,
    };
  }

  let cumulative = 0;
  const points: [number, number][] = [];
  const rows: ChartTableRow[] = [];

  d.labels.forEach((label, i) => {
    const n = counts[i] ?? 0;
    // A BIN NOTHING LANDED IN ADDS NO POINT. Adding one would repeat the
    // previous percentile at a higher response time, drawing a horizontal run
    // that asserts observations at durations nothing was observed at — and on
    // a hundred-bin histogram of a fast run, most bins are empty, so the curve
    // would be mostly that.
    if (n === 0) return;
    cumulative += n;
    const percentile = (cumulative / total) * 100;
    points.push([percentile, label]);
    rows.push({ label: String(percentile), values: [label, cumulative] });
  });

  return {
    series: [{ name: SERIES_NAME[outcome], data: points }],
    // EMPTY ON PURPOSE. x is a measured quantity here, not a category, so each
    // point carries its own x — see `ChartSeries.data`'s pair form, and
    // `ChartXAxis.type`, which is what puts a value axis under it. Filling this
    // would index the points by position and space unevenly-spaced percentiles
    // evenly, straightening the curvature the chart exists to show.
    axisLabels: [],
    columns,
    rows,
    limitation,
  };
}
