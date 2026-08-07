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
        this.#waiters.get(runId)?.delete(onNotify);
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
