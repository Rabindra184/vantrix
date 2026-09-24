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
  // Σx²/n − mean². Clamped at zero because floating-point cancellation can
  // make an exactly-uniform sample come out fractionally negative, and
  // Math.sqrt of that is NaN.
  const variance = Math.max(0, all.sumOfSquares() / count - mean * mean);

  return {
    count,
    okCount,
    koCount,
    errorRate: koCount / count,
    minMs: all.min,
    maxMs: all.max,
    meanMs: mean,
    stddevMs: Math.sqrt(variance),
    // A zero-length window cannot arrive through the API — `from >= to` is a
    // 400 — but a rate of Infinity leaking into a response is worse than a
    // guard nobody trips.
    throughputRps: windowMs > 0 ? count / (windowMs / 1000) : 0,
    percentiles: recoverablePercentiles(all, percentiles),
  };
}

/**
 * The percentiles this window can actually answer — OMITTING any whose rank
 * lands in the histogram's overflow bin, rather than letting that throw.
 *
 * ═══ WHY THE THROW IS RIGHT AND CATCHING IT HERE IS ALSO RIGHT ═══
 *
 * `Histogram#quantile` refuses a rank above the cap on purpose: the value is
 * genuinely unrecoverable and a percentile that silently guesses is the defect
 * that class exists to avoid. That reasoning is about the HISTOGRAM. It says
 * nothing about what a read handler should do with the refusal, and until this
 * function caught it the answer was "throw out of the request" — a 500 on
 * `GET /v1/runs/:id/stats?from=&to=` for a run whose UNWINDOWED page renders
 * perfectly, because that path reads the uncapped sketch instead.
 *
 * ═══ AND IT IS NOT THE PATHOLOGICAL RUN THE CAP'S COMMENT IMAGINED ═══
 *
 * 120 s is above any realistic HTTP timeout, which is true of REQUESTS and
 * false of the `group_duration` rows the same histograms hold: a group's
 * duration is its wall-clock span, so `group("Browse") { during(5.minutes) }`
 * — ordinary Gatling — produces 300 s observations. Measured on exactly that
 * shape, with a slowest REQUEST of 400 ms:
 *
 *     unwindowed  p50 300700   (the sketch, uncapped)
 *     windowed    THREW at p50 — every rank was in the overflow bin
 *
 * ═══ OMITTED, NOT GUESSED, AND NOT ZERO ═══
 *
 * `bucketLatency`'s `percentilesOf` already answers `{}` for a sketch with
 * nothing in it, on the same reasoning: "a p95 of 0 is a fabricated
 * observation for a bucket that made none". An unrecoverable p95 is the same
 * kind of non-answer, and `StatisticsTable` already renders a missing
 * percentile as a dash rather than as the fastest row in the column.
 *
 * The rest of the row is EXACT and survives: `Histogram#accept` updates
 * `#min`, `#max` and `#sum` BEFORE it folds an observation into the overflow
 * bin, so count, min, max, mean and standard deviation are all still the real
 * figures. The reader loses the estimated columns and keeps the measured ones,
 * which is the right half to lose.
 *
 * THE SIBLING DEFECT IS DONE, AND THIS NOTE USED TO SAY OTHERWISE. It read
 * "NOT DONE, AND RECORDED RATHER THAN MISSED: `bandsFrom` reaches
 * `Histogram#countBelow`, which throws on the same bin" — true when written and
 * fixed since: `bandsOrRefuse` in `metrics.controller.ts` converts that refusal
 * into a 400 naming `indicators.higherMs`, and BOTH the windowed and unwindowed
 * callers reach it, so `bandsFrom` has exactly one call site in the app.
 *
 * The reason that note gave for leaving it — that the band call needs an
 * indicator bound ABOVE the cap as well as an overflow observation, where this
 * path needs only the overflow — was correct, and it explained why no FIXTURE
 * reached it rather than whether the PRODUCT handled it. It did not: the
 * unwindowed path was already guarded and the windowed one was not, so this was
 * a fix that had landed on one of two callers. A deferral explaining why a test
 * cannot reach something has not established that the code survives it.
 */
function recoverablePercentiles(
  all: Histogram,
  percentiles: readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of percentiles) {
    // Asking is cheaper than re-deriving the rank arithmetic here, and asking
    // keeps ONE definition of which ranks the overflow covers — `quantile`'s.
    // A second copy of that boundary is how the two would come to disagree.
    try {
      out[`p${p}`] = all.quantile(p / 100);
    } catch {
      // Unrecoverable at this rank. The key is absent, never 0.
    }
  }
  return out;
}
