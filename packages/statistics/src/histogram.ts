/** Wire format tag stored in `run_stat.histogram_kind`. Bump on any layout change. */
export const HISTOGRAM_KIND = 'sparse-ms-v1' as const;

/**
 * Observations above this fold into a single overflow bin. 120s is above any
 * realistic HTTP timeout, so the loss is theoretical; the bin exists so a
 * pathological run degrades loudly (countBelow throws) instead of silently.
 */
export const DEFAULT_HISTOGRAM_CAP_MS = 120_000;

export interface HistogramSnapshot {
  total: number;
  min: number;
  max: number;
  sum: number;
  overflowCount: number;
}

function writeUvarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readUvarint(buf: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 1;
  for (;;) {
    const byte = buf[pos.i++];
    if (byte === undefined) throw new Error('Histogram: truncated varint');
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 128;
  }
}

/**
 * An exact, sparse, one-millisecond-resolution histogram.
 *
 * Response times are integer milliseconds, so 1 ms bins are lossless — which is
 * what lets indicator bands and Gatling's distribution bins be computed at read
 * time at ANY bounds, exactly. The DDSketch beside it cannot do this: its bins
 * are logarithmic (~2% wide), so the bin straddling 800 ms cannot be split.
 *
 * Size is bounded by DISTINCT OBSERVED VALUES, not by range.
 */
export class Histogram {
  #bins = new Map<number, number>();
  #capMs: number;
  #total = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;
  #overflowCount = 0;

  constructor(opts: { capMs?: number } = {}) {
    this.#capMs = opts.capMs ?? DEFAULT_HISTOGRAM_CAP_MS;
  }

  /** Negative durations are a upstream data fault; clamp to 0 rather than corrupt the key space. */
  accept(valueMs: number): void {
    const v = Math.max(0, Math.round(valueMs));
    this.#total++;
    this.#sum += v;
    if (v < this.#min) this.#min = v;
    if (v > this.#max) this.#max = v;
    if (v > this.#capMs) {
      this.#overflowCount++;
      return;
    }
    this.#bins.set(v, (this.#bins.get(v) ?? 0) + 1);
  }

  merge(other: Histogram): void {
    for (const [v, c] of other.#bins) this.#bins.set(v, (this.#bins.get(v) ?? 0) + c);
    this.#total += other.#total;
    this.#sum += other.#sum;
    this.#overflowCount += other.#overflowCount;
    if (other.#min < this.#min) this.#min = other.#min;
    if (other.#max > this.#max) this.#max = other.#max;
  }

  get total(): number { return this.#total; }
  get sum(): number { return this.#sum; }
  get overflowCount(): number { return this.#overflowCount; }
  get capMs(): number { return this.#capMs; }
  get min(): number { return this.#total === 0 ? 0 : this.#min; }
  get max(): number { return this.#total === 0 ? 0 : this.#max; }

  countAt(valueMs: number): number { return this.#bins.get(valueMs) ?? 0; }

  /** Ascending by value. */
  *entries(): IterableIterator<readonly [number, number]> {
    for (const v of [...this.#bins.keys()].sort((a, b) => a - b)) {
      yield [v, this.#bins.get(v) as number] as const;
    }
  }

  /**
   * Exact count of observations strictly below `boundMs`.
   *
   * Throws when the bound sits above the cap and an overflow bin exists: the
   * answer would be a guess, and a band count that silently guesses is exactly
   * the defect this class replaced.
   */
  countBelow(boundMs: number): number {
    if (this.#overflowCount > 0 && boundMs > this.#capMs) {
      throw new Error(
        `Histogram: countBelow(${boundMs}) crosses the ${this.#capMs}ms overflow bin (${this.#overflowCount} observations); the exact count is unrecoverable.`,
      );
    }
    let n = 0;
    for (const [v, c] of this.#bins) if (v < boundMs) n += c;
    return n;
  }

  /**
   * The value at quantile `q`, EXACTLY — nearest-rank, `sorted[ceil(q·n) − 1]`.
   *
   * ═══ THE CONVENTION IS NOT A DETAIL ═══
   *
   * `Sketch#quantile` goes to considerable trouble to re-express its query so
   * DDSketch's internal `q * (count - 1)` arithmetic resolves to this same
   * index, because every ground-truth computation in this repo's tests uses it.
   * A histogram quantile on the linear-interpolation convention would differ by
   * one rank position on identical data — and since a windowed statistics row
   * reads histograms while the unwindowed row reads sketches, that difference
   * would surface as a percentile that shifts when a reader brushes to the
   * whole run. It would look like a windowing bug and would not be one.
   *
   * ═══ THE OVERFLOW BIN ═══
   *
   * Throws when the rank lands beyond the cap, matching `countBelow`: the value
   * is genuinely unrecoverable there, and a percentile that silently guesses is
   * the defect this class exists to avoid. Only the ranks the overflow actually
   * covers are refused — a p50 below the cap is still answered when the p99 is
   * not, because refusing every quantile would throw away answers we have.
   */
  quantile(q: number): number {
    if (this.#total === 0) return NaN;
    const index = Math.min(this.#total - 1, Math.max(0, Math.ceil(q * this.#total) - 1));

    // Every counted observation sits below the cap; the overflow is the tail.
    const counted = this.#total - this.#overflowCount;
    if (index >= counted) {
      throw new Error(
        `Histogram: quantile(${q}) lands in the ${this.#capMs}ms overflow bin ` +
          `(${this.#overflowCount} observations); the exact value is unrecoverable.`,
      );
    }

    let seen = 0;
    for (const [value, count] of this.entries()) {
      seen += count;
      if (seen > index) return value;
    }
    return this.max;
  }

  /**
   * `Σ(value² × count)`, for an exact standard deviation over any merged set.
   *
   * A walk rather than a running total, so it stays correct through `merge` and
   * `deserialize` without a third field to keep in step. The bins are the
   * state; everything else is derived from them.
   */
  sumOfSquares(): number {
    let total = 0;
    for (const [value, count] of this.entries()) total += value * value * count;
    return total;
  }

  snapshot(): HistogramSnapshot {
    return {
      total: this.total, min: this.min, max: this.max,
      sum: this.sum, overflowCount: this.overflowCount,
    };
  }

  serialize(): Uint8Array {
    const out: number[] = [1];                       // version
    writeUvarint(out, this.#capMs);
    const sorted = [...this.entries()];
    writeUvarint(out, sorted.length);
    let prev = 0;
    for (const [v, c] of sorted) {
      writeUvarint(out, v - prev);                   // delta; first entry is its own value
      writeUvarint(out, c);
      prev = v;
    }
    writeUvarint(out, this.#total);
    writeUvarint(out, this.#sum);
    writeUvarint(out, this.#overflowCount);
    writeUvarint(out, this.#total === 0 ? 0 : this.#min);
    writeUvarint(out, this.#total === 0 ? 0 : this.#max);
    return Uint8Array.from(out);
  }

  static deserialize(buf: Uint8Array): Histogram {
    const pos = { i: 0 };
    const version = buf[pos.i++];
    if (version !== 1) throw new Error(`Histogram: unsupported version ${String(version)}`);
    const capMs = readUvarint(buf, pos);
    const h = new Histogram({ capMs });
    const n = readUvarint(buf, pos);
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = prev + readUvarint(buf, pos);
      h.#bins.set(v, readUvarint(buf, pos));
      prev = v;
    }
    // Restored explicitly, never re-derived from the bins: the overflow bin
    // holds observations the bins do not, so total/sum/max would all be wrong.
    h.#total = readUvarint(buf, pos);
    h.#sum = readUvarint(buf, pos);
    h.#overflowCount = readUvarint(buf, pos);
    const min = readUvarint(buf, pos);
    const max = readUvarint(buf, pos);
    h.#min = h.#total === 0 ? Number.POSITIVE_INFINITY : min;
    h.#max = h.#total === 0 ? Number.NEGATIVE_INFINITY : max;
    return h;
  }
}
