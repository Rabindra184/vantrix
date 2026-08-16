import type { ErrorSeriesResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { OTHER_LABEL, toErrorSeries } from '../src/charts/transforms/errorSeries';
import { MAX_CATEGORICAL_SERIES } from '../src/charts/theme';
import { ERROR_SERIES_KEEP } from './support/errorSeriesKeep';

const response = (over: Partial<ErrorSeriesResponse> = {}): ErrorSeriesResponse => ({
  runId: '00000000-0000-4000-8000-000000000000',
  window: null,
  bucketWidthMs: 1000,
  available: true,
  series: [],
  ...over,
});

/** The `[elapsedMs, value]` pairs of one drawn series. */
function points(data: unknown): readonly (readonly [number, number])[] {
  return data as readonly (readonly [number, number])[];
}

describe('toErrorSeries', () => {
  it('plots [elapsedMs, rate] pairs on a value axis', () => {
    // Not one value per shared category: errors are SPARSE, and a category
    // axis indexes by position, so failures at 5s, 40s and 90s would draw
    // three evenly-spaced points and misplace all of them in time.
    const d = toErrorSeries(response({
      series: [{ message: 'boom', total: 2, points: [{ startOffsetMs: 5000, count: 2 }] }],
    }));
    expect(points(d.series[0]!.data)).toEqual([[5000, 2]]);
    expect(d.axisLabels).toEqual([]);
  });

  it('divides by the response’s OWN bucket width', () => {
    // A 2000ms bucket holding the same count is HALF the rate — the same
    // argument transforms/rates.ts makes, and the reason bucketWidthMs is in
    // the payload at all.
    const pts = [{ startOffsetMs: 0, count: 4 }];
    const fine = toErrorSeries(response({ bucketWidthMs: 1000, series: [{ message: 'b', total: 4, points: pts }] }));
    const coarse = toErrorSeries(response({ bucketWidthMs: 2000, series: [{ message: 'b', total: 4, points: pts }] }));
    const at0 = (d: ReturnType<typeof toErrorSeries>) => points(d.series[0]!.data)[0]![1];
    expect(at0(coarse)).toBeCloseTo(at0(fine) / 2, 9);
  });

  it('names the folded remainder rather than drawing an unlabelled series', () => {
    const d = toErrorSeries(response({
      series: [{ message: null, total: 3, points: [{ startOffsetMs: 0, count: 3 }] }],
    }));
    expect(d.series[0]!.name).toBe(OTHER_LABEL);
    expect(d.columns).toContain(OTHER_LABEL);
  });

  it('says a run predates the recording instead of drawing empty axes', () => {
    const d = toErrorSeries(response({ available: false }));
    expect(d.empty).toBeTruthy();
    expect(d.series).toHaveLength(0);
  });

  it('says a run simply had no failures, in different words', () => {
    // The distinction `available` exists for. Both states draw nothing, and
    // only one of them is good news; a reader who cannot tell "this run
    // passed" from "we did not record this" has been told nothing.
    const missing = toErrorSeries(response({ available: false })).empty;
    const clean = toErrorSeries(response({ available: true })).empty;
    expect(clean).toBeTruthy();
    expect(clean).not.toBe(missing);
  });

  it('carries one table row per offset across every series', () => {
    // The parity surface: a sparse series must not lose the offsets only its
    // neighbours occupy.
    const d = toErrorSeries(response({
      series: [
        { message: 'a', total: 1, points: [{ startOffsetMs: 0, count: 1 }] },
        { message: 'b', total: 1, points: [{ startOffsetMs: 2000, count: 1 }] },
      ],
    }));
    expect(d.rows).toHaveLength(2);
    expect(d.rows.map((r) => r.label)).toEqual(['0', '2']);
  });

  it('writes an em dash, not zero, where a message did not fail', () => {
    // Zero is a measured rate. This message was simply not seen in that
    // bucket, which is a different claim.
    const d = toErrorSeries(response({
      series: [
        { message: 'a', total: 1, points: [{ startOffsetMs: 0, count: 1 }] },
        { message: 'b', total: 1, points: [{ startOffsetMs: 1000, count: 1 }] },
      ],
    }));
    expect(d.rows[0]!.values[1]).toBe('—');
  });
});

describe('the palette has room for what the engine keeps', () => {
  it('draws every kept message AND the folded remainder', () => {
    // ERROR_SERIES_KEEP and this palette cannot share a constant — see
    // test/support/errorSeriesKeep.ts. Shrinking CATEGORICAL would otherwise
    // push `Other errors` off the chart silently, because assignPalette leaves
    // an excess series UNDRAWN rather than cycling hues.
    expect(MAX_CATEGORICAL_SERIES).toBeGreaterThanOrEqual(ERROR_SERIES_KEEP + 1);
  });
});
