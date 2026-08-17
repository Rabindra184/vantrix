import type { MetricFamily, MetricScope } from '@perfportal/core';
import { Histogram } from './histogram.js';
import { Sketch } from './sketch.js';

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
  /** A projection of `sketch`, exact at this scope. Aggregation merges `sketch`, never these. */
  percentiles: Record<string, number>;
  throughputRps: number;
  sketch: Sketch;
  /**
   * Exact 1ms histograms, split by status because Gatling renders OK and KO as
   * separate distribution series. `All` is their merge, which is exact.
   * The sketch above spans BOTH statuses; do not conflate the two.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
}

export class RollupBuilder {
  #sketch = new Sketch();
  #histOk = new Histogram();
  #histKo = new Histogram();
  #count = 0;
  #ok = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;
  #mean = 0;
  #m2 = 0;                        // Welford

  add(durationMs: number, ok: boolean): void {
    this.#count++;
    if (ok) this.#ok++;
    if (durationMs < this.#min) this.#min = durationMs;
    if (durationMs > this.#max) this.#max = durationMs;
    const delta = durationMs - this.#mean;
    this.#mean += delta / this.#count;
    this.#m2 += delta * (durationMs - this.#mean);
    this.#sketch.accept(durationMs);
    if (ok) this.#histOk.accept(durationMs); else this.#histKo.accept(durationMs);
  }

  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
    /**
     * Hand back COPIES of the sketch and histograms rather than the live
     * accumulators.
     *
     * Off by default: a batch fold finishes once and never touches the builder
     * again, so copying would be pure cost. A LIVE fold keeps going after the
     * snapshot, and a snapshot that aliases the accumulator would mutate under
     * whoever is serializing it — a state that existed at no instant.
     *
     * Lossless: DDSketch and Histogram merges are exact, which is the same
     * property that makes BucketSeries coalescing lossless.
     */
    clone?: boolean;
  }): StatRollup {
    const percentiles: Record<string, number> = {};
    for (const p of opts.percentiles) percentiles[`p${p}`] = this.#sketch.quantile(p / 100);

    const copyOf = <T extends { merge(other: T): void }>(src: T, empty: T): T => {
      empty.merge(src);
      return empty;
    };

    return {
      scope: opts.scope,
      name: opts.name,
      family: opts.family,
      count: this.#count,
      okCount: this.#ok,
      koCount: this.#count - this.#ok,
      errorRate: this.#count === 0 ? 0 : (this.#count - this.#ok) / this.#count,
      minMs: this.#count === 0 ? 0 : this.#min,
      maxMs: this.#count === 0 ? 0 : this.#max,
      meanMs: this.#mean,
      stddevMs: this.#count === 0 ? 0 : Math.sqrt(this.#m2 / this.#count),
      percentiles,
      throughputRps: opts.windowMs === 0 ? 0 : (this.#count / opts.windowMs) * 1000,
      sketch: opts.clone ? copyOf(this.#sketch, new Sketch()) : this.#sketch,
      histogramOk: opts.clone ? copyOf(this.#histOk, new Histogram()) : this.#histOk,
      histogramKo: opts.clone ? copyOf(this.#histKo, new Histogram()) : this.#histKo,
    };
  }
}
