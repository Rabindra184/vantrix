import type { StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  BAND_ROLES,
  OUTCOME_ROLES,
  toIndicators,
  toRequestCounts,
} from '../src/charts/transforms/indicators.js';
import { CATEGORICAL, CATEGORICAL_DARK, chartTheme, type ChartMode } from '../src/charts/theme.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ③ the indicator bands (Appendix A G-06…G-09) and ④ the request-count
 * donut (G-10), both folded out of `GET /v1/runs/:id/stats`.
 *
 * Read against `fixtures/reference-run.json`, the payload captured from the
 * live API for the real Gatling reference run — the same bytes the browser
 * receives.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The reference run's `bounds` are
 * `{ lowerMs: 800, higherMs: 1200 }`, which are also the project defaults and
 * also the exact numbers the plan warns against hard-coding. So a band-label
 * assertion written against THIS payload alone cannot fail: `'t < 800 ms'` is
 * what a transform reading `stats.bounds` produces AND what a transform with
 * `800` typed into a template literal produces. The brief's own Step 1 test has
 * that shape, and it is kept here verbatim because it pins the exact strings —
 * but it is immediately followed by the same assertion run over bounds the
 * fixture does not carry, which is the one that discriminates. See §"the bounds
 * are read, not assumed" below.
 */

const stats = fixture.stats as StatsResponse;

/** The reference run, with the project's indicator bounds moved. */
const withBounds = (lowerMs: number, higherMs: number): StatsResponse => ({
  ...stats,
  bounds: { lowerMs, higherMs },
});

const MODES: readonly ChartMode[] = ['light', 'dark'];

describe('toIndicators — the four bands ③ (G-06…G-09)', () => {
  it('labels the bands with the bounds that produced them', () => {
    const d = toIndicators(stats);
    expect(d.columns).toEqual(['Band', 'Count', 'Percent']);
    expect(d.rows.map((r) => r.label)).toEqual([
      't < 800 ms',
      '800 ms <= t < 1200 ms',
      't >= 1200 ms',
      'failed',
    ]);
  });

  /**
   * THE ASSERTION THAT CAN ACTUALLY FAIL, and the design's falsification
   * checkpoint #5 in test form.
   *
   * `bounds` is a project setting the API reports alongside the bands, not a
   * property of the run's traffic, so moving it on a captured payload is a
   * well-formed input rather than a doctored one. The counts are deliberately
   * NOT re-folded — they cannot be, the histogram is server-side — and nothing
   * here asserts on them. What is asserted is the only thing `bounds` decides:
   * the thresholds the reader is told the bands were cut at.
   *
   * The expectations are written out as literals rather than built from the
   * same template the transform uses, because a test that formats the label the
   * way the implementation formats it is testing that a function equals itself.
   */
  const CASES = [
    {
      bounds: [800, 1200] as const,
      labels: ['t < 800 ms', '800 ms <= t < 1200 ms', 't >= 1200 ms', 'failed'],
    },
    {
      bounds: [250, 3000] as const,
      labels: ['t < 250 ms', '250 ms <= t < 3000 ms', 't >= 3000 ms', 'failed'],
    },
    {
      bounds: [50, 75] as const,
      labels: ['t < 50 ms', '50 ms <= t < 75 ms', 't >= 75 ms', 'failed'],
    },
  ];

  it.each(CASES)('reads the thresholds off the payload — bounds $bounds', ({ bounds, labels }) => {
    const d = toIndicators(withBounds(bounds[0], bounds[1]));
    expect(d.rows.map((r) => r.label)).toEqual(labels);
  });

  it('and those three cases really are three different label sets', () => {
    // Guards the it.each above against the degenerate version of itself: if
    // two rows carried the same expectations, one of them would be certifying
    // nothing. Only the fourth band ('failed') is shared, by definition.
    const first = CASES.map((c) => c.labels[0]);
    expect(new Set(first).size).toBe(CASES.length);
  });

  it('the four bands account for every request', () => {
    const s = stats;
    const total = s.indicators.under + s.indicators.between + s.indicators.over + s.indicators.failed;
    const run = s.stats.find((r) => r.scope === 'run')!;
    expect(total).toBe(run.count);
  });

  it('plots the counts the payload reports, and percentages of their total', () => {
    const d = toIndicators(stats);
    // 848 / 0 / 23 / 24 out of 895. The middle band is EMPTY in this run, and
    // it is still a row — a band nobody landed in is a fact about the run.
    expect(d.rows.map((r) => r.values[0])).toEqual([848, 0, 23, 24]);
    expect(d.rows.map((r) => r.values[1])).toEqual(['94.7%', '0.0%', '2.6%', '2.7%']);
    expect(d.series.map((s) => s.data)).toEqual([[848], [0], [23], [24]]);
  });

  /**
   * The stacked bar is FOUR series of one value each, not one series of four,
   * because that is what gives each band its own colour (see the roles test
   * below). Colour is assigned by series index, so series order and row order
   * being the same list is what makes "band 3 is grey" true rather than
   * "series 3 is grey, and band 3 is probably series 3".
   */
  it('keeps the series in the same order as the rows, which is what aligns the colours', () => {
    const d = toIndicators(stats);
    expect(d.series.map((s) => s.name)).toEqual(d.rows.map((r) => r.label));
    expect(d.series).toHaveLength(BAND_ROLES.length);
  });
});

describe('toIndicators — a run whose bands are not configurable', () => {
  const frozen = toIndicators({ ...stats, configurable: false });

  it('says so when the bands are not configurable, instead of offering a control that would do nothing', () => {
    expect(frozen.empty ?? frozen.rows[0]!.label).toBeDefined();
    expect(JSON.stringify(frozen)).toMatch(/fixed|not configurable/i);
  });

  /**
   * The assertion above cannot fail on its own: a transform that returned the
   * word "fixed" unconditionally would satisfy it. This pair is what makes the
   * message CONDITIONAL — present when the run predates the parity migration,
   * absent when it does not.
   */
  it('and says nothing of the sort when they are configurable', () => {
    expect(toIndicators(stats).limitation).toBeUndefined();
    expect(JSON.stringify(toIndicators(stats))).not.toMatch(/fixed|not configurable/i);
  });

  it('states it as a limitation beside the chart, naming the bounds they were frozen at', () => {
    expect(frozen.limitation).toMatch(/fixed/i);
    expect(frozen.limitation).toContain('800');
    expect(frozen.limitation).toContain('1200');
  });

  /**
   * Design §10: "Render the bands and state that they are fixed." A run with no
   * histogram still has bands — they are simply not going to move — so hiding
   * them would lose G-06…G-09 for every pre-migration run.
   */
  it('still renders the bands, rather than replacing them with the caveat', () => {
    expect(frozen.rows.map((r) => r.values[0])).toEqual([848, 0, 23, 24]);
    expect(frozen.empty).toBeUndefined();
  });
});

describe('toIndicators — the bands wear the BAND RAMP, not the categorical palette', () => {
  it('gives the four bands four distinct roles', () => {
    expect(BAND_ROLES).toHaveLength(4);
    expect(new Set(BAND_ROLES).size).toBe(4);
  });

  /**
   * And they are the BAND roles, not the status ones. The donut ④ beside this
   * chart legitimately takes the status palette — OK and KO are app-wide states
   * — so "semantic, not categorical" is not enough to pin which of the two
   * semantic palettes the bands took, and the first cut of this took the wrong
   * one.
   */
  it('takes them from the band ramp, not from the app-wide status palette', () => {
    expect(BAND_ROLES.every((role) => role.startsWith('band-'))).toBe(true);
    expect(OUTCOME_ROLES.some((role) => role.startsWith('band-'))).toBe(false);
  });

  it.each(MODES)('resolves those roles to four distinct colours in %s mode', (mode) => {
    const { roles } = chartTheme(mode);
    const colours = BAND_ROLES.map((role) => roles[role]);
    // Two bands in one colour is the failure `assignPalette` exists to prevent
    // on the categorical side, and nothing was preventing it here.
    expect(new Set(colours).size).toBe(colours.length);
  });

  /**
   * The point of the whole exercise. A band is a POSITION ON A SCALE — fast,
   * borderline, slow, failed — not an identity, so it wears the four-step
   * severity ramp, whose red end is the same red the rest of the app spends its
   * failures in (`marks.tsx`). A reader who has learned that red means failed
   * there is not shown red meaning "slow" here.
   *
   * Asserted as "no band colour is a categorical hue" rather than as an
   * equality against a list of expected hexes, because the equality version
   * would pass if the transform were switched to CATEGORICAL and the expected
   * list updated in the same edit.
   */
  it.each(MODES)('takes none of them from the categorical series palette (%s)', (mode) => {
    const { roles } = chartTheme(mode);
    const categorical = new Set<string>([...CATEGORICAL, ...CATEGORICAL_DARK]);
    for (const role of BAND_ROLES) {
      expect(categorical.has(roles[role])).toBe(false);
    }
  });
});

describe('toIndicators — a run with no requests', () => {
  const nothing = toIndicators({
    ...stats,
    indicators: { under: 0, between: 0, over: 0, failed: 0 },
  });

  /**
   * Four zero-height segments and a percentage of nothing is the shape this
   * would take by default — `0 / 0` formats as `NaN%` and the bar renders as an
   * empty rectangle that reads "measured, and everything was fine".
   */
  it('explains itself instead of drawing four empty bands', () => {
    expect(nothing.empty).toBeDefined();
    expect(nothing.rows).toEqual([]);
    expect(JSON.stringify(nothing)).not.toMatch(/NaN/);
  });

  it('still declares its columns, because the data table renders unconditionally', () => {
    expect(nothing.columns).toEqual(['Band', 'Count', 'Percent']);
  });
});

describe('toRequestCounts — the OK/KO donut ④ (G-10)', () => {
  const d = toRequestCounts(stats);

  /**
   * The RUN-scope row, and this is the assertion that discriminates. The
   * payload's first row is the `Cart` group (70 OK, 15 KO) and there are 13
   * more; a transform reading `stats.stats[0]`, or the first `request` row, or
   * summing the request rows, produces a plausible donut with the wrong
   * numbers in it. 871/24 belongs to exactly one of the fourteen rows.
   */
  it('reads the run-scope row, not whichever row happens to be first', () => {
    expect(d.rows.map((r) => r.label)).toEqual(['OK', 'KO', 'Total']);
    expect(d.rows.map((r) => r.values[0])).toEqual([871, 24, 895]);

    const first = stats.stats[0]!;
    expect(first.scope).not.toBe('run');
    expect([first.okCount, first.koCount]).not.toEqual([871, 24]);
  });

  it('carries the totals and the percentages G-10 asks for', () => {
    expect(d.columns).toEqual(['Outcome', 'Count', 'Percent']);
    expect(d.rows.map((r) => r.values[1])).toEqual(['97.3%', '2.7%', '100.0%']);
  });

  /**
   * The donut plots two slices; the table carries three rows. The extra row is
   * the total, which G-10 names in its own title ("OK vs KO chart with totals")
   * and which has no slice of its own — a total slice would double the ring.
   */
  it('plots OK and KO as slices, with the total in the table only', () => {
    expect(d.axisLabels).toEqual(['OK', 'KO']);
    expect(d.series).toHaveLength(1);
    expect(d.series[0]!.data).toEqual([871, 24]);
    expect(OUTCOME_ROLES).toHaveLength(d.axisLabels.length);
  });

  it.each(MODES)('paints OK and KO in the status colours, not categorical hues (%s)', (mode) => {
    const { roles } = chartTheme(mode);
    const colours = OUTCOME_ROLES.map((role) => roles[role]);
    expect(new Set(colours).size).toBe(colours.length);
    const categorical = new Set<string>([...CATEGORICAL, ...CATEGORICAL_DARK]);
    for (const colour of colours) expect(categorical.has(colour)).toBe(false);
  });

  /**
   * ③ and ④ read the same run through two different fields — `indicators.failed`
   * on the response, `koCount` on the run row — and they are on the same page,
   * inches apart. If they ever disagreed, one of them would be lying and a
   * reader would have no way to tell which.
   */
  it('agrees with the indicator bands about how many requests failed', () => {
    const bands = toIndicators(stats);
    const failedBand = bands.rows.at(-1)!;
    expect(failedBand.label).toBe('failed');
    expect(failedBand.values[0]).toBe(d.rows[1]!.values[0]);
  });

  it('explains itself when the run has no request statistics at all', () => {
    const none = toRequestCounts({ ...stats, stats: [] });
    expect(none.empty).toBeDefined();
    expect(none.rows).toEqual([]);
    expect(none.columns).toEqual(['Outcome', 'Count', 'Percent']);
    expect(JSON.stringify(none)).not.toMatch(/NaN/);
  });

  it('explains itself when the run recorded zero requests', () => {
    const run = stats.stats.find((r) => r.scope === 'run')!;
    const none = toRequestCounts({
      ...stats,
      stats: [{ ...run, count: 0, okCount: 0, koCount: 0 }],
    });
    expect(none.empty).toBeDefined();
    expect(none.rows).toEqual([]);
  });
});
