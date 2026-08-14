import type { SeriesResponse } from '@perfportal/contracts';
import type { ChartData, ChartSeries, ChartTableRow } from '../types';

/**
 * The percentile bands, in the order Gatling draws them.
 *
 * EXACTLY TEN (design D-7). §13.2 ⑨ and §12.4's band selector both name
 * twelve, including a 98th and a 99.9th — neither exists. The statistics
 * engine emits `BUCKET_PERCENTILES = [25, 50, 75, 80, 85, 90, 95, 99]` per
 * bucket, and the real Gatling report draws `min, 25%, 50%, 75%, 80%, 85%,
 * 90%, 95%, 99%, max` and nothing else. The parity target is what the tool
 * draws, so this is the set.
 *
 * Exported so the tests import it rather than restating it: a change to the
 * band set must not be able to leave a stale copy asserting the old one.
 */
export const BANDS = [
  'min',
  'p25',
  'p50',
  'p75',
  'p80',
  'p85',
  'p90',
  'p95',
  'p99',
  'max',
] as const;

export type Band = (typeof BANDS)[number];

/** Human labels, matching the Gatling report's own series names. */
const BAND_LABEL: Record<Band, string> = {
  min: 'min',
  p25: '25%',
  p50: '50%',
  p75: '75%',
  p80: '80%',
  p85: '85%',
  p90: '90%',
  p95: '95%',
  p99: '99%',
  max: 'max',
};

/**
 * Did this bucket measure any OK response time?
 *
 * Keyed on `percentilesOk` being non-empty, and deliberately NOT on
 * `okCount`. Those are different edges: `okCount` counts requests that ENDED
 * OK in this second, while the percentile sketches are fed on the START edge
 * to match Gatling. They disagree, and the reference run contains the case —
 * the bucket at 63 s has `okCount: 1` and `startedOkCount: 0` with an empty
 * `percentilesOk`, because the request it counts started in the previous
 * second.
 *
 * Not keyed on `startedOkCount` either, which is the semantically right edge
 * but is nullable for runs ingested before the migration that added it. The
 * emptiness of the map we actually read cannot be null and cannot disagree
 * with itself.
 */
function measured(bucket: SeriesResponse['buckets'][number]): boolean {
  return Object.keys(bucket.percentilesOk).length > 0;
}

/**
 * One band's value in one bucket, or `null` where it was not measured.
 *
 * `null`, never `0`. Zero would draw the band plunging to the axis, which
 * reads as "every response was instant" rather than "nothing succeeded here"
 * — and `minMs` is literally `0` in the reference run's unmeasured bucket, so
 * this is the difference between a correct gap and a false floor.
 */
function bandValue(bucket: SeriesResponse['buckets'][number], band: Band): number | null {
  if (!measured(bucket)) return null;
  if (band === 'min') return bucket.minMs;
  if (band === 'max') return bucket.maxMs;
  return bucket.percentilesOk[band] ?? null;
}

/**
 * Response Time Percentiles over Time — §13.2 ⑨, Appendix A G-22.
 *
 * **OK-only.** `SeriesBucket` carries three percentile maps and this reads
 * `percentilesOk`, never `percentiles`. G-22 and RQ-05 both specify the OK
 * series alone, and the combined set is a different curve that looks entirely
 * reasonable — higher exactly where a reader expects response times to be
 * higher, with nothing on the rendered chart to reveal the substitution. In
 * the reference run the two are IDENTICAL at p95 and p99 (24 failures out of
 * 895 never move the 95th), so only the lower bands can even tell them apart.
 *
 * `bands` SELECTS WHAT IS DRAWN, AND ONLY WHAT IS DRAWN — §13.2 ⑨'s band
 * selector. Order always follows `BANDS`, never the caller's argument order, so
 * the legend cannot be reordered by how a selection happened to be built.
 *
 * **THE DATA TABLE ALWAYS CARRIES ALL TEN BANDS, whatever the selection.** The
 * two are genuinely different concerns and used to be one, which left the
 * parity surface carrying six of the ten D-7 requires:
 *
 *   - The drawing is narrowed because ten lines on one axis is more than a
 *     sighted reader can follow, and more than the six hues the categorical
 *     palette has. That is a legibility budget, and it is real.
 *   - `rows`/`columns` are the parity surface (design §7) and the screen-reader
 *     route to the same information. Neither has a legibility budget: a table
 *     column costs a reader nothing until they read it, and a screen-reader
 *     user is not the one who narrowed the drawing. Shrinking the table with
 *     the selection means a spec asserting parity against G-22 can only ever
 *     see whichever six bands a control happened to be left on — and that a
 *     reader who cannot see the chart loses four bands to a decision made about
 *     pixels.
 *
 * So `series` follows `selected`; `columns` and every row's `values` follow
 * `BANDS`. They are deliberately not the same list, and this is the one place
 * in the file where the table and the drawing legitimately disagree.
 */
export function toPercentiles(
  series: SeriesResponse,
  bands: readonly Band[] = BANDS,
): ChartData {
  const selected = BANDS.filter((b) => bands.includes(b));
  // ALL TEN. Not `selected` — see the docstring above.
  const columns = ['Elapsed (s)', ...BANDS.map((b) => BAND_LABEL[b])];

  if (series.buckets.length === 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      empty: 'No response times were recorded for this run.',
    };
  }

  const axisLabels = series.buckets.map((b) => b.startOffsetMs / 1000);

  const drawn: ChartSeries[] = selected.map((band) => ({
    name: BAND_LABEL[band],
    data: series.buckets.map((bucket) => bandValue(bucket, band)),
  }));

  const rows: ChartTableRow[] = series.buckets.map((bucket, i) => ({
    label: String(axisLabels[i]),
    values: BANDS.map((band) => bandValue(bucket, band) ?? '—'),
  }));

  const unmeasured = series.buckets.filter((b) => !measured(b)).length;

  // min and max are the bucket's COMBINED OK+KO extremes — the payload carries
  // no OK-only ones, only percentilesOk's p25…p99. Gatling's own min/max in
  // this chart are OK-only, so these two bands are a known deviation and are
  // said so rather than presented as OK-only alongside eight bands that are.
  const notes = ['min and max are the combined OK+KO extremes; the other bands are OK-only.'];
  if (unmeasured > 0) {
    notes.unshift(
      `${unmeasured} of ${series.buckets.length} seconds recorded no successful ` +
        'response, so those points are absent rather than zero.',
    );
  }

  return {
    series: drawn,
    axisLabels,
    columns,
    rows,
    /**
     * NOTHING SELECTED IS NOTHING TO DRAW, and design §11 forbids drawing
     * empty axes for it.
     *
     * `empty` was set only from `series.buckets.length`, a fact about the
     * PAYLOAD — so deselecting every band returned 62 axis labels, 62 rows and
     * zero series, and `Chart` dutifully initialised ECharts and drew a
     * labelled grid with no marks. That is the picture that says "we measured
     * this second, and there was nothing in it", for a chart whose data is
     * entirely intact and merely unselected.
     *
     * The message names the remedy, because unlike every other empty state in
     * this file the reader is one click from fixing it — and the rows above are
     * still returned in full, so the table goes on carrying all ten bands while
     * the drawing is switched off.
     */
    empty:
      selected.length === 0
        ? 'No percentile bands are selected, so there is nothing to draw. Choose at least one band above.'
        : undefined,
    limitation: notes.join(' '),
  };
}
