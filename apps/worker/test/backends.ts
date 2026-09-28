import pg from 'pg';
import { RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';

/**
 * What a test needs to END A REAL POSTGRES SESSION on purpose: find the exact
 * backend by pid, and terminate it the way a restart, a failover or an
 * operator's `pg_terminate_backend` does.
 *
 * A trigger raising `57P01` would be the easy injection, and it would prove
 * nothing here. The same SQLSTATE on a LIVE connection lets `ROLLBACK`
 * succeed and makes the client emit no `error` event at all, and that event
 * is the whole defect: pg-pool removes its own listener from a client while
 * it is checked out, so an `error` nobody listens for is thrown as an
 * uncaught exception and takes the process with it. Only a dead connection
 * produces it. Measured (node-postgres 8.22, pg-pool 3.14.0): a HELD idle
 * client emits two -- `57P01`, then "Connection terminated unexpectedly" --
 * and an idle client inside the pool makes the pool emit one.
 *
 * EVERY LOOKUP RUNS ON AN AUTOCOMMIT CONNECTION, and that is not tidiness.
 * `pg_stat_activity` read inside a transaction is a snapshot frozen at that
 * transaction's first read of it, so a poll issued from inside a `BEGIN`
 * re-reads "nothing is waiting yet" for ever whenever its first read beats
 * the backend it is waiting for -- measured on the transient-ingest-retries
 * branch as a 180-second wait on a backend parked the whole time.
 */
export class Backends {
  readonly #observer: pg.Client;

  private constructor(observer: pg.Client) {
    this.#observer = observer;
  }

  static async open(databaseUrl: string): Promise<Backends> {
    const observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    return new Backends(observer);
  }

  /** The backend holding `runId`'s ingest advisory lock, or null. The lock
   * is `pg_try_advisory_lock(RUN_INGEST_LOCK_NAMESPACE, hashtext(runId))`,
   * which `pg_locks` files as `classid`/`objid` with `objsubid = 2`; a
   * negative `hashtext` wraps into `oid`, so both sides are cast. */
  async lockHolder(runId: string): Promise<number | null> {
    const { rows } = await this.#observer.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1::oid
          AND objid = hashtext($2)::oid AND objsubid = 2 AND granted`,
      [RUN_INGEST_LOCK_NAMESPACE, runId],
    );
    return rows[0]?.pid ?? null;
  }

  /** The first backend waiting on a lock `holderPid` holds, with the
   * statement it is waiting in -- so a case can prove it parked the backend
   * it meant to rather than whichever one happened to be waiting. */
  async blockedBy(holderPid: number): Promise<{ pid: number; query: string } | null> {
    const { rows } = await this.#observer.query<{ pid: number; query: string }>(
      'SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
      [holderPid],
    );
    return rows[0] ?? null;
  }

  async terminate(pid: number): Promise<void> {
    const { rows } = await this.#observer.query<{ ok: boolean }>(
      'SELECT pg_terminate_backend($1) AS ok',
      [pid],
    );
    if (!rows[0]?.ok) throw new Error(`pg_terminate_backend(${pid}) terminated nothing`);
  }

  async close(): Promise<void> {
    await this.#observer.end();
  }
}

/**
 * A session holding `table` in `mode` inside an open transaction, so a
 * statement that needs a conflicting lock parks behind it -- inside ITS OWN
 * transaction, which is the only place the defects under test live.
 * `release()` rolls back and disconnects.
 */
export async function holdTable(
  databaseUrl: string,
  table: string,
  mode: 'EXCLUSIVE' | 'ACCESS EXCLUSIVE',
): Promise<{ pid: number; release: () => Promise<void> }> {
  const holder = new pg.Client({ connectionString: databaseUrl });
  await holder.connect();
  const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  await holder.query('BEGIN');
  await holder.query(`LOCK TABLE "${table}" IN ${mode} MODE`);
  return {
    pid: rows[0]!.pid,
    release: async () => {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    },
  };
}

/** Polls `probe` until it returns something other than null/false, or fails
 * naming `what` -- a wait that gives up has to say what it was waiting for. */
export async function until<T>(
  what: string,
  probe: () => Promise<T | null | false> | T | null | false,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null && got !== false) return got;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
