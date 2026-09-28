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
 * ═══ THE INVARIANT, AND THE GOAL ═══
 *
 * UNGROUPED ⇒ UNNUMBERED: a run never carries a number without a test. Both
 * statements below write the test and the number together, and
 * `TestRepository.remove` clears the number of every run it ungroups. That is
 * the invariant the argument below leans on.
 *
 * "A run in a test has a number" is the GOAL, not an invariant, and it has one
 * known exception: a run an older, pre-numbering worker attached to its test
 * during an upgrade, which carries a test and no number. The finalize
 * statement numbers such a run when it meets it — the self-heal row in its
 * table below.
 *
 * ═══ WHY THESE STATEMENTS DO NOT DEADLOCK `TestRepository.remove` — AND THE
 *     ONE WINDOW WHERE THEY CAN ═══
 *
 * Both statements lock a RUN row first and only then, sometimes, a TEST row.
 * `remove(T)` cannot follow that order all the way — its delete locks T, and
 * the foreign key's `ON DELETE SET NULL` cascade then locks runs — so lock
 * order alone does not rule a cycle out. What does is WHICH rows each side can
 * be waiting for:
 *
 *   - a writer waits on test T only while holding its own run R, where R is
 *     either NOT committed in T (an attach, or a finalize moving R into T), or
 *     committed in T without a number (the self-heal row, in `allocated`), or
 *     committed in T with a number the finalize keeps — that one waits in the
 *     pipeline's terminal UPDATE, whose foreign-key check locks T because the
 *     finalize statement below rewrote the row earlier in the same
 *     transaction (measured: a second UPDATE of one row in one transaction,
 *     test_id unchanged, waits on a test row held FOR UPDATE, as a delete
 *     holds it);
 *   - `remove(T)` takes the runs committed in T FIRST, in a statement that
 *     holds no lock on T. So it can wait on a writer holding one of them only
 *     BEFORE it holds T, and that writer can then get T and finish. That first
 *     statement exists for LOCK ORDER as much as for clearing numbers, and
 *     the worker suite's "does not deadlock a delete against a finalize that
 *     numbers a run already in the test" pins it: without it, that case's
 *     interleaving deadlocks (40P01) on every run;
 *   - once `remove` holds T, it waits only on runs committed in T that its
 *     first statement did not lock — runs that joined T after that statement
 *     read — and on ungrouped-but-numbered runs, which by the invariant are
 *     only the ones its own cascade just ungrouped. A writer that JOINED a run
 *     to T needed a lock on T's row to do it, so it has committed before
 *     `remove` holds T, and holds nothing.
 *
 * THE RESIDUAL THIS DOES NOT COVER: a run that joins T after `remove`'s first
 * statement read and is then taken by its FINALIZE before `remove`'s cascade
 * reaches it. That finalize holds the run and waits on T — in `allocated` if an
 * older worker attached it without a number, in the terminal UPDATE's
 * foreign-key check if it already has one — while `remove` holds T and waits
 * on the run. The numbered variant is NOT limited to an upgrade window; both
 * were reproduced against this code with forced interleavings. Reaching either
 * needs a live run's header to join T AND its stream to close and be picked up
 * by the pipeline, all inside one delete's window between its first statement
 * and its cascade. Postgres resolves it by aborting one side with 40P01.
 *
 * Widening either of `remove`'s clearing statements, or `target`'s/`cur`'s
 * filter below, needs this argument re-made from scratch.
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
