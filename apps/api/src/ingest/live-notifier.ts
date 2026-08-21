import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { LIVE_CHANNELS } from '@perfportal/core';
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
 * regardless of any of these channels, and that poll is NOT redundant --
 * see its own docstring in `fold-owner.ts`.
 *
 * TWO OF THE THREE CHANNELS ARE OPTIMISATIONS; `live:closed` IS NOT.
 * `opened` and `advanced` only buy latency -- the poll finds an unclaimed
 * run and a claimed run's new bytes on its own schedule regardless. Design
 * §1.2, as amended, is explicit that the CLOSE path is incorrect without
 * its channel: `close()` enqueues the pipeline immediately, the pipeline
 * takes the same advisory lock the fold owner is still holding, and its
 * whole retry budget (BullMQ's three attempts on exponential backoff from
 * 2 s -- about 6 s) is shorter than the owner's own release latency, which
 * is `liveTickMs` plus an unbounded in-flight tick. Exhausting those
 * attempts strands the run at `parsing` until `parsingStaleAfterMs` -- 15
 * minutes. See `closed`'s own doc comment.
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
    void this.#redis.publish(LIVE_CHANNELS.opened, runId).catch(() => {});
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
    void this.#redis.publish(LIVE_CHANNELS.advance, runId).catch(() => {});
  }

  /**
   * A run's `close()` has claimed it off `running`. Tells the fold owner to
   * release its advisory lock NOW rather than on its next tick.
   *
   * NOT AN OPTIMISATION, unlike the two channels above -- design §1.2 as
   * amended. `close()` enqueues the terminal parse moments after this call,
   * and `PipelineService.process` takes the SAME advisory lock this owner
   * still holds (§1.1 reuses the namespace deliberately, so a run can never
   * be folded and parsed at once). The pipeline's whole budget for waiting
   * that out is BullMQ's three attempts on exponential backoff from 2 s --
   * roughly 6 s. The owner's own release latency is `liveTickMs` plus the
   * duration of whatever tick is in flight, and that duration is unbounded:
   * one tick folds and publishes up to `maxOwnedRuns` runs sequentially.
   * Raising `LIVE_TICK_MS` at all, or one slow tick at the defaults, burns
   * all three attempts -- and the run then sits at `parsing` until the
   * sweeper's `parsingStaleAfterMs` (15 minutes) re-enqueues it. A live
   * run's worst-case time to verdict becomes a quarter of an hour,
   * silently.
   *
   * A DROPPED MESSAGE IS STILL COVERED, which is why this being
   * load-bearing does not make it a single point of failure: the tick's
   * release pass drops any owned run whose status has left `running`
   * regardless. This channel removes the LATENCY of that pass, and the
   * latency is the whole defect.
   */
  closed(runId: string): void {
    void this.#redis.publish(LIVE_CHANNELS.closed, runId).catch(() => {});
  }

  async onModuleDestroy(): Promise<void> {
    await this.#redis.quit();
  }
}
