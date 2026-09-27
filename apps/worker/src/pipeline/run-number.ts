import type pg from 'pg';

/**
 * ═══ A RUN'S NUMBER WITHIN ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * "Run 12": the number a run takes the moment it JOINS its test, kept for
 * ever. Arrival order, deliberately — numbering by when a test ran would
 * renumber every later run whenever an old bundle is uploaded late, and "#12"
 * in last week's thread would name a different run today.
 *
 * A run's test is set in exactly two places, and so is its number, in the
 * SAME statement: `LiveFoldOwner#identify` at the log header
 * (`attachLiveRunToTest`), and `PipelineService` inside its finalize
 * transaction (`numberRunForTest`). The counter is `test.next_run_number`,
 * bumped by an UPDATE whose row lock serialises two runs of one test; a
 * max-plus-one read would hand both the same number.
 *
 * ═══ WHY NONE OF THIS CAN DEADLOCK `TestRepository.remove` ═══
 *
 * Both statements below lock a RUN row, then (sometimes) a TEST row — but
 * `remove` does not follow that order: its delete locks the TEST row first,
 * and the FK's `ON DELETE SET NULL` cascade then locks RUN rows, and its
 * clearing statement locks RUN rows again. Lock order alone would not rule
 * out a cycle. What actually does is the PREDICATES each side waits under:
 *
 *   - a numbering statement here only waits on test T while holding a run
 *     whose COMMITTED `test_id` is NOT T (otherwise `allocated`'s EXISTS is
 *     false and the test row is never touched);
 *   - `remove(T)`, once it holds T, only waits on runs whose committed
 *     `test_id` IS T (the cascade) or that are ungrouped-but-numbered
 *     (`test_id` NULL AND `run_number` NOT NULL) — and a run either writer
 *     here is holding is never ungrouped-but-numbered, because the invariant
 *     (`run_number` non-null exactly when `test_id` is) makes an ungrouped
 *     run unnumbered.
 *
 * So a numbering statement waiting on T is holding a run NOT in T, and
 * `remove(T)` waiting on that same run needs it to BE in T (or ungrouped and
 * numbered, which it is not) — no run can satisfy what both sides are
 * waiting for at once, so no wait cycle can form. Widening the clearing
 * statement's predicate, or `target`'s/`cur`'s filter above, would need this
 * argument re-made from scratch.
 *
 * No backticks anywhere in the SQL below: it sits in template literals.
 */

/**
 * The live run's test, at its header — and its number, if and only if the run
 * had no test yet. A re-claimed fold identifies the run again; the EXISTS
 * guard is what stops that burning a second number (the second call blocks on
 * the row lock, re-reads test_id as set, finds "target" empty and allocates
 * nothing). Returns the number assigned, or null when nothing was.
 */
export async function attachLiveRunToTest(
  pool: pg.Pool,
  runId: string,
  testId: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ run_number: number | null }>(
    `WITH target AS (
       SELECT id FROM run WHERE id = $1::uuid AND test_id IS NULL FOR UPDATE
     ), allocated AS (
       UPDATE test SET next_run_number = next_run_number + 1
        WHERE id = $2::uuid AND EXISTS (SELECT 1 FROM target)
       RETURNING next_run_number - 1 AS n
     )
     UPDATE run SET test_id = $2::uuid, run_number = (SELECT n FROM allocated)
      WHERE id = (SELECT id FROM target)
      RETURNING run_number`,
    [runId, testId],
  );
  return rows[0]?.run_number ?? null;
}

/**
 * The number, decided at finalize, INSIDE the pipeline's transaction and
 * immediately before its terminal UPDATE (whose status guard this repeats, so
 * a redelivered job cannot renumber a finished run):
 *
 *   arrives with no test (an upload)      -> the resolved test's next number
 *   arrives in the resolved test          -> the number it already has, kept
 *   arrives in a DIFFERENT test           -> the resolved test's next; the old
 *                                            test keeps a gap, never refilled
 *   arrives in the resolved test with NO
 *     number (attached by a worker that
 *     predates numbering)                 -> the resolved test's next
 *   the resolver answered null            -> no test, no number
 *
 * Returns the run's number afterwards, or null (no test, or no row updated).
 */
export async function numberRunForTest(
  client: pg.PoolClient,
  runId: string,
  testId: string | null,
): Promise<number | null> {
  const { rows } = await client.query<{ run_number: number | null }>(
    `WITH cur AS (
       SELECT test_id, run_number FROM run
        WHERE id = $1::uuid AND status NOT IN ('complete', 'failed') FOR UPDATE
     ), allocated AS (
       UPDATE test SET next_run_number = next_run_number + 1
        WHERE id = $2::uuid
          AND EXISTS (SELECT 1 FROM cur
                       WHERE cur.test_id IS DISTINCT FROM $2::uuid OR cur.run_number IS NULL)
       RETURNING next_run_number - 1 AS n
     )
     UPDATE run
        SET test_id = $2::uuid,
            run_number = CASE WHEN run.test_id IS NOT DISTINCT FROM $2::uuid
                                AND run.run_number IS NOT NULL
                              THEN run.run_number
                              ELSE (SELECT n FROM allocated) END
      WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM cur)
      RETURNING run_number`,
    [runId, testId],
  );
  return rows[0]?.run_number ?? null;
}
