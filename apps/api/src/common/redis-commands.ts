import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * The API's one Redis connection for ORDINARY commands, shared by everything
 * that issues them: the live gateway's seed (`GET`, `XRANGE`) and the
 * password-attempt throttle (`MULTI` of `INCR`, `EXPIRE`, `TTL`). One
 * connection for the process, opened at boot — never one per request.
 *
 * Two of the API's other Redis connections cannot be this one: `LiveHub`'s is
 * in subscriber mode, which refuses ordinary commands, and `IngestQueue`'s
 * belongs to BullMQ. `LiveNotifier` keeps the publisher it opened before this
 * existed; folding it in is a separate change.
 *
 * It owns the connection's lifetime: whoever is handed `client` must not quit
 * it.
 */
@Injectable()
export class RedisCommands implements OnModuleDestroy {
  readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
