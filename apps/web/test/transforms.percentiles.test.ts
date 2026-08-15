import type { SeriesResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { BANDS, toPercentiles } from '../src/charts/transforms/percentiles';
import fixture from './fixtures/reference-run.json';

const series = fixture.series as unknown as SeriesResponse;

/** The rendered label for a band key, as the transform names its series. */
const LABEL: Record<string, string> = {
  min: 'min', p25: '25%', p50: '50%', p75: '75%', p80: '80%',
  p85: '85%', p90: '90%', p95: '95%', p99: '99%', max: 'max',
};

describe('toPercentiles — the band set (D-7)', () => {
  it('draws exactly the ten bands Gatling draws', () => {
    const d = toPercentiles(series);
    expect(d.series.map((s) => s.name)).toEqual(BANDS.map((b) => LABEL[b]));
    // The PRD names a 98th and a 99.9th. Neither is emitted by the engine and
    // neither appears in the real report.
    expect(d.series.map((s) => s.name)).not.toContain('98%');
    expect(d.series.map((s) => s.name)).not.toContain('99.9%');
  });

  it('carries real data in every band, not just the right names', () => {
    // The name assertion above passes against a transform that produces ten
    // correctly-named series of nulls. This is what makes it mean something.
    const d = toPercentiles(series);
    for (const s of d.series) {
      const values = s.data as readonly (number | null)[];
      expect(values).toHaveLength(series.buckets.length);
      expect(values.filter((v) => typeof v === 'number').length).toBeGreaterThan(50);
    }
  });

  it('orders bands by BANDS, not by the caller`s argument order', () => {
    const d = toPercentiles(series, ['p95', 'min', 'p50']);
    expect(d.series.map((s) => s.name)).toEqual(['min', '50%', '95%']);
  });
});

describe('toPercentiles — OK-only (G-22)', () => {
  // MEASURED against this fixture, and the reason this suite asserts on p50:
  // percentilesOk and percentiles are IDENTICAL in all 62 buckets at p95 and
  // p99 — 24 KO out of 895 requests never move the 95th — so an assertion on
  // p95 passes just as happily against the combined set, and the falsification
  // checkpoint would stay green with the bug present.
  //   p25: 3   p50: 8   p75: 3   p80: 3   p85: 1   p90: 1   p95: 0   p99: 0
  const disagreeing = series.buckets.filter(
    (b) => b.percentilesOk.p50 !== b.percentiles.p50,
  );

  it('has buckets where OK-only and combined actually disagree', () => {
    // The precondition the test below depends on. If the fixture is ever
    // recaptured from a run without failures, this says so rather than
    // letting the assertion underneath go quietly vacuous.
    expect(disagreeing.length).toBeGreaterThan(0);
  });

  it('reads percentilesOk, never the combined set', () => {
    const d = toPercentiles(series);
    const p50 = d.series.find((s) => s.name === '50%')!.data;
    expect(p50).toEqual(series.buckets.map((b) => b.percentilesOk.p50 ?? null));
    expect(p50).not.toEqual(series.buckets.map((b) => b.percentiles.p50 ?? null));
  });

  it('is indifferent to the KO set entirely', () => {
    const koified = {
      ...series,
      buckets: series.buckets.map((b) => ({ ...b, percentilesKo: { p50: 99_999 } })),
    };
    expect(toPercentiles(koified).series).toEqual(toPercentiles(series).series);
  });
});

describe('toPercentiles — a second with no successful response', () => {
  // The reference run has exactly one such bucket, so this is real data and
  // not a synthetic edge case.
  const blank = series.buckets.findIndex((b) => Object.keys(b.percentilesOk).length === 0);

  it('the fixture actually contains one, and it is an END-vs-START-edge case', () => {
    expect(blank).toBeGreaterThanOrEqual(0);
    const b = series.buckets[blank]!;
    expect(Object.keys(b.percentilesOk)).toHaveLength(0);
    // The trap this test exists for: okCount is the END-edge count and is
    // NON-ZERO here, so gating on it would treat this bucket as measured and
    // plot minMs — which is 0 — as a real value.
    expect(b.okCount).toBeGreaterThan(0);
    expect(b.startedOkCount).toBe(0);
    expect(b.minMs).toBe(0);
  });

  it('leaves the point absent rather than plotting zero', () => {
    const d = toPercentiles(series);
    for (const s of d.series) {
      // Zero would draw every band plunging to the axis for that second,
      // which reads as "every response was instant" rather than "nothing
      // succeeded here".
      expect((s.data as readonly (number | null)[])[blank]).toBeNull();
    }
  });

  it('says so, rather than letting the gap pass without comment', () => {
    expect(toPercentiles(series).limitation).toMatch(/absent rather than zero/i);
  });

  it('drops the absent-points note when every second measured something', () => {
    const full = {
      ...series,
      buckets: series.buckets.filter((b) => Object.keys(b.percentilesOk).length > 0),
    };
    expect(toPercentiles(full).limitation).not.toMatch(/absent rather than zero/i);
  });

  it('always says min and max are the combined extremes, not OK-only', () => {
    // Eight of the ten bands are OK-only and two are not; presenting them as
    // one set without saying so is the quiet kind of parity error.
    expect(toPercentiles(series).limitation).toMatch(/combined OK\+KO extremes/i);
  });
});

describe('toPercentiles — the data table', () => {
  it('carries one row per bucket, headed by elapsed seconds', () => {
    const d = toPercentiles(series);
    expect(d.rows).toHaveLength(series.buckets.length);
    expect(d.columns[0]).toBe('Elapsed (s)');
    expect(d.columns).toHaveLength(BANDS.length + 1);
    expect(d.rows[0]!.label).toBe(String(series.buckets[0]!.startOffsetMs / 1000));
  });

  it('shows the same values it plots, band by band', () => {
    const d = toPercentiles(series);
    const bucket = series.buckets[0]!;
    expect(d.rows[0]!.values).toEqual([
      bucket.minMs,
      bucket.percentilesOk.p25,
      bucket.percentilesOk.p50,
      bucket.percentilesOk.p75,
      bucket.percentilesOk.p80,
      bucket.percentilesOk.p85,
      bucket.percentilesOk.p90,
      bucket.percentilesOk.p95,
      bucket.percentilesOk.p99,
      bucket.maxMs,
    ]);
  });

  /**
   * THE TABLE DOES NOT SHRINK WITH THE SELECTION, and this is the assertion
   * that says so.
   *
   * `rows`/`columns` used to follow `bands`, so the default six-band selection
   * left the parity surface carrying six of the ten D-7 requires — and a
   * screen-reader user, who did not narrow anything, lost four bands to a
   * decision made about how many lines fit legibly on one axis.
   */
  it('carries all ten bands however few are drawn', () => {
    const d = toPercentiles(series, ['p50']);

    expect(d.series.map((s) => s.name)).toEqual(['50%']);
    expect(d.columns).toEqual(['Elapsed (s)', ...BANDS.map((b) => LABEL[b])]);
    for (const row of d.rows) {
      expect(row.values).toHaveLength(BANDS.length);
    }

    // And the numbers are the same numbers, not merely the right count of
    // columns: narrowing the drawing must not shift which band a column holds.
    expect(d.rows.map((r) => r.values)).toEqual(toPercentiles(series).rows.map((r) => r.values));
  });
});

describe('toPercentiles — nothing to draw', () => {
  it('explains itself instead of rendering empty axes', () => {
    const d = toPercentiles({ ...series, buckets: [] });
    expect(d.series).toHaveLength(0);
    expect(d.empty).toMatch(/no response times/i);
  });

  /**
   * Design §11 forbids drawing empty axes, and `empty` used to be set only
   * from `series.buckets.length` — a fact about the PAYLOAD. Deselecting every
   * band therefore returned a full axis, a full table and zero series, and the
   * chart drew a labelled grid with no marks: the picture that says "this was
   * measured and there was nothing here", for data that is entirely intact.
   */
  it('says the selection is empty rather than drawing a grid with no marks', () => {
    const d = toPercentiles(series, []);

    expect(d.series).toHaveLength(0);
    expect(d.empty).toBeDefined();
    // Names the remedy: unlike every other empty state here, the reader is one
    // click from fixing it.
    expect(d.empty).toMatch(/no percentile bands are selected/i);
    expect(d.empty).toMatch(/choose at least one band/i);
  });

  it('keeps the whole table while the drawing is switched off', () => {
    // The selection governs the DRAWING. Turning it off must not also take
    // away the parity surface and the screen-reader route to the data.
    const d = toPercentiles(series, []);
    expect(d.rows).toHaveLength(series.buckets.length);
    expect(d.columns).toHaveLength(BANDS.length + 1);
  });

  it('is not empty while any band is selected', () => {
    // The other side of the guard: it must key on the SELECTION being empty,
    // not merely on it being smaller than BANDS.
    expect(toPercentiles(series, ['min']).empty).toBeUndefined();
    expect(toPercentiles(series).empty).toBeUndefined();
  });
});

/**
 * THE OUTCOME SELECTOR — the three-way OK / KO / all control Gatling puts on
 * this figure.
 *
 * `'ok'` is the DEFAULT and is what G-22 / RQ-05 specify, so the chart a
 * reader already knows does not move under them. The other two exist because
 * `percentilesKo` has been in the payload since the parity migration and
 * nothing in the web app read it.
 *
 * The interesting case is the emptiness rule. It was keyed on `percentilesOk`
 * being non-empty for reasons about the START edge that hold equally for all
 * three maps — left pinned to the OK map, a KO series would draw as a
 * continuous line across seconds that recorded no failure at all.
 */
describe('toPercentiles — outcome selection', () => {
  it('defaults to OK, so existing callers are unchanged', () => {
    expect(toPercentiles(series)).toEqual(toPercentiles(series, BANDS, 'ok'));
  });

  it('reads percentilesKo when KO is selected', () => {
    const i = series.buckets.findIndex((b) => Object.keys(b.percentilesKo).length > 0);
    expect(i).toBeGreaterThanOrEqual(0); // the fixture must contain failures

    const drawn = toPercentiles(series, ['p95'], 'ko').series[0]!.data as readonly (
      | number
      | null
    )[];
    expect(drawn[i]).toBe(series.buckets[i]!.percentilesKo.p95);
  });

  it('leaves a bucket with no KO as a gap, not a zero', () => {
    const i = series.buckets.findIndex((b) => Object.keys(b.percentilesKo).length === 0);
    expect(i).toBeGreaterThanOrEqual(0);

    const drawn = toPercentiles(series, ['p95'], 'ko').series[0]!.data as readonly (
      | number
      | null
    )[];
    expect(drawn[i]).toBeNull();
  });

  it('does not simply reuse the OK gaps for KO', () => {
    // The regression this whole task guards: a bucket that measured a success
    // and no failure must be a POINT on the OK series and a GAP on the KO one.
    const i = series.buckets.findIndex(
      (b) => Object.keys(b.percentilesOk).length > 0 && Object.keys(b.percentilesKo).length === 0,
    );
    expect(i).toBeGreaterThanOrEqual(0);

    const ok = toPercentiles(series, ['p95'], 'ok').series[0]!.data as readonly (number | null)[];
    const ko = toPercentiles(series, ['p95'], 'ko').series[0]!.data as readonly (number | null)[];
    expect(ok[i]).not.toBeNull();
    expect(ko[i]).toBeNull();
  });

  it('reads the combined map when all is selected', () => {
    const i = series.buckets.findIndex((b) => Object.keys(b.percentiles).length > 0);
    const drawn = toPercentiles(series, ['p95'], 'all').series[0]!.data as readonly (
      | number
      | null
    )[];
    expect(drawn[i]).toBe(series.buckets[i]!.percentiles.p95);
  });

  it('names the selected outcome in the deviation note', () => {
    expect(toPercentiles(series, BANDS, 'ok').limitation).toContain('OK-only');
    expect(toPercentiles(series, BANDS, 'ko').limitation).toContain('KO-only');
    expect(toPercentiles(series, BANDS, 'all').limitation).not.toContain('-only');
  });

  it('counts unmeasured seconds against the SELECTED outcome', () => {
    // Derived from the payload, never written down: the two counts differ
    // because most seconds of a healthy run record no failure.
    const okGaps = series.buckets.filter((b) => Object.keys(b.percentilesOk).length === 0).length;
    const koGaps = series.buckets.filter((b) => Object.keys(b.percentilesKo).length === 0).length;
    expect(koGaps).not.toBe(okGaps);

    expect(toPercentiles(series, BANDS, 'ko').limitation).toContain(String(koGaps));
  });

  it('still carries all ten bands in the table whatever the outcome', () => {
    // The drawing has a legibility budget; the parity surface does not.
    const d = toPercentiles(series, ['p95'], 'ko');
    expect(d.columns).toHaveLength(BANDS.length + 1);
    expect(d.rows).toHaveLength(series.buckets.length);
  });
});

/**
 * MIN AND MAX ARE NOT SPLIT BY OUTCOME, AND THE KO VIEW MUST NOT PRETEND THEY
 * ARE.
 *
 * `SeriesBucket` carries three percentile maps, and every one of them holds
 * `p25`…`p99` — NOT `min` and `max`. Those two bands are read off
 * `bucket.minMs` / `bucket.maxMs`, which are the bucket's COMBINED OK+KO
 * extremes and the only extrema the payload has.
 *
 * On the OK view of a mostly-successful run that is a small, disclosed
 * approximation, and it is what shipped. On the KO view it is not small: in
 * the reference run's first bucket with failures, the combined minimum is
 * 21 ms while the 25th percentile of the KO responses is 141 ms — so a drawn
 * "KO min" would sit almost seven times below the lowest KO band and plunge
 * the series to the axis.
 *
 * A KO minimum was never measured, so it is not drawn. Same rule as a bucket
 * with no failures: absent, not zero, not somebody else's number.
 */
describe('toPercentiles — min and max under outcome selection', () => {
  const withKo = series.buckets.findIndex((b) => Object.keys(b.percentilesKo).length > 0);

  it('omits min and max on the KO view, because the payload has no KO extrema', () => {
    const d = toPercentiles(series, ['min', 'max'], 'ko');
    for (const drawn of d.series) {
      expect(drawn.data.every((value) => value === null)).toBe(true);
    }
  });

  it('would otherwise have drawn a KO min far below the lowest KO band', () => {
    // The defect, stated as arithmetic so it cannot quietly come back.
    const bucket = series.buckets[withKo]!;
    expect(bucket.minMs).toBeLessThan(bucket.percentilesKo.p25!);
  });

  it('renders those cells as dashes in the table rather than a borrowed number', () => {
    const d = toPercentiles(series, ['min', 'max'], 'ko');
    const minColumn = BANDS.indexOf('min');
    const maxColumn = BANDS.indexOf('max');
    expect(d.rows[withKo]!.values[minColumn]).toBe('—');
    expect(d.rows[withKo]!.values[maxColumn]).toBe('—');
  });

  it('keeps them on the All view, where the combined extrema are exactly right', () => {
    const d = toPercentiles(series, ['min', 'max'], 'all');
    const drawn = d.series[0]!.data as readonly (number | null)[];
    expect(drawn[withKo]).toBe(series.buckets[withKo]!.minMs);
  });

  it('keeps them on the OK view, which is what shipped and is disclosed', () => {
    // Unchanged deliberately: `DEFAULT_BANDS` draws min and max, this is the
    // default view, and G-22 parity was established against it. The same
    // approximation applies and the note names it.
    const d = toPercentiles(series, ['min'], 'ok');
    const drawn = d.series[0]!.data as readonly (number | null)[];
    expect(drawn[withKo]).toBe(series.buckets[withKo]!.minMs);
  });

  it('says which bands the KO view is actually showing', () => {
    expect(toPercentiles(series, BANDS, 'ko').limitation).toContain('min and max are not shown');
  });
});
