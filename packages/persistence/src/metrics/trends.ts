import type { Sketch } from '@perfportal/statistics';

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
 * ═══ ORDERING, AND WHY THE REQUESTED RUN IS ADDED BACK ═══
 *
 * `COALESCE(tool_started_at, started_at) DESC` is the same effective ordering
 * key `RunRepository.list` uses, so a trend and the run list cannot disagree
 * about what "most recent" means. Newest first; the chart transform reverses,
 * because a trend reads left-to-right in time.
 *
 * THE WINDOW IS THE NEWEST `limit` RUNS, PLUS THE REQUESTED ONE IF IT IS NOT
 * AMONG THEM — `rn <= $4 OR id = $5`, so at most `limit + 1` rows.
 *
 * A bare `LIMIT` was wrong: it returns the n newest runs of the cohort, which
 * the moment a cohort outgrows n stops containing the run the reader is
 * looking at. The page is titled "this run in context", the contract states
 * outright that a terminal run is always in its own response, and a trend
 * without the run you opened it from is worse than no trend.
 *
 * ANCHORING THE WINDOW AT THE REQUESTED RUN INSTEAD — the `limit` runs up to
 * and including it — was tried and rejected. It is contiguous, which is nice,
 * but it hides every run that came AFTER the one being viewed: open a
 * regression from a ticket three weeks old and the page cannot tell you it was
 * fixed the next day. It also makes "the trend" mean something different
 * depending on which run you happened to enter from.
 *
 * The cost of adding the run back is that the axis may be non-contiguous. The
 * x labels are timestamps, so the jump is legible, and the transform states
 * the window size beside the cohort size — but a reader must not take two
 * adjacent slots for two consecutive runs, which is why the label is a date
 * rather than an index.
 *
 * No index covers (project_id, simulation, COALESCE(...)). Neither does
 * `RunRepository.list`'s ordering, and for a cohort of a few hundred runs the
 * sort is cheap. If a project ever holds enough runs for this to matter the
 * fix is an index, not a different query — written down so the next reader
 * does not have to rediscover which it was.
 */

/**
 * The cohort's rows: the newest `$4`, plus the requested run `$5` if it fell
 * outside them. At most `limit + 1` rows.
 *
 * ONE QUERY, AND THE COUNT RIDES ALONG. `cohort_size` is a window function
 * over the inner query, which has no LIMIT — PostgreSQL evaluates window
 * functions before `LIMIT` anyway, verified rather than assumed:
 *
 *     SELECT id, COUNT(*) OVER() FROM (VALUES (1),(2),(3),(4),(5)) …LIMIT 2
 *     -- 1|5
 *     -- 2|5
 *
 * An earlier version of this file split it into two statements on the stated
 * grounds that a window function "is evaluated against the result set the
 * LIMIT produced". That was simply false, and the second query was a round
 * trip spent on a misconception.
 *
 * `ROW_NUMBER()` and `COUNT(*)` are computed over the WHOLE cohort in the
 * inner query; the outer `WHERE` then selects the window. So `cohort_size` is
 * the cohort's real size on every row, which is exactly the number the client
 * needs in order to say "showing 20 of 60".
 */
export const TRENDS_SQL = `
  SELECT t.id, t.started_at, t.tool_started_at, t.duration_ms, t.verdict,
         t.count, t.ok_count, t.ko_count, t.error_rate,
         t.min_ms, t.max_ms, t.mean_ms, t.throughput_rps, t.percentiles, t.sketch,
         t.cohort_size
    FROM (
      SELECT r.id, r.started_at, r.tool_started_at, r.duration_ms, r.verdict,
             s.count, s.ok_count, s.ko_count, s.error_rate,
             s.min_ms, s.max_ms, s.mean_ms, s.throughput_rps, s.percentiles, s.sketch,
             COALESCE(r.tool_started_at, r.started_at) AS effective,
             ROW_NUMBER() OVER (
               ORDER BY COALESCE(r.tool_started_at, r.started_at) DESC, r.id DESC
             ) AS rn,
             COUNT(*) OVER ()::int AS cohort_size
        FROM run r
        JOIN run_stat s
          ON s.run_id = r.id
         AND s.org_id = r.org_id
         AND s.project_id = r.project_id
         AND s.scope = 'run'
         AND s.name = ''
         AND s.family = 'response_time'
       WHERE r.org_id = $1 AND r.project_id = $2
         AND r.status = 'complete'
         -- ═══ THE COHORT IS A TEST, NOT A STRING ═══
         --
         -- This was \`r.simulation IS NOT DISTINCT FROM $3\`, which is the same
         -- selection for every run the migration backfilled — a test IS
         -- (project, simulation class), so the two agree by construction. What
         -- changes is what the cohort can be CALLED, and one real defect.
         --
         -- \`IS NOT DISTINCT FROM\` matches NULL to NULL. So every run in a
         -- project whose header declared no simulation was cohorted with every
         -- OTHER such run, regardless of what they actually were: a failed
         -- ingest of the checkout suite trended against a failed ingest of the
         -- search suite, because neither could say what it was. That is not a
         -- cohort, it is the absence of one, and the UI needed a paragraph
         -- explaining that the grouping did not mean what it looked like.
         -- \`= $3\` never matches a NULL test_id, so those runs stop being
         -- grouped with each other.
         --
         -- THE \`OR r.id = $5\` IS WHAT KEEPS THEM FROM VANISHING. Without it a
         -- run with no test drops out of the inner query entirely, and the
         -- outer \`t.id = $5\` below has nothing left to add back — a run's own
         -- Trends tab would show not even itself. With it, such a run is a
         -- cohort of exactly one, which is the honest answer.
         AND (r.test_id = $3::uuid OR r.id = $5::uuid)
    ) t
   WHERE t.rn <= $4 OR t.id = $5::uuid
   ORDER BY t.effective DESC, t.id DESC`;

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
  /**
   * The FROZEN column, written at ingest. A fallback only — see `sketch`.
   */
  readonly percentiles: Record<string, number>;
  /**
   * THE SKETCH, WHICH IS WHERE A TREND'S PERCENTILES ACTUALLY COME FROM.
   *
   * `/stats` recomputes percentiles from this at the project's CURRENTLY
   * configured set (spec §9.1, K-03) — that is the entire reason the sketch is
   * persisted, so reconfiguring the set needs no re-ingest. The frozen
   * `percentiles` column is only for rows written before it existed.
   *
   * A trend reading the frozen column instead would put the statistics table
   * and the trend on DIFFERENT PERCENTILE SETS the moment a project
   * reconfigured — silently, since both would look like plausible numbers.
   * They also disagree in the last few decimal places even when the sets
   * match, one being a sketch quantile and the other a stored float, which is
   * how this was caught.
   */
  readonly sketch: Sketch | null;
}
