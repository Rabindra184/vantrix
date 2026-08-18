import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Wakes the fold owner immediately instead of leaving it to discover a new
 * run, or new bytes on one it already owns, only on its next tick (up to
 * `liveTickMs`, 5000ms by default, late) -- design part-2a §1.2 and §2.3.
 *
 * A DEDICATED provider, not a reach into `IngestQueue`'s BullMQ connection.
 * `IngestQueue` (`queue.ts`) takes a `redisUrl` and wraps a BullMQ `Queue`
 * without exposing the raw connection, and `LiveService`'s other injected
 * dependencies (config, repositories, blob/chunk stores, the queue, the
 * terminal waiter) carry no `Redis` client either -- the API otherwise has
 * none to reuse. Reaching into BullMQ's own connection instead would couple
 * a notification path to a job queue's internals for no reason.
 *
 * Both methods are synchronous and fire-and-forget BY SIGNATURE, not merely
 * by convention: returning `void` rather than `Promise<void>` means a caller
 * cannot accidentally `await` a publish into the request path. A message
 * carries only a run id, never bytes -- the bytes are already durable in
 * blob storage by the time either method is called, which is the whole
 * reason this is a notification rather than a queue (design §0).
 *
 * A dropped or undelivered message is harmless. Redis pub/sub has no
 * persistence: a message published while every worker is down (or between
 * deploys) reaches nobody. The fold owner's tick polls `running` runs
 * regardless of either channel, and that poll is NOT redundant -- see its
 * own docstring in `fold-owner.ts`. Both channels here are optimisations
 * over that poll, never replacements for it.
 */
@Injectable()
export class LiveNotifier implements OnModuleDestroy {
  readonly #redis: Redis;

  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl);
  }

  /**
   * A run was just opened (`POST /v1/runs/live` succeeded). Tells the fold
   * owner it can attempt a claim now, rather than waiting for the next
   * discovery poll to notice the new `running` row.
   */
  opened(runId: string): void {
    void this.#redis.publish('live:opened', runId).catch(() => {});
  }

  /**
   * Tells the fold owner a run advanced. Fire-and-forget by signature, not
   * just by convention: this must never block the 202, and a failure here
   * must never fail a chunk that was already accepted and durably stored.
   *
   * The message carries a run id, never bytes. The bytes are already in
   * blob storage, which is the whole reason this is a notification rather
   * than a queue (design §0).
   *
   * A dropped message is harmless: the owner's tick polls for `running`
   * runs regardless, and that poll is not redundant -- pub/sub has no
   * persistence, so anything published while every worker is down reaches
   * nobody.
   */
  advanced(runId: string): void {
    void this.#redis.publish('live:advance', runId).catch(() => {});
  }

  async onModuleDestroy(): Promise<void> {
    await this.#redis.quit();
  }
}
