import { execFileSync } from 'node:child_process';
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
  'run_assertion', 'run_error', 'run_series_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
];

async function seedRun(bundleBody: Buffer, engineOptions: Record<string, unknown> = {}) {
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
      bundleKey: key, bundleSha256: 'x'.repeat(64), bundleBytes: BigInt(bundleBody.length),
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

  it('writes nothing at all when the run fails — no half-persisted statistics', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    await expect(pipeline().process(ctx.runId)).rejects.toThrow();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.n).toBe(0);
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
