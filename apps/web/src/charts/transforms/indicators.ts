import type { StatsResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartTableRow } from '../types';

/**
 * `GET /v1/runs/:id/stats` → the two charts §13.2 draws from it: the indicator
 * bands ③ (Appendix A G-06…G-09) and the OK-vs-KO request-count donut ④ (G-10).
 *
 * Pure data in, pure data out. No React, no ECharts, nothing that needs a DOM —
 * which is what lets every number below be asserted in the node environment
 * against the captured payload fixture.
 */

/* ------------------------------------------------------------------ *
 * ③ the indicator bands
 * ------------------------------------------------------------------ */

/**
 * A band's colour ROLE, and why the bands do not use the categorical palette.
 *
 * The four bands are states, not identities: `t < lowerMs` is *better* than
 * `t >= higherMs`, and `failed` is not merely a fifth kind of thing. Okabe–Ito's
 * six hues are deliberately meaningless — that is their virtue for series — so
 * spending them here would say "these are four different bands" when what the
 * reader needs is "these are four bands, and they get worse left to right".
 * Design §11 and the plan both say status tokens; this is that, typed.
 *
 * THE MAPPING IS NOT THE OBVIOUS ONE, AND THE REASON MATTERS. There are four
 * bands and exactly four `--color-status-*` tokens, but only three of them form
 * a severity ramp (passed → pending → failed); the fourth,
 * `--color-status-not-applicable`, is a neutral grey. Something has to take it.
 *
 *   - `failed` takes `failed`. Red means "this request did not succeed"
 *     everywhere else in this app (`routes/marks.tsx`: the run status, the run
 *     verdict, every SLA assertion outcome), and the donut ④ sitting beside
 *     this chart paints the very same 24 requests in the very same red. Giving
 *     the red to `t >= higherMs` instead would put one fact in two colours a
 *     few inches apart on one page.
 *   - So `t >= higherMs` — slow, but it *answered* — takes the neutral. It
 *     understates the band, and that is a real cost, honestly the wrong
 *     trade-off in isolation. Gatling's own report has a fourth warm colour
 *     (orange) for exactly this band and we do not; adding a fifth status token
 *     is a design-system decision, not a chart decision, and inventing an
 *     orange by eye is precisely what `palette.test.ts` exists to stop. The
 *     band's threshold is in its label, so the meaning is present; only the
 *     emphasis is missing. Recorded in the Task 5 report as the open item.
 */
interface BandSpec {
  readonly key: keyof StatsResponse['indicators'];
  readonly role: StatusRole;
  /** Built from the payload's bounds. NEVER from a constant — see `toIndicators`. */
  readonly label: (bounds: StatsResponse['bounds']) => string;
}

const BANDS: readonly BandSpec[] = [
  { key: 'under', role: 'passed', label: (b) => `t < ${b.lowerMs} ms` },
  { key: 'between', role: 'pending', label: (b) => `${b.lowerMs} ms <= t < ${b.higherMs} ms` },
  { key: 'over', role: 'neutral', label: (b) => `t >= ${b.higherMs} ms` },
  { key: 'failed', role: 'failed', label: () => 'failed' },
];

/**
 * The band colours, in band order — handed to `<Chart statusRoles={…}/>`, which
 * assigns them to series BY INDEX.
 *
 * That index alignment is the whole contract between this module and the
 * component, so `toIndicators` builds its series from the same `BANDS` array in
 * the same order, and a test asserts `series[i].name === rows[i].label`.
 *
 * A module-level constant rather than a fresh array at the call site: it lands
 * in a `useEffect` dependency list, and a new array every render would re-issue
 * `setOption` on every render.
 */
export const BAND_ROLES: readonly StatusRole[] = BANDS.map((band) => band.role);

const BAND_COLUMNS = ['Band', 'Count', 'Percent'] as const;

/** The stacked bar's single category. Every band is a segment of this one bar. */
const ALL_REQUESTS = 'All requests';

/**
 * One decimal place, with the sign, because the column is read as text by a
 * screen reader and by the parity specs alike and `2.7` alone in a cell is
 * ambiguous about its units.
 */
function percent(count: number, total: number): string {
  return `${((count / total) * 100).toFixed(1)}%`;
}

/**
 * The four bands, as a stacked bar of one category plus a count and a
 * percentage per band.
 *
 * **The thresholds come from `stats.bounds`, never from a constant.** They are
 * a per-project setting the API reports alongside the folded counts precisely
 * so a client never has to guess (`StatsResponseSchema`'s own comment). A UI
 * that types `800` into the label is correct for every project that has not
 * changed the default and silently, plausibly wrong for every project that has
 * — the counts would move and the labels would not, and nothing on the chart
 * would look broken. This is the design's falsification checkpoint #5.
 *
 * FOUR SERIES OF ONE VALUE, not one series of four. Colour is assigned per
 * series, so this is what lets each band carry its own status colour; it is
 * also why `Chart` grew `stacked`.
 *
 * The percentage denominator is the sum of the four bands, not the run row's
 * `count`. The bands are a partition of the requests by construction, so the
 * two agree — but reading the response's own `indicators` for both the parts
 * and the whole keeps this transform independent of `stats.stats` entirely, and
 * makes the four percentages sum to 100 by construction rather than by luck.
 */
export function toIndicators(stats: StatsResponse): ChartData {
  const counts = BANDS.map((band) => stats.indicators[band.key]);
  const labels = BANDS.map((band) => band.label(stats.bounds));
  const total = counts.reduce((sum, count) => sum + count, 0);

  /**
   * Design §10: a run ingested before the parity migration has no stored
   * histogram, so its bands were folded once at whatever the bounds were then
   * and will not move if the bounds change. Render them, say they are fixed,
   * and do not offer a control that would do nothing — there is no bounds
   * control in this sub-project, so the caveat is the entire deliverable, and
   * it has to name the numbers or "fixed" tells the reader nothing actionable.
   */
  const limitation = stats.configurable
    ? undefined
    : `These bands are fixed at ${stats.bounds.lowerMs} ms and ${stats.bounds.higherMs} ms. ` +
      'This run was recorded before response times were stored as a histogram, so its bands ' +
      'were folded once and will not change if the project’s indicator bounds change.';

  if (total <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns: [...BAND_COLUMNS],
      rows: [],
      // Not four zero-height segments: an empty bar reads as "we measured, and
      // it was fine". `0 / 0` would also format as `NaN%` in every cell.
      empty: 'No requests were recorded for this run, so there are no response-time bands to show.',
      limitation,
    };
  }

  const rows: ChartTableRow[] = labels.map((label, i) => ({
    label,
    values: [counts[i]!, percent(counts[i]!, total)],
  }));

  return {
    series: labels.map((name, i) => ({ name, data: [counts[i]!] })),
    axisLabels: [ALL_REQUESTS],
    columns: [...BAND_COLUMNS],
    rows,
    limitation,
  };
}

/* ------------------------------------------------------------------ *
 * ④ the request-count donut
 * ------------------------------------------------------------------ */

/**
 * OK and KO, in slice order.
 *
 * For a pie, `Chart` hands this list to ECharts as the top-level colour list,
 * which a single-series pie consumes PER SLICE — so this aligns with
 * `axisLabels`, where the bands' `BAND_ROLES` aligns with `series`. Both are
 * "the order marks are drawn in"; they differ only because a pie's marks are
 * its data points and a bar's are its series.
 */
export const OUTCOME_ROLES: readonly StatusRole[] = ['passed', 'failed'];

const OUTCOME_COLUMNS = ['Outcome', 'Count', 'Percent'] as const;

/**
 * OK vs KO for the run as a whole, with totals (G-10).
 *
 * THE RUN-SCOPE ROW, and only it. `/stats` is fetched unfiltered because both
 * charts need the whole response, so `stats.stats` here holds fourteen rows
 * across four scopes — the first of which, on the reference run, is a *group*.
 * Reading `stats.stats[0]`, or summing the `request` rows, yields a donut that
 * looks entirely reasonable and is about the wrong subset of the traffic.
 *
 * `family: 'response_time'` as well as `scope: 'run'`: the run can also carry
 * group families, and `latency` is explicitly not rendered anywhere in this
 * sub-project (design §1 — Gatling 3.15.1.2 reports none).
 *
 * The denominator is `okCount + koCount`, not `count`. They are equal by
 * construction, but the two slices are what the percentages describe, so
 * dividing by their own sum is what makes them sum to 100.
 */
export function toRequestCounts(stats: StatsResponse): ChartData {
  const run = stats.stats.find((row) => row.scope === 'run' && row.family === 'response_time');
  const total = run === undefined ? 0 : run.okCount + run.koCount;

  if (run === undefined || total <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns: [...OUTCOME_COLUMNS],
      rows: [],
      empty:
        run === undefined
          ? 'This run has no request statistics, so there is nothing to count.'
          : 'This run recorded no requests.',
    };
  }

  return {
    series: [{ name: 'Requests', data: [run.okCount, run.koCount] }],
    axisLabels: ['OK', 'KO'],
    columns: [...OUTCOME_COLUMNS],
    rows: [
      { label: 'OK', values: [run.okCount, percent(run.okCount, total)] },
      { label: 'KO', values: [run.koCount, percent(run.koCount, total)] },
      // A third ROW but not a third slice: G-10 asks for the totals and a
      // total slice would double the ring. The data table is the parity
      // surface, so the total belongs there.
      { label: 'Total', values: [total, percent(total, total)] },
    ],
  };
}
