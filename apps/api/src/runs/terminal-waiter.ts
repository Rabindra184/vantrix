import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RunStatus } from '@perfportal/contracts';
import pg from 'pg';

export interface TerminalWaiterOptions {
  /**
   * The wait before the first attempt to listen again after the session is
   * lost, doubling on each failed attempt up to `maxMs`. Defaults to 250 ms
   * and 10 s: a restart is over in seconds, and an outage long enough to hit
   * the cap logs one failed attempt every ten seconds rather than a flood.
   */
  reconnectDelayMs?: { initialMs: number; maxMs: number };
}

/**
 * The statuses `RunsService.statusFor` answers 202 for -- still in progress,
 * so a caller woken for one would only answer 202 early. Every other status
 * is terminal; see `#recheck`, the only reader.
 */
const IN_PROGRESS: readonly RunStatus[] = ['pending', 'parsing', 'running'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Waits for a run to reach a terminal state.
 *
 * Listens on a DEDICATED connection: a pooled one would be handed to another
 * query mid-wait and the LISTEN registration would be lost. The worker issues
 * pg_notify only after its transaction commits, so a wake-up can never
 * announce a state that rolled back.
 *
 * ═══ AND THAT CONNECTION CAN END UNDER IT ═══
 *
 * A database restart, a failover or an operator's `pg_terminate_backend` ends
 * the session, and node-postgres then emits `error` on the client -- two of
 * them, measured on 8.22: `57P01`, then "Connection terminated unexpectedly".
 * An EventEmitter with no `error` listener THROWS, and Nest installs no
 * process-level handler, so before this listener a restart ended the API.
 *
 * Surviving is half of it. A LISTEN registration lives in the session, so a
 * waiter that only survived would never be woken again: every later `waitFor`
 * would wait out its whole window -- `POST /v1/runs` answering after 25 s
 * instead of the moment the worker finished -- with nothing saying why. So a
 * lost session is reported, and listened for again with backoff until it is
 * back.
 *
 * ═══ A NOTIFICATION SENT DURING THE GAP IS GONE ═══
 *
 * NOTIFY reaches the sessions listening when it is delivered, and during the
 * gap there are none. A caller is never WRONG for it -- every caller re-reads
 * the run after the wait, because the row is the source of truth and never
 * the notification -- but it would be late by its whole window. So once the
 * session is back, `#recheck` asks the database which waited-on runs are
 * already terminal and wakes exactly those. A run still in progress is left
 * waiting: waking it would only make its caller answer 202 early, and its own
 * notification now reaches the new session. LISTEN is issued BEFORE the
 * re-check, so a run finishing in between is caught by one or the other.
 */
@Injectable()
export class TerminalWaiter implements OnModuleInit, OnModuleDestroy {
  #client: pg.Client | null = null;
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #delays: { initialMs: number; maxMs: number };
  #closed = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #failedAttempts = 0;
  /**
   * Every client that has raised `error`, current or not. `#onLost` acts only
   * for the INSTALLED client, but a session can die in the same socket read
   * that completes its LISTEN -- the error event then fires before
   * `#reconnect` has installed the client, is ignored as belonging to no one,
   * and a dead client would be installed silently: the never-woken-again
   * defect this class exists to prevent, reached through a race. Checked at
   * installation. Not reproducible on demand; recorded as the argued half.
   */
  readonly #dead = new WeakSet<pg.Client>();

  constructor(
    private readonly databaseUrl: string,
    options: TerminalWaiterOptions = {},
  ) {
    this.#delays = options.reconnectDelayMs ?? { initialMs: 250, maxMs: 10_000 };
  }

  /**
   * Test-only: the number of distinct run ids #waiters currently holds an
   * entry for. Exposed as a count (never the Map or its Sets themselves) so
   * tests can assert the structure doesn't grow without bound without being
   * able to read or mutate listener internals.
   */
  get waitingRunCount(): number {
    return this.#waiters.size;
  }

  /** A failure HERE still fails the boot, loudly -- an API that cannot reach
   * its database at start should not come up. Only a session lost later is
   * recovered. */
  async onModuleInit(): Promise<void> {
    this.#client = await this.#listen();
  }

  /** Resolves true if the run went terminal within the window, false on timeout. */
  waitFor(runId: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (woken: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.#waiters.get(runId);
        if (set) {
          set.delete(onNotify);
          // An empty Set left behind in the Map is itself the leak: every
          // distinct runId ever waited on would otherwise keep a permanent
          // entry for the lifetime of the process.
          if (set.size === 0) this.#waiters.delete(runId);
        }
        resolve(woken);
      };
      const onNotify = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);

      let set = this.#waiters.get(runId);
      if (!set) {
        set = new Set();
        this.#waiters.set(runId, set);
      }
      set.add(onNotify);
    });
  }

  async onModuleDestroy(): Promise<void> {
    // First, and synchronously: a reconnect already in flight checks this
    // when its connect resolves, and ends the session it opened rather than
    // installing it.
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const client = this.#client;
    this.#client = null;
    await client?.end().catch(() => {});
  }

  /** A connected, listening client, or a rejection with nothing left open. */
  async #listen(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('error', (err: Error) => this.#onLost(client, err));
    client.on('notification', (msg) => {
      if (msg.channel === 'run_terminal' && msg.payload) this.#wake(msg.payload);
    });
    try {
      await client.connect();
      await client.query('LISTEN run_terminal');
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    return client;
  }

  #wake(runId: string): void {
    const set = this.#waiters.get(runId);
    if (!set) return;
    for (const resolve of set) resolve();
  }

  /**
   * The session ended. Acts only for the client currently INSTALLED.
   *
   * Not because of the pair of errors a dead client raises: ending it here
   * suppresses the second, since an ended client reports its close as
   * expected rather than as an error -- measured, one event where an unended
   * client raises two. What the check keeps out is a reconnect ATTEMPT's
   * client dying mid-LISTEN: its `error` fires before the attempt's own catch
   * runs, and that catch already retries -- acting here as well would start a
   * second, parallel chain of attempts. No case reaches that on demand.
   */
  #onLost(client: pg.Client, err: Error): void {
    this.#dead.add(client);
    if (client !== this.#client) return;
    this.#client = null;
    void client.end().catch(() => {});
    console.warn(
      `TerminalWaiter: lost its LISTEN run_terminal session (${sqlState(err)}: ${err.message}); ` +
        'listening again as soon as the database answers. Until then no run wakes its waiter, ' +
        'and waiters whose runs finish meanwhile are woken once it is back',
    );
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    const delay = Math.min(this.#delays.initialMs * 2 ** this.#failedAttempts, this.#delays.maxMs);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#reconnect();
    }, delay);
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) return;
    let client: pg.Client;
    try {
      client = await this.#listen();
    } catch (err) {
      this.#failedAttempts += 1;
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `TerminalWaiter: could not listen again (attempt ${this.#failedAttempts}, ` +
          `${sqlState(e)}: ${e.message}); retrying`,
      );
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed) {
      await client.end().catch(() => {});
      return;
    }
    if (this.#dead.has(client)) {
      await client.end().catch(() => {});
      this.#failedAttempts += 1;
      this.#scheduleReconnect();
      return;
    }
    this.#client = client;
    const attempts = this.#failedAttempts + 1;
    this.#failedAttempts = 0;
    console.warn(`TerminalWaiter: listening on run_terminal again (after ${attempts} attempt(s))`);
    await this.#recheck(client);
  }

  /**
   * Wakes every waiter whose run went terminal while nothing was listening.
   * On the new session itself: it is connected, and a pooled query would
   * need a pool this class does not have.
   *
   * Only run ids that ARE uuids are asked about -- `run.id` is a uuid column,
   * and one malformed key must not fail the cast for every other waiter. A
   * failure here costs latency and nothing else (callers re-read the row),
   * so it is logged and those waiters fall back to their own timeouts.
   */
  async #recheck(client: pg.Client): Promise<void> {
    const ids = [...this.#waiters.keys()].filter((id) => UUID.test(id));
    if (ids.length === 0) return;
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM run WHERE id = ANY($1::uuid[]) AND status <> ALL($2::text[])',
        [ids, IN_PROGRESS],
      );
      for (const row of rows) this.#wake(row.id);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `TerminalWaiter: could not re-check ${ids.length} waiting run(s) after listening again ` +
          `(${sqlState(e)}: ${e.message}); they wake on their own timeouts instead`,
      );
    }
  }
}

function sqlState(err: Error): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'no code';
}
