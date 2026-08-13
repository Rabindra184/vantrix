import type { DistributionResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { DISTRIBUTION_ROLES, toDistribution } from '../src/charts/transforms/distribution.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑧ the response-time distribution (Appendix A G-20/G-21), folded out of
 * `GET /v1/runs/:id/distribution`.
 *
 * Read against `fixtures/reference-run.json`, the payload captured from the
 * live API for the real Gatling reference run — the same bytes the browser
 * receives.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. Two of the brief's three example tests pass
 * against transforms that are wrong in ways this chart is specifically prone
 * to, and the fixture is what makes that measurable rather than a suspicion.
 * Both are kept verbatim — they pin real properties — and each is immediately
 * followed by the assertion that can actually fail. See "the brief's tests,
 * measured" below.
 */

const src = fixture.distribution as DistributionResponse;

/** The reference payload with one field moved; every variant below is one of these. */
const withFields = (fields: Partial<DistributionResponse>): DistributionResponse => ({
  ...src,
  ...fields,
});

const zeros = (n: number): number[] => new Array<number>(n).fill(0);

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** `ChartSeries.data` is a union; these charts are all plain value series. */
const dataOf = (d: ReturnType<typeof toDistribution>, i: number): readonly number[] =>
  d.series[i]!.data as readonly number[];

/** Column indices into `ChartTableRow.values` — `columns[0]` heads the labels. */
const OK_PERCENT = 0;
const KO_PERCENT = 1;
const OK_COUNT = 2;
const KO_COUNT = 3;

/* ------------------------------------------------------------------ *
 * what the fixture actually contains
 * ------------------------------------------------------------------ */

/**
 * Measured before any test was trusted. Every discriminating assertion below
 * depends on one of these being true of the payload, so they are pinned here:
 * a future re-capture against a run that lacks the property fails HERE, with
 * the explanation attached, rather than silently turning a test elsewhere into
 * a tautology.
 */
describe('the reference payload', () => {
  it('is a hundred bucketed bins with nothing overflowed', () => {
    expect(src.labels).toHaveLength(100);
    expect(src.exactValues).toBe(false);
    expect(src.overflowCount).toBe(0);
    for (const array of [src.okCount, src.koCount, src.okPercent, src.koPercent]) {
      expect(array).toHaveLength(src.labels.length);
    }
  });

  it('carries percentages of the COMBINED total — neither series sums to 100 alone', () => {
    expect(sum(src.okPercent)).toBeCloseTo(97.318, 3);
    expect(sum(src.koPercent)).toBeCloseTo(2.682, 3);
    expect(sum(src.okPercent) + sum(src.koPercent)).toBeCloseTo(100, 6);
    // 871 OK and 24 KO over 895 requests. The KO share is small, which is what
    // makes independent renormalisation such a plausible-looking mistake: it
    // would redraw those 24 failures at the same height as the 871 successes.
    expect(sum(src.okCount)).toBe(871);
    expect(sum(src.koCount)).toBe(24);
  });

  it('has bins where OK and KO differ, so a swap of the two is detectable', () => {
    const differing = src.labels.filter((_, i) => src.okPercent[i] !== src.koPercent[i]);
    expect(differing).toHaveLength(40);
    // Five bins have BOTH series non-zero, which is what makes a swap visible
    // in the table rather than only in the series arrays.
    const bothPresent = src.labels.filter(
      (_, i) => src.okPercent[i]! > 0 && src.koPercent[i]! > 0,
    );
    expect(bothPresent).toHaveLength(5);
  });

  /**
   * The property that makes the brief's `rows[0]` assertion partly blind, and
   * it is worth stating explicitly because it is not obvious: bin 0 has 223 OK
   * and **zero** KO. Zero is a fixed point of renormalisation — `0 / 2.68 * 100`
   * is still 0 — so a transform that rescaled the KO series alone produces a
   * row 0 identical to a correct one. The KO renormalisation is first visible
   * at bin 1, where 0.223% would become 8.33%.
   */
  it('has a first bin whose KO share is zero', () => {
    expect(src.okPercent[0]).toBeCloseTo(24.916, 3);
    expect(src.koPercent[0]).toBe(0);
    expect(src.koPercent[1]).toBeCloseTo(0.2235, 4);
  });

  it('labels bins by their midpoint, which is not the run minimum', () => {
    // step = (2503 - 16) / 100 ≈ 24.87, so bin 0's midpoint rounds to 28 while
    // the fastest request in the run took 16 ms (§A.9 F-8).
    expect(src.labels[0]).toBe(28);
    expect(src.labels.at(-1)).toBe(2491);
  });
});

/* ------------------------------------------------------------------ *
 * the two series ⑧ (G-20/G-21)
 * ------------------------------------------------------------------ */

describe('toDistribution — OK and KO ⑧ (G-20/G-21)', () => {
  // The brief's Step 1 test, verbatim. It pins the names and their order, and
  // it is the assertion the design's falsification checkpoint #4 (drop the KO
  // series) goes red on.
  it('draws OK and KO as distinct series', () => {
    const d = toDistribution(fixture.distribution as DistributionResponse);
    expect(d.series.map((s) => s.name)).toEqual(['OK', 'KO']);
  });

  /**
   * THE ASSERTION THE ONE ABOVE CANNOT MAKE. Names are not numbers: a
   * transform that read `koPercent` into the series called OK and `okPercent`
   * into the series called KO passes the name test exactly, and draws a chart
   * claiming this run's 24 failures are its 871 successes. The fixture makes
   * that detectable — 40 of 100 bins differ between the two arrays — and the
   * comparison is bin by bin across all 100 rather than at a sampled index,
   * because the 60 bins where both are zero prove nothing.
   */
  it('gives each series its own numbers, bin by bin', () => {
    const d = toDistribution(src);
    expect(dataOf(d, 0)).toEqual(src.okPercent);
    expect(dataOf(d, 1)).toEqual(src.koPercent);
    // The guard that keeps the two assertions above from being one assertion.
    expect(src.okPercent).not.toEqual(src.koPercent);
  });

  /**
   * G-21 is a row of the parity matrix in its own right, so the KO series is
   * drawn even when it is flat zero. "This run had no failures" and "this
   * chart forgot to draw failures" must not be the same picture — and unlike
   * the requests/s chart (design §9 checkpoint 7) there is no
   * `startedSplitAvailable` here: the split is always in the payload, so zero
   * means zero and is honest to draw.
   */
  it('still draws KO on a run that recorded no failures', () => {
    const n = src.labels.length;
    const clean = withFields({ koCount: zeros(n), koPercent: zeros(n) });
    const d = toDistribution(clean);
    expect(d.series.map((s) => s.name)).toEqual(['OK', 'KO']);
    expect(dataOf(d, 1)).toEqual(zeros(n));
  });

  it('paints the two series in the status colours, in series order', () => {
    expect(DISTRIBUTION_ROLES).toEqual(['passed', 'failed']);
  });
});

/* ------------------------------------------------------------------ *
 * the percentages are the API's
 * ------------------------------------------------------------------ */

describe('toDistribution — percentages of the combined total (§A.9 F-8)', () => {
  // The brief's Step 1 test, verbatim.
  it('keeps the API percentages, which are of the COMBINED total', () => {
    const src = fixture.distribution as DistributionResponse;
    const d = toDistribution(src);
    // okPercent and koPercent together sum to 100 (A.9 F-8). Renormalising
    // either one independently would make each series sum to 100 instead.
    const sum = src.okPercent.reduce((a, b) => a + b, 0) + src.koPercent.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(100, 1);
    expect(d.rows[0]!.values).toContain(src.okPercent[0]);
  });

  /**
   * WHAT THE TEST ABOVE DOES NOT CATCH, and this file's second reason to
   * exist. Its `sum` assertion is computed entirely from `src` — the transform
   * is not in it — so the only claim it makes about `toDistribution` is that
   * row 0 contains `okPercent[0]` SOMEWHERE. `toContain` is position-blind, so
   * a transform that swapped the OK and KO columns still passes; and bin 0's
   * KO share is zero, which renormalising the KO series alone leaves at zero,
   * so that mutation is invisible to it as well.
   *
   * This asserts the property the chart actually depends on, over the whole
   * payload and against the transform's own output: each series keeps the
   * share of the combined total it arrived with, so the two together sum to
   * 100 and NEITHER sums to 100 alone.
   */
  it('does not rescale either series to sum to 100 on its own', () => {
    const d = toDistribution(src);
    const ok = sum(dataOf(d, 0));
    const ko = sum(dataOf(d, 1));

    expect(ok + ko).toBeCloseTo(100, 6);
    expect(ok).toBeCloseTo(97.318, 3);
    expect(ko).toBeCloseTo(2.682, 3);
    // Said the other way round, because this is the failure mode: a KO series
    // rescaled to its own total would sum to 100 here and be drawn as tall as
    // the OK one.
    expect(ko).not.toBeCloseTo(100, 1);
    expect(ok).not.toBeCloseTo(100, 1);
  });

  /**
   * The same claim on the parity surface, and POSITIONALLY — `values[0]` is
   * the OK share and `values[1]` is the KO share, per `columns`. Every bin,
   * not a sampled one.
   */
  it('puts each bin’s OK and KO shares in their own columns', () => {
    const d = toDistribution(src);
    expect(d.columns).toEqual([
      'Response time (ms, bin midpoint)',
      'OK (% of all requests)',
      'KO (% of all requests)',
      'OK requests',
      'KO requests',
    ]);
    expect(d.rows).toHaveLength(src.labels.length);
    expect(d.rows.map((r) => r.values[OK_PERCENT])).toEqual(src.okPercent);
    expect(d.rows.map((r) => r.values[KO_PERCENT])).toEqual(src.koPercent);
    // The exact underlying counts, which the platform holds and Gatling does
    // not display (AC-PARITY-2).
    expect(d.rows.map((r) => r.values[OK_COUNT])).toEqual(src.okCount);
    expect(d.rows.map((r) => r.values[KO_COUNT])).toEqual(src.koCount);
  });

  it('labels every row and every axis tick with the bin label itself', () => {
    const d = toDistribution(src);
    // Exact bin labels are half of G-20/G-21's tolerance. Plotting the bin
    // INDEX — which a histogram invites — loses it while looking fine.
    expect(d.axisLabels).toEqual(src.labels);
    expect(d.rows.map((r) => r.label)).toEqual(src.labels.map(String));
  });
});

/* ------------------------------------------------------------------ *
 * what the labels mean, and what is missing
 * ------------------------------------------------------------------ */

describe('toDistribution — says what it is showing', () => {
  /**
   * `exactValues` changes what a label IS: a midpoint of a 25 ms bin, or a
   * millisecond value some request actually took. Nothing else on the chart
   * tells them apart — both render as a bare number under a bar — so the axis
   * has to. `DistributionChart` hands `columns[0]` to the drawn chart as its
   * category-axis name, so this one string covers the table and the drawing.
   */
  it('names the labels as bucket midpoints', () => {
    const d = toDistribution(src);
    expect(d.columns[0]).toMatch(/midpoint/i);
    expect(d.columns[0]).not.toMatch(/exact/i);
  });

  it('names them as exact values when Gatling skipped bucketing', () => {
    const d = toDistribution(withFields({ exactValues: true }));
    expect(d.columns[0]).toMatch(/exact/i);
    expect(d.columns[0]).not.toMatch(/midpoint/i);
    // And it is a real difference, not the same string twice.
    expect(d.columns[0]).not.toEqual(toDistribution(src).columns[0]);
  });

  // The brief's Step 1 test, verbatim.
  it('says when bins are incomplete rather than drawing a truncated distribution', () => {
    const d = toDistribution({ ...(fixture.distribution as DistributionResponse), overflowCount: 7 });
    expect(JSON.stringify(d)).toMatch(/exceeded|incomplete|overflow/i);
  });

  /**
   * THE OTHER HALF OF THE TEST ABOVE, which on its own is passed by a
   * transform that warns about truncated bins unconditionally — a warning
   * printed under all 100 bins of a complete distribution, on every run, which
   * is how a real one stops being read. The reference payload's
   * `overflowCount` is 0, so this is the same fixture with nothing changed.
   */
  it('says nothing about incomplete bins when nothing overflowed', () => {
    const d = toDistribution(src);
    expect(d.limitation).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/exceeded|incomplete|overflow/i);
  });

  it('names how many observations overflowed', () => {
    const d = toDistribution(withFields({ overflowCount: 7 }));
    // The count itself, because "some observations exceeded the range" leaves
    // a reader unable to tell 7 from 7000.
    expect(d.limitation).toMatch(/\b7\b/);
    expect(d.limitation).toMatch(/exceeded/i);
    // The bins are still drawn — the warning is beside the chart, not instead
    // of it.
    expect(d.series).toHaveLength(2);
    expect(d.rows).toHaveLength(src.labels.length);
  });
});

/* ------------------------------------------------------------------ *
 * nothing to draw
 * ------------------------------------------------------------------ */

describe('toDistribution — nothing to draw', () => {
  it('explains an empty distribution instead of drawing empty axes', () => {
    const d = toDistribution(
      withFields({ labels: [], okCount: [], koCount: [], okPercent: [], koPercent: [] }),
    );
    expect(d.series).toEqual([]);
    expect(d.axisLabels).toEqual([]);
    expect(d.rows).toEqual([]);
    expect(d.empty).toMatch(/no response times were recorded/i);
    // The table's header survives, because `Chart` renders the (empty) table
    // unconditionally — it is the parity surface on every chart on the page.
    expect(d.columns).toHaveLength(5);
  });

  /**
   * The pathological case the two guards exist separately for: bins were
   * computed, but every observation landed outside the range they cover, so
   * every count is zero. "Nothing was recorded" would be false — 895 requests
   * were — and a hundred zero-height bars would read as "every request took no
   * time at all".
   */
  it('distinguishes a run whose every observation overflowed', () => {
    const n = src.labels.length;
    const d = toDistribution(
      withFields({
        okCount: zeros(n),
        koCount: zeros(n),
        okPercent: zeros(n),
        koPercent: zeros(n),
        overflowCount: 895,
      }),
    );
    expect(d.series).toEqual([]);
    expect(d.empty).toMatch(/recorded range/i);
    expect(d.empty).not.toMatch(/no response times were recorded/i);
    // And the reason is still stated beside it.
    expect(d.limitation).toMatch(/895/);
  });
});
