import { Histogram } from './histogram.js';
import { Sketch } from './sketch.js';

export interface Bucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  /**
   * The START-edge outcome split, for requests/s (G-23). `okCount`/`koCount`
   * above are the END-edge split and belong to responses/s; a request that
   * starts in one bucket and fails in the next contributes its KO to
   * `startedKoCount` here and to `koCount` one bucket later.
   */
  startedOkCount: number;
  startedKoCount: number;
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
  /**
   * The same observations `sketchOk`/`sketchKo` hold, in a form a TIME WINDOW
   * can merge.
   *
   * Both are kept rather than one replacing the other. The sketch is what
   * `run_stat` already stores for the whole run and what K-03 recomputes
   * percentiles from; these are what a sub-range is re-aggregated from, and
   * they are a different trade. Measured: a DDSketch protobuf costs 1068 bytes
   * for a SINGLE observation because its store is dense, while this costs 12 —
   * and its quantiles are exact rather than within RELATIVE_ACCURACY.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
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
        okCount: 0, koCount: 0, startedOkCount: 0, startedKoCount: 0,
        sketch: new Sketch(), sketchOk: new Sketch(), sketchKo: new Sketch(),
        histogramOk: new Histogram(), histogramKo: new Histogram(),
      };
      this.#buckets.set(idx, b);
    }
    if (edge === 'start') {
      b.startedCount++;
      // The START-edge split. okCount/koCount below are the END-edge split and
      // belong to responses/s; requests/s is bucketed by start time, exactly
      // like the sketches immediately below (G-23).
      if (ok) b.startedOkCount++; else b.startedKoCount++;
      // Sketches are fed on the START edge, not the end, to match Gatling.
      // Gatling's RequestPercentilesBuffers.updateRequestPercentilesBuffers
      // (gatling-charts, buffers/RequestPercentilesBuffers.scala) files every
      // percentile/scatter observation under `startBucket` — the bucket
      // derived from the request's START time. A request starting at 10.9s
      // and finishing at 11.2s therefore belongs to Gatling's bucket 10, not
      // 11. Feeding the sketch on 'end' instead shifts every
      // percentiles-over-time and scatter point that straddles a bucket
      // boundary. The caller (engine.ts) always passes the same value/ok on
      // both edges, so this only changes WHICH bucket the sketch lands in.
      b.sketch.accept(value);
      if (ok) b.sketchOk.accept(value); else b.sketchKo.accept(value);
      // Same edge, same condition as the split above — which is what makes
      // histogramOk.total equal startedOkCount, the invariant the persisted
      // column is checked against at every layer.
      if (ok) b.histogramOk.accept(value); else b.histogramKo.accept(value);
    } else {
      b.endedCount++;
      if (ok) b.okCount++; else b.koCount++;
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
          target.startedOkCount += b.startedOkCount;
          target.startedKoCount += b.startedKoCount;
          target.sketch.merge(b.sketch);      // exact — this is why coalescing is lossless
          target.sketchOk.merge(b.sketchOk);
          target.sketchKo.merge(b.sketchKo);
          target.histogramOk.merge(b.histogramOk);   // exact, like the sketches
          target.histogramKo.merge(b.histogramKo);
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
