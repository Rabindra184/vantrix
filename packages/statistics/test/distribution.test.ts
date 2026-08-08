import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/histogram.js';
import {
  GATLING_MAX_PLOTS, bucketIndexFor, distribution, gatlingBucketFor, gatlingLabels, gatlingStep,
} from '../src/distribution.js';

// Verified against fixtures/gatling-3.15.1.2/reference-report/index.html:
// the global chart's 100 categories are 28, 53, 78, ..., 2491, and they are
// reproduced EXACTLY by min=16, max=2503. 28 is the first bin's MIDPOINT,
// not the minimum - which is why reading the minimum off the chart is wrong.
const FIXTURE_MIN = 16;
const FIXTURE_MAX = 2503;

describe('gatling distribution binning', () => {
  it('uses 100 plots, matching the hardcoded literal in GlobalReportGenerator', () => {
    expect(GATLING_MAX_PLOTS).toBe(100);
  });

  it('steps by range/maxPlots, or by 1 when the range is narrower than maxPlots', () => {
    expect(gatlingStep(16, 2503, 100)).toBeCloseTo(24.87, 10);
    expect(gatlingStep(10, 40, 100)).toBe(1.0);
  });

  it('reproduces the fixture 100 labels exactly', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    const labels = gatlingLabels(FIXTURE_MIN, FIXTURE_MAX, step);
    expect(labels).toHaveLength(100);
    expect(labels[0]).toBe(28);
    expect(labels[1]).toBe(53);
    expect(labels[8]).toBe(227);      // the 24ms gap, not 228
    expect(labels[99]).toBe(2491);
    // 12 gaps of 24ms among 87 of 25ms - the signature that (max-min)/100 is wrong.
    const gaps = labels.slice(1).map((v, i) => v - (labels[i] as number));
    expect(gaps.filter((g) => g === 24)).toHaveLength(12);
    expect(gaps.filter((g) => g === 25)).toHaveLength(87);
  });

  it('clamps the maximum observation into the last bucket', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    expect(gatlingBucketFor(FIXTURE_MAX, FIXTURE_MIN, FIXTURE_MAX, step)).toBe(2491);
    expect(gatlingBucketFor(FIXTURE_MIN, FIXTURE_MIN, FIXTURE_MAX, step)).toBe(28);
  });

  it('expresses BOTH series as a percent of the combined OK+KO count', () => {
    const ok = new Histogram();
    const ko = new Histogram();
    for (let i = 0; i < 300; i++) ok.accept(100);
    for (let i = 0; i < 100; i++) ko.accept(2000);
    const d = distribution(ok, ko);
    const okTotal = d.okPercent.reduce((a, b) => a + b, 0);
    const koTotal = d.koPercent.reduce((a, b) => a + b, 0);
    expect(okTotal).toBeCloseTo(75, 6);
    expect(koTotal).toBeCloseTo(25, 6);
    expect(okTotal + koTotal).toBeCloseTo(100, 6);
  });

  it('drops bucketing entirely when the range is at most maxPlots', () => {
    const ok = new Histogram();
    for (const v of [10, 10, 11, 12]) ok.accept(v);
    const d = distribution(ok, new Histogram());
    expect(d.exactValues).toBe(true);
    expect(d.labels).toEqual([10, 11, 12]);
    expect(d.okCount).toEqual([2, 1, 1]);
  });

  it('returns empty for no observations', () => {
    const d = distribution(new Histogram(), new Histogram());
    expect(d.labels).toEqual([]);
    expect(d.okPercent).toEqual([]);
  });

  it('places every observation on the fixture range exactly where Gatling does', () => {
    const step = gatlingStep(FIXTURE_MIN, FIXTURE_MAX, GATLING_MAX_PLOTS);
    const labels = gatlingLabels(FIXTURE_MIN, FIXTURE_MAX, step);
    for (let v = FIXTURE_MIN; v <= FIXTURE_MAX; v++) {
      const i = bucketIndexFor(v, FIXTURE_MIN, FIXTURE_MAX, step, labels.length);
      expect(labels[i]).toBe(gatlingBucketFor(v, FIXTURE_MIN, FIXTURE_MAX, step));
    }
  });

  // Gatling drops observations whose computed label is absent from its own
  // label set; arithmetic indexing cannot. Conservation is the invariant every
  // percentage assertion rests on.
  it('never loses an observation, on ranges where Gatling would', () => {
    for (const [min, max] of [[14, 818], [0, 101], [7, 3999], [16, 2503]] as const) {
      const ok = new Histogram();
      for (let v = min; v <= max; v++) ok.accept(v);
      const d = distribution(ok, new Histogram());
      expect(d.okCount.reduce((a, b) => a + b, 0)).toBe(max - min + 1);
      expect(d.okPercent.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    }
  });
});
