import { GATLING_MAX_PLOTS, distribution, gatlingStep } from './distribution.js';
import { Histogram } from './histogram.js';

/**
 * ═══ ONE DURATION SECTION OF GE'S REPORT, FROM STORED BUCKETS ═══
 * (GE report parity PR 2, Task 6)
 *
 * A TCP-connect, TLS-handshake or DNS-resolution section is the same three
 * figures over one (family, dimension): GE's 13 percentile rows per bucket over
 * time, a distribution over the whole selection, and a percentile curve. The
 * read endpoints hand this the buckets inside their window, so every figure is
 * of the window and nothing else.
 *
 * PURE, AND IT NEVER WRITES TO ITS INPUT. The histograms come from the reader
 * and the merges below are fresh ones, so a caller that reuses a bucket for a
 * second section reads the same values twice.
 */

/**
 * GE's 13 rows (spec §6), in GE's order: Min, 25, 50, 75, 80, 85, 90, 95, 99,
 * 99.9, 99.99, Max, Mean. `@perfportal/contracts`' `AGENT_PERCENTILE_ROWS` is
 * the same list — this package does not depend on contracts, so each side pins
 * the literal in its own test.
 */
export const AGENT_DURATION_ROW_KEYS = [
  'min', 'p25', 'p50', 'p75', 'p80', 'p85', 'p90', 'p95', 'p99', 'p99_9', 'p99_99', 'max', 'mean',
] as const;

/** The ranks between Min and Max, in row order. */
const ROW_RANKS = [25, 50, 75, 80, 85, 90, 95, 99, 99.9, 99.99] as const;

/** The percentile curve's x positions: 0, 2.5 … 97.5, then the tail at 99, 99.9, 99.99, and 100. */
export const AGENT_DURATION_CURVE_PERCENTILES: readonly number[] = [
  ...Array.from({ length: 40 }, (_, i) => i * 2.5),
  99, 99.9, 99.99, 100,
];

export interface DurationBucketInput {
  startOffsetMs: number;
  okCount: number;
  koCount: number;
  histogramOk: Histogram;
  histogramKo: Histogram;
}

/** The shape of `@perfportal/contracts`' `DurationSection`, structurally. */
export interface AgentDurationSection {
  overTime: { startOffsetMs: number; ok: number[] | null; ko: number[] | null; all: number[] | null }[];
  distribution: { offsetMs: number; stepMs: number; ok: number[]; ko: number[]; meanMs: number | null };
  percentiles: {
    ok: [number, number][];
    ko: [number, number][];
    all: [number, number][];
    meanMs: { ok: number | null; ko: number | null; all: number | null };
  };
  totals: { ok: number; ko: number };
}

function merged(...parts: Histogram[]): Histogram {
  const out = new Histogram();
  for (const h of parts) out.merge(h);
  return out;
}

const meanOf = (h: Histogram): number | null => (h.total === 0 ? null : h.sum / h.total);

/**
 * The 13 rows of one population, or null when it is empty: GE draws nothing
 * for a bucket a population did not reach, and a row of zeros would be a
 * measurement nobody took. Percentiles are nearest rank through
 * `Histogram#percentiles` (`nearestRankIndex`); Min and Max are its extremes.
 * An agent histogram is never a legacy overflow one, so no rank is refused.
 */
function rows(h: Histogram): number[] | null {
  if (h.total === 0) return null;
  const ranked = h.percentiles(ROW_RANKS).map((v) => v ?? h.max);
  return [h.min, ...ranked, h.max, h.sum / h.total];
}

function curve(h: Histogram): [number, number][] {
  if (h.total === 0) return [];
  const values = h.percentiles(AGENT_DURATION_CURVE_PERCENTILES);
  return AGENT_DURATION_CURVE_PERCENTILES.map((p, i): [number, number] => {
    // The endpoints are the extremes by definition, not by what a rank lands on.
    if (p === 0) return [p, h.min];
    if (p === 100) return [p, h.max];
    return [p, values[i] ?? h.max];
  });
}

/**
 * Gatling's distribution over the merged OK and KO populations, laid on a
 * uniform grid so a reader can place bin `i` at `offsetMs + i * stepMs`.
 *
 * `distribution`'s wide branch already is one: its labels are the midpoints of
 * `stepMs`-wide bins, so `offsetMs` is the first midpoint (each later label is
 * that plus `i * stepMs`, within Gatling's own rounding). Its narrow branch
 * ("use exact values", a range of 100 ms or less) labels each DISTINCT value,
 * which leaves gaps a grid cannot express — so that branch is spread here onto
 * every millisecond from the first value to the last, zeros between. The bars
 * are Gatling's; only the empty columns between them are drawn.
 */
function gridDistribution(ok: Histogram, ko: Histogram): AgentDurationSection['distribution'] {
  const d = distribution(ok, ko);
  const meanMs = meanOf(merged(ok, ko));
  if (d.labels.length === 0) return { offsetMs: 0, stepMs: 1, ok: [], ko: [], meanMs };
  const first = d.labels[0] as number;
  if (d.exactValues) {
    const last = d.labels[d.labels.length - 1] as number;
    const okBins = new Array<number>(last - first + 1).fill(0);
    const koBins = new Array<number>(last - first + 1).fill(0);
    d.labels.forEach((label, i) => {
      okBins[label - first] = d.okCount[i] as number;
      koBins[label - first] = d.koCount[i] as number;
    });
    return { offsetMs: first, stepMs: 1, ok: okBins, ko: koBins, meanMs };
  }
  const min = ok.total === 0 ? ko.min : ko.total === 0 ? ok.min : Math.min(ok.min, ko.min);
  const max = Math.max(ok.max, ko.max);
  return { offsetMs: first, stepMs: gatlingStep(min, max, GATLING_MAX_PLOTS), ok: d.okCount, ko: d.koCount, meanMs };
}

export function durationSection(buckets: readonly DurationBucketInput[]): AgentDurationSection {
  const sorted = [...buckets].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const okAll = merged(...sorted.map((b) => b.histogramOk));
  const koAll = merged(...sorted.map((b) => b.histogramKo));
  const all = merged(okAll, koAll);
  return {
    overTime: sorted.map((b) => ({
      startOffsetMs: b.startOffsetMs,
      ok: rows(b.histogramOk),
      ko: rows(b.histogramKo),
      all: rows(merged(b.histogramOk, b.histogramKo)),
    })),
    distribution: gridDistribution(okAll, koAll),
    percentiles: {
      ok: curve(okAll),
      ko: curve(koAll),
      all: curve(all),
      meanMs: { ok: meanOf(okAll), ko: meanOf(koAll), all: meanOf(all) },
    },
    totals: {
      ok: sorted.reduce((acc, b) => acc + b.okCount, 0),
      ko: sorted.reduce((acc, b) => acc + b.koCount, 0),
    },
  };
}
