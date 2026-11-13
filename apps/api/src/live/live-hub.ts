import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * The whole of what the fan-out needs from a subscriber.
 *
 * Deliberately NOT `ws.WebSocket`. `LiveGateway` wraps each published body in
 * the wire frame the client expects AND applies the backpressure policy before
 * writing, so what it registers here is its own sink over the socket. Typing
 * the room as the socket would force one of those two decisions into this
 * file and leave the wire protocol described in two places.
 */
export interface LiveSink {
  send(body: string): void;
}

/** A run's viewers on this pod, and the one SUBSCRIBE they all depend on. */
interface Room {
  readonly sinks: Set<LiveSink>;
  /** Settles when Redis has answered the room's SUBSCRIBE. See `LiveHub.join`. */
  readonly subscribed: Promise<void>;
}

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
  readonly #rooms = new Map<string, Room>();

  constructor(redisUrl: string) {
    this.#sub = new Redis(redisUrl);
    this.#sub.on('message', (channel, body) => {
      const runId = channel.slice('live:'.length);
      for (const socket of this.#rooms.get(runId)?.sinks ?? []) {
        // PER-SINK, INSIDE THE LOOP. `ws.send()` throws outright on a
        // CONNECTING socket, and a sink is free to fail for its own reasons;
        // an unguarded call therefore lets ONE dead socket abandon every
        // subscriber after it in iteration order -- for this delta, silently,
        // and repeatedly for as long as the dead one stays in the room.
        //
        // The failing sink is NOT removed here. A socket that is genuinely
        // gone is removed by LiveGateway's own 'close'/'error' handler, which
        // is the one place that knows a socket's lifecycle; guessing at it
        // from a single failed write would evict a subscriber whose next
        // write would have succeeded.
        try {
          socket.send(body);
        } catch {
          // Deliberately swallowed -- see above.
        }
      }
    });
  }

  /**
   * ═══ EVERY JOINER WAITS ON THE ROOM'S ONE SUBSCRIBE ═══
   *
   * A second join used to return the moment it found the room, whether or not
   * the first join's SUBSCRIBE had been answered. Two things followed. The
   * gateway seeds a viewer as soon as its join resolves, so the second viewer
   * was seeded over a subscription that did not exist yet. And if that
   * SUBSCRIBE was REFUSED, only the first joiner heard: the others sat in a
   * room nothing was subscribed to, and because the room was not empty when
   * the first one left, nothing ever subscribed it again. A run's viewers on
   * this pod received no delta for as long as any of them stayed.
   *
   * The room holds the subscribe's promise, and every join awaits it. A
   * refusal reaches all of them (the gateway closes each with 1011 and the
   * client reconnects), and takes the room with it, so the next join starts a
   * fresh one.
   */
  async join(runId: string, socket: LiveSink): Promise<void> {
    const existing = this.#rooms.get(runId);
    if (existing) {
      existing.sinks.add(socket);
      await existing.subscribed;
      return;
    }
    // The room is in the map BEFORE the subscribe is awaited: a second join
    // arriving while this one is in flight must find it and share its
    // SUBSCRIBE, not start another for the same channel.
    const room: Room = {
      sinks: new Set([socket]),
      subscribed: this.#sub.subscribe(`live:${runId}`).then(
        () => undefined,
        (err: unknown) => {
          // Only if it is still THIS room: one emptied and re-created while
          // the SUBSCRIBE was in flight belongs to a later join.
          if (this.#rooms.get(runId) === room) this.#rooms.delete(runId);
          throw err;
        },
      ),
    };
    this.#rooms.set(runId, room);
    await room.subscribed;
  }

  async leave(runId: string, socket: LiveSink): Promise<void> {
    const room = this.#rooms.get(runId);
    if (!room) return;
    room.sinks.delete(socket);
    if (room.sinks.size > 0) return;
    this.#rooms.delete(runId);
    await this.#sub.unsubscribe(`live:${runId}`);
  }

  size(runId: string): number {
    return this.#rooms.get(runId)?.sinks.size ?? 0;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.#rooms.clear();
    await this.#sub.quit();
  }
}
