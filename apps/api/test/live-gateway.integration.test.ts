import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
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
      buckets: offsets.map((startOffsetMs) => ({ scenario: 'checkout', startOffsetMs, active: 5 })),
    },
    errors: { rows: [{ message: 'status 500', count: offsets.length }] },
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

function opened(conn: Conn): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.socket.on('open', () => resolve());
    conn.socket.on('error', reject);
  });
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
  it('seeds from the snapshot, then replays the stream forward from its seq', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const snapshot = deltaFixture(runId, 5, [0, 1000, 2000, 3000, 4000]);
    await seedSnapshot(runId, snapshot);
    const tail = [5, 6, 7, 8].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000]));
    await appendDeltas(runId, tail);

    const frames = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 4);

    expect(frames[0]!.type).toBe('snapshot');
    expect(frames[0]!.partial).toBe(false);
    expect(frames[0]!.delta.seq).toBe(snapshot.seq);
    expect(frames.slice(1).map((f) => f.type)).toEqual(['delta', 'delta', 'delta']);
    // The stream entry AT the snapshot's seq is not re-sent: the snapshot
    // already carries it, and a consumer that upserts by startOffsetMs would
    // not notice the duplicate, which is exactly why it has to be asserted.
    expect(frames.slice(1).map((f) => f.delta.seq)).toEqual([6, 7, 8]);
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
    const snapshot = deltaFixture(runId, 5, [0, 1000, 2000, 3000, 4000]);
    await seedSnapshot(runId, snapshot);
    // The stream has been trimmed past the run's start: nothing in it carries
    // the first buckets, so a client replaying only the stream would draw a
    // series beginning at 5000ms and never know it.
    const tail = [6, 7, 8].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000]));
    await appendDeltas(runId, tail);
    const oldest = await redis!.xrange(`live:${runId}:deltas`, '-', '+', 'COUNT', 1);
    expect(JSON.parse(oldest[0]![1][1]!).seq).toBeGreaterThan(1); // genuinely trimmed

    const frames = await collect(connect(port, `/v1/runs/${runId}/live`, cookie), 4);

    // Relayed faithfully, field for field -- not summarised, not re-encoded.
    expect(frames[0]!.delta).toEqual(snapshot);
    expect(frames[0]!.delta.responseTime.buckets[0]!.startOffsetMs).toBe(0);
    // ...and joined with NO gap at the seam. A hole here is invisible to a
    // consumer: it cannot tell a bucket that was never sent from one that saw
    // no traffic.
    const seqs = frames.map((f) => f.delta.seq);
    expect(seqs).toEqual([snapshot.seq, ...tail.map((d) => d.seq)]);
    expect(frames.slice(1).map((f) => f.delta)).toEqual(tail);
  });

  it('follows the run live once the seed is delivered', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    await seedSnapshot(runId, deltaFixture(runId, 1, [0]));
    const conn = connect(port, `/v1/runs/${runId}/live`, cookie);
    await collect(conn, 1);
    await vi.waitFor(() => expect(ctx.app.get(LiveHub).size(runId)).toBe(1));

    const live = deltaFixture(runId, 2, [1000]);
    await redis!.publish(`live:${runId}`, JSON.stringify(live));

    const frames = await collect(conn, 2);
    expect(frames[1]).toEqual({ type: 'delta', delta: live });
  });

  it('replays forward from the client-supplied lastSeq instead of re-seeding', async () => {
    const port = await start();
    const runId = await openLiveRun();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    await seedSnapshot(runId, deltaFixture(runId, 5, [0, 1000, 2000, 3000, 4000]));
    await appendDeltas(runId, [6, 7, 8].map((seq) => deltaFixture(runId, seq, [(seq - 1) * 1000])));

    const conn = connect(port, `/v1/runs/${runId}/live`, cookie);
    await opened(conn);
    conn.socket.send(JSON.stringify({ lastSeq: 6 }));

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
