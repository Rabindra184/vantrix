import { describe, expect, it } from 'vitest';
import {
  AGENT_DURATION_CURVE_PERCENTILES,
  AGENT_DURATION_ROW_KEYS,
  durationSection,
  type DurationBucketInput,
} from '../src/agent-read.js';
import { Histogram } from '../src/histogram.js';

function hist(values: readonly number[]): Histogram {
  const h = new Histogram();
  for (const v of values) h.accept(v);
  return h;
}

function bucket(startOffsetMs: number, ok: readonly number[], ko: readonly number[] = []): DurationBucketInput {
  return {
    startOffsetMs,
    okCount: ok.length,
    koCount: ko.length,
    histogramOk: hist(ok),
    histogramKo: hist(ko),
  };
}

const ONE_TO_HUNDRED = Array.from({ length: 100 }, (_, i) => i + 1);

describe('durationSection', () => {
  it('names GE\'s 13 rows in GE\'s order', () => {
    // The contract's AGENT_PERCENTILE_ROWS is the same list; @perfportal/contracts is not a
    // dependency of this package, so the order is pinned here by its literal.
    expect(AGENT_DURATION_ROW_KEYS).toEqual([
      'min', 'p25', 'p50', 'p75', 'p80', 'p85', 'p90', 'p95', 'p99', 'p99_9', 'p99_99', 'max', 'mean',
    ]);
  });

  it('answers the 13 rows of a known histogram by nearest rank', () => {
    const s = durationSection([bucket(0, ONE_TO_HUNDRED)]);
    const row = s.overTime[0]!;
    expect(row.startOffsetMs).toBe(0);
    // min 25 50 75 80 85 90 95 99 99.9 99.99 max mean
    expect(row.ok).toEqual([1, 25, 50, 75, 80, 85, 90, 95, 99, 100, 100, 100, 50.5]);
    expect(row.all).toEqual(row.ok);
  });

  it('answers null for a population that is empty in the bucket, never a row of zeros', () => {
    const s = durationSection([bucket(1000, [5, 7], [])]);
    expect(s.overTime[0]!.ko).toBeNull();
    expect(s.overTime[0]!.ok).not.toBeNull();
    expect(s.percentiles.ko).toEqual([]);
    expect(s.percentiles.meanMs.ko).toBeNull();
    expect(s.totals).toEqual({ ok: 2, ko: 0 });
  });

  it('merges every bucket into the curve, whose endpoints are the min and the max', () => {
    const s = durationSection([bucket(0, [3, 4, 5]), bucket(1000, [90], [200])]);
    expect(s.overTime.map((b) => b.startOffsetMs)).toEqual([0, 1000]);
    expect(s.percentiles.all).toHaveLength(AGENT_DURATION_CURVE_PERCENTILES.length);
    expect(s.percentiles.all[0]).toEqual([0, 3]);
    expect(s.percentiles.all.at(-1)).toEqual([100, 200]);
    expect(s.percentiles.ok[0]).toEqual([0, 3]);
    expect(s.percentiles.ok.at(-1)).toEqual([100, 90]);
    expect(s.percentiles.ko).toEqual(AGENT_DURATION_CURVE_PERCENTILES.map((p) => [p, 200]));
    expect(s.percentiles.meanMs).toEqual({ ok: 25.5, ko: 200, all: 302 / 5 });
    expect(s.totals).toEqual({ ok: 4, ko: 1 });
  });

  it('places the curve at 0, 2.5 … 97.5, 99, 99.9, 99.99, 100', () => {
    expect(AGENT_DURATION_CURVE_PERCENTILES.slice(0, 3)).toEqual([0, 2.5, 5]);
    expect(AGENT_DURATION_CURVE_PERCENTILES.slice(-5)).toEqual([97.5, 99, 99.9, 99.99, 100]);
    expect(AGENT_DURATION_CURVE_PERCENTILES).toHaveLength(44);
  });

  it('draws the distribution on a uniform grid from its first bin', () => {
    // A narrow range takes Gatling's exact-values branch; its labels are distinct values,
    // which the response spreads onto a step-1 grid so `offsetMs + i * stepMs` holds.
    const s = durationSection([bucket(0, [10, 12, 12], [15])]);
    expect(s.distribution.offsetMs).toBe(10);
    expect(s.distribution.stepMs).toBe(1);
    expect(s.distribution.ok).toEqual([1, 0, 2, 0, 0, 0]);
    expect(s.distribution.ko).toEqual([0, 0, 0, 0, 0, 1]);
    expect(s.distribution.meanMs).toBe(49 / 4);

    // A wide range takes Gatling's 100-plot bucketing.
    const wide = durationSection([bucket(0, ONE_TO_HUNDRED.map((v) => v * 10))]);
    expect(wide.distribution.ok).toHaveLength(100);
    expect(wide.distribution.stepMs).toBeCloseTo(9.9);
    expect(wide.distribution.ok.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('answers an empty section for no buckets', () => {
    const s = durationSection([]);
    expect(s.overTime).toEqual([]);
    expect(s.distribution).toEqual({ offsetMs: 0, stepMs: 1, ok: [], ko: [], meanMs: null });
    expect(s.percentiles).toEqual({ ok: [], ko: [], all: [], meanMs: { ok: null, ko: null, all: null } });
    expect(s.totals).toEqual({ ok: 0, ko: 0 });
  });

  it('does not write to the histograms it is given', () => {
    const b = bucket(0, [1, 2], [3]);
    durationSection([b]);
    expect(b.histogramOk.total).toBe(2);
    expect(b.histogramKo.total).toBe(1);
  });
});
