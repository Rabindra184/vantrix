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
 *     ONE WINDOW WHERE THEY STILL CAN ═══
 *
 * Both statements lock a RUN row first and only then, sometimes, a TEST row.
 * `remove(T)` cannot follow that order all the way — its delete locks T, and
 * the foreign key's `ON DELETE SET NULL` cascade then locks runs — so lock
 * order alone does not rule a cycle out. What does is WHICH rows each side can
 * be waiting for:
 *
 *   - a writer waits on test T only while holding its own run R, where R is
 *     either NOT committed in T (an attach, or a finalize moving R into T), or
 *     committed in T without a number (the self-heal row, in "allocated").
 *     A finalize that KEEPS R's number never asks for T at all: the keep arm
 *     writes nothing, so the pipeline's terminal UPDATE (test_id unchanged,
 *     the row not yet written by this transaction) runs no foreign-key check.
 *     Had the keep arm rewritten the row, Postgres would re-check the key on
 *     that UPDATE — it re-checks a row the same transaction already wrote —
 *     and the check locks T;
 *   - `remove(T)`'s first statement UNGROUPS the runs committed in T while it
 *     holds no lock on T, and changing test_id — a key column, half of the
 *     unique index on (test_id, run_number) — takes each run FOR UPDATE,
 *     which waits behind ANY lock a writer holds on it, the FOR KEY SHARE of a
 *     finalize's run_assertion inserts included. So `remove` waits on such a
 *     writer only BEFORE it holds T, and that writer can then get T and
 *     finish. A writer holding only that KEY SHARE upgrades it as the run's
 *     sole locker without queueing behind `remove` (Postgres does not make a
 *     transaction wait on itself). The worker suite's "does not deadlock a
 *     delete against a self-healing finalize that already wrote its
 *     assertions" pins the lock mode and the statement's existence alike —
 *     it deadlocks, every time, with the statement removed or back to
 *     rewriting the number alone;
 *   - once `remove` holds T, it waits only on runs committed in T that its
 *     first statement did not see — runs that joined T after that statement
 *     read — and on ungrouped-but-numbered runs, which by the invariant are
 *     only the ones its own cascade just ungrouped. A writer that JOINED a run
 *     to T needed a lock on T's row to do it (the counter, or the foreign-key
 *     check's KEY SHARE), so it has committed before `remove` holds T, and
 *     holds nothing. If the joiner arrived NUMBERED, its finalize keeps the
 *     number and never asks for T ("... keeping the number of a run that
 *     joined mid-delete" pins it).
 *
 * THE ONE WINDOW LEFT is a joiner WITHOUT a number — attached by an older,
 * pre-numbering worker, so it exists only while a deployment of this version
 * rolls out — whose finalize self-heals it: that finalize holds the run and
 * needs T in "allocated". It deadlocks when it takes the run and then asks for
 * T after `remove` has taken or queued for it: inside one statement of the
 * finalize, or with a third transaction numbering another run into T so that
 * both queue behind it. Measured with the fixes in place, that interleaving is
 * 40P01 3 of 3, the victim varying. Its outcomes are the ordinary race's, but
 * for one: a finalize that loses fails its run, as it would losing to the
 * delete without a deadlock (its test is gone, 23503); a delete that loses
 * answers an error, and retrying it succeeds. No lock order closes it — the
 * finalize must take T to allocate, and the joiner is a run `remove`'s first
 * statement cannot have seen.
 *
 * Widening either of `remove`'s clearing statements, or "target"'s/"cur"'s
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
 * ═══ THE KEEP ARM WRITES NOTHING ═══
 *
 * The second row is answered from "cur", which still locks the run, and the
 * row is NOT rewritten — not even to the values it already holds. A rewrite
 * made the pipeline's terminal UPDATE re-check the run's foreign key, which
 * locks the test row, so a finalize that only kept a number waited on a test a
 * delete held while the delete's cascade waited on the run: 40P01. See the
 * module docstring above, and "finalizes a run already numbered in its test
 * without waiting on the test row", which drives the real pipeline against a
 * held test row.
 *
 * Returns the run's number afterwards, or null (no test, or no row updated).
 */
export async function numberRunForTest(
  client: pg.PoolClient,
  runId: string,
  testId: string | null,
): Promise<number | null> {
  // "moves" is every case but the keep: the run arrives in another test, in
  // none, or in this one with no number. The keep row is answered from "cur"
  // and WRITES NOTHING — see "THE KEEP ARM WRITES NOTHING" above.
  const { rows } = await client.query<{ run_number: number | null }>(
    `WITH cur AS (
       SELECT test_id, run_number FROM run
        WHERE id = $1::uuid AND status NOT IN ('complete', 'failed') FOR UPDATE
     ), moves AS (
       SELECT 1 FROM cur
        WHERE cur.test_id IS DISTINCT FROM $2::uuid OR cur.run_number IS NULL
     ), allocated AS (
       UPDATE test SET next_run_number = next_run_number + 1
        WHERE id = $2::uuid AND EXISTS (SELECT 1 FROM moves)
       RETURNING next_run_number - 1 AS n
     ), written AS (
       UPDATE run SET test_id = $2::uuid, run_number = (SELECT n FROM allocated)
        WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM moves)
       RETURNING run_number
     )
     SELECT run_number FROM written
     UNION ALL
     SELECT run_number FROM cur WHERE NOT EXISTS (SELECT 1 FROM moves)`,
    [runId, testId],
  );
  return rows[0]?.run_number ?? null;
}
