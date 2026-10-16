import { nearestRankIndex } from './rank.js';

/** Wire format tag stored in `run_stat.histogram_kind`. Bump on any layout change. */
export const HISTOGRAM_KIND = 'sparse-ms-v2' as const;

/**
 * Histograms written before 2026-10-15 (`sparse-ms-v1`) folded observations
 * above this into one overflow bin. New histograms are uncapped: a sparse
 * 1 ms structure costs one entry per DISTINCT observed value, so a 300 s
 * group duration costs the same as a 3 ms response. Kept only to read v1.
 *
 * The cap was a real loss, not a theoretical one: a group's duration is its
 * wall-clock span, so `group("Browse") { during(5.minutes) { … } }` — ordinary
 * Gatling — produced 300 s observations, every rank of which landed in the
 * overflow bin. A v1 row read today still carries that bin, and the ranks it
 * hides stay unrecoverable (`percentile` answers `undefined` for them).
 */
export const LEGACY_V1_CAP_MS = 120_000;

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
 * time at ANY bounds, exactly. A DDSketch cannot do this: its bins are
 * logarithmic (~2% wide), so the bin straddling 800 ms cannot be split.
 *
 * Size is bounded by DISTINCT OBSERVED VALUES, not by range.
 */
export class Histogram {
  #bins = new Map<number, number>();
  /** Infinite for every new histogram; only a v1 read carries a finite cap. */
  #capMs: number = Number.POSITIVE_INFINITY;
  #exact = true;
  #total = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;
  #overflowCount = 0;

  constructor() {}

  /** True unless this histogram was read from `sparse-ms-v1` bytes. */
  get exact(): boolean { return this.#exact; }

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
    // A legacy input makes the merge legacy: its overflow bin hides ranks, and
    // the cap below which its bins are exact is the narrowest one merged in.
    if (!other.#exact) this.#exact = false;
    this.#capMs = Math.min(this.#capMs, other.#capMs);
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
   * Only a LEGACY v1 histogram can throw: when the bound sits above its cap
   * and an overflow bin exists, the answer would be a guess, and a band count
   * that silently guesses is exactly the defect this class replaced. A new
   * histogram has no cap, so the comparison below is never true for it.
   */
  countBelow(boundMs: number): number {
    if (this.#overflowCount > 0 && boundMs > this.#capMs) {
      throw new Error(
        `Histogram: countBelow(${boundMs}) crosses the legacy ${this.#capMs}ms overflow bin (${this.#overflowCount} observations); the exact count is unrecoverable.`,
      );
    }
    let n = 0;
    for (const [v, c] of this.#bins) if (v < boundMs) n += c;
    return n;
  }

  /**
   * The nearest-rank value at percentile `p` (0–100), exactly — see
   * `nearestRankIndex`. `undefined` when empty, or when a LEGACY v1 overflow
   * bin hides the rank (that value is unrecoverable, and an absent key is
   * the honest answer; `StatisticsTable` already renders it as a dash).
   *
   * ═══ THE CONVENTION IS NOT A DETAIL ═══
   *
   * Nearest-rank, `sorted[⌈p/100 × n⌉ − 1]`, computed on integers by
   * `nearestRankIndex` — the ONE rank formula, so a windowed row and a
   * whole-run row cannot disagree by a rank position on identical data. That
   * disagreement would look like a windowing bug and would not be one.
   *
   * Only the ranks a legacy overflow actually covers are refused — a p50
   * below the cap is still answered when the p99 is not, because refusing
   * every percentile would throw away answers we have.
   */
  percentile(p: number): number | undefined {
    const index = nearestRankIndex(p, this.#total);
    if (index < 0) return undefined;
    // Every counted observation sits below a legacy cap; the overflow is the tail.
    if (index >= this.#total - this.#overflowCount) return undefined;
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

  /** Always `sparse-ms-v2`: version 2, entries, total, sum, min, max. */
  serialize(): Uint8Array {
    if (this.#overflowCount > 0) {
      throw new Error('Histogram: a legacy v1 histogram with an overflow bin cannot be re-serialized');
    }
    const out: number[] = [2];                       // version
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
    writeUvarint(out, this.#total === 0 ? 0 : this.#min);
    writeUvarint(out, this.#total === 0 ? 0 : this.#max);
    return Uint8Array.from(out);
  }

  /**
   * Reads both formats. v1 (`sparse-ms-v1`) carries a cap after the version
   * byte and an overflow count after the sum; v2 carries neither. A v1 read is
   * marked not `exact`.
   */
  static deserialize(buf: Uint8Array): Histogram {
    const pos = { i: 0 };
    const version = buf[pos.i++];
    if (version !== 1 && version !== 2) throw new Error(`Histogram: unsupported version ${String(version)}`);
    const h = new Histogram();
    if (version === 1) {
      h.#capMs = readUvarint(buf, pos);
      h.#exact = false;
    }
    const n = readUvarint(buf, pos);
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const v = prev + readUvarint(buf, pos);
      h.#bins.set(v, readUvarint(buf, pos));
      prev = v;
    }
    // Restored explicitly, never re-derived from the bins: a v1 overflow bin
    // holds observations the bins do not, so total/sum/max would all be wrong.
    h.#total = readUvarint(buf, pos);
    h.#sum = readUvarint(buf, pos);
    h.#overflowCount = version === 1 ? readUvarint(buf, pos) : 0;
    const min = readUvarint(buf, pos);
    const max = readUvarint(buf, pos);
    h.#min = h.#total === 0 ? Number.POSITIVE_INFINITY : min;
    h.#max = h.#total === 0 ? Number.NEGATIVE_INFINITY : max;
    return h;
  }

  /** Test-only: the exact v1 bytes the pre-2026-10-15 writer produced. */
  static legacyV1ForTests(values: readonly number[]): Uint8Array {
    const bins = new Map<number, number>();
    let overflow = 0, sum = 0, min = Infinity, max = -Infinity;
    for (const raw of values) {
      const v = Math.max(0, Math.round(raw));
      sum += v; min = Math.min(min, v); max = Math.max(max, v);
      if (v > LEGACY_V1_CAP_MS) overflow++; else bins.set(v, (bins.get(v) ?? 0) + 1);
    }
    const out: number[] = [1];
    writeUvarint(out, LEGACY_V1_CAP_MS);
    const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
    writeUvarint(out, sorted.length);
    let prev = 0;
    for (const [v, c] of sorted) { writeUvarint(out, v - prev); writeUvarint(out, c); prev = v; }
    writeUvarint(out, values.length);
    writeUvarint(out, sum);
    writeUvarint(out, overflow);
    writeUvarint(out, values.length === 0 ? 0 : min);
    writeUvarint(out, values.length === 0 ? 0 : max);
    return Uint8Array.from(out);
  }
}
