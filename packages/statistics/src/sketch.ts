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
  get min(): number { return this.#inner.min; }
  get max(): number { return this.#inner.max; }
  get sum(): number { return this.#inner.sum; }

  serialize(): Uint8Array { return this.#inner.toProto(); }
  static deserialize(bytes: Uint8Array): Sketch {
    const sketch = new Sketch();
    /** fromProto returns a BaseDDSketch; it merges correctly, so the cast is safe. */
    sketch.#inner = DDSketch.fromProto(bytes) as unknown as DDSketch;
    return sketch;
  }
}
