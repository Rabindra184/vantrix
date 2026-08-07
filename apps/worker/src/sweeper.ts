import { Queue } from 'bullmq';
import type pg from 'pg';
import type { WorkerConfig } from './config.js';

/**
 * Recovers the one inconsistency the accept path can produce: a run committed
 * whose queue enqueue never landed (spec §6.1). FOR UPDATE SKIP LOCKED makes
 * this safe with any number of worker replicas and needs no leader election,
 * which is why this slice has no separate scheduler deployable.
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
          WHERE status = 'pending'
            AND created_at < now() - ($1::int * interval '1 millisecond')
          ORDER BY created_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        [this.config.staleAfterMs],
      );
      for (const row of rows) {
        await this.#queue.add('ingest', { runId: row.id }, { jobId: `sweep-${row.id}-${rows.length}` });
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

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
