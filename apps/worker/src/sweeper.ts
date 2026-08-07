import { Queue } from 'bullmq';
import type pg from 'pg';
import type { WorkerConfig } from './config.js';

/**
 * Recovers the two inconsistencies the ingest/parse path can produce (spec
 * §6.1, §6.2):
 *
 *  1. A run committed whose queue enqueue never landed — stuck at 'pending'.
 *  2. A run whose worker died mid-parse (OOM, SIGKILL, node eviction) after
 *     markParsing but before a terminal write — stuck at 'parsing' forever
 *     once BullMQ's attempts are exhausted, since nothing else ever revisits
 *     it. The API would keep answering 202 with a statusUrl that never
 *     changes.
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
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM run
          WHERE (status = 'pending'
                 AND created_at < now() - ($1::int * interval '1 millisecond'))
             OR (status = 'parsing'
                 AND created_at < now() - ($2::int * interval '1 millisecond'))
          ORDER BY created_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        [this.config.staleAfterMs, this.config.parsingStaleAfterMs],
      );
      for (const row of rows) {
        await this.#reenqueue(row.id);
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
