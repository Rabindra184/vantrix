import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma, MetricReader } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../src/config.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);

let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_assertion', 'run_error', 'run_indicator', 'run_series_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
];

async function seedRun(
  bundleBody: Buffer,
  engineOptions: Record<string, unknown> = {},
  bundleSha256: string = createHash('sha256').update(bundleBody).digest('hex'),
) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${Date.now()}.tgz`;
  await blobs.putStream(key, Readable.from([bundleBody]), 100_000_000);
  const startedAt = new Date('2026-08-07T10:00:00Z');
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256, bundleBytes: BigInt(bundleBody.length),
      startedAt, startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: engineOptions as object,
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id, startedOn: new Date('2026-08-07T00:00:00Z') };
}

function pipeline(): PipelineService {
  return new PipelineService(config, prisma, pool, blobs);
}

describe('PipelineService', () => {
  it('reproduces the fixture statistics end to end', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.toolVersion).toBe('3.15.1');

    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    const runStat = stats.find((s) => s.scope === 'run' && s.family === 'response_time');

    expect(runStat?.count).toBe(895);
    expect(runStat?.okCount).toBe(871);
    expect(runStat?.koCount).toBe(24);
    expect(Math.round(runStat!.maxMs)).toBe(2503);
    expect(Math.round(runStat!.meanMs)).toBe(228);
    expect(Math.round(runStat!.stddevMs)).toBe(370);
  });

  it('persists the error table with the fixture counts', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const errors = await new MetricReader(pool).errors(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    expect(errors.reduce((a, e) => a + e.count, 0)).toBe(24);
    expect(errors.map((e) => e.count).sort((a, b) => b - a)).toEqual([15, 9]);
  });

  it('persists series buckets readable through the partition key', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const buckets = await new MetricReader(pool).series(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
      ctx.startedOn,
      { scope: 'run', name: '' },
    );
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.reduce((a, b) => a + b.startedCount, 0)).toBe(895);
  });

  it('evaluates SLA rules and records the verdict', async () => {
    const ctx = await seedRun(bundle);
    await prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('failed');

    const assertions = await prisma.runAssertion.findMany({ where: { runId: ctx.runId } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.outcome).toBe('failed');
    expect(assertions[0]?.ruleSnapshot).toMatchObject({ threshold: 1, metric: 'p95' });
  });

  it('reports not_evaluated when a project has no rules', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);
    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('not_evaluated');
  });

  it('records a structured failure with remediation for a corrupt bundle', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    // process() rethrows a deterministic failure after recording it, so the
    // consumer can classify it with isTransient — expected here, not a bug.
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('fails with a storage-integrity error, not a bundle error, when the fetched bytes do not match the recorded checksum', async () => {
    // The stored bundleSha256 is wrong relative to the object actually in the
    // blob store — simulating corruption that happened after upload, on the
    // storage side, not a bad upload from the caller (spec §6.2 step 2).
    const ctx = await seedRun(bundle, {}, 'f'.repeat(64));
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatchObject({
      code: 'BUNDLE_CHECKSUM_MISMATCH',
      remediation: expect.stringMatching(/.+/),
    });
    // Not blamed on the caller: the remediation must not read like a
    // malformed-upload message.
    expect((run?.error as { remediation: string }).remediation).toMatch(/storage/i);
  });

  it('writes nothing at all when the run fails — no half-persisted statistics', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  it('does not let a losing concurrent worker clobber the winner\'s committed result', async () => {
    // Two jobs for the same run racing (BullMQ default concurrency, or a
    // stalled-job redelivery) both pass the pending guard before either
    // commits. The loser's run_stat insert then hits the unique constraint,
    // rolls back, and — if RunRepository.fail writes unconditionally —
    // overwrites the winner's already-committed complete/verdict with
    // failed/null, leaving orphaned run_stat rows behind: statistics with no
    // verdict, which this task's design forbids.
    const ctx = await seedRun(bundle);

    const results = await Promise.allSettled([
      pipeline().process(ctx.runId),
      pipeline().process(ctx.runId),
    ]);
    // At least one side may legitimately throw (unique-constraint rollback);
    // what matters is that the winner's row survives untouched.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.verdict).not.toBeNull();

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1',
      [ctx.runId],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('Sweeper', () => {
  it('re-enqueues a run whose job never landed, and leaves fresh ones alone', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);
    const fresh = await seedRunKeepingExisting();

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000 }, pool);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);
    } finally {
      await sweeper.close();
    }
    expect(fresh).toBeDefined();
  });

  it('uses a stable, run-derived job id so two sweeps of the same stale run dedupe to one job', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const { Queue } = await import('bullmq');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);
    // A second run goes stale alongside the first, so the first sweep's
    // batch has rows.length === 2. Reproduces the reviewer's finding: the
    // old jobId (`sweep-${row.id}-${rows.length}`) baked the batch size in,
    // so the same run gets a different job id once the batch size changes.
    const other = await seedRunKeepingExisting();
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      other.id,
    ]);

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000 }, pool);
    const queue = new Queue('ingest', { connection: { url: config.redisUrl } });
    try {
      await sweeper.sweep(); // batch of 2 -> old code: jobId `sweep-${runId}-2`

      // The other run gets picked up and leaves 'pending', so the next sweep
      // finds only the target run: batch of 1 -> old code: `sweep-${runId}-1`.
      await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [other.id]);
      await sweeper.sweep(); // batch of 1, same target run still pending

      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      const forThisRun = jobs.filter((j) => j.data?.runId === ctx.runId);
      expect(forThisRun).toHaveLength(1);
    } finally {
      await sweeper.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

/** A second pending run created without truncating, so the sweep has both. */
async function seedRunKeepingExisting() {
  const project = await prisma.project.findFirstOrThrow();
  return prisma.run.create({
    data: {
      orgId: project.orgId, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: 'runs/none.tgz', bundleSha256: 'y'.repeat(64), bundleBytes: BigInt(1),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
}
