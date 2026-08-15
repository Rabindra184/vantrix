/**
 * The cohort query behind `GET /v1/runs/:id/trends`.
 *
 * ═══ WHY EVERY PART OF THE JOIN PREDICATE IS THERE ═══
 *
 * `run_stat` has a UNIQUE index on (run_id, scope, name, family)
 * — `run_stat_run_id_scope_name_family_key`. Filtering ALL FOUR is what makes
 * this join return exactly one row per run.
 *
 * Joining on `scope = 'run'` alone would fan out the moment a run carries a
 * run-scope row for a second family, and the failure mode is both silent and
 * ugly: the same run appears twice in the trend, at the same timestamp, with
 * different numbers — which reads as a regression that happened instantly and
 * reverted instantly. The reference run has exactly one run-scope row today
 * (`family = 'response_time'`), so nothing would catch this until a run with a
 * `latency` roll-up arrived.
 *
 * `name = ''` is the run-scope row's own name, not a placeholder for one.
 * `family = 'response_time'` is the family the statistics table already treats
 * as the run's totals.
 *
 * ═══ IS NOT DISTINCT FROM ═══
 *
 * `simulation = $3` is WRONG for the NULL cohort. In SQL `NULL = NULL` is
 * NULL, not true, so a run with no simulation name would match no rows at all
 * — including itself, which would give it an empty trend containing neither
 * the run being asked about nor any of its peers. `IS NOT DISTINCT FROM` is
 * the operator that treats two NULLs as equal, and it is exactly the
 * equivalence class the design asks for.
 *
 * ═══ ONLY TERMINAL RUNS ═══
 *
 * A `pending` or `parsing` run has no `run_stat` row, so the inner join
 * already excludes it. `status = 'complete'` is stated anyway for two reasons:
 * it makes the intent readable at the query rather than inferable from a join,
 * and it excludes a `failed` run, which CAN carry partial stats and would put
 * a spurious dip in the trend.
 *
 * ═══ ORDERING ═══
 *
 * `COALESCE(tool_started_at, started_at) DESC` is the same effective ordering
 * key `RunRepository.list` uses, so a trend and the run list cannot disagree
 * about what "most recent" means. Newest first; the chart transform reverses,
 * because a trend reads left-to-right in time.
 *
 * No index covers (project_id, simulation, COALESCE(...)). Neither does
 * `RunRepository.list`'s ordering, and for a cohort of a few hundred runs the
 * sort is cheap. If a project ever holds enough runs for this to matter the
 * fix is an index, not a different query — written down so the next reader
 * does not have to rediscover which it was.
 */

/** The cohort's rows, newest first, capped. */
export const TRENDS_SQL = `
  SELECT r.id, r.started_at, r.tool_started_at, r.duration_ms, r.verdict,
         s.count, s.ok_count, s.ko_count, s.error_rate,
         s.min_ms, s.max_ms, s.mean_ms, s.throughput_rps, s.percentiles
    FROM run r
    JOIN run_stat s
      ON s.run_id = r.id
     AND s.org_id = r.org_id
     AND s.project_id = r.project_id
     AND s.scope = 'run'
     AND s.name = ''
     AND s.family = 'response_time'
   WHERE r.org_id = $1 AND r.project_id = $2
     AND r.simulation IS NOT DISTINCT FROM $3
     AND r.status = 'complete'
   ORDER BY COALESCE(r.tool_started_at, r.started_at) DESC, r.id DESC
   LIMIT $4`;

/**
 * The same predicate, counted.
 *
 * ITS OWN QUERY RATHER THAN A WINDOW FUNCTION. `COUNT(*) OVER ()` alongside
 * the rows would be one round trip, but it is evaluated against the result set
 * the LIMIT produced — so a cohort of sixty read twenty at a time would report
 * its size as twenty, which is precisely the number this column exists to
 * contradict.
 */
export const COHORT_SIZE_SQL = `
  SELECT COUNT(*)::int AS size
    FROM run r
    JOIN run_stat s
      ON s.run_id = r.id
     AND s.org_id = r.org_id
     AND s.project_id = r.project_id
     AND s.scope = 'run'
     AND s.name = ''
     AND s.family = 'response_time'
   WHERE r.org_id = $1 AND r.project_id = $2
     AND r.simulation IS NOT DISTINCT FROM $3
     AND r.status = 'complete'`;

/**
 * A cohort row as the database returns it — `Date`s and raw numerics, before
 * the controller serialises them. Deliberately not `TrendRun`: that is the
 * wire shape, with ISO strings, and persistence has no business knowing it.
 */
export interface StoredTrendRun {
  readonly id: string;
  readonly startedAt: Date;
  readonly toolStartedAt: Date | null;
  readonly durationMs: number | null;
  readonly verdict: string | null;
  readonly count: number;
  readonly okCount: number;
  readonly koCount: number;
  readonly errorRate: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly throughputRps: number;
  readonly percentiles: Record<string, number>;
}
