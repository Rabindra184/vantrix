import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { LiveDeltaSchema, type LiveDelta } from '@perfportal/contracts';
import { createPool, createPrisma, RuleRepository } from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { LiveFoldOwner } from '../src/live/fold-owner.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { buildRequestBatch, buildRunHeader, RUN_START_MS } from './synthetic-log.js';

/**
 * ═══ THE TWO CALL SITES, COMPARED ═══
 *
 * `LiveFoldOwner#publish` and `PipelineService#ingest` both evaluate a
 * project's SLA rules. That is the whole premise of live SLA signals: the
 * banner an operator kills a run on has to mean the same thing as the verdict
 * the run would reach if it ended at that instant. Nothing else in this
 * feature is worth anything if those two disagree.
 *
 * ═══ WHY THIS FILE, AND NOT `packages/sla` ═══
 *
 * `packages/sla/test/stats.test.ts` used to hold a case claiming to pin this.
 * It could not: both of its sides were the SAME expression,
 * `evaluateRules(rules, toEvaluableStats(result.stats))`, so it asserted
 * `f(x) === f(x)` for a pure function and passed for every possible
 * implementation of either caller — neither of which it imported. It stayed
 * green through five reviews while the two call sites were building their
 * engines from DIFFERENT options (whole-branch review, A1), which is exactly
 * the disagreement it was written to catch.
 *
 * A real comparison has to reach both call sites, and `packages/sla` depends
 * on neither app — it is the leaf both of them import. `apps/worker` is the
 * one place where both are reachable at once, because both live in it. So the
 * test lives here, with the database, Redis and object store the two paths
 * genuinely need, rather than as a unit test of a mapping that was never where
 * the divergence was.
 *
 * ═══ WHAT MAKES IT A REAL COMPARISON ═══
 *
 * One run. One set of bytes. One set of rules. The live side reads its
 * assertions off the DELTA THE BROWSER WOULD RECEIVE (`sla.breaching`,
 * `sla.evaluated`), not off an internal accessor; the batch side reads them
 * off the `run_assertion` ROWS THE PIPELINE COMMITTED. Neither number is
 * written down here.
 *
 * `warmupMs` is set deliberately, and is what makes this fail against a fold
 * owner that ignores `run.engineOptions`: it changes which events are
 * aggregated at all (`engine.ts`'s `isWarmup`), so an owner using the
 * engine's defaults judges 300 requests with a 4000ms max where the pipeline
 * judges 150 with a 50ms max — a banner reading "currently breaching, actual
 * 4000" on a run that then parses to `passed`.
 */

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);
const rules = new RuleRepository(prisma);

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

beforeAll(async () => {
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const WARMUP_MS = 5000;
const SLOW_MS = 4000;
const FAST_MS = 50;
/** Per side of the warm-up boundary. Above `liveEvidenceFloor`'s flat 100 for
 * a scalar metric on BOTH sides, so the live path judges the rules whether or
 * not it honours the warm-up — a run that fell under the floor would report
 * "not checked" and the comparison would be two empties agreeing. */
const PER_SIDE = 150;

/** Slow requests wholly inside the warm-up window, fast ones wholly after it.
 * `isWarmup` tests a request's START against the run start, so the second
 * batch begins a clear second past the boundary rather than on it. */
const LOG = Buffer.concat([
  buildRunHeader(RUN_START_MS),
  buildRequestBatch(0, PER_SIDE, true, SLOW_MS),
  buildRequestBatch(WARMUP_MS + 1000, PER_SIDE, true, FAST_MS),
]);

/**
 * ONE run, reachable by both paths: `status: 'running'` with chunk objects for
 * `LiveFoldOwner`, and a `bundleKey` ending in `/simulation.log` holding the
 * identical raw bytes for `PipelineService` (Task 9's live shape — see
 * `pipeline.integration.test.ts`'s own `seedLiveRun`). The pipeline verifies
 * `bundleSha256` against what it fetches, so that is computed from the bytes,
 * never invented.
 */
async function seedRun(engineOptions: Record<string, unknown>) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: `acme-${randomUUID()}`, name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${randomUUID()}/simulation.log`;
  await blobs.putStream(key, Readable.from([LOG]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'running', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(LOG).digest('hex'),
      bundleBytes: BigInt(LOG.length), streamOffset: BigInt(LOG.length),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: engineOptions as object,
    },
  });
  await chunks.put(run.id, 0, LOG);
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

async function seedRule(
  orgId: string,
  projectId: string,
  opts: { metric: string; comparator: 'lte' | 'gte'; threshold: number },
): Promise<string> {
  const rule = await prisma.slaRule.create({
    data: {
      orgId, projectId, scope: 'run', targetName: null, family: 'response_time',
      metric: opts.metric, comparator: opts.comparator, threshold: opts.threshold, enabled: true,
    },
  });
  return rule.id;
}

/** The delta the browser would receive for this run's first tick — subscribed
 * on its own connection, exactly as `live.gateway.ts` does, and validated
 * against the wire schema so this reads the same bytes a client would. */
async function firstPublishedDelta(owner: LiveFoldOwner, runId: string): Promise<LiveDelta> {
  const sub = new Redis(config.redisUrl);
  try {
    const seen: LiveDelta[] = [];
    await sub.subscribe(`live:${runId}`);
    sub.on('message', (_channel, message: string) => {
      seen.push(LiveDeltaSchema.parse(JSON.parse(message)));
    });
    await owner.tick();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    return seen[0]!;
  } finally {
    await sub.quit();
  }
}

describe('the live and batch SLA call sites', () => {
  it('reach the same assertions for the same run, under the run’s own engine options', async () => {
    const { orgId, projectId, runId } = await seedRun({ warmupMs: WARMUP_MS });
    // Two rules, on either side of the post-warm-up maximum, so the
    // comparison below is a real judgement on both sides rather than two
    // matching empties: one must fail and one must pass.
    const breachingRuleId = await seedRule(orgId, projectId, {
      metric: 'max', comparator: 'lte', threshold: FAST_MS - 1,
    });
    const passingRuleId = await seedRule(orgId, projectId, {
      metric: 'max', comparator: 'lte', threshold: FAST_MS + 1,
    });

    const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl), rules);
    let delta: LiveDelta;
    try {
      delta = await firstPublishedDelta(owner, runId);
    } finally {
      // BEFORE the pipeline runs, not after: both share
      // `RUN_INGEST_LOCK_NAMESPACE` by design (part-2a §1.1), so a run cannot
      // be folded and parsed at once. `close()` releases the owner's lock.
      await owner.close();
    }

    await new PipelineService(config, prisma, pool, blobs).process(runId);

    const run = await prisma.run.findUnique({ where: { id: runId } });
    const persisted = await prisma.runAssertion.findMany({ where: { runId }, orderBy: { ruleId: 'asc' } });

    // The batch side really did judge both rules, one each way. Without this
    // the agreement below could be satisfied by a run that failed to parse.
    expect(run?.status).toBe('complete');
    expect(run?.verdict).toBe('failed');
    expect(persisted.map((a) => [a.ruleId, a.outcome]).sort()).toEqual(
      [[breachingRuleId, 'failed'], [passingRuleId, 'passed']].sort(),
    );

    // ═══ THE COMPARISON ═══
    const liveBreaching = [...delta.sla.breaching].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    const batchFailed = persisted
      .filter((a) => a.outcome === 'failed')
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

    expect(liveBreaching.map((b) => b.ruleId)).toEqual(batchFailed.map((a) => a.ruleId));
    expect(liveBreaching.map((b) => b.actualValue)).toEqual(batchFailed.map((a) => a.actualValue));
    // The evaluator's own message, reached through both call sites: the banner
    // renders `description` verbatim and the run page renders `message`, so a
    // divergence here is two different sentences about one rule.
    expect(liveBreaching.map((b) => b.description)).toEqual(batchFailed.map((a) => a.message));
    // Both rules were judged on both sides -- neither was withheld by the live
    // evidence floor, which is what makes the denominator comparable.
    expect(delta.sla.evaluated).toBe(persisted.filter((a) => a.outcome !== 'not_applicable').length);
  });
});
