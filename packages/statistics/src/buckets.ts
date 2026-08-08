import { Sketch } from './sketch.js';

export interface Bucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  sketch: Sketch;
  /**
   * Status-filtered sketches. Gatling's percentiles-over-time chart is OK-only
   * (its title is literally "Response Time Percentiles over Time (OK)") and its
   * response-time-vs-throughput scatter is two independent series, each from its
   * own status-filtered digest. `sketch` above spans BOTH and is retained for
   * the combined view; it is not a substitute for these.
   */
  sketchOk: Sketch;
  sketchKo: Sketch;
}

/**
 * Starts at 1-second buckets and halves resolution in place whenever the count
 * exceeds maxBuckets. Because DDSketch merges are exact, coalescing is lossless.
 */
export class BucketSeries {
  #startMs: number;
  #maxBuckets: number;
  #widthMs = 1000;
  #buckets = new Map<number, Bucket>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  get widthMs(): number { return this.#widthMs; }

  add(tsMs: number, value: number, ok: boolean, edge: 'start' | 'end'): void {
    const idx = Math.floor((tsMs - this.#startMs) / this.#widthMs);
    let b = this.#buckets.get(idx);
    if (!b) {
      b = {
        startOffsetMs: idx * this.#widthMs, startedCount: 0, endedCount: 0,
        okCount: 0, koCount: 0,
        sketch: new Sketch(), sketchOk: new Sketch(), sketchKo: new Sketch(),
      };
      this.#buckets.set(idx, b);
    }
    if (edge === 'start') {
      b.startedCount++;
    } else {
      b.endedCount++;
      if (ok) b.okCount++; else b.koCount++;
      b.sketch.accept(value);
      if (ok) b.sketchOk.accept(value); else b.sketchKo.accept(value);
    }
    if (this.#buckets.size > this.#maxBuckets) this.#coalesce();
  }

  #coalesce(): void {
    while (this.#buckets.size > this.#maxBuckets) {
      const next = new Map<number, Bucket>();
      const newWidth = this.#widthMs * 2;
      for (const [idx, b] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
        const ni = Math.floor(idx / 2);
        const target = next.get(ni);
        if (!target) {
          next.set(ni, { ...b, startOffsetMs: ni * newWidth });
        } else {
          target.startedCount += b.startedCount;
          target.endedCount += b.endedCount;
          target.okCount += b.okCount;
          target.koCount += b.koCount;
          target.sketch.merge(b.sketch);      // exact — this is why coalescing is lossless
          target.sketchOk.merge(b.sketchOk);
          target.sketchKo.merge(b.sketchKo);
        }
      }
      this.#buckets = next;
      this.#widthMs = newWidth;
    }
  }

  buckets(): Bucket[] {
    return [...this.#buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  }
}

/**
 * The bucket width of a persisted series.
 *
 * run_series_bucket stores start_offset_ms but not the width, and the width is
 * not always 1000: BucketSeries halves resolution in place once a run exceeds
 * its bucket cap. The scatter's x-axis is a RATE, so dividing by the wrong
 * width silently scales every point.
 *
 * The smallest positive gap, not the first gap: a bucket with no observations
 * is absent from the table, so consecutive offsets can be two widths apart.
 */
export function inferBucketWidthMs(offsets: number[]): number {
  let width = Number.POSITIVE_INFINITY;
  for (let i = 1; i < offsets.length; i++) {
    const gap = (offsets[i] as number) - (offsets[i - 1] as number);
    if (gap > 0 && gap < width) width = gap;
  }
  return Number.isFinite(width) ? width : 1000;
}
