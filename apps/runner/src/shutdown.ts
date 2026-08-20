export class Shutdown {
  #stopping = false;
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
    if (this.#stopping) return;
    this.#stopping = true;
    console.log(`runner shutdown requested: ${reason}`);
    for (const callback of [...this.#callbacks].reverse()) {
      try {
        await callback();
      } catch (err) {
        console.error('runner shutdown step failed', err);
      }
    }
  }
}
