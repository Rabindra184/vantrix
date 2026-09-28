import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma, RuleRepository } from '@perfportal/persistence';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { runEngine, type EngineResult } from '@perfportal/statistics';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { LiveFoldOwner } from '../src/live/fold-owner.js';
import { Sweeper } from '../src/sweeper.js';
import { Backends, holdTable, until } from './backends.js';

/**
 * WHAT A POSTGRES RESTART DOES TO THIS PROCESS: every session it holds ends
 * at once. These cases end ONE, on purpose, with `pg_terminate_backend` --
 * the same server-side act a restart, a failover or an operator performs --
 * and hold each component to two claims:
 *
 *  - THE PROCESS SURVIVES. A client ending while it is checked out emits an
 *    `error` event, and pg-pool listens only while a client is IDLE, so with
 *    no listener of the holder's own that event is thrown as an uncaught
 *    exception. Vitest fails the file on one, which is the guard for that
 *    half: there is no assertion that could see a process that died.
 *  - THE COMPONENT RECOVERS, and says so, rather than carrying on as though
 *    nothing happened.
 *
 * See `backends.ts` for why the injection is a real termination and never a
 * trigger raising the same SQLSTATE.
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);
const rules = new RuleRepository(prisma);
const redis = new Redis(config.redisUrl);

let log: Buffer;
let batch: EngineResult;
let backends: Backends;
let warn: MockInstance<typeof console.warn>;

beforeAll(async () => {
  log = readFileSync(FIXTURE_LOG);
  batch = runEngine(parseSimulationLog(log));
  await blobs.ensureBucket();
  backends = await Backends.open(config.databaseUrl);
});

afterAll(async () => {
  await backends.close();
  await redis.quit();
  await pool.end();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE ${[
      'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
      'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
    ].map((t) => `"${t}"`).join(', ')} CASCADE`,
  );
  // Spied, not silenced: the owner's report of a lost session is part of what
  // these cases assert, and anything else a component warns about should
  // still reach the log.
  warn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  warn.mockRestore();
});

async function seedOrgProject(): Promise<{ orgId: string; projectId: string }> {
  const org = await prisma.org.create({ data: { slug: `acme-${randomUUID()}`, name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

/** A live run at `running`, shaped as fold-owner.integration.test.ts's own
 * `seedRunningRun`. `streamed` is how many bytes its chunk objects hold. */
async function seedRunningRun(orgId: string, projectId: string, streamed: number): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'running', tool: 'gatling',
      bundleKey: `runs/test/${randomUUID()}/simulation.log`,
      bundleSha256: createHash('sha256').update(randomUUID()).digest('hex'),
      bundleBytes: BigInt(streamed), streamOffset: BigInt(streamed),
      startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

async function seedStreamingRun(orgId: string, projectId: string): Promise<string> {
  const runId = await seedRunningRun(orgId, projectId, log.length);
  await chunks.put(runId, 0, log);
  return runId;
}

/** The `seq` of the last delta published for `runId`, or null when none has
 * been. Every tick publishes exactly one delta per run it owns, so this moves
 * by exactly the number of times an owner published the run. */
async function tipSeq(runId: string): Promise<number | null> {
  const rows = await redis.xrevrange(`live:${runId}:deltas`, '+', '-', 'COUNT', 1);
  const body = rows[0]?.[1]?.[1];
  return typeof body === 'string' ? (JSON.parse(body) as { seq: number }).seq : null;
}

/** Waits for the owner's own report that the session holding `runId`'s lock
 * ended -- the event has to have been HANDLED before a tick can be asked what
 * it does about it, and the log line is the handling a reader can see. */
function ownerReportedLoss(runId: string): Promise<true> {
  return until(`the owner to report losing ${runId}'s lock session`, () =>
    warn.mock.calls.some((c) => String(c[0]).includes(runId) && /session/.test(String(c[0]))),
  );
}

const runCount = (r: EngineResult | null) =>
  r?.stats.find((s) => s.scope === 'run' && s.family === 'response_time')?.count;

describe('Sweeper, when Postgres ends the session it is sweeping on', () => {
  it('rejects with the cause, and the next sweep does the work the lost one could not', async () => {
    const { orgId, projectId } = await seedOrgProject();
    // Nothing streamed, so the sweep finalizes it in place inside its own
    // transaction -- the branch that needs no queue and no object store.
    const runId = await seedRunningRun(orgId, projectId, 0);
    await pool.query(`UPDATE run SET created_at = now() - interval '1 day' WHERE id = $1`, [runId]);

    const pub = new Redis(config.redisUrl);
    const sweeper = new Sweeper(config, pool, chunks, blobs, pub);
    const table = await holdTable(config.databaseUrl, 'run', 'EXCLUSIVE');
    try {
      const sweep = sweeper.sweep();
      // Settled by the `rejects` below; attached now so the rejection is
      // never momentarily unhandled while the kill is being arranged.
      sweep.catch(() => {});
      const parked = await until('the sweep to park behind the table lock', () =>
        backends.blockedBy(table.pid),
      );
      // Inside its transaction, at the SELECT: BEGIN has run, so ending the
      // session here is the case where the catch has a ROLLBACK to attempt.
      expect(parked.query).toMatch(/FOR UPDATE SKIP LOCKED/);
      await backends.terminate(parked.pid);
      // The CAUSE, not what a ROLLBACK on the dead session said about it:
      // "Connection terminated unexpectedly" carries no code, so a caller
      // classifying the failure would read a restart as a bug.
      await expect(sweep).rejects.toMatchObject({ code: '57P01' });
    } finally {
      await table.release();
    }

    try {
      await expect(sweeper.sweep()).resolves.toBe(1);
    } finally {
      await sweeper.close();
      await pub.quit();
    }
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [runId]);
    expect(rows[0]?.status).toBe('incomplete');
  });
});

describe('LiveFoldOwner, when Postgres ends the session holding a run lock', () => {
  it('re-claims the run on a fresh session, folding it once and continuing its sequence', async () => {
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedStreamingRun(orgId, projectId);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    try {
      await owner.tick();
      const first = await backends.lockHolder(runId);
      expect(first).not.toBeNull();
      const before = await tipSeq(runId);
      expect(before).not.toBeNull();

      await backends.terminate(first!);
      await ownerReportedLoss(runId);
      await owner.tick();

      // A NEW session holds the lock: the old one took it to the grave, so
      // nothing but a fresh claim can have put it back.
      const second = await backends.lockHolder(runId);
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      // Folded from byte 0 into a FRESH engine -- the batch numbers exactly.
      // Re-folding into the old engine would double them.
      expect(runCount(owner.snapshotOf(runId))).toBe(runCount(batch));
      // One delta for the tick, continuing the run's own sequence.
      expect(await tipSeq(runId)).toBe(before! + 1);
    } finally {
      await owner.close();
    }
  });

  it('stops owning the run once another replica holds the lock its session lost', async () => {
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedStreamingRun(orgId, projectId);
    const a = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    const b = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    try {
      await a.tick();
      const lost = await backends.lockHolder(runId);
      expect(lost).not.toBeNull();

      await backends.terminate(lost!);
      await ownerReportedLoss(runId);
      // The lock is free the instant the session ends, so another replica
      // can take the run before this one ticks again -- that is the case the
      // lock exists for, and nothing this owner does can prevent it.
      await b.tick();
      const bPid = await backends.lockHolder(runId);
      expect(bPid).not.toBeNull();
      expect(b.snapshotOf(runId)).not.toBeNull();
      const afterB = await tipSeq(runId);

      await a.tick();
      // Two owners of one run is the defect: two folds publishing into one
      // sequence. The replica that lost its session lets go and publishes
      // nothing more.
      expect(a.snapshotOf(runId)).toBeNull();
      expect(await backends.lockHolder(runId)).toBe(bPid);
      expect(await tipSeq(runId)).toBe(afterB);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('publishes nothing for a run whose lock session dies in the middle of a tick', async () => {
    const { orgId, projectId } = await seedOrgProject();
    const held = await seedStreamingRun(orgId, projectId);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    try {
      await owner.tick();
      const before = await tipSeq(held);
      const holder = await backends.lockHolder(held);
      expect(before).not.toBeNull();
      expect(holder).not.toBeNull();

      // A second run for the next tick to CLAIM, which reads its SLA rules --
      // parked behind a lock on `sla_rule`, that claim holds the tick between
      // its release pass and its publish pass, which is the only window a
      // loss can land in that the release pass has not already seen.
      const claimed = await seedStreamingRun(orgId, projectId);
      const table = await holdTable(config.databaseUrl, 'sla_rule', 'ACCESS EXCLUSIVE');
      let tick: Promise<void>;
      try {
        tick = owner.tick();
        const parked = await until("the second run's claim to park reading its rules", () =>
          backends.blockedBy(table.pid),
        );
        expect(parked.query).toMatch(/sla_rule/);
        await backends.terminate(holder!);
        await ownerReportedLoss(held);
      } finally {
        await table.release();
      }
      await tick;

      expect(await tipSeq(held)).toBe(before);
      expect(owner.snapshotOf(claimed)).not.toBeNull();

      await owner.tick();
      expect(await tipSeq(held)).toBe(before! + 1);
    } finally {
      await owner.close();
    }
  });

  it('shuts down cleanly while it still holds a run whose lock session has ended', async () => {
    // A worker stopping right after a restart -- the ordinary rolling-deploy
    // case -- reaches `close()` before any tick has retired the lost run.
    // The lock is already gone; there is nothing to unlock and nothing
    // failed, so `close()` must not raise the AggregateError it exists to
    // raise for a release that really did fail.
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedStreamingRun(orgId, projectId);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    let closed = false;
    try {
      await owner.tick();
      const holder = await backends.lockHolder(runId);
      expect(holder).not.toBeNull();
      await backends.terminate(holder!);
      await ownerReportedLoss(runId);

      await expect(owner.close()).resolves.toBeUndefined();
      closed = true;
    } finally {
      if (!closed) await owner.close().catch(() => {});
    }
  });

  it('does not take ownership of a run whose lock session dies while it is being claimed', async () => {
    const { orgId, projectId } = await seedOrgProject();
    const runId = await seedStreamingRun(orgId, projectId);
    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    try {
      const table = await holdTable(config.databaseUrl, 'sla_rule', 'ACCESS EXCLUSIVE');
      let tick: Promise<void>;
      try {
        tick = owner.tick();
        await until("the claim to park reading the run's rules", () => backends.blockedBy(table.pid));
        // The claim takes the lock BEFORE it reads the rules, so the session
        // that just won it is the one to end.
        const claiming = await backends.lockHolder(runId);
        expect(claiming).not.toBeNull();
        await backends.terminate(claiming!);
        await ownerReportedLoss(runId);
      } finally {
        await table.release();
      }
      await tick;

      expect(owner.snapshotOf(runId)).toBeNull();
      expect(await tipSeq(runId)).toBeNull();

      await owner.tick();
      expect(owner.snapshotOf(runId)).not.toBeNull();
      expect(await backends.lockHolder(runId)).not.toBeNull();
      expect(await tipSeq(runId)).not.toBeNull();
    } finally {
      await owner.close();
    }
  });
});
