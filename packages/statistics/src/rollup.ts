import type { MetricFamily, MetricScope } from '@perfportal/core';
import { Histogram } from './histogram.js';

export interface StatRollup {
  scope: MetricScope;
  name: string;
  family: MetricFamily;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  /**
   * Exact nearest-rank values over BOTH statuses, at the configured set — a
   * projection of `mergedHistogram(histogramOk, histogramKo)`. Aggregation
   * merges the histograms, never these.
   */
  percentiles: Record<string, number>;
  throughputRps: number;
  /**
   * Exact 1 ms histograms, split by status because Gatling renders OK and KO as
   * separate distribution series. Their merge is the all-responses population
   * every other figure on this row is computed from.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
}

const merges = new WeakMap<Histogram, { ko: Histogram; okVersion: number; koVersion: number; all: Histogram }>();

/**
 * The merge of both statuses — never mutates either input.
 *
 * MEMOISED and FROZEN. One live tick asked for the same merge three times
 * per rollup (`finish`, `toEvaluableStats`, every percentile Gatling
 * assertion), and each fresh merge then paid its own key sort; at 300,000
 * distinct values that was most of a tick. A repeat call for the same two
 * histograms, neither written since (`Histogram#version`), returns the merge
 * already built, sorted keys and all. It is frozen because it is now shared:
 * a caller that wrote to it would change every other caller's answer, so a
 * write throws instead. A caller that needs to accumulate builds its own.
 */
export function mergedHistogram(ok: Histogram, ko: Histogram): Histogram {
  const hit = merges.get(ok);
  if (hit && hit.ko === ko && hit.okVersion === ok.version && hit.koVersion === ko.version) return hit.all;
  const all = new Histogram();
  all.merge(ok);
  all.merge(ko);
  all.freeze();
  merges.set(ok, { ko, okVersion: ok.version, koVersion: ko.version, all });
  return all;
}

/**
 * Percentiles of a histogram at a set, omitting ranks it cannot answer. An
 * empty histogram answers {}: a p95 of 0 would be a fabricated observation.
 */
export function percentilesOf(h: Histogram, set: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const values = h.percentiles(set); // one walk for the whole set
  set.forEach((p, i) => {
    const v = values[i];
    if (v !== undefined) out[`p${p}`] = v;
  });
  return out;
}

export class RollupBuilder {
  #histOk = new Histogram();
  #histKo = new Histogram();

  add(durationMs: number, ok: boolean): void {
    if (ok) this.#histOk.accept(durationMs); else this.#histKo.accept(durationMs);
  }

  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
    /**
     * Hand back COPIES of the histograms rather than the live accumulators.
     *
     * Off by default: a batch fold finishes once and never touches the builder
     * again, so copying would be pure cost. A LIVE fold keeps going after the
     * snapshot, and a snapshot that aliases the accumulator would mutate under
     * whoever is serializing it — a state that existed at no instant.
     *
     * Lossless: a histogram merge is exact, which is the same property that
     * makes BucketSeries coalescing lossless.
     */
    clone?: boolean;
  }): StatRollup {
    const copy = (h: Histogram): Histogram => {
      const c = new Histogram();
      c.merge(h);
      return c;
    };
    const histogramOk = opts.clone ? copy(this.#histOk) : this.#histOk;
    const histogramKo = opts.clone ? copy(this.#histKo) : this.#histKo;
    // ONE population for every figure on the row. Count, extremes, mean,
    // standard deviation and percentiles all come from this merge, so a row
    // describes one set of values and no figure can sit outside another's range.
    // Merged from the histograms the row RETURNS, so `toEvaluableStats` and
    // the Gatling assertions asking for this row's merge get this one back.
    const all = mergedHistogram(histogramOk, histogramKo);
    const count = all.total;
    const okCount = histogramOk.total;
    const mean = count === 0 ? 0 : all.sum / count;
    return {
      scope: opts.scope,
      name: opts.name,
      family: opts.family,
      count,
      okCount,
      koCount: count - okCount,
      errorRate: count === 0 ? 0 : (count - okCount) / count,
      minMs: all.min,
      maxMs: all.max,
      meanMs: mean,
      stddevMs: Math.sqrt(all.variance()), // population, two-pass — see Histogram#variance
      percentiles: percentilesOf(all, opts.percentiles),
      throughputRps: opts.windowMs === 0 ? 0 : (count / opts.windowMs) * 1000,
      histogramOk,
      histogramKo,
    };
  }
}
