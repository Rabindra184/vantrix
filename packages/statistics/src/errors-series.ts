/**
 * A run's failures on a time axis, one count per (bucket, message).
 *
 * ═══ WHY THIS IS NOT PART OF `ErrorRollup` ═══
 *
 * `ErrorRollup` is the flat total behind the errors table, and it is correct as
 * it stands. Giving it a second, differently-scoped responsibility — one that
 * INCLUDES warm-up where the flat one excludes it, and folds at five where the
 * flat one folds at two hundred — would make both harder to read than two small
 * classes are.
 *
 * ═══ WHY THE WIDTH IS AN ARGUMENT TO `finish` ═══
 *
 * Errors are sparse. `BucketSeries` halves resolution on its count of OCCUPIED
 * buckets, so a structure bucketing only failures halves far less often than
 * the run's response-time series does. Two consequences, both bad:
 *
 *   - Two charts on one page at two resolutions, which invites a reader to
 *     compare a 1000 ms error bar against a 4000 ms response bar.
 *
 *   - `inferBucketWidthMs` reads the SMALLEST GAP between offsets, which is
 *     right for a dense series and systematically wrong for a sparse one:
 *     three errors at 5 s, 40 s and 90 s infer a width of 35 000 ms.
 *
 * So the caller passes the run series' final width and this coalesces up to it.
 * That is always possible, and always exact: an error is recorded at the same
 * `endMs` the run series receives on its 'end' edge, so error buckets are a
 * SUBSET of run buckets at every width; given the same `maxBuckets` cap the run
 * series therefore never halves later, and the coalesce is a merge of counts
 * rather than an impossible split. `engine.ts` passes `maxBucketsRun` for
 * exactly this reason — a different cap breaks the argument.
 */

/**
 * Five named messages, so five plus the folded remainder fills the categorical
 * palette exactly.
 *
 * `apps/web`'s `MAX_CATEGORICAL_SERIES` is six and there is no seventh —
 * `assignPalette` leaves an excess series UNDRAWN. A sixth named message would
 * therefore push `other` off the chart silently.
 *
 * The two numbers cannot share a constant: this package depends only on
 * `@perfportal/core` and `apps/web` only on `@perfportal/contracts`, and adding
 * a dependency to carry one integer is not worth it. `apps/web/test` asserts
 * the relationship from its side instead.
 */
export const ERROR_SERIES_KEEP = 5;

/**
 * How many DISTINCT messages are tracked in the time dimension before further
 * new ones fold on arrival. Matches `ErrorRollup.top()`'s limit.
 *
 * ═══ THIS MAKES THE TOP FIVE A BOUNDED APPROXIMATION, NOT AN EXACT RANKING ═══
 *
 * Admission is FIRST-SEEN. So on a run with more than this many distinct
 * messages, one that first appears after the cap is reached folds into `other`
 * however often it then occurs — including when it is the run's single most
 * frequent failure. That is a real limitation, and it is chosen rather than
 * overlooked. `errors-series.test.ts` pins it as a regression case.
 *
 * THE OBVIOUS FIX IS WORSE. Evicting a weak tracked message and promoting the
 * newcomer once its running total overtakes cannot recover the newcomer's
 * per-bucket counts from before the promotion — those are already folded into
 * `other`. Its curve would begin mid-run and understate its own height. A
 * series that is consistently absent is honest; a series drawn at the wrong
 * magnitude is not, and nothing on the chart tells the reader which it is
 * looking at.
 *
 * Exact ranking WITH per-bucket curves needs both to come from the same
 * tracked set, which means tracking every message — and this structure is
 * `distinct messages × occupied buckets`, against the flat rollup's `distinct`.
 *
 * WHAT SURVIVES EITHER WAY: whatever folds still lands in `other`, so a
 * bucket's drawn total continues to reconcile exactly with its `koCount`. The
 * failures are never lost, only unattributed — and the errors table beside the
 * chart still lists every message with its true total.
 */
const MAX_TRACKED_MESSAGES = 200;

export interface ErrorSeriesRow {
  startOffsetMs: number;
  /** `null` is the folded remainder, NOT a message that happens to be absent. */
  message: string | null;
  count: number;
}

export interface ErrorSeriesResult {
  bucketWidthMs: number;
  rows: ErrorSeriesRow[];
}

interface ErrorBucket {
  counts: Map<string, number>;
  /** Failures the tracking cap turned away. Folded into `other` at finish. */
  overflow: number;
}

export class ErrorSeries {
  readonly #startMs: number;
  readonly #maxBuckets: number;
  #widthMs = 1000;
  #buckets = new Map<number, ErrorBucket>();
  #tracked = new Set<string>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  get widthMs(): number {
    return this.#widthMs;
  }

  add(tsMs: number, message: string): void {
    const idx = Math.floor((tsMs - this.#startMs) / this.#widthMs);
    let bucket = this.#buckets.get(idx);
    if (!bucket) {
      bucket = { counts: new Map(), overflow: 0 };
      this.#buckets.set(idx, bucket);
    }

    if (this.#tracked.has(message) || this.#tracked.size < MAX_TRACKED_MESSAGES) {
      this.#tracked.add(message);
      bucket.counts.set(message, (bucket.counts.get(message) ?? 0) + 1);
    } else {
      bucket.overflow += 1;
    }

    while (this.#buckets.size > this.#maxBuckets) this.#halve();
  }

  /** Merges adjacent bucket pairs and doubles the width. Lossless: counts sum. */
  #halve(): void {
    const next = new Map<number, ErrorBucket>();
    for (const [idx, b] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
      const ni = Math.floor(idx / 2);
      const target = next.get(ni);
      if (!target) {
        next.set(ni, b);
        continue;
      }
      for (const [message, count] of b.counts) {
        target.counts.set(message, (target.counts.get(message) ?? 0) + count);
      }
      target.overflow += b.overflow;
    }
    this.#buckets = next;
    this.#widthMs *= 2;
  }

  finish(widthMs: number, keep: number = ERROR_SERIES_KEEP): ErrorSeriesResult {
    // Up only. A request for a NARROWER width cannot happen (see the file
    // docstring), and clamping rather than throwing keeps a broken invariant
    // from failing a whole ingest for one chart — the returned width is the
    // real one, so the chart stays self-consistent either way.
    while (this.#widthMs < widthMs) this.#halve();

    // Run-wide totals, computed AFTER coalescing so the ranking is over final
    // buckets. Per-bucket ranking would make a series appear and vanish
    // depending on which message happened to lead in each bucket.
    const totals = new Map<string, number>();
    for (const bucket of this.#buckets.values()) {
      for (const [message, count] of bucket.counts) {
        totals.set(message, (totals.get(message) ?? 0) + count);
      }
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, keep)
      .map(([message]) => message);
    const kept = new Set(top);

    const rows: ErrorSeriesRow[] = [];
    for (const [idx, bucket] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
      const startOffsetMs = idx * this.#widthMs;
      // In global rank order, so a bucket's rows read the same way everywhere.
      for (const message of top) {
        const count = bucket.counts.get(message);
        if (count !== undefined) rows.push({ startOffsetMs, message, count });
      }
      let other = bucket.overflow;
      for (const [message, count] of bucket.counts) if (!kept.has(message)) other += count;
      // No zero row: a fold that folded nothing is not a measurement.
      if (other > 0) rows.push({ startOffsetMs, message: null, count: other });
    }

    return { bucketWidthMs: this.#widthMs, rows };
  }
}
