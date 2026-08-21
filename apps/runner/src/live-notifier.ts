import { LIVE_CHANNELS } from '@perfportal/core';
import { Redis } from 'ioredis';

export class RunnerLiveNotifier {
  readonly #redis: Redis;

  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl);
    this.#redis.on('error', (err) => {
      console.error('runner live notifier redis error', err);
    });
  }

  opened(runId: string): void {
    void this.#redis.publish(LIVE_CHANNELS.opened, runId).catch(() => undefined);
  }

  advanced(runId: string): void {
    void this.#redis.publish(LIVE_CHANNELS.advance, runId).catch(() => undefined);
  }

  closed(runId: string): void {
    void this.#redis.publish(LIVE_CHANNELS.closed, runId).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.#redis.quit().catch(() => {
      this.#redis.disconnect();
    });
  }
}
