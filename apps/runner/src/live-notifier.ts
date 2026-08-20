import { Redis } from 'ioredis';

export class RunnerLiveNotifier {
  readonly #redis: Redis;

  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl);
  }

  opened(runId: string): void {
    void this.#redis.publish('live:opened', runId).catch(() => undefined);
  }

  advanced(runId: string): void {
    void this.#redis.publish('live:advance', runId).catch(() => undefined);
  }

  closed(runId: string): void {
    void this.#redis.publish('live:closed', runId).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
