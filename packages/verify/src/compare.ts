import { AGENT_PERCENTILE_RANKS, agentPercentileFigure, type AgentPopulationFigures, type ExpectedAgentDuration, type ExpectedAgentMetric } from './agent.js';
import type {
  Comparison,
  Expected,
  ExpectedError,
  ExpectedErrorBucket,
  ExpectedSeriesBucket,
  ExpectedStat,
  ExpectedUserBucket,
  FigureMismatch,
  Stored,
  StoredSeriesBucket,
} from './figures.js';

/**
 * ═══ ONE LEDGER, ONE COMPARATOR PER TABLE ═══
 *
 * `compare` runs every comparator in `COMPARATORS` over one `Ledger`. A
 * comparator owns one table: it pairs expected and stored rows by their key
 * (`matchRows`) and checks each figure through the ledger, which counts it and
 * records a mismatch. Each metric table — stats, series buckets, errors,
 * error buckets, users — and the run's two spans has one comparator in that
 * list, and so do the two agent tables (below).
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

type SeriesKeyed = Pick<ExpectedSeriesBucket, 'scope' | 'name' | 'family' | 'startOffsetMs'>;

const seriesKey = (b: SeriesKeyed): string => `${b.scope}\u0000${b.name}\u0000${b.family}\u0000${String(b.startOffsetMs)}`;

const seriesPlace = (b: SeriesKeyed): RowPlace => ({
  table: 'run_series_bucket',
  scope: b.scope,
  name: b.name,
  family: b.family,
  bucket: b.startOffsetMs,
});

/** Its edges: what a reader needs to recognise a bucket that is present on one side only. */
const edgesOf = (b: Pick<ExpectedSeriesBucket, 'startedCount' | 'endedCount'>): number => b.startedCount + b.endedCount;

/**
 * `run_series_bucket`, keyed `(scope, name, family, start_offset_ms)`. Per
 * paired bucket: the six counts (population null), min/max/mean over the
 * start-edge observations (population `'all'`), and the three percentile
 * maps — `percentiles` as `'all'`, `percentiles_ok` as `'ok'`,
 * `percentiles_ko` as `'ko'`; the population is what tells `p95` of one map
 * from `p95` of another. A bucket on one side only is one `row` mismatch,
 * carrying its edge count (`started_count + ended_count`). A stored column
 * that is null is compared like any other value — a null map as an empty one,
 * so each figure the expected map holds is reported against null.
 */
export const compareSeries: Comparator = (expected, stored, ledger) => {
  matchRows<ExpectedSeriesBucket, StoredSeriesBucket>(expected.series, stored.series, seriesKey, {
    both(e, s) {
      const at = seriesPlace(e);
      ledger.exact(at, 'started_count', null, s.startedCount, e.startedCount);
      ledger.exact(at, 'ended_count', null, s.endedCount, e.endedCount);
      ledger.exact(at, 'ok_count', null, s.okCount, e.okCount);
      ledger.exact(at, 'ko_count', null, s.koCount, e.koCount);
      ledger.exact(at, 'started_ok_count', null, s.startedOkCount, e.startedOkCount);
      ledger.exact(at, 'started_ko_count', null, s.startedKoCount, e.startedKoCount);
      ledger.exact(at, 'min_ms', 'all', s.minMs, e.minMs);
      ledger.exact(at, 'max_ms', 'all', s.maxMs, e.maxMs);
      ledger.close(at, 'mean_ms', 'all', s.meanMs, e.meanMs);
      ledger.exactMap(at, 'all', s.percentiles, e.percentiles);
      ledger.exactMap(at, 'ok', s.percentilesOk ?? {}, e.percentilesOk);
      ledger.exactMap(at, 'ko', s.percentilesKo ?? {}, e.percentilesKo);
    },
    missing(e) {
      ledger.row(seriesPlace(e), null, edgesOf(e));
    },
    extra(s) {
      ledger.row(seriesPlace(s), edgesOf(s), null);
    },
  });
};

/*
 * ═══ ERROR ROWS: WHERE THE MESSAGE GOES, AND THE OTHER ROW'S KEY ═══
 *
 * `FigureMismatch` has no message field, and an error row has no family, so
 * a mismatch on an error row carries its MESSAGE as its `family` — the third
 * coordinate of the row, as the family is of a stat row. The `is_other` row
 * carries `''`, which no real row can: a real label is the message or
 * `'(no message)'`, never empty.
 *
 * Rows are KEYED with `is_other` in the key, though: the other row by
 * `(scope, name, other)` and a real row by `(scope, name, its message)`, so a
 * stored real row whose message is `''` can never pair with the other row.
 * The other row's message is then checked as a figure of its own (`message`,
 * which must be `''`).
 *
 * A stored REAL row whose message is `''` therefore reports its mismatches
 * under family `''`, the same label the other row's carry. That is accepted
 * rather than disambiguated: the engine writes `'(no message)'` for an empty
 * message (`NO_MESSAGE`), so only a corrupted row can hold `''`, its key still
 * differs from the other row's, and the row it labels is itself the defect.
 */

const familyOf = (r: Pick<ExpectedError, 'isOther' | 'message'>): string => (r.isOther ? '' : r.message);

const errorKey = (r: Pick<ExpectedError, 'scope' | 'name' | 'isOther' | 'message'>): string =>
  r.isOther ? `${r.scope}\u0000${r.name}\u0000other` : `${r.scope}\u0000${r.name}\u0000message\u0000${r.message}`;

const errorPlace = (r: Pick<ExpectedError, 'scope' | 'name' | 'isOther' | 'message'>): RowPlace => ({
  table: 'run_error',
  scope: r.scope,
  name: r.name,
  family: familyOf(r),
  bucket: null,
});

/**
 * `run_error`: `count` per row, and an other row's `message`. A row on one
 * side only is one `row` mismatch carrying its count.
 */
export const compareErrors: Comparator = (expected, stored, ledger) => {
  matchRows<ExpectedError, ExpectedError>(expected.errors, stored.errors, errorKey, {
    both(e, s) {
      const at = errorPlace(e);
      ledger.exact(at, 'count', null, s.count, e.count);
      if (e.isOther) ledger.exact(at, 'message', null, s.message, e.message);
    },
    missing(e) {
      ledger.row(errorPlace(e), null, e.count);
    },
    extra(s) {
      ledger.row(errorPlace(s), s.count, null);
    },
  });
};

type ErrorBucketKeyed = Pick<ExpectedErrorBucket, 'startOffsetMs' | 'isOther' | 'message'>;

const errorBucketKey = (b: ErrorBucketKeyed): string =>
  b.isOther ? `${String(b.startOffsetMs)}\u0000other` : `${String(b.startOffsetMs)}\u0000message\u0000${b.message}`;

const errorBucketPlace = (b: ErrorBucketKeyed): RowPlace => ({
  table: 'run_error_bucket',
  scope: 'run',
  name: '',
  family: familyOf(b),
  bucket: b.startOffsetMs,
});

/**
 * `run_error_bucket`, run scope only, keyed `(start_offset_ms, other)` or
 * `(start_offset_ms, message)`: `count` and `bucket_width_ms` per row, and an
 * other row's `message`. A row on one side only is one `row` mismatch
 * carrying its count.
 */
export const compareErrorBuckets: Comparator = (expected, stored, ledger) => {
  matchRows<ExpectedErrorBucket, ExpectedErrorBucket>(expected.errorBuckets, stored.errorBuckets, errorBucketKey, {
    both(e, s) {
      const at = errorBucketPlace(e);
      ledger.exact(at, 'count', null, s.count, e.count);
      ledger.exact(at, 'bucket_width_ms', null, s.bucketWidthMs, e.bucketWidthMs);
      if (e.isOther) ledger.exact(at, 'message', null, s.message, e.message);
    },
    missing(e) {
      ledger.row(errorBucketPlace(e), null, e.count);
    },
    extra(s) {
      ledger.row(errorBucketPlace(s), s.count, null);
    },
  });
};

type UserKeyed = Pick<ExpectedUserBucket, 'scenario' | 'startOffsetMs'>;

const userKey = (b: UserKeyed): string => `${b.scenario}\u0000${String(b.startOffsetMs)}`;

const userPlace = (b: UserKeyed): RowPlace => ({
  table: 'run_user_bucket',
  scope: 'scenario',
  name: b.scenario,
  family: '',
  bucket: b.startOffsetMs,
});

/**
 * `run_user_bucket`, keyed `(scenario, start_offset_ms)`: `started`, `ended`
 * and `max_concurrent`. A bucket on one side only is one `row` mismatch
 * carrying its `max_concurrent` — a gap-filled bucket has no starts or ends,
 * so its concurrency is what a reader recognises it by.
 */
export const compareUsers: Comparator = (expected, stored, ledger) => {
  matchRows<ExpectedUserBucket, ExpectedUserBucket>(expected.users, stored.users, userKey, {
    both(e, s) {
      const at = userPlace(e);
      ledger.exact(at, 'started', null, s.started, e.started);
      ledger.exact(at, 'ended', null, s.ended, e.ended);
      ledger.exact(at, 'max_concurrent', null, s.maxConcurrent, e.maxConcurrent);
    },
    missing(e) {
      ledger.row(userPlace(e), null, e.maxConcurrent);
    },
    extra(s) {
      ledger.row(userPlace(s), s.maxConcurrent, null);
    },
  });
};

/*
 * ═══ THE AGENT TABLES: WHERE EACH COORDINATE GOES ═══
 *
 * `FigureMismatch` was shaped for statistics rows, so an agent row lays its key
 * into the same three slots, most general first, as `rowLabel` reads them:
 *
 *   run_agent_duration_bucket   scope = family (`tcp_connect` …), name = dim
 *                               (a remote, a hostname or `*`), family = ''
 *   run_agent_metric_bucket     scope = metric (`bw.bits` …), name = dim,
 *                               family = label (`out`, `200`, a collector …)
 *
 * and `bucket` is the row's start offset. Every agent figure is an integer both
 * sides compute from the same records, so every comparison is EXACT.
 *
 * `run_agent` holds one checked figure, `bucket_width_ms` (scope `run`, no
 * name, family or bucket): the width the stored rows were laid on, against the
 * width the verifier derived from simulation.log itself (`runSeriesWidth`).
 * The expected rows are built on the DERIVED width, so a wrong stored width
 * reads twice — on this figure, and on every row it misplaced.
 *
 * All three comparators run only when the expected side carries agent figures (the
 * worker sets both sides together, for a collected run alone); a stored side
 * left absent then is compared as empty, so every expected row reads missing.
 */

/** `run_agent`: the one figure, `bucket_width_ms`. */
export const compareAgentSummary: Comparator = (expected, stored, ledger) => {
  if (expected.agent === undefined) return;
  const at: RowPlace = { table: 'run_agent', scope: 'run', name: '', family: '', bucket: null };
  ledger.exact(at, 'bucket_width_ms', null, stored.agent?.bucketWidthMs ?? null, expected.agent.bucketWidthMs);
};

type AgentDurationKeyed = Pick<ExpectedAgentDuration, 'family' | 'dim' | 'startOffsetMs'>;

const agentDurationKey = (b: AgentDurationKeyed): string => `${b.family}\u0000${b.dim}\u0000${String(b.startOffsetMs)}`;

const agentDurationPlace = (b: AgentDurationKeyed): RowPlace => ({
  table: 'run_agent_duration_bucket',
  scope: b.family,
  name: b.dim,
  family: '',
  bucket: b.startOffsetMs,
});

/** count, min, max, sum and the 10 GE percentiles of one population; every value null for an empty one. */
function populationFigures(p: AgentPopulationFigures | null): [string, number | null][] {
  return [
    ['count', p?.count ?? null],
    ['min', p?.min ?? null],
    ['max', p?.max ?? null],
    ['sum', p?.sum ?? null],
    ...AGENT_PERCENTILE_RANKS.map((rank, i): [string, number | null] => [agentPercentileFigure(rank), p?.percentiles[i] ?? null]),
  ];
}

function comparePopulation(
  ledger: Ledger,
  at: RowPlace,
  population: 'ok' | 'ko',
  stored: AgentPopulationFigures | null,
  recomputed: AgentPopulationFigures | null,
): void {
  // Both empty: nothing was measured and nothing is stored, so there is no figure to check.
  if (stored === null && recomputed === null) return;
  const want = populationFigures(recomputed);
  const have = populationFigures(stored);
  for (let i = 0; i < want.length; i += 1) ledger.exact(at, want[i]![0], population, have[i]![1], want[i]![1]);
}

/**
 * `run_agent_duration_bucket`, keyed `(family, dim, start_offset_ms)`: the two
 * count columns, then each population's figures as the stored histogram
 * answers them. A row on one side only is one `row` mismatch carrying its
 * total count.
 */
export const compareAgentDurations: Comparator = (expected, stored, ledger) => {
  if (expected.agent === undefined) return;
  matchRows<ExpectedAgentDuration, ExpectedAgentDuration>(expected.agent.durations, stored.agent?.durations ?? [], agentDurationKey, {
    both(e, s) {
      const at = agentDurationPlace(e);
      ledger.exact(at, 'ok_count', null, s.okCount, e.okCount);
      ledger.exact(at, 'ko_count', null, s.koCount, e.koCount);
      comparePopulation(ledger, at, 'ok', s.ok, e.ok);
      comparePopulation(ledger, at, 'ko', s.ko, e.ko);
    },
    missing(e) {
      ledger.row(agentDurationPlace(e), null, e.okCount + e.koCount);
    },
    extra(s) {
      ledger.row(agentDurationPlace(s), s.okCount + s.koCount, null);
    },
  });
};

type AgentMetricKeyed = Pick<ExpectedAgentMetric, 'metric' | 'dim' | 'label' | 'startOffsetMs'>;

const agentMetricKey = (m: AgentMetricKeyed): string =>
  `${m.metric}\u0000${m.dim}\u0000${m.label}\u0000${String(m.startOffsetMs)}`;

const agentMetricPlace = (m: AgentMetricKeyed): RowPlace => ({
  table: 'run_agent_metric_bucket',
  scope: m.metric,
  name: m.dim,
  family: m.label,
  bucket: m.startOffsetMs,
});

/**
 * `run_agent_metric_bucket`, keyed `(metric, dim, label, start_offset_ms)`:
 * `value`. A row on one side only is one `row` mismatch carrying its value.
 */
export const compareAgentMetrics: Comparator = (expected, stored, ledger) => {
  if (expected.agent === undefined) return;
  matchRows<ExpectedAgentMetric, ExpectedAgentMetric>(expected.agent.metrics, stored.agent?.metrics ?? [], agentMetricKey, {
    both(e, s) {
      ledger.exact(agentMetricPlace(e), 'value', null, s.value, e.value);
    },
    missing(e) {
      ledger.row(agentMetricPlace(e), null, e.value);
    },
    extra(s) {
      ledger.row(agentMetricPlace(s), s.value, null);
    },
  });
};

export const COMPARATORS: readonly Comparator[] = [
  compareStats,
  compareSeries,
  compareErrors,
  compareErrorBuckets,
  compareUsers,
  compareRun,
  compareAgentSummary,
  compareAgentDurations,
  compareAgentMetrics,
];

export function compare(expected: Expected, stored: Stored): Comparison {
  const ledger = new Ledger();
  for (const c of COMPARATORS) c(expected, stored, ledger);
  return { figuresChecked: ledger.figuresChecked, mismatches: ledger.mismatches };
}
