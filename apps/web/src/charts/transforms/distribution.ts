import type { DistributionResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartTableRow } from '../types';

/**
 * `GET /v1/runs/:id/distribution` → §13.2 ⑧, the response-time distribution
 * (Appendix A G-20/G-21).
 *
 * Pure data in, pure data out — no React, no ECharts, nothing that needs a DOM
 * — so every number below is asserted in the node environment against the
 * captured payload fixture.
 *
 * WHAT IS PLOTTED IS PERCENTAGES, NOT COUNTS. Appendix A §A.9 F-8: what Gatling
 * *displays* per bin is a percentage of the COMBINED OK+KO count to 2 dp, and
 * the parity tolerance for G-20/G-21 is written against exactly that ("bin
 * labels exact; percent of combined OK+KO exact to 2dp — never raw counts").
 * The counts are carried too, in their own table columns, because the platform
 * additionally holds them exactly (AC-PARITY-2) and "223 requests" is a more
 * useful thing for a screen reader to read out than "24.9".
 *
 * THE PERCENTAGES ARE THE API'S AND ARE NEVER RESCALED. `okPercent` and
 * `koPercent` are both shares of the combined total, so the two series TOGETHER
 * sum to 100 — on the reference run, 97.32 + 2.68. Dividing either one by its
 * own sum would make each series sum to 100 separately, which is a different
 * and wrong claim: it would redraw a 2.7%-of-traffic failure distribution at
 * the same height as the 97.3% success one, so a run with a handful of
 * failures would show a KO histogram as tall as its OK histogram. The
 * arithmetic is `distribution()`'s (`packages/statistics/src/distribution.ts`),
 * which divides both series by `ok.total + ko.total`.
 */

/**
 * OK and KO, in SERIES order.
 *
 * The app-wide status colours, not the categorical palette: these two marks
 * mean "succeeded" and "did not succeed", which is the same claim the donut ④
 * makes about the very same requests, and red has to mean there what it means
 * here. See `MarkRole` in `theme.ts`.
 *
 * Declared here rather than reusing `indicators.ts`'s `OUTCOME_ROLES` even
 * though the two arrays are identical: that one is consumed PER SLICE by a
 * single-series pie and is aligned with its `axisLabels`, this one is consumed
 * PER SERIES by a bar chart and is aligned with `series`. Same colours, two
 * different alignment contracts — see `ChartProps.roles`.
 *
 * A module-level constant rather than a fresh array at the call site: it lands
 * in a `useEffect` dependency list.
 */
export const DISTRIBUTION_ROLES: readonly StatusRole[] = ['passed', 'failed'];

/** The two series' names, and G-20/G-21's own. */
const OK = 'OK';
const KO = 'KO';

/**
 * The value columns of the data table, in row-`values` order. See
 * `ChartTableRow`: `columns[0]` heads the label column and is built separately
 * by `labelColumn`, because what the label MEANS depends on the payload.
 *
 * The percent columns say "of all requests" because that is the one thing
 * about this chart a reader can get wrong on their own: a column headed "OK %"
 * beside a column headed "KO %" invites reading each as a share of its own
 * series, which is precisely what these numbers are not.
 */
const VALUE_COLUMNS = [
  'OK (% of all requests)',
  'KO (% of all requests)',
  'OK requests',
  'KO requests',
] as const;

/**
 * The label column's header — which `DistributionChart` also hands to the
 * drawn chart as its category-axis name, so the two cannot drift.
 *
 * IT NAMES WHICH KIND OF NUMBER THE LABELS ARE, and that is not decoration.
 * The labels are normally bin MIDPOINTS: `floor(min + step·i + step/2 + 0.5)`
 * with `step = (max−min)/100` (§A.9 F-8), so the reference run's first label,
 * 28, is the centre of a 25 ms bin and NOT the run's minimum, which is 16. But
 * when the observed range is narrow enough that Gatling skips bucketing
 * entirely — `exactValues`, one plot per distinct observation — a label is an
 * exact millisecond value that some request actually took.
 *
 * Those are different quantities carried in the same array, and nothing else
 * on the chart distinguishes them: both render as a bare number under a bar. A
 * reader who takes a midpoint for an observation concludes the fastest request
 * took 28 ms when it took 16.
 */
function labelColumn(exactValues: boolean): string {
  return exactValues
    ? 'Response time (ms, exact value)'
    : 'Response time (ms, bin midpoint)';
}

function total(counts: readonly number[]): number {
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * Said in prose, because the alternative is drawing a truncated distribution
 * and letting it look complete.
 *
 * An observation above the histogram's cap is counted in the DENOMINATOR the
 * percentages are taken over (`Histogram#total`, and so `distribution()`'s
 * `size`) but lands in no bin (`Histogram#accept` returns before touching
 * `#bins`). Two consequences the reader cannot see and both have to be told:
 * the percentages here add up to less than 100, and the top of the range is
 * drawn as if nothing happened there. The cap itself is not named — it is a
 * server constant the payload does not carry, and inventing "120 seconds" here
 * would be a claim this module cannot support.
 */
function overflowNote(count: number): string {
  const times = count === 1 ? 'response time' : 'response times';
  return (
    `${count} ${times} exceeded the range this histogram records, so they are counted in the ` +
    'totals below but fall into no bin. The bins at the top of this distribution are therefore ' +
    'incomplete, and these percentages add up to less than 100.'
  );
}

/**
 * ⑧ — the response-time histogram, OK and KO as distinct series (G-20/G-21).
 *
 * KO IS ALWAYS A SERIES, including on a run that recorded no failures at all,
 * where it is a flat zero line. That is not the mistake `startedSplitAvailable`
 * guards against on the requests/s chart (design §9 checkpoint 7): there a zero
 * KO series would mean "not recorded" while reading as "no failures", whereas
 * here the split is always present in the payload and zero genuinely means zero.
 * Dropping the series when it happens to be empty is the design's falsification
 * checkpoint #4, and it would make "this run had no failures" and "this chart
 * forgot to draw failures" the same picture.
 */
export function toDistribution(d: DistributionResponse): ChartData {
  const columns = [labelColumn(d.exactValues), ...VALUE_COLUMNS];
  // Emitted in the empty branch too: "everything overflowed" is exactly the
  // case where there are no bins to draw AND the reader most needs to know why.
  const limitation = d.overflowCount > 0 ? overflowNote(d.overflowCount) : undefined;

  const binned = total(d.okCount) + total(d.koCount);

  if (d.labels.length === 0 || binned <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Not a hundred zero-height bars, which read as "we measured, and every
      // request took no time at all". The two cases are told apart because a
      // reader acts on them differently: nothing to report, versus a run whose
      // observations all landed outside the recorded range.
      empty:
        d.labels.length === 0
          ? 'No response times were recorded for this run, so there is no distribution to show.'
          : 'No response time in this run fell inside the recorded range, so there are no bins to draw.',
      limitation,
    };
  }

  // Indexed off `labels` rather than mapped over each array in turn, so the
  // series, the axis and the table are all exactly as long as the label set
  // even if a payload's arrays ever disagreed. `?? 0` is what satisfies
  // `noUncheckedIndexedAccess`; the schema makes the five arrays parallel.
  const bins = d.labels.map((label, i) => ({
    label,
    okPercent: d.okPercent[i] ?? 0,
    koPercent: d.koPercent[i] ?? 0,
    okCount: d.okCount[i] ?? 0,
    koCount: d.koCount[i] ?? 0,
  }));

  const rows: ChartTableRow[] = bins.map((bin) => ({
    label: String(bin.label),
    /**
     * THE PERCENTAGES GO IN UNROUNDED, and the parity tolerance is the reason
     * rather than an oversight. G-20/G-21 are compared "exact to 2 dp" — a
     * comparison rule, not a rendering one. A spec that wants Gatling's
     * two-decimal string can round these; it cannot recover precision this
     * transform threw away. The exact underlying integers are the two columns
     * beside them.
     */
    values: [bin.okPercent, bin.koPercent, bin.okCount, bin.koCount],
  }));

  return {
    series: [
      { name: OK, data: bins.map((bin) => bin.okPercent) },
      { name: KO, data: bins.map((bin) => bin.koPercent) },
    ],
    // The labels themselves, as numbers and in payload order. They are the
    // parity surface for "bin labels exact" (G-20/G-21) and renumbering them
    // 1…100 — or plotting the bin INDEX, which a histogram invites — would lose
    // the one quantity that tolerance names.
    axisLabels: [...d.labels],
    columns,
    rows,
    limitation,
  };
}
