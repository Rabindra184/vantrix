import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import type { LiveDelta } from '@perfportal/contracts';
import type { OrgMemberRepository, RunRepository } from '@perfportal/persistence';
import { fromNodeHeaders } from 'better-auth/node';
import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { auth } from '../auth/better-auth.instance.js';
import { LiveHub, type LiveSink } from './live-hub.js';

/**
 * `GET /v1/runs/:id/live`. The id is matched as an opaque segment rather than
 * as a uuid: a malformed id must reach {@link LiveGateway.authorize} and be
 * refused there, identically to a foreign one, instead of falling through to
 * "not this endpoint's path" and leaving the socket to hang.
 */
const LIVE_PATH = /^\/v1\/runs\/([^/]+)\/live$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Not authenticated, not a member, or not this org's run — one code for all three. */
export const CLOSE_UNAUTHORIZED = 4401;

/** The client stopped reading. It reconnects and re-seeds; design §3.4. */
export const CLOSE_TOO_FAR_BEHIND = 4408;

/**
 * Above this, a client is not reading and the pod is paying for it.
 *
 * It has to clear one snapshot frame with room to spare -- a full series plus
 * a 20-scenario users envelope reaches ~2 MB (design §2.4) -- or the SEED
 * itself would trip the guard on a slow link and the connection could never
 * establish. 8 MiB is four such frames.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * The most a client may send in one frame.
 *
 * Its entire vocabulary is `{ lastSeq: number }`. `ws` defaults to a 100 MiB
 * inbound limit, which on an endpoint that reads exactly one small object is
 * a per-socket heap budget handed to whoever opened the socket.
 */
const MAX_CLIENT_FRAME_BYTES = 4096;

/**
 * How long the seed waits for the client's optional `{ lastSeq }` frame.
 *
 * The resume cursor is a FRAME rather than a query parameter (design §2.2), so
 * there is no way to know a fresh connection is fresh except by not hearing
 * one. That costs every fresh connect this much latency before its snapshot --
 * against re-sending a ~2 MB seed the client already holds on every reconnect,
 * which is precisely what a deploy or a wifi blip produces in bulk. A quarter
 * of a second against a 5 s tick is not visible; the seed is not.
 */
const RESUME_FRAME_WAIT_MS = 250;

/**
 * Deltas the hub may deliver while the seed is still being read.
 *
 * The socket joins the room BEFORE reading Redis (see {@link LiveGateway.serve}),
 * so anything published during the seed is held here and flushed behind it.
 * At one delta per tick this is never more than one or two; overflowing it
 * means the seed took most of a minute, and the socket is closed rather than
 * silently holed, because a consumer cannot tell a bucket that was never sent
 * from one that saw no traffic.
 */
const MAX_PENDING_DELTAS = 8;

interface StreamEntry {
  seq: number;
  /** The producer's own JSON, spliced into the frame verbatim — never re-encoded. */
  body: string;
}

interface Seed {
  /** The snapshot frame's delta body, or null when resuming from a client cursor. */
  snapshot: string | null;
  partial: boolean;
  replay: StreamEntry[];
  lastSeq: number;
}

/**
 * Reads a delta's `seq` without trusting the body.
 *
 * A corrupt or half-written key reads as absent rather than as a delta with a
 * missing sequence number, which would be indistinguishable from a genuine
 * one at the consumer and would poison the gap detection the whole protocol
 * rests on.
 */
function seqOf(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const seq = (parsed as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

/**
 * The seed for a run whose owner has not ticked yet: neither key exists, and
 * refusing would refuse every connection made in a run's first seconds.
 *
 * `replaces: true` so the consumer's series is emptied rather than merged
 * into, and both widths are the engine's own base width -- corrected by the
 * first real delta, which arrives within one tick.
 */
function emptyDelta(runId: string): LiveDelta {
  return {
    runId,
    seq: 0,
    summary: {
      count: 0,
      okCount: 0,
      koCount: 0,
      errorRate: 0,
      percentiles: {},
      maxUsers: 0,
      durationMs: 0,
    },
    responseTime: { widthMs: 1000, replaces: true, buckets: [] },
    users: { widthMs: 1000, buckets: [] },
    errors: { rows: [] },
  };
}

/**
 * The WebSocket endpoint a browser watches a running load test through.
 *
 * NOT a `@WebSocketGateway`. Nest's `ws` adapter matches a literal path and
 * has no notion of a route parameter, so `/v1/runs/:id/live` cannot be
 * expressed through it; this attaches its own `'upgrade'` listener to the
 * HTTP server Nest already owns. That is also what makes the authorization
 * below possible at the only point it is meaningful -- before the handshake.
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES });
  readonly #redis: Redis;

  /**
   * A SECOND Redis client, beside {@link LiveHub}'s. Not an oversight: ioredis
   * in subscriber mode refuses ordinary commands, so the hub's connection
   * cannot serve the `GET`/`XRANGE` the seed is made of.
   */
  constructor(
    redisUrl: string,
    private readonly hub: LiveHub,
    private readonly runs: RunRepository,
    private readonly members: OrgMemberRepository,
    private readonly adapterHost: HttpAdapterHost,
  ) {
    this.#redis = new Redis(redisUrl);
  }

  onApplicationBootstrap(): void {
    // `getHttpServer()` is the SAME `http.Server` Nest hands Express, and it
    // exists from `init()` onward -- `listen()` only binds it. Attaching here
    // rather than from `main.ts` means every way this app is constructed
    // (production, `createTestApp`) gets the endpoint, instead of one wiring
    // line that a second entry point can forget.
    const server = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!server) return;
    server.on('upgrade', this.onUpgrade);
  }

  async onModuleDestroy(): Promise<void> {
    this.#wss.close();
    await this.#redis.quit();
  }

  /**
   * NEST'S HTTP GUARDS DO NOT RUN ON AN UPGRADE.
   *
   * `AuthGuard`, `SessionOnlyGuard` and `@Scopes` are bound to the HTTP
   * request pipeline, which a WebSocket upgrade never traverses -- and neither
   * does `AuthMiddleware`, mounted on `v1/*path`, for the same reason. A
   * gateway that declares `@UseGuards(AuthGuard)` compiles, reads as guarded
   * in review, and is unauthenticated. So the checks are here, explicitly, and
   * they run BEFORE the handshake completes rather than on an accepted socket.
   *
   * This resolves the session exactly as `auth.middleware.ts` does. It must
   * not resolve it some other way: two answers to "who is this" is two
   * authorization models, and the weaker one wins.
   */
  private async authorize(req: IncomingMessage, runId: string): Promise<{ orgId: string } | null> {
    // Before the repository, not after: `run.id` is a uuid column, so a
    // malformed id reaches Postgres as a cast error -- a 500-shaped outcome
    // that is loudly DIFFERENT from the silent refusal below.
    if (!UUID.test(runId)) return null;

    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return null;

    const membership = await this.members.findOrgForUser(session.user.id);
    if (!membership) return null;

    // A run in another org and a run that does not exist answer the SAME way,
    // because `findById` is org-scoped and returns null for both. Splitting
    // them turns this endpoint into an existence oracle for run ids across the
    // whole deployment.
    const run = await this.runs.findById({ orgId: membership.orgId }, runId);
    if (!run) return null;

    return { orgId: membership.orgId };
  }

  /**
   * Bound once, as a field, so `onModuleDestroy` and a future detach have a
   * stable reference and `this` is the gateway rather than the HTTP server.
   */
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void this.handleUpgrade(req, socket, head);
  };

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const runId = LIVE_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1];
    if (runId === undefined) {
      // Node destroys an upgrade nobody listens for; the moment THIS listener
      // exists it stops doing that, so an unmatched path would hold a socket
      // open with nothing ever answering it. This is the app's only WebSocket
      // surface -- adding a second one makes this a dispatch decision rather
      // than a fallthrough.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let authorized: { orgId: string } | null;
    try {
      authorized = await this.authorize(req, runId);
    } catch (err) {
      // An outage is not an authentication failure, and answering 4401 would
      // tell an entirely legitimate client to stop trying. Refuse the upgrade
      // itself so the client sees a retryable transport error.
      console.error(`LiveGateway: authorization failed for ${runId}:`, err);
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // The client may have given up while the session and the run were being
    // read; handleUpgrade on a dead socket throws.
    if (socket.destroyed) return;

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authorized) {
        // CLOSED, never accepted-then-errored: an accepted socket is one an
        // unauthorized caller can hold open. There is no `await` between the
        // handshake and this close, so no frame can precede it -- which is
        // what the integration test asserts, rather than merely asserting the
        // socket closed.
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      void this.serve(ws, runId);
    });
  }

  /**
   * Seed, replay, follow -- design §2.2, with the join moved to the FRONT.
   *
   * The brief's order (seed, replay, then join) leaves a window between the
   * last `XRANGE` and the `SUBSCRIBE` in which a published delta reaches
   * nobody: the stream read has already passed it and the room does not exist
   * yet. That window is a Redis round trip wide, and what falls into it is a
   * hole the consumer can only recover from by noticing a `seq` gap and
   * reconnecting -- paying for a whole fresh seed. Joining first and holding
   * what arrives closes it; the buffer is flushed behind the replay, filtered
   * by `seq`, so nothing is delivered twice or out of order.
   */
  private async serve(socket: WebSocket, runId: string): Promise<void> {
    let seeded = false;
    let lastSeq = -1;
    const pending: string[] = [];

    const sink: LiveSink = {
      send: (body) => {
        if (seeded) {
          if (seqOf(body) !== null) this.deliver(socket, body);
          return;
        }
        if (pending.length >= MAX_PENDING_DELTAS) {
          socket.close(CLOSE_TOO_FAR_BEHIND, 'seed too slow');
          return;
        }
        pending.push(body);
      },
    };

    // THE FIX FOR THE LEAK LiveHub CANNOT SEE. A socket that closes without a
    // `leave()` stays in its room forever, the room never reaches size 0, and
    // the run's Redis subscription never tears down -- for the life of the
    // pod. `error` as well as `close`: a socket that errors may never emit
    // `close`, and `leave` is idempotent, so wiring both costs nothing.
    const leave = (): void => {
      void this.hub.leave(runId, sink).catch(() => undefined);
    };
    socket.on('close', leave);
    socket.on('error', leave);

    // Registered before the first `await`, so a client that sends its resume
    // cursor the instant the handshake completes cannot beat the listener.
    const resume = this.awaitResume(socket);

    try {
      await this.hub.join(runId, sink);
      const clientLastSeq = await resume;
      const seed = await this.seed(runId, clientLastSeq);
      if (socket.readyState !== WebSocket.OPEN) return;

      if (seed.snapshot !== null) {
        this.write(socket, `{"type":"snapshot","partial":${seed.partial},"delta":${seed.snapshot}}`);
      }
      for (const entry of seed.replay) this.deliver(socket, entry.body);
      lastSeq = seed.lastSeq;

      const buffered = pending.splice(0);
      seeded = true;
      for (const body of buffered) {
        const seq = seqOf(body);
        if (seq !== null && seq > lastSeq) this.deliver(socket, body);
      }
    } catch (err) {
      console.error(`LiveGateway: seed failed for ${runId}:`, err);
      socket.close(1011, 'seed failed');
    }
  }

  /**
   * Waits for the client's optional `{ lastSeq }` frame, or gives up.
   *
   * Anything that is not a non-negative integer `lastSeq` -- a malformed
   * frame, a hostile one, an empty one -- resolves to null and takes the fresh
   * seed. A resume cursor is an optimisation; a bad one must degrade to the
   * correct answer, never to a partial series presented as whole.
   */
  private awaitResume(socket: WebSocket): Promise<number | null> {
    return new Promise((resolve) => {
      const finish = (value: number | null): void => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('close', onClose);
        resolve(value);
      };
      const onMessage = (data: RawData): void => {
        try {
          const parsed: unknown = JSON.parse(String(data));
          const value = (parsed as { lastSeq?: unknown }).lastSeq;
          finish(typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
        } catch {
          finish(null);
        }
      };
      const onClose = (): void => finish(null);
      const timer = setTimeout(() => finish(null), RESUME_FRAME_WAIT_MS);
      socket.on('message', onMessage);
      socket.on('close', onClose);
    });
  }

  /**
   * ONE RETRY ON A HOLE, and that is design §2.3's whole argument made
   * executable: `SNAPSHOT_EVERY_N_TICKS` sits well inside the replay window,
   * but `REPLAY_BUDGET_BYTES` can shrink that window at any moment, so "the
   * stream's oldest entry is newer than the snapshot's seq" is a RECOVERABLE
   * state -- the snapshot is rewritten every 60 ticks and a second read
   * usually lands past the hole -- rather than an error. If the second read is
   * still holed, the seed goes out marked `partial` instead of presenting a
   * series with a hole in the middle as complete.
   */
  private async seed(runId: string, clientLastSeq: number | null): Promise<Seed> {
    if (clientLastSeq !== null) {
      const entries = await this.readStream(runId);
      const oldest = entries[0]?.seq;
      // `oldest === clientLastSeq + 1` still reaches: the client's own entry
      // has been trimmed, but nothing after it has.
      if (oldest === undefined || oldest <= clientLastSeq + 1) {
        const replay = entries.filter((entry) => entry.seq > clientLastSeq);
        return { snapshot: null, partial: false, replay, lastSeq: replay.at(-1)?.seq ?? clientLastSeq };
      }
      // The stream no longer reaches the client's cursor. Fall through and
      // re-seed exactly as a fresh connection does -- the server owns this
      // judgement, so the client has one recovery path and not two.
    }

    const first = await this.attemptSeed(runId);
    return first.holed ? await this.attemptSeed(runId) : first;
  }

  private async attemptSeed(runId: string): Promise<Seed & { holed: boolean }> {
    // SNAPSHOT FIRST, STREAM SECOND, always. Read the other way round and a
    // snapshot written in between claims a seq past every entry just read, so
    // the catch-up starts beyond the seed and drops whatever fell between.
    const snapshot = await this.readSnapshot(runId);
    const entries = await this.readStream(runId);

    if (snapshot === null) {
      // Degraded, not broken (design §2.2): send whatever the stream still
      // holds and SAY it is partial. Its oldest entry becomes the seed and the
      // rest replay behind it, so each envelope keeps its own `replaces` flag
      // -- the gateway relays, it does not re-fold.
      const head = entries[0];
      return {
        snapshot: head?.body ?? JSON.stringify(emptyDelta(runId)),
        partial: true,
        replay: entries.slice(1),
        lastSeq: entries.at(-1)?.seq ?? 0,
        holed: false,
      };
    }

    const oldest = entries[0]?.seq;
    const holed = oldest !== undefined && oldest > snapshot.seq + 1;
    const replay = entries.filter((entry) => entry.seq > snapshot.seq);
    return {
      snapshot: snapshot.body,
      partial: holed,
      replay,
      lastSeq: replay.at(-1)?.seq ?? snapshot.seq,
      holed,
    };
  }

  private async readSnapshot(runId: string): Promise<StreamEntry | null> {
    const body = await this.#redis.get(`live:${runId}:snapshot`);
    if (body === null) return null;
    const seq = seqOf(body);
    return seq === null ? null : { seq, body };
  }

  /**
   * The WHOLE stream, filtered in this process rather than ranged in Redis.
   *
   * `XRANGE` ranges over stream IDs, and the producer `XADD`s with `*` -- so
   * the ids are Redis timestamps and carry no relation to a delta's own `seq`.
   * There is no id to range from. The stream is bounded by
   * `REPLAY_MAX_ENTRIES` (200) and `REPLAY_BUDGET_BYTES` (4 MiB) at every
   * write, so reading it whole is bounded too.
   */
  private async readStream(runId: string): Promise<StreamEntry[]> {
    const rows = await this.#redis.xrange(`live:${runId}:deltas`, '-', '+');
    const entries: StreamEntry[] = [];
    for (const [, fields] of rows) {
      // The producer writes a single `delta <json>` field pair.
      const body = fields[1];
      if (typeof body !== 'string') continue;
      const seq = seqOf(body);
      if (seq !== null) entries.push({ seq, body });
    }
    return entries;
  }

  private deliver(socket: WebSocket, deltaBody: string): void {
    // String splice, not parse-and-re-encode: the delta reaching the browser
    // is byte-for-byte what the fold owner published, and a ~2 MB body is not
    // round-tripped through JSON once per socket.
    this.write(socket, `{"type":"delta","delta":${deltaBody}}`);
  }

  private write(socket: WebSocket, frame: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Design §3.4: a client that far behind is not reading, and an unbounded
      // per-socket buffer on a shared pod is the pod's problem rather than
      // that client's. Dropping the viewer is recoverable — it reconnects and
      // re-seeds.
      socket.close(CLOSE_TOO_FAR_BEHIND, 'too far behind');
      return;
    }
    socket.send(frame);
  }
}
