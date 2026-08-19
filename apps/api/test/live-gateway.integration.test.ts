import { randomUUID } from 'node:crypto';
import { connect as tcpConnect, type AddressInfo } from 'node:net';
import type { LiveDelta } from '@perfportal/contracts';
import { OrgMemberRepository } from '@perfportal/persistence';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { LiveHub } from '../src/live/live-hub.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signUp, signUpAsOrgMember } from './support/session.js';

// Same fallback every other integration suite in this directory uses for a
// raw ioredis client (live-hub.integration.test.ts, live.integration.test.ts).
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

interface Frame {
  type: 'snapshot' | 'delta';
  partial?: boolean;
  /** Present on a snapshot frame only; see `snapshotFixture` below. */
  lastSeq?: number;
  delta: LiveDelta;
}

interface Conn {
  socket: WebSocket;
  frames: Frame[];
  closed: Promise<number>;
}

let ctx: TestContext;
let redis: Redis | undefined;
let conns: Conn[] = [];
let keys: string[] = [];

afterEach(async () => {
  for (const conn of conns) conn.socket.terminate();
  conns = [];
  if (redis && keys.length > 0) await redis.del(...keys);
  keys = [];
  await redis?.quit();
  redis = undefined;
  await ctx?.close();
});

/**
 * Every other suite here drives the app through supertest, which listens on
 * an ephemeral port per request. A WebSocket upgrade needs a URL, so this
 * one has to bind the server itself. `listen()` re-enters `init()` and Nest
 * makes that idempotent, so calling it after createTestApp() is safe, and
 * `ctx.close()` stops it again.
 */
async function start(): Promise<number> {
  ctx = await createTestApp();
  redis = new Redis(REDIS_URL);
  await ctx.app.listen(0);
  return (ctx.app.getHttpServer().address() as AddressInfo).port;
}

async function openLiveRun(): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs/live')
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .send({ tool: 'gatling' });
  expect(res.status).toBe(201);
  const runId = res.body.runId as string;
  keys.push(`live:${runId}:snapshot`, `live:${runId}:deltas`);
  return runId;
}

/**
 * A delta shaped exactly as the fold owner publishes one. Values are
 * DERIVED from `seq` and the offsets asked for, never written down twice:
 * every assertion below compares against the object this returned rather
 * than against a literal, so a change to the delta's shape breaks the
 * gateway's relay contract here and nothing else.
 */
function deltaFixture(runId: string, seq: number, offsets: number[]): LiveDelta {
  return {
    runId,
    seq,
    summary: {
      count: offsets.length * 10,
      okCount: offsets.length * 9,
      koCount: offsets.length,
      errorRate: 0.1,
      percentiles: { p50: 100 + seq, p95: 200 + seq },
      maxUsers: 5,
      durationMs: (offsets.at(-1) ?? 0) + 1000,
    },
    responseTime: {
      widthMs: 1000,
      replaces: false,
      buckets: offsets.map((startOffsetMs) => ({
        startOffsetMs,
        startedCount: 10,
        endedCount: 10,
        okCount: 9,
        koCount: 1,
        startedOkCount: 9,
        startedKoCount: 1,
        minMs: 10,
        maxMs: 300,
        meanMs: 120,
        percentiles: { p50: 100, p95: 250 },
        percentilesOk: { p50: 95, p95: 240 },
        percentilesKo: { p50: 400, p95: 500 },
      })),
    },
    users: {
      widthMs: 1000,
      buckets: offsets.map((startOffsetMs) => ({
        scenario: 'checkout', startOffsetMs, started: 5, ended: 0, active: 5,
      })),
    },
    errors: { rows: [{ message: 'status 500', count: offsets.length }] },
    sla: { evaluated: 2, notJudged: 0, rulesUnavailable: false, breaching: [] },
  };
}

/**
 * A snapshot key's content, built the way the PRODUCER builds it.
 *
 * ═══ A SNAPSHOT IS STAMPED WITH THE SEQ IT DOES NOT CONTAIN ═══
 * `LiveFoldOwner#publish` emits delta C, advances its cursor to C+1, and only
 * THEN writes the snapshot -- from the same EngineResult delta C came from,
 * stamped `next.seq`. So a key labelled C+1 holds state through delta C, and
 * the first delta a seeded client still needs is the stream entry AT C+1.
 *
 * WRITTEN OUT HERE ON PURPOSE. `apps/api` has no dependency on the worker, so
 * `buildSnapshot` cannot be imported to supply it -- and a fixture that
 * stamped the snapshot with the seq of the last delta it contains would encode
 * the GATEWAY's reading of the key on both sides of the assertion, leaving the
 * join between producer and gateway untested. That is the defect this fixture
 * exists to catch: reading the key the other way drops exactly one delta, and
 * drops it invisibly, because the client's own last-seen seq is contiguous.
 *
 * `replaces: true` for the same fidelity: `buildSnapshot` runs `buildDelta`
 * from `INITIAL_CURSOR`, which is "no lookback floor, replaces everything".
 */
function snapshotFixture(runId: string, throughSeq: number, offsets: number[]): LiveDelta {
  const base = deltaFixture(runId, throughSeq, offsets);
  return {
    ...base,
    seq: throughSeq + 1,
    responseTime: { ...base.responseTime, replaces: true },
  };
}

async function seedSnapshot(runId: string, delta: LiveDelta): Promise<void> {
  await redis!.set(`live:${runId}:snapshot`, JSON.stringify(delta), 'EX', 300);
}

async function appendDeltas(runId: string, deltas: LiveDelta[]): Promise<void> {
  for (const delta of deltas) {
    await redis!.xadd(`live:${runId}:deltas`, '*', 'delta', JSON.stringify(delta));
  }
}

function connect(port: number, path: string, cookie?: string): Conn {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const frames: Frame[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  const closed = new Promise<number>((resolve) => {
    // A rejected UPGRADE (rather than a rejected socket) surfaces as 'error'
    // on the ws client; without a listener that is an unhandled 'error'
    // event and kills the worker. Resolving 0 keeps the two shapes
    // distinguishable in an assertion.
    socket.on('error', () => resolve(0));
    socket.on('close', (code) => resolve(code));
  });
  const conn = { socket, frames, closed };
  conns.push(conn);
  return conn;
}

function collect(conn: Conn, count: number): Promise<Frame[]> {
  return vi
    .waitFor(() => {
      expect(conn.frames.length).toBeGreaterThanOrEqual(count);
    }, { timeout: 10_000 })
    .then(() => conn.frames.slice(0, count));
}

describe('the live gateway rejects what it should', () => {
  // Nest's HTTP guards do not run on an upgrade. A gateway that declares
  // @UseGuards(AuthGuard) and stops there is unauthenticated while reading as
  // guarded -- the decorator is accepted and never consulted.
  it('closes an upgrade carrying no session cookie, without sending a frame', async () => {
    const port = await start();
    const runId = await openLiveRun();

    const conn = connect(port, `/v1/runs/${runId}/live`);

    await expect(conn.closed).resolves.toBeGreaterThanOrEqual(4000);
    expect(conn.frames).toHaveLength(0);
  });

  it('closes an upgrade whose session belongs to another org', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const other = await ctx.prisma.org.create({
      data: { slug: `org-${randomUUID().slice(0, 8)}`, name: 'Other' },
    });
    const { cookie, userId } = await signUp(ctx.app, `outsider-${randomUUID()}@example.com`);
    await ctx.app.get(OrgMemberRepository).add(userId, other.id, 'member');

    const conn = connect(port, `/v1/runs/${runId}/live`, cookie);

    await expect(conn.closed).resolves.toBeGreaterThanOrEqual(4000);
    expect(conn.frames).toHaveLength(0);
  });

  /**
   * A REPRODUCED UNAUTHENTICATED REMOTE PROCESS CRASH, and the reason this
   * asserts on `uncaughtException` rather than on anything the socket does.
   *
   * `ws.close()` does not stop the socket READING. The receiver keeps parsing
   * whatever arrives next, and a frame declaring more than `maxPayload` -- or
   * any protocol violation, including plain garbage -- reaches
   * `receiverOnError`, which emits 'error' on the WebSocket. With no listener
   * that is an uncaught exception, and in production the pod exits: every
   * viewer on it disconnected, by an anonymous caller, over and over.
   *
   * Registering a listener is also what makes this assertable -- any
   * `uncaughtException` listener suppresses Node's default handler, so the
   * run survives either way and the array is the only evidence.
   */
  it('survives garbage sent on a socket it has already rejected', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const seen: Error[] = [];
    const record = (err: Error): void => void seen.push(err);
    process.on('uncaughtException', record);

    try {
      // A masked frame declaring 1 MiB, past the 4096-byte inbound cap.
      const oversized = Buffer.alloc(14);
      oversized[0] = 0x82; // FIN + binary
      oversized[1] = 0x80 | 127; // masked, 64-bit length
      oversized.writeBigUInt64BE(1n << 20n, 2);
      oversized.write('abcd', 10, 'ascii');
      const conn = connect(port, `/v1/runs/${runId}/live`);
      await new Promise<void>((resolve) => {
        conn.socket.on('open', () => {
          (conn.socket as unknown as { _socket: { write(b: Buffer): void } })._socket.write(oversized);
          resolve();
        });
        conn.socket.on('close', () => resolve());
        setTimeout(resolve, 3000);
      });

      // And the same failure by the cruder route: bytes appended to the
      // upgrade request itself, which the receiver parses as frames the
      // instant the handshake completes.
      await new Promise<void>((resolve) => {
        const raw = tcpConnect(port, '127.0.0.1', () => {
          raw.write(
            `GET /v1/runs/${runId}/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
              `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
              `Sec-WebSocket-Version: 13\r\n\r\n`,
          );
          raw.write(Buffer.alloc(4096, 0x41));
          setTimeout(() => {
            raw.destroy();
            resolve();
          }, 250);
        });
        raw.on('error', () => resolve());
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
    }
  });

  /**
   * TASK 9 A1, THE LAST OF THIS FILE'S UNAUTHENTICATED REMOTE PROCESS-EXIT
   * VECTORS -- and, unlike the case above, a REJECTED PROMISE rather than a
   * synchronous 'error' event, so this asserts on 'unhandledRejection'.
   *
   * `onUpgrade` used to be `void this.handleUpgrade(req, socket, head)` with
   * no `.catch()`. `handleUpgrade`'s own `try` wraps only `this.authorize(...)`;
   * `new URL(req.url, 'http://localhost')` runs BEFORE that try, and an
   * absolute-form request target (RFC 7230 §5.3.2) carrying a port out of
   * range is enough to make it throw "Invalid URL". Thrown inside an async
   * function with nothing awaiting or catching it, that became an unhandled
   * rejection -- and on Node 22 that exits the process, for every OTHER
   * viewer on the pod, over one malformed request line from an anonymous
   * caller who never even reached the handshake.
   */
  it('survives a pathological absolute-form request target new URL() cannot parse', async () => {
    const port = await start();
    const seen: unknown[] = [];
    const record = (reason: unknown): void => void seen.push(reason);
    process.on('unhandledRejection', record);

    try {
      await new Promise<void>((resolve) => {
        const raw = tcpConnect(port, '127.0.0.1', () => {
          raw.write(
            'GET http://x:99999/v1/runs/anything/live HTTP/1.1\r\nHost: x\r\n' +
              'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
          setTimeout(() => {
            raw.destroy();
            resolve();
          }, 250);
        });
        raw.on('error', () => resolve());
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  /**
   * The SECOND reachable example the same defect class covers: `serve` is
   * dispatched with `void this.serve(...)` (`handleUpgrade`, below the
   * authorization check), a fire-and-forget call whose own rejection the
   * `onUpgrade` fix above cannot see -- an async function's errors never
   * propagate synchronously to a `void` caller, no matter how early they
   * occur, so `serve`'s promise is an entirely separate chain from
   * `handleUpgrade`'s once dispatched. `serve`'s own `catch` used to call
   * `socket.close(1011, 'seed failed')` unguarded; if THAT throws -- a
   * socket left in an unexpected state by whatever made the seed fail in the
   * first place is exactly the kind of thing that could -- the throw
   * reaches nobody, and is this file's next remote crash vector.
   *
   * Forces the seed to fail (`LiveHub#join` rejected) and the recovery close
   * to fail too (`WebSocket#close` throwing on its first call this test
   * makes -- which, with a real join short-circuited by the mock, is
   * guaranteed to be exactly this one), so the case reaches the nested catch
   * this task adds rather than merely exercising the outer one.
   */
  it("survives socket.close() itself throwing inside serve's own catch", async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);

    const hub = ctx.app.get(LiveHub);
    const joinSpy = vi.spyOn(hub, 'join').mockRejectedValueOnce(new Error('join boom'));
    const closeSpy = vi
      .spyOn(WebSocket.prototype, 'close')
      .mockImplementationOnce(() => {
        throw new Error('close boom');
      });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const record = (reason: unknown): void => void seen.push(reason);
    process.on('unhandledRejection', record);

    try {
      connect(port, `/v1/runs/${runId}/live`, cookie);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen).toEqual([]);
      // Both mocked calls were actually reached -- otherwise this would pass
      // for the wrong reason (nothing exercised the nested catch at all).
      expect(joinSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', record);
      joinSpy.mockRestore();
      closeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // Answering these two differently -- a different close code, a different
  // latency, a frame on one and not the other -- turns this endpoint into an
  // existence oracle for run ids across the whole deployment.
  it('answers a foreign run and a run that does not exist identically', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const other = await ctx.prisma.org.create({
      data: { slug: `org-${randomUUID().slice(0, 8)}`, name: 'Other' },
    });
    const { cookie: outsider, userId } = await signUp(ctx.app, `outsider-${randomUUID()}@example.com`);
    await ctx.app.get(OrgMemberRepository).add(userId, other.id, 'member');
    const member = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);

    const foreign = connect(port, `/v1/runs/${runId}/live`, outsider);
    const missing = connect(port, `/v1/runs/${randomUUID()}/live`, member);

    expect(await foreign.closed).toBe(await missing.closed);
    expect(foreign.frames).toHaveLength(0);
    expect(missing.frames).toHaveLength(0);
  });
});

describe('the live gateway seeds, replays, then follows', () => {
  it('replays from the stream entry AT the snapshot seq, which the snapshot does not contain', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    // C is the last delta the snapshot's CONTENT covers; the key is stamped
    // C+1. See snapshotFixture -- the whole point of this case is that the two
    // numbers differ, so the fixture must not be built from the gateway's own
    // reading of the key.
    const C = 5;
    const snapshot = snapshotFixture(runId, C, [0, 1000, 2000, 3000, 4000]);
    expect(snapshot.seq).toBe(C + 1);
    await seedSnapshot(runId, snapshot);
    const stream = [C, C + 1, C + 2].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000]));
    await appendDeltas(runId, stream);

    const frames = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 3);

    expect(frames[0]!.type).toBe('snapshot');
    expect(frames[0]!.partial).toBe(false);
    expect(frames[0]!.delta.seq).toBe(C + 1);
    // Delta C is NOT re-sent -- the snapshot already carries it. Delta C+1 IS,
    // and dropping it is invisible downstream: the client's own last-seen seq
    // would be C+1 either way, so its gap detection never fires and a handful
    // of responseTime buckets just vanish from the middle of the chart.
    expect(frames.slice(1).map((f) => f.type)).toEqual(['delta', 'delta']);
    expect(frames.slice(1).map((f) => f.delta.seq)).toEqual([C + 1, C + 2]);
    // The resume cursor is the seq the client HOLDS, which after this seed is
    // the last delta delivered -- never the snapshot's own label.
    expect(frames[0]!.lastSeq).toBe(C + 2);
  });

  // The one case where the snapshot's label and the client's cursor differ on
  // the wire, and the only one that can pin it: nothing to replay, so the
  // client holds state through C while the frame it just read says C+1.
  it('tells a client seeded from a snapshot alone to resume one behind its label', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const C = 5;
    await seedSnapshot(runId, snapshotFixture(runId, C, [0, 1000, 2000]));

    const [first] = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 1);

    expect(first!.delta.seq).toBe(C + 1);
    expect(first!.lastSeq).toBe(C);
  });

  // §2.3: a stream that no longer reaches the snapshot's seq is a genuine hole
  // in the MIDDLE of the series, and a consumer cannot tell a bucket that was
  // never sent from one that saw no traffic. Reading the seam one off makes
  // this report as healthy.
  it('marks the seed partial when the stream no longer reaches the snapshot seq', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const C = 5;
    await seedSnapshot(runId, snapshotFixture(runId, C, [0, 1000, 2000, 3000, 4000]));
    // C+1 is missing: the snapshot stops at C, the stream starts at C+2.
    await appendDeltas(runId, [C + 2, C + 3].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000])));

    const [first] = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 1);

    expect(first!.type).toBe('snapshot');
    expect(first!.partial).toBe(true);
  });

  // The seed is the ONE thing a browser cannot do for itself: it cannot read
  // a Redis key. If this regresses to a client-side fetch the endpoint is
  // unusable.
  it('sends a partial snapshot rather than refusing when the key has expired', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    await redis!.del(`live:${runId}:snapshot`);
    await appendDeltas(runId, [deltaFixture(runId, 9, [8000])]);

    const [first] = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 1);

    expect(first!.type).toBe('snapshot');
    expect(first!.partial).toBe(true);
    expect(first!.delta.seq).toBe(9);
  });

  // A run whose owner has not ticked yet has neither key. Refusing here
  // would refuse every connection made in a run's first few seconds.
  it('sends an empty partial snapshot when neither key exists yet', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);

    const [first] = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 1);

    expect(first!.type).toBe('snapshot');
    expect(first!.partial).toBe(true);
    expect(first!.delta.runId).toBe(runId);
    expect(first!.delta.responseTime.buckets).toEqual([]);
    // -1, NOT 0. Deltas are zero-indexed, and seq 0 is the one delta carrying
    // `replaces: true` and the series from offset 0 -- so a cursor of 0 here
    // makes the flush drop the owner's very first tick on `0 > 0`, for exactly
    // the client that opened the page in the run's first seconds.
    expect(first!.lastSeq).toBe(-1);
  });

  // A resume cursor is an optimisation; a bad one must degrade to the correct
  // answer -- a full seed -- never to a partial series presented as whole.
  it('ignores a malformed resume cursor and seeds in full', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const snapshot = snapshotFixture(runId, 5, [0, 1000, 2000, 3000, 4000]);
    await seedSnapshot(runId, snapshot);

    const [first] = await collect(connect(port, `/v1/runs/${runId}/live?lastSeq=nonsense`, cookie), 1);

    expect(first!.type).toBe('snapshot');
    expect(first!.delta).toEqual(snapshot);
  });

  // Design §5.2. Without the snapshot key this fails with holes at the FRONT
  // of the series, which is exactly the defect §2 exists for. The gateway's
  // contract is to RELAY the producer's own state and to join the stream with
  // no gap at the seam -- not to recompute the fold, which is proven
  // worker-side by Task 4's own test.
  it('reconstructs a run whose stream no longer reaches its start', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const C = 5;
    const snapshot = snapshotFixture(runId, C, [0, 1000, 2000, 3000, 4000]);
    await seedSnapshot(runId, snapshot);
    // The stream has been trimmed to exactly the snapshot's own seam: its
    // oldest surviving entry is C+1, and nothing in it carries the run's first
    // buckets -- so a client replaying only the stream would draw a series
    // beginning at 5000ms and never know it.
    const tail = [C + 1, C + 2, C + 3].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000]));
    await appendDeltas(runId, tail);
    const oldest = await redis!.xrange(`live:${runId}:deltas`, '-', '+', 'COUNT', 1);
    expect(JSON.parse(oldest[0]![1][1]!).seq).toBeGreaterThan(1); // genuinely trimmed

    const frames = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 4);

    // Relayed faithfully, field for field -- not summarised, not re-encoded.
    expect(frames[0]!.type).toBe('snapshot');
    expect(frames[0]!.partial).toBe(false);
    expect(frames[0]!.delta).toEqual(snapshot);
    expect(frames[0]!.delta.responseTime.buckets[0]!.startOffsetMs).toBe(0);
    // ...and joined with NO gap at the seam: the replay begins at the entry
    // the snapshot's label names, not after it.
    expect(frames.slice(1).map((f) => f.delta)).toEqual(tail);
    expect(frames.slice(1).map((f) => f.delta.seq)).toEqual([C + 1, C + 2, C + 3]);
  });

  it('follows the run live once the seed is delivered', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    await seedSnapshot(runId, snapshotFixture(runId, 0, [0]));
    const conn = connect(port, `/v1/runs/${runId}/live`, cookie);
    await collect(conn, 1);
    await vi.waitFor(() => expect(ctx.app.get(LiveHub).size(runId)).toBe(1));

    // Seq 1 is exactly the snapshot's label -- the delta it does NOT contain.
    const live = deltaFixture(runId, 1, [1000]);
    await redis!.publish(`live:${runId}`, JSON.stringify(live));

    const frames = await collect(conn, 2);
    expect(frames[1]).toEqual({ type: 'delta', delta: live });
  });

  it('replays forward from the client-supplied lastSeq instead of re-seeding', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    await seedSnapshot(runId, snapshotFixture(runId, 5, [0, 1000, 2000, 3000, 4000]));
    await appendDeltas(runId, [6, 7, 8].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000])));

    // A QUERY PARAMETER, not a first frame: the server has the answer before
    // the handshake completes, so a fresh connection -- which sends nothing --
    // never waits out a timeout to be told it is fresh.
    const conn = connect(port, `/v1/runs/${runId}/live?lastSeq=6`, cookie);

    const frames = await collect(conn, 2);
    // No snapshot frame at all: the client already holds everything up to 6,
    // and re-sending a ~2 MB seed it has is the cost this cursor exists to
    // avoid.
    expect(frames.map((f) => f.type)).toEqual(['delta', 'delta']);
    expect(frames.map((f) => f.delta.seq)).toEqual([7, 8]);
  });

  // LiveHub deliberately has no socket-lifecycle awareness, so nothing but
  // the gateway can remove a closed socket from its room. Left unwired, a
  // room never reaches size 0 and the Redis subscription for that run never
  // tears down -- for the life of the pod.
  it('leaves the hub room when the socket closes, so the subscription tears down', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const hub = ctx.app.get(LiveHub);
    const conn = connect(port, `/v1/runs/${runId}/live`, cookie);
    await collect(conn, 1);
    await vi.waitFor(() => expect(hub.size(runId)).toBe(1));

    conn.socket.close();
    await conn.closed;

    await vi.waitFor(() => expect(hub.size(runId)).toBe(0));
  });
});
