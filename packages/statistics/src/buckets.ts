import { Histogram } from './histogram.js';

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
  /**
   * Exact 1 ms histograms, split by status. Gatling's percentiles-over-time
   * chart is OK-only (its title is literally "Response Time Percentiles over
   * Time (OK)") and its response-time-vs-throughput scatter is two independent
   * series, each from its own status-filtered population; their merge is the
   * combined view. A TIME WINDOW re-aggregates a sub-range by merging these,
   * and a merge is exact — so every figure a bucket reports is exact too.
   */
  histogramOk: Histogram;
  histogramKo: Histogram;
}

/**
 * Starts at 1-second buckets and halves resolution in place whenever the count
 * exceeds maxBuckets. Because histogram merges are exact, coalescing is lossless.
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
        histogramOk: new Histogram(), histogramKo: new Histogram(),
      };
      this.#buckets.set(idx, b);
    }
    if (edge === 'start') {
      b.startedCount++;
      // The START-edge split. okCount/koCount below are the END-edge split and
      // belong to responses/s; requests/s is bucketed by start time, exactly
      // like the histograms immediately below (G-23).
      if (ok) b.startedOkCount++; else b.startedKoCount++;
      // Histograms are fed on the START edge, not the end, to match Gatling.
      // Gatling's RequestPercentilesBuffers.updateRequestPercentilesBuffers
      // (gatling-charts, buffers/RequestPercentilesBuffers.scala) files every
      // percentile/scatter observation under `startBucket` — the bucket
      // derived from the request's START time. A request starting at 10.9s
      // and finishing at 11.2s therefore belongs to Gatling's bucket 10, not
      // 11. Feeding the histograms on 'end' instead shifts every
      // percentiles-over-time and scatter point that straddles a bucket
      // boundary. The caller (engine.ts) always passes the same value/ok on
      // both edges, so this only changes WHICH bucket an observation lands in.
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
          target.histogramOk.merge(b.histogramOk);   // exact — this is why coalescing is lossless
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
