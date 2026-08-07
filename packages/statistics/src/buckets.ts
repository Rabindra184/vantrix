import { Sketch } from './sketch.js';

export interface Bucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  sketch: Sketch;
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
      b = { startOffsetMs: idx * this.#widthMs, startedCount: 0, endedCount: 0, okCount: 0, koCount: 0, sketch: new Sketch() };
      this.#buckets.set(idx, b);
    }
    if (edge === 'start') { b.startedCount++; return; }
    b.endedCount++;
    if (ok) b.okCount++; else b.koCount++;
    b.sketch.accept(value);
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
