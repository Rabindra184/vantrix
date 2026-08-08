import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';

/**
 * Waits for a run to reach a terminal state.
 *
 * Listens on a DEDICATED connection: a pooled one would be handed to another
 * query mid-wait and the LISTEN registration would be lost. The worker issues
 * pg_notify only after its transaction commits, so a wake-up can never
 * announce a state that rolled back.
 */
@Injectable()
export class TerminalWaiter implements OnModuleInit, OnModuleDestroy {
  #client: pg.Client | null = null;
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(private readonly databaseUrl: string) {}

  /**
   * Test-only: the number of distinct run ids #waiters currently holds an
   * entry for. Exposed as a count (never the Map or its Sets themselves) so
   * tests can assert the structure doesn't grow without bound without being
   * able to read or mutate listener internals.
   */
  get waitingRunCount(): number {
    return this.#waiters.size;
  }

  async onModuleInit(): Promise<void> {
    this.#client = new pg.Client({ connectionString: this.databaseUrl });
    await this.#client.connect();
    this.#client.on('notification', (msg) => {
      if (msg.channel !== 'run_terminal' || !msg.payload) return;
      const set = this.#waiters.get(msg.payload);
      if (!set) return;
      for (const resolve of set) resolve();
    });
    await this.#client.query('LISTEN run_terminal');
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
    await this.#client?.end();
    this.#client = null;
  }
}
