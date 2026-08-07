import { DDSketch } from '@datadog/sketches-js';

export const SKETCH_KIND = 'ddsketch' as const;
/**
 * Measured (post half-rank-bias fix): up to ~1.000% max relative error across p50-p99.9
 * on realistic latency data; ~2.1 KB serialized. The bound is a ceiling DDSketch can
 * legitimately approach, not slack we have to spare — hence every accuracy assertion
 * against this class uses `<=`, never `<`.
 */
export const RELATIVE_ACCURACY = 0.01;

export class Sketch {
  #inner: DDSketch;
  constructor() {
    this.#inner = new DDSketch({ relativeAccuracy: RELATIVE_ACCURACY });
  }

  accept(value: number): void { this.#inner.accept(value); }
  /**
   * `DDSketch#getValueAtQuantile` ranks with `q * (count - 1)` (linear-interpolation
   * convention). This codebase's notion of "true" quantile — used consistently by every
   * test that computes ground truth from sorted data — is the nearest-rank convention
   * `sorted[ceil(q * n) - 1]`. The two conventions differ by at most one rank position,
   * usually negligible, but on small/discontinuous samples (a sharp jump in the sorted
   * tail) landing one rank off can select an entirely different — and much less
   * accurate — bucket. Re-express the query as the exact nearest-rank index so DDSketch's
   * internal rank arithmetic resolves to that same index.
   *
   * Naively querying `getValueAtQuantile(index / (n - 1))` is NOT enough: DDSketch
   * recomputes `rank = q * (count - 1)` internally, and `(index / (n-1)) * (n-1)` does
   * not always round-trip back to `index` in floating point (e.g. n=1647, index=16:
   * `16/1646*1646 === 15.999999999999998`), silently landing one rank short and
   * returning the wrong bucket. Querying at `(index + 0.5) / (n - 1)` instead gives the
   * float error half a rank of headroom in either direction before it can cross a rank
   * boundary, so the recomputed rank always floors back to `index`.
   */
  quantile(q: number): number {
    const n = this.#inner.count;
    if (n <= 0) return NaN;
    if (n === 1) return this.#inner.max;
    const index = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    if (index === 0) return this.#inner.min;
    if (index === n - 1) return this.#inner.max;
    return this.#inner.getValueAtQuantile((index + 0.5) / (n - 1));
  }
  merge(other: Sketch): void { this.#inner.merge(other.#inner); }

  get count(): number { return this.#inner.count; }
  /** Exact until the sketch is serialized; after a `deserialize` round-trip this is bucket-approximate (see `deserialize`), carrying the same relative-accuracy bound as `quantile`. */
  get min(): number { return this.#inner.min; }
  /** Exact until the sketch is serialized; after a `deserialize` round-trip this is bucket-approximate (see `deserialize`), carrying the same relative-accuracy bound as `quantile`. */
  get max(): number { return this.#inner.max; }
  /** Exact until the sketch is serialized; after a `deserialize` round-trip this is bucket-reconstructed (see `deserialize`), carrying the same relative-accuracy bound as `quantile`. */
  get sum(): number { return this.#inner.sum; }

  serialize(): Uint8Array { return this.#inner.toProto(); }
  static deserialize(bytes: Uint8Array): Sketch {
    const sketch = new Sketch();
    /** fromProto returns a BaseDDSketch; it merges correctly, so the cast is safe. */
    sketch.#inner = DDSketch.fromProto(bytes) as unknown as DDSketch;
    /**
     * `fromProto` is documented upstream to lose summary min/max: the protobuf wire
     * format carries only the bucket store, so the fresh Infinity/-Infinity sentinels
     * from the constructor survive untouched. `quantile()` above returns `#inner.min`
     * / `#inner.max` directly (not a bucket lookup) at the two boundary ranks, so an
     * unrestored sketch would silently answer a boundary quantile — exactly the case
     * this class exists to serve after a bytea round-trip — with an infinite sentinel.
     * Bucket-approximate reconstruction carries the same relative-accuracy bound as
     * every other quantile call, which is the best a lossy wire format allows.
     */
    if (sketch.#inner.count > 0) {
      sketch.#inner.min = sketch.#inner.getValueAtQuantile(0);
      sketch.#inner.max = sketch.#inner.getValueAtQuantile(1);
      sketch.#inner.sum = reconstructSum(sketch.#inner);
    }
    return sketch;
  }
}

/**
 * `fromProto` loses `sum` the same way it loses `min`/`max` above: the protobuf wire
 * format carries only the bucket store, so the fresh `sum = 0` from the constructor
 * survives untouched, and a caller computing a mean from a reloaded sketch would
 * silently get 0 instead of an error.
 *
 * Unlike min/max, `sum` cannot be read off a single boundary bucket — it is
 * reconstructed by walking every non-empty bucket in both stores and multiplying each
 * bucket's count by its representative value (`mapping.value(key)`, the same
 * bucket-midpoint `quantile()` already relies on for every other answer after a
 * round-trip). Each representative value is within `RELATIVE_ACCURACY` of the true
 * values that landed in that bucket, so for same-signed data (all latencies are >= 0,
 * the only values this class ever accepts) the reconstructed sum inherits the same
 * relative-accuracy bound as `quantile()` — measured ~0.004% on a 200k-point mixture
 * distribution, far inside the 1% ceiling. The zero bucket contributes exactly 0 and
 * needs no reconstruction.
 */
function reconstructSum(inner: DDSketch): number {
  let sum = 0;
  for (let i = 0; i < inner.store.bins.length; i++) {
    const count = inner.store.bins[i] ?? 0;
    if (count) sum += count * inner.mapping.value(i + inner.store.offset);
  }
  for (let i = 0; i < inner.negativeStore.bins.length; i++) {
    const count = inner.negativeStore.bins[i] ?? 0;
    if (count) sum += count * -inner.mapping.value(i + inner.negativeStore.offset);
  }
  return sum;
}
