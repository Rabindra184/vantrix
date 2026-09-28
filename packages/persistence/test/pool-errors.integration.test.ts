import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../src/index.js';
import { requireDatabaseUrl } from './support/db.js';

const url = requireDatabaseUrl();
let observer: pg.Client;

beforeAll(async () => {
  observer = new pg.Client({ connectionString: url });
  await observer.connect();
});

afterAll(async () => {
  await observer.end();
});

/**
 * A POOL'S IDLE CONNECTIONS ARE THE ONES A RESTART FINDS FIRST. Between
 * queries every connection a process owns is idle in its pool, so when the
 * database restarts, fails over, or an operator ends a session, this is the
 * shape almost all of them are in.
 *
 * pg-pool reports such a connection as an `error` event on the pool, after
 * it has already discarded the client -- and an EventEmitter with no `error`
 * listener throws. Measured (node-postgres 8.22, pg-pool 3.14.0) with no
 * listener: `57P01 terminating connection due to administrator command`, as
 * an uncaught exception, which in the worker and the API is the process.
 *
 * The session is ended with a real `pg_terminate_backend`: the event only
 * exists for a connection that is actually dead.
 */
describe('createPool, when Postgres ends one of its idle sessions', () => {
  it('logs it, discards it, and serves the next query on a new session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = createPool(url);
    try {
      const client = await pool.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]!.pid;
      client.release();
      expect(pool.idleCount).toBe(1);

      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(pool.totalCount).toBe(0), { timeout: 10_000 });

      // Said, not swallowed: an operator whose database restarted should be
      // able to find out the process noticed.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/57P01/);

      const again = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(again.rows[0]!.pid).not.toBe(pid);
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });
});
