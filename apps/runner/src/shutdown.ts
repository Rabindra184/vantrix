export class Shutdown {
  #stopping = false;
  #stopPromise: Promise<void> | null = null;
  readonly #callbacks: Array<() => Promise<void> | void> = [];

  get stopping(): boolean {
    return this.#stopping;
  }

  onStop(callback: () => Promise<void> | void): void {
    this.#callbacks.push(callback);
  }

  install(): void {
    const stop = (signal: NodeJS.Signals) => {
      void this.stop(signal);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = (async () => {
      console.log(`runner shutdown requested: ${reason}`);
      for (const callback of [...this.#callbacks].reverse()) {
        try {
          await callback();
        } catch (err) {
          console.error('runner shutdown step failed', err);
        }
      }
    })();
    return this.#stopPromise;
  }
}
