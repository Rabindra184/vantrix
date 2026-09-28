import type pg from 'pg';

/**
 * A pooled client someone has checked out, guarded against its connection
 * dying while they hold it.
 *
 * ═══ WHY HOLDING A CLIENT NEEDS A LISTENER OF ITS OWN ═══
 *
 * pg-pool listens for a client's `error` event only while the client is IDLE:
 * `_acquireClient` removes that listener at checkout and `_release` restores
 * it (pg-pool 3.14.0). A connection that dies in between -- a database
 * restart, a failover, `pg_terminate_backend` -- makes the client emit
 * `error` with nobody listening, and an EventEmitter with no `error` listener
 * THROWS: an uncaught exception, which in this worker is the process.
 * Measured (node-postgres 8.22): a held client whose backend is terminated
 * emits two, `57P01` and then "Connection terminated unexpectedly", whether
 * or not a query was in flight.
 *
 * `createPool` listens on the POOL, which covers idle clients and nothing
 * else. Every checkout that outlives one `pool.query` goes through here.
 *
 * ═══ AND WHY THE ERROR IS KEPT, NOT JUST SWALLOWED ═══
 *
 * A dead connection takes its SESSION with it, and a session is where this
 * worker keeps its advisory locks. A holder that only survived the event
 * would carry on believing it holds a lock the database has already released
 * -- see `LiveFoldOwner`'s use of `lost`. The first error is recorded (the
 * second of the pair adds nothing), reported once through `onLost`, and
 * handed back to the pool at release so it destroys the client rather than
 * wondering whether it is reusable.
 */
export interface HeldClient {
  readonly client: pg.PoolClient;
  /** The first error the connection raised while held, or null while it is
   * healthy. Once set it never clears: a dead connection does not recover. */
  readonly lost: Error | null;
  /**
   * Stops guarding and returns the client to the pool. The pool DESTROYS it
   * when `err` is given or the connection was lost -- a session that may
   * still be in a transaction, or still holding a lock, must never be lent
   * to the next caller.
   */
  release(err?: Error): void;
}

export function holdClient(client: pg.PoolClient, onLost?: (err: Error) => void): HeldClient {
  let lost: Error | null = null;
  const listener = (err: Error): void => {
    if (lost) return;
    lost = err;
    onLost?.(err);
  };
  client.on('error', listener);
  return {
    client,
    get lost() {
      return lost;
    },
    release(err?: Error) {
      // Removed immediately before the release, which restores pg-pool's own
      // idle listener in the same synchronous turn -- so no event can land
      // between the two with nobody listening.
      client.removeListener('error', listener);
      client.release(err ?? lost ?? undefined);
    },
  };
}

/** An error's SQLSTATE when it carries one -- for log lines that name what
 * happened, since a restart (`57P01`) and a network drop (no code) call for
 * different reading. */
export function sqlState(err: Error): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'no code';
}
