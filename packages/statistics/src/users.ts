export interface UserBucket {
  startOffsetMs: number;
  started: number;
  ended: number;
  /** Peak concurrency reached at any instant inside this bucket. */
  maxConcurrent: number;
}

interface Delta { tsMs: number; delta: 1 | -1 }

/**
 * Per-scenario user arrival rate (G-26) and concurrency (G-18).
 *
 * These are different quantities and Gatling charts them separately: a constant
 * arrival rate produces a RISING concurrency curve when the service slows, and
 * that divergence is the signal an engineer looks for.
 *
 * Events are buffered and sorted before sweeping, because concurrency depends on
 * ordering and a tool's log is only approximately ordered. The buffer is one
 * entry per user event - orders of magnitude fewer than request events.
 */
export class UserSeries {
  #startMs: number;
  #maxBuckets: number;
  #events = new Map<string, Delta[]>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  add(scenario: string, kind: 'start' | 'end', tsMs: number): void {
    let list = this.#events.get(scenario);
    if (!list) { list = []; this.#events.set(scenario, list); }
    list.push({ tsMs, delta: kind === 'start' ? 1 : -1 });
  }

  scenarios(): { scenario: string; bucketWidthMs: number; buckets: UserBucket[] }[] {
    const out: { scenario: string; bucketWidthMs: number; buckets: UserBucket[] }[] = [];
    for (const [scenario, events] of this.#events) {
      const { widthMs, buckets } = this.#sweep(events);
      out.push({ scenario, bucketWidthMs: widthMs, buckets });
    }
    return out.sort((a, b) => a.scenario.localeCompare(b.scenario));
  }

  // Each scenario sweeps and coalesces INDEPENDENTLY -- its own event count
  // decides when its own buckets cross `#maxBuckets`, so two scenarios in the
  // same run can (and in an imbalanced simulation, do) settle on different
  // widths. `widthMs` is therefore returned per scenario, not once for the
  // whole series; a caller that needs one number for several scenarios must
  // decide how to reduce them, not assume they already agree.
  #sweep(events: Delta[]): { widthMs: number; buckets: UserBucket[] } {
    // Starts before ends at the same instant, so a user who starts and ends in
    // the same millisecond still contributes 1 to the peak rather than 0.
    const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs || b.delta - a.delta);
    let width = 1000;
    let buckets = new Map<number, UserBucket>();
    let concurrent = 0;

    for (const e of sorted) {
      const idx = Math.floor((e.tsMs - this.#startMs) / width);
      let b = buckets.get(idx);
      if (!b) {
        b = { startOffsetMs: idx * width, started: 0, ended: 0, maxConcurrent: concurrent };
        buckets.set(idx, b);
      }
      if (e.delta === 1) { b.started++; concurrent++; } else { b.ended++; concurrent--; }
      if (concurrent > b.maxConcurrent) b.maxConcurrent = concurrent;
    }

    // Buckets with no user event still carry the standing concurrency, so a long
    // steady phase does not read as a gap.
    if (buckets.size > 0) {
      const indices = [...buckets.keys()].sort((a, b) => a - b);
      const first = indices[0] as number;
      const last = indices[indices.length - 1] as number;
      let standing = 0;
      for (let i = first; i <= last; i++) {
        const b = buckets.get(i);
        if (b) {
          standing = standing + b.started - b.ended;
        } else {
          buckets.set(i, { startOffsetMs: i * width, started: 0, ended: 0, maxConcurrent: standing });
        }
      }
    }

    while (buckets.size > this.#maxBuckets) {
      const next = new Map<number, UserBucket>();
      const newWidth = width * 2;
      for (const [idx, b] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
        const ni = Math.floor(idx / 2);
        const target = next.get(ni);
        if (!target) {
          next.set(ni, { ...b, startOffsetMs: ni * newWidth });
        } else {
          target.started += b.started;
          target.ended += b.ended;
          // Peak of a wider window is the peak of its parts - correct because
          // each part's maxConcurrent is already an instantaneous peak.
          if (b.maxConcurrent > target.maxConcurrent) target.maxConcurrent = b.maxConcurrent;
        }
      }
      buckets = next;
      width = newWidth;
    }

    return { widthMs: width, buckets: [...buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs) };
  }
}
