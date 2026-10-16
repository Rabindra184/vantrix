import type { Comparison, Expected, ExpectedStat, FigureMismatch, Stored } from './figures.js';

/**
 * ═══ ONE LEDGER, ONE COMPARATOR PER TABLE ═══
 *
 * `compare` runs every comparator in `COMPARATORS` over one `Ledger`. A
 * comparator owns one table: it pairs expected and stored rows by their key
 * (`matchRows`) and checks each figure through the ledger, which counts it and
 * records a mismatch. Series buckets, errors, error buckets and users (Tasks
 * 3 and 4) are each one more comparator in that list; nothing here changes
 * for them.
 *
 * TOLERANCE. Counts, extremes and percentiles are integers both sides compute
 * from the same observations, so they must be EQUAL. A mean, a standard
 * deviation, a throughput and an error rate are float arithmetic whose result
 * can depend on the order of summation, so they agree to 1e-9 relative —
 * absolute when the expected value is 0, where a relative bound means nothing.
 */

export const RELATIVE_TOLERANCE = 1e-9;

/** Where a figure lives: everything in a `FigureMismatch` except the figure itself. */
export interface RowPlace {
  table: FigureMismatch['table'];
  scope: string;
  name: string;
  family: string;
  bucket: number | null;
}

export type Population = FigureMismatch['population'];

function closeEnough(stored: number, recomputed: number): boolean {
  if (recomputed === 0) return Math.abs(stored) <= RELATIVE_TOLERANCE;
  return Math.abs(stored - recomputed) <= RELATIVE_TOLERANCE * Math.abs(recomputed);
}

export class Ledger {
  figuresChecked = 0;
  readonly mismatches: FigureMismatch[] = [];

  #record(place: RowPlace, figure: string, population: Population, stored: FigureMismatch['stored'], recomputed: FigureMismatch['recomputed']): void {
    this.mismatches.push({
      scope: place.scope,
      name: place.name,
      family: place.family,
      population,
      bucket: place.bucket,
      table: place.table,
      figure,
      stored,
      recomputed,
    });
  }

  /** A figure that must be identical: a count, an extreme, a percentile, a label. */
  exact(place: RowPlace, figure: string, population: Population, stored: number | string | null, recomputed: number | string | null): void {
    this.figuresChecked += 1;
    if (stored !== recomputed) this.#record(place, figure, population, stored, recomputed);
  }

  /** A float figure, within `RELATIVE_TOLERANCE`. */
  close(place: RowPlace, figure: string, population: Population, stored: number, recomputed: number): void {
    this.figuresChecked += 1;
    if (!closeEnough(stored, recomputed)) this.#record(place, figure, population, stored, recomputed);
  }

  /**
   * A row present on one side only: ONE figure, ONE mismatch, however many
   * figures the row would have carried. The present side carries something
   * that identifies it to a reader (a stat row's count, say); the absent side
   * is null.
   */
  row(place: RowPlace, stored: number | string | null, recomputed: number | string | null): void {
    this.figuresChecked += 1;
    this.#record(place, 'row', null, stored, recomputed);
  }

  /**
   * A keyed map of figures (a percentile set): the union of the keys, each
   * compared exactly, a key on one side only reported with null on the other.
   */
  exactMap(place: RowPlace, population: Population, stored: Record<string, number>, recomputed: Record<string, number>): void {
    const keys = [...new Set([...Object.keys(recomputed), ...Object.keys(stored)])].sort(byPercentileKey);
    for (const k of keys) this.exact(place, k, population, stored[k] ?? null, recomputed[k] ?? null);
  }
}

/** `p50` before `p99.9` before `p100`, by the number they name; anything else by text. */
function byPercentileKey(a: string, b: string): number {
  const na = Number(a.slice(1));
  const nb = Number(b.slice(1));
  if (a.startsWith('p') && b.startsWith('p') && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pair two row lists by key, in key order. A duplicate key on either side is
 * a row too many and is reported as missing or extra, never silently dropped.
 */
export function matchRows<E, S>(
  expected: readonly E[],
  stored: readonly S[],
  keyOf: (row: E | S) => string,
  handle: { both(e: E, s: S): void; missing(e: E): void; extra(s: S): void },
): void {
  const want = new Map<string, E[]>();
  for (const e of expected) want.set(keyOf(e), [...(want.get(keyOf(e)) ?? []), e]);
  const have = new Map<string, S[]>();
  for (const s of stored) have.set(keyOf(s), [...(have.get(keyOf(s)) ?? []), s]);

  const keys = [...new Set([...want.keys(), ...have.keys()])].sort();
  for (const k of keys) {
    const es = want.get(k) ?? [];
    const ss = have.get(k) ?? [];
    const paired = Math.min(es.length, ss.length);
    for (let i = 0; i < paired; i += 1) handle.both(es[i]!, ss[i]!);
    for (let i = paired; i < es.length; i += 1) handle.missing(es[i]!);
    for (let i = paired; i < ss.length; i += 1) handle.extra(ss[i]!);
  }
}

export type Comparator = (expected: Expected, stored: Stored, ledger: Ledger) => void;

const statKey = (r: Pick<ExpectedStat, 'scope' | 'name' | 'family'>): string => `${r.scope}\u0000${r.name}\u0000${r.family}`;

const statPlace = (r: Pick<ExpectedStat, 'scope' | 'name' | 'family'>): RowPlace => ({
  table: 'run_stat',
  scope: r.scope,
  name: r.name,
  family: r.family,
  bucket: null,
});

/** `run_stat`: nine scalar figures and the percentile set, per row. */
export const compareStats: Comparator = (expected, stored, ledger) => {
  matchRows(expected.stats, stored.stats, statKey, {
    both(e, s) {
      const at = statPlace(e);
      ledger.exact(at, 'count', null, s.count, e.count);
      ledger.exact(at, 'ok_count', null, s.okCount, e.okCount);
      ledger.exact(at, 'ko_count', null, s.koCount, e.koCount);
      ledger.close(at, 'error_rate', null, s.errorRate, e.errorRate);
      ledger.exact(at, 'min_ms', 'all', s.minMs, e.minMs);
      ledger.exact(at, 'max_ms', 'all', s.maxMs, e.maxMs);
      ledger.close(at, 'mean_ms', 'all', s.meanMs, e.meanMs);
      ledger.close(at, 'stddev_ms', 'all', s.stddevMs, e.stddevMs);
      ledger.close(at, 'throughput_rps', null, s.throughputRps, e.throughputRps);
      ledger.exactMap(at, 'all', s.percentiles, e.percentiles);
    },
    missing(e) {
      ledger.row(statPlace(e), null, e.count);
    },
    extra(s) {
      ledger.row(statPlace(s), s.count, null);
    },
  });
};

/** The two `run` columns. */
export const compareRun: Comparator = (expected, stored, ledger) => {
  const at: RowPlace = { table: 'run', scope: 'run', name: '', family: '', bucket: null };
  ledger.exact(at, 'duration_ms', null, stored.run.durationMs, expected.run.durationMs);
  ledger.exact(at, 'activity_ms', null, stored.run.activityMs, expected.run.activityMs);
};

/** Tasks 3 and 4 append their comparators here. */
export const COMPARATORS: readonly Comparator[] = [compareStats, compareRun];

export function compare(expected: Expected, stored: Stored): Comparison {
  const ledger = new Ledger();
  for (const c of COMPARATORS) c(expected, stored, ledger);
  return { figuresChecked: ledger.figuresChecked, mismatches: ledger.mismatches };
}
