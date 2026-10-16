import { Histogram } from './histogram.js';

export interface WindowRollup {
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  percentiles: Record<string, number>;
}

/**
 * One statistics row for a time window, from the merged bucket histograms.
 *
 * ═══ EVERY COLUMN FROM ONE SOURCE ═══
 *
 * Not a mixture, and that is the point. The stored `ended_count`/`ok_count`
 * columns are the END-edge split; these histograms are the START-edge one. A
 * row that took its counts from the columns and its percentiles from the
 * histograms would describe two different sets of requests inside a single
 * line of a table — the count of one, the shape of another. A windowed row
 * describes the requests that STARTED in the window, all the way across.
 *
 * ═══ `windowMs` IS THE SNAPPED WINDOW, NOT THE RUN ═══
 *
 * Dividing by the run's duration would leave throughput unchanged as a reader
 * brushes, which is the single most visible thing a re-aggregation has to get
 * right: Gatling's own table moves from 900 requests to 455 and its rate moves
 * with it.
 */
export function rollupFromHistograms(
  ok: Histogram,
  ko: Histogram,
  windowMs: number,
  percentiles: readonly number[],
): WindowRollup {
  const okCount = ok.total;
  const koCount = ko.total;
  const count = okCount + koCount;

  if (count === 0) {
    // Zeros rather than NaN: a window dragged over an idle stretch is a
    // legitimate question, and `0 requests` is its legitimate answer.
    return {
      count: 0, okCount: 0, koCount: 0, errorRate: 0,
      minMs: 0, maxMs: 0, meanMs: 0, stddevMs: 0, throughputRps: 0,
      percentiles: {},
    };
  }

  // Merged into a FRESH histogram rather than mutating either input: `merge`
  // is destructive, and the caller still needs the OK-only set to fold the
  // indicator bands from. Folding a merged histogram would silently count KO
  // durations as response-time bands.
  const all = new Histogram();
  all.merge(ok);
  all.merge(ko);

  const mean = all.sum / count;

  return {
    count,
    okCount,
    koCount,
    errorRate: koCount / count,
    minMs: all.min,
    maxMs: all.max,
    meanMs: mean,
    // Population, two-pass over the sorted bins (Histogram#variance) — the
    // same computation the batch row makes, so a full-extent window agrees
    // with it to the bit.
    stddevMs: Math.sqrt(all.variance()),
    // A zero-length window cannot arrive through the API — `from >= to` is a
    // 400 — but a rate of Infinity leaking into a response is worse than a
    // guard nobody trips.
    throughputRps: windowMs > 0 ? count / (windowMs / 1000) : 0,
    percentiles: recoverablePercentiles(all, percentiles),
  };
}

/**
 * The percentiles this window can actually answer — OMITTING any whose rank
 * lands in a legacy histogram's overflow bin, rather than reporting a guess.
 *
 * New histograms (`sparse-ms-v2`) are uncapped and never overflow, so every
 * rank is answered exactly. Legacy v1 rows can still carry an overflow bin;
 * the ranks it hides stay absent, never 0, and `StatisticsTable` renders the
 * missing key as a dash while count, min, max and mean stay exact. (The
 * deviation omits the overflowed observations' spread — `Histogram#variance`.)
 */
function recoverablePercentiles(all: Histogram, percentiles: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const values = all.percentiles(percentiles); // one walk for the whole set
  percentiles.forEach((p, i) => {
    const value = values[i];
    if (value !== undefined) out[`p${p}`] = value; // absent, never 0, for a legacy overflowed rank
  });
  return out;
}
