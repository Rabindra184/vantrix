import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { WebSocket } from 'ws';

/**
 * ONE ioredis subscriber for the whole pod, and a set of sockets per run.
 *
 * This is what makes FR-LIVE-7's "no sticky routing" true rather than
 * aspirational: every pod subscribes to the runs it currently has viewers for,
 * so a viewer can land on any pod and a run needs no owning one.
 *
 * The subscriber is per POD rather than per socket because a connection per
 * socket puts a Redis connection count on the viewer count -- a number set by
 * how many people opened a page.
 *
 * A dedicated connection is required regardless: ioredis in subscriber mode
 * refuses ordinary commands, so this cannot share the client anything else uses.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  readonly #sub: Redis;
  readonly #rooms = new Map<string, Set<WebSocket>>();

  constructor(redisUrl: string) {
    this.#sub = new Redis(redisUrl);
    this.#sub.on('message', (channel, body) => {
      const runId = channel.slice('live:'.length);
      for (const socket of this.#rooms.get(runId) ?? []) socket.send(body);
    });
  }

  async join(runId: string, socket: WebSocket): Promise<void> {
    const room = this.#rooms.get(runId);
    if (room) {
      room.add(socket);
      return;
    }
    // Insert BEFORE awaiting the subscribe: a second join arriving while this
    // one is in flight must find the room and add to it, not start a second
    // SUBSCRIBE for the same channel.
    this.#rooms.set(runId, new Set([socket]));
    await this.#sub.subscribe(`live:${runId}`);
  }

  async leave(runId: string, socket: WebSocket): Promise<void> {
    const room = this.#rooms.get(runId);
    if (!room) return;
    room.delete(socket);
    if (room.size > 0) return;
    this.#rooms.delete(runId);
    await this.#sub.unsubscribe(`live:${runId}`);
  }

  size(runId: string): number {
    return this.#rooms.get(runId)?.size ?? 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.#rooms.clear();
    await this.#sub.quit();
  }
}
