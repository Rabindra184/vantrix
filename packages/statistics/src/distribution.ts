import { Histogram } from './histogram.js';

/**
 * Hardcoded in Gatling at GlobalReportGenerator.scala:80 as the literal 100.
 * It is NOT configuration, so the platform must not make it configurable
 * either without breaking parity.
 */
export const GATLING_MAX_PLOTS = 100;

export interface DistributionResult {
  labels: number[];
  okCount: number[];
  koCount: number[];
  /** Percent of the COMBINED OK+KO count, matching Gatling. Sums to 100 across both series. */
  okPercent: number[];
  koPercent: number[];
  /** True when the range was narrow enough that Gatling skips bucketing. */
  exactValues: boolean;
  /** Non-zero means some observations exceeded the histogram cap; see Histogram. */
  overflowCount: number;
}

/** Scala's Double.round is floor(x + 0.5); JS Math.round differs for negatives. */
function scalaRound(x: number): number {
  return Math.floor(x + 0.5);
}

/** StatsHelper.step */
export function gatlingStep(min: number, max: number, maxPlots: number): number {
  const range = max - min;
  return range < maxPlots ? 1.0 : range / maxPlots;
}

/** StatsHelper.buckets — labels are bucket MIDPOINTS, not lower edges. */
export function gatlingLabels(min: number, max: number, step: number): number[] {
  const halfStep = step / 2;
  const length = Math.ceil((max - min) / step);
  return Array.from({ length }, (_, i) => scalaRound(min + step * i + halfStep));
}

/**
 * LogFileData.distribution's bucketFunction, transcribed exactly — note the
 * clamp to max - 1. Exported and tested because it documents the source rule,
 * but NOT used to place observations; see bucketIndexFor.
 */
export function gatlingBucketFor(t: number, min: number, max: number, step: number): number {
  const value = Math.min(t, max - 1);
  return scalaRound(value - ((value - min) % step) + step / 2);
}

/**
 * The bin index an observation belongs to.
 *
 * Gatling groups by the LABEL VALUE that bucketFunction computes, then looks
 * that value up among the labels StatsHelper.buckets produced. Those two
 * roundings do not always agree: probing 4240 (min, max) ranges found 26 where
 * some observation's computed label is absent from the label set, so Gatling
 * silently drops it — up to 8 observations in the worst case, and some ranges
 * yield 101 labels rather than 100 because `ceil(range/step)` is a
 * floating-point round trip.
 *
 * DELIBERATE DEVIATION: we index arithmetically instead, which is the same
 * quantity without the second rounding. It never drops an observation, so the
 * percentages always sum to 100. Verified across the same 4240 ranges: zero
 * out-of-range indices, and identical placement to bucketFunction across the
 * ENTIRE fixture range (min 16, max 2503), which is what parity is asserted on.
 */
export function bucketIndexFor(
  t: number, min: number, max: number, step: number, binCount: number,
): number {
  const value = Math.min(t, max - 1);
  return Math.min(Math.max(Math.floor((value - min) / step), 0), binCount - 1);
}

export function distribution(
  ok: Histogram,
  ko: Histogram,
  maxPlots: number = GATLING_MAX_PLOTS,
): DistributionResult {
  const size = ok.total + ko.total;
  const overflowCount = ok.overflowCount + ko.overflowCount;
  if (size === 0) {
    return { labels: [], okCount: [], koCount: [], okPercent: [], koPercent: [], exactValues: false, overflowCount };
  }

  // min/max span BOTH series - which is why the fixture's global min is 16 and
  // not the 28 the chart's first label suggests.
  const min = ok.total === 0 ? ko.min : ko.total === 0 ? ok.min : Math.min(ok.min, ko.min);
  const max = Math.max(ok.max, ko.max);
  const percent = (n: number): number => (n * 100) / size;

  if (max - min <= maxPlots) {
    // Gatling's "use exact values" branch: one plot per distinct observation.
    // NOT exercised by the reference fixture (its range is 2487); implemented
    // from source semantics, with labels as the sorted union of both series.
    const values = new Set<number>();
    for (const [v] of ok.entries()) values.add(v);
    for (const [v] of ko.entries()) values.add(v);
    const labels = [...values].sort((a, b) => a - b);
    const okCount = labels.map((v) => ok.countAt(v));
    const koCount = labels.map((v) => ko.countAt(v));
    return {
      labels, okCount, koCount,
      okPercent: okCount.map(percent),
      koPercent: koCount.map(percent),
      exactValues: true,
      overflowCount,
    };
  }

  const step = gatlingStep(min, max, maxPlots);
  const labels = gatlingLabels(min, max, step);

  const okCount = new Array<number>(labels.length).fill(0);
  const koCount = new Array<number>(labels.length).fill(0);
  const fold = (h: Histogram, into: number[]): void => {
    for (const [v, c] of h.entries()) {
      const i = bucketIndexFor(v, min, max, step, labels.length);
      into[i] = (into[i] as number) + c;
    }
  };
  fold(ok, okCount);
  fold(ko, koCount);

  return {
    labels, okCount, koCount,
    okPercent: okCount.map(percent),
    koPercent: koCount.map(percent),
    exactValues: false,
    overflowCount,
  };
}
