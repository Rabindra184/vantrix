import { Queue } from 'bullmq';
import type pg from 'pg';
import type { WorkerConfig } from './config.js';

/**
 * Recovers the three inconsistencies the ingest/parse/stream paths can
 * produce (spec §6.1, §6.2; live-monitoring design §5):
 *
 *  1. A run committed whose queue enqueue never landed — stuck at 'pending'.
 *  2. A run whose worker died mid-parse (OOM, SIGKILL, node eviction) after
 *     markParsing but before a terminal write — stuck at 'parsing' forever
 *     once BullMQ's attempts are exhausted, since nothing else ever revisits
 *     it. The API would keep answering 202 with a statusUrl that never
 *     changes.
 *  3. A live run whose producer vanished — stuck at 'running'. That state is
 *     entered by POST /v1/runs/live and left by POST /v1/runs/:id/close, and
 *     an agent that is SIGKILLed, evicted, or loses the network sends no
 *     close: without this branch the run answers 202 + Retry-After forever,
 *     and the only exit is an operator UPDATE.
 *
 * THE THIRD ONE DOES NOT RE-ENQUEUE, and that is the whole difference
 * between it and the other two. A run at 'pending' or 'parsing' has a
 * bundle sitting at bundleKey waiting to be parsed, so handing it back to
 * the queue is exactly the repair. A run at 'running' does not: its bytes
 * are still per-chunk objects under live/{runId}/, and only close()
 * assembles them into bundleKey. Enqueueing one would drive PipelineService
 * into a parse failure for a run whose only fault is that its agent died.
 * It is finalized in place as 'incomplete' instead — the terminal state
 * RunRepository.markIncomplete already existed for, and which never carries
 * a pass verdict (design §1.2).
 *
 * THAT WRITES THE ROW AND NOTHING ELSE. The run's live/{runId}/* chunk
 * objects are LEFT IN PLACE: this class holds a pg.Pool and no BlobStore, and
 * giving it one to delete a swept run's chunks would put object-store latency
 * and failure modes inside a transaction that currently touches one database.
 * They are storage's to expire — a bucket lifecycle rule on the live/ prefix —
 * which is the same disposition putStream already relies on for the parts of
 * an aborted multipart upload. Do not read "finalized" here as "cleaned up".
 *
 * FOR UPDATE SKIP LOCKED makes this safe with any number of worker replicas
 * and needs no leader election, which is why this slice has no separate
 * scheduler deployable.
 */
export class Sweeper {
  readonly #queue: Queue;

  constructor(
    private readonly config: WorkerConfig,
    private readonly pool: pg.Pool,
  ) {
    this.#queue = new Queue('ingest', { connection: { url: config.redisUrl } });
  }

  async sweep(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 'parsing' staleness is measured from parsing_started_at, NOT
      // created_at (the row's OPEN/upload time) -- COALESCE falls back to
      // created_at only for a row that reached 'parsing' with the column
      // still null (predates this migration, or some future path forgets
      // to set it). A live run's created_at is when it was opened, often
      // well past parsingStaleAfterMs before close() ever runs (the normal
      // case for the soak tests live streaming exists for), so measuring
      // from created_at made every such run look stale the INSTANT close()
      // claimed it -- this sweep could then re-enqueue a run whose
      // close() was still assembling the log, racing PipelineService
      // against a bundleSha256 close() had not finished writing yet. See
      // Run.parsingStartedAt's own docstring (schema.prisma) and
      // RunRepository.claimForClose/markParsing, both of which set it.
      //
      // 'running' staleness is measured from stream_updated_at, for the
      // SAME reason and against the same trap: created_at is a live run's
      // OPEN time, and a soak test streams for hours, so ageing a 'running'
      // run from created_at would finalize a perfectly healthy mid-stream
      // run as 'incomplete' purely for being long. What "stale" means here
      // is that the PRODUCER has stopped, and the only evidence of a live
      // producer is bytes landing -- RunRepository.advanceOffset stamps
      // that column on every accepted chunk. COALESCE covers a run opened
      // and abandoned before its first chunk, which has no cursor movement
      // to measure and whose open time is then the honest reading.
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM run
          WHERE (status = 'pending'
                 AND created_at < now() - ($1::int * interval '1 millisecond'))
             OR (status = 'parsing'
                 AND COALESCE(parsing_started_at, created_at)
                     < now() - ($2::int * interval '1 millisecond'))
             OR (status = 'running'
                 AND COALESCE(stream_updated_at, created_at)
                     < now() - ($3::int * interval '1 millisecond'))
          ORDER BY created_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        [this.config.staleAfterMs, this.config.parsingStaleAfterMs, this.config.runningStaleAfterMs],
      );
      for (const row of rows) {
        // Routed per ROW, not per batch: one sweep can select a stale
        // 'pending' run and a stale 'running' run together, and they need
        // opposite treatments.
        if (row.status === 'running') await this.#finalizeIncomplete(client, row.id);
        else await this.#reenqueue(row.id);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The 'running' branch's terminal write — RunRepository.markIncomplete's
   * statement, hand-written here rather than called.
   *
   * ON THIS CLIENT, INSIDE THIS TRANSACTION, AND THAT IS NOT A STYLE
   * CHOICE. The SELECT above already holds this row under FOR UPDATE, so a
   * Prisma call would open a SECOND connection, block on the row lock this
   * very transaction holds, and never be released — a self-deadlock that
   * only resolves when the pool's timeout fires. The Sweeper is also
   * constructed with a pg.Pool alone (apps/worker/src/main.ts) and has no
   * Prisma client to reach for.
   *
   * Carries markIncomplete's guard verbatim (never regress a run another
   * process has already decided) even though this row is locked and was
   * selected as 'running': the guard costs nothing and means the two
   * writers of this transition cannot drift apart in what they consider
   * safe. verdict is 'not_evaluated', never 'passed' — design §1.2, and the
   * reason `incomplete` exists as a state at all.
   */
  async #finalizeIncomplete(client: pg.PoolClient, runId: string): Promise<void> {
    await client.query(
      `UPDATE run
          SET status = 'incomplete', verdict = 'not_evaluated', ingested_at = now()
        WHERE id = $1 AND status NOT IN ('complete', 'failed', 'incomplete')`,
      [runId],
    );
  }

  /**
   * `Queue.add` with an existing jobId returns the existing job WITHOUT
   * enqueueing anything — that is correct dedup when the job is still
   * waiting/active/delayed (there is nothing to do), but it is a silent
   * no-op when the job is sitting in the `failed` set (removeOnFail keeps it
   * around, so it is still "existing"). A run can then be re-selected by
   * every sweep tick forever while zero jobs are ever actually enqueued.
   * Explicitly inspect the existing job's state and retry() it — the only
   * way to move a failed job back to `wait` under its stable, run-derived id
   * — rather than assuming `add` always enqueues.
   */
  async #reenqueue(runId: string): Promise<void> {
    const existing = await this.#queue.getJob(runId);
    if (!existing) {
      // Stable, run-derived id — matches what the API's own enqueue uses
      // (IngestQueue.add uses jobId: runId), so a sweeper re-enqueue of a
      // job that is still queued is a harmless no-op via BullMQ dedup,
      // instead of minting a second job whenever the batch size differs.
      await this.#queue.add('ingest', { runId }, { jobId: runId });
      return;
    }

    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') {
      // Give it a genuinely fresh set of attempts: the prior attempts were
      // burned by crashes unrelated to the job's own merits (the point of
      // sweeping it back up at all), not by the job repeatedly failing on
      // its own terms.
      await existing.retry(state, { resetAttemptsMade: true });
      return;
    }
    // waiting / active / delayed / prioritized: already on track to run (or
    // running right now) — nothing to do, and calling add() here would only
    // return the same job without changing anything anyway.
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
