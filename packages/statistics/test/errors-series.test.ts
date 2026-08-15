import { describe, expect, it } from 'vitest';
import { ERROR_SERIES_KEEP, ErrorSeries, type ErrorSeriesResult } from '../src/errors-series.js';

/** Counts keyed by message for one offset, for readable assertions. */
function at(result: ErrorSeriesResult, offset: number): Record<string, number> {
  return Object.fromEntries(
    result.rows.filter((r) => r.startOffsetMs === offset).map((r) => [r.message ?? '@other', r.count]),
  );
}

describe('ErrorSeries', () => {
  it('files a failure in the bucket its timestamp falls in', () => {
    const s = new ErrorSeries({ startMs: 1000, maxBuckets: 100 });
    s.add(1200, 'boom');
    s.add(2300, 'boom');
    s.add(2900, 'bang');

    const out = s.finish(1000);
    expect(out.bucketWidthMs).toBe(1000);
    expect(at(out, 0)).toEqual({ boom: 1 });
    expect(at(out, 1000)).toEqual({ boom: 1, bang: 1 });
  });

  it('leaves an unoccupied bucket absent rather than emitting a zero row', () => {
    // A gap in time is a gap. A zero row would draw a measured "no errors
    // here" over an interval nothing was recorded in.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 'boom');
    s.add(5000, 'boom');
    expect(s.finish(1000).rows.map((r) => r.startOffsetMs)).toEqual([0, 5000]);
  });

  it('halves its own resolution once it exceeds maxBuckets', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 4 });
    for (let i = 0; i < 10; i += 1) s.add(i * 1000, 'boom');
    expect(s.widthMs).toBeGreaterThan(1000);
  });

  it('coalesces UP to a requested wider width, summing exactly', () => {
    // The property the whole design rests on: merging counts is lossless, so
    // an error series bucketed finer than the run series can always be lifted
    // to match it.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(500, 'boom');
    s.add(1500, 'boom');
    s.add(2500, 'bang');

    const out = s.finish(2000);
    expect(out.bucketWidthMs).toBe(2000);
    expect(at(out, 0)).toEqual({ boom: 2 });
    expect(at(out, 2000)).toEqual({ bang: 1 });
  });

  it('preserves the total count across any coalesce', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 50; i += 1) s.add(i * 300, `m${i % 3}`);
    const total = (r: ErrorSeriesResult) => r.rows.reduce((n, x) => n + x.count, 0);
    expect(total(s.finish(8000))).toBe(50);
  });

  it('reports the width it actually has when asked for a NARROWER one', () => {
    // Cannot happen by the spec's subset argument (§2) — the run series always
    // halves at least as often. Clamping rather than throwing keeps a broken
    // invariant from failing a whole ingest for one chart, and the response
    // still carries the real width so the chart stays self-consistent.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 2 });
    for (let i = 0; i < 20; i += 1) s.add(i * 1000, 'boom');
    const wide = s.widthMs;
    expect(wide).toBeGreaterThan(1000);
    expect(s.finish(1000).bucketWidthMs).toBe(wide);
  });

  it('keeps the top five by RUN-WIDE total and folds the rest', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    // Seven distinct messages, descending frequency.
    for (let rank = 0; rank < 7; rank += 1) {
      for (let n = 0; n < 10 - rank; n += 1) s.add(0, `m${rank}`);
    }
    const out = s.finish(1000);
    const named = out.rows.filter((r) => r.message !== null).map((r) => r.message);
    expect(named).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(named).toHaveLength(ERROR_SERIES_KEEP);
    // m5 (10 - 5) + m6 (10 - 6) — derived from the loop, not written down.
    expect(at(out, 0)['@other']).toBe(10 - 5 + (10 - 6));
  });

  it('selects the top five globally, NOT per bucket', () => {
    // A message that leads one bucket but is rare overall must not appear as a
    // series that exists only there — a line that starts and stops mid-chart
    // reads as a metric that was measured and then was not.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let rank = 0; rank < 5; rank += 1) {
      for (let n = 0; n < 20; n += 1) s.add(0, `common${rank}`);
    }
    s.add(1000, 'local-leader');

    const out = s.finish(1000);
    expect(out.rows.some((r) => r.message === 'local-leader')).toBe(false);
    expect(at(out, 1000)).toEqual({ '@other': 1 });
  });

  it('emits no other row when nothing was folded', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    s.add(0, 'boom');
    expect(s.finish(1000).rows.every((r) => r.message !== null)).toBe(true);
  });

  it('folds beyond 200 distinct messages instead of growing without bound', () => {
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 250; i += 1) s.add(0, `m${i}`);
    const out = s.finish(1000);
    // 250 seen, 200 admitted, 50 rejected on arrival; of the 200 admitted, 5
    // are kept by name and 195 fold. Derived from the two caps.
    expect(at(out, 0)['@other']).toBe(250 - 200 + (200 - ERROR_SERIES_KEEP));
  });

  it('folds a late message even when it becomes the most frequent — a stated limit', () => {
    // THE COST OF THE FIRST-SEEN CAP, pinned so it cannot change unnoticed.
    //
    // 200 one-off messages fill the tracking set before the run's real problem
    // ever appears. That message then dominates the run and is still folded,
    // because admission is first-seen and a single pass cannot recover the
    // per-bucket counts of something it already discarded.
    //
    // Promoting it on overtake would draw its curve from the promotion point
    // onward, understating its height — a series lying about its magnitude,
    // which a reader cannot detect. Absent is the more honest failure.
    const s = new ErrorSeries({ startMs: 0, maxBuckets: 100 });
    for (let i = 0; i < 200; i += 1) s.add(0, `m${i}`);
    for (let n = 0; n < 5_000; n += 1) s.add(1000, 'the-real-problem');

    const out = s.finish(1000);
    expect(out.rows.some((r) => r.message === 'the-real-problem')).toBe(false);

    // NOT LOST, only unattributed. The bucket's drawn total still reconciles
    // with its koCount, which is what stops this from corrupting the chart.
    expect(at(out, 1000)).toEqual({ '@other': 5_000 });
  });

  it('is empty, not broken, when nothing was ever added', () => {
    expect(new ErrorSeries({ startMs: 0, maxBuckets: 100 }).finish(1000)).toEqual({
      bucketWidthMs: 1000,
      rows: [],
    });
  });
});
