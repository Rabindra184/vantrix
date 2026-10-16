import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma, VerificationRepository } from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig, type WorkerConfig } from '../src/config.js';
import { PipelineService, RUN_INGEST_LOCK_NAMESPACE } from '../src/pipeline/pipeline.service.js';
import { Sweeper } from '../src/sweeper.js';
import { VerifyService } from '../src/verify/verify.service.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);
const verifications = new VerificationRepository(pool);
const redis = new Redis(config.redisUrl);

let bundle: Buffer;

const TABLES = [
  'run_verification', 'run_verdict_change', 'run_assertion', 'run_error', 'run_error_bucket',
  'run_series_bucket', 'run_user_bucket', 'run_stat', 'run', 'test', 'sla_rule', 'api_token',
  'project', 'org', 'org_member', 'session', 'account', 'verification', 'user',
];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
});

afterAll(async () => {
  redis.disconnect();
  await pool.end();
  await prisma.$disconnect();
});

interface Seeded {
  id: string;
  bundleKey: string;
}

/** Finished runs ingested by the real pipeline, each `ageDays` old by its ingested_at. */
async function seedRuns(...ageDays: number[]): Promise<Seeded[]> {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const pipeline = new PipelineService(config, prisma, pool, blobs);
  const out: Seeded[] = [];
  for (const age of ageDays) {
    const key = `runs/test/${randomUUID()}.tgz`;
    await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
    const run = await prisma.run.create({
      data: {
        orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
        bundleKey: key, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: BigInt(bundle.length),
        startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    await pipeline.process(run.id, { queueWillRetry: false });
    await pool.query(`UPDATE run SET ingested_at = now() - make_interval(days => $2::int) WHERE id = $1`, [run.id, age]);
    out.push({ id: run.id, bundleKey: key });
  }
  return out;
}

function sweeper(days: number): Sweeper {
  const c: WorkerConfig = { ...config, rawLogRetentionDays: days };
  return new Sweeper(c, pool, chunks, blobs, redis);
}

async function deletedAt(runId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ raw_log_deleted_at: Date | null }>(
    'SELECT raw_log_deleted_at FROM run WHERE id = $1',
    [runId],
  );
  return rows[0]!.raw_log_deleted_at;
}

describe('raw-log retention in the sweeper', () => {
  it('deletes the raw log of a run past retention, and not of one inside it', async () => {
    const [old, young] = await seedRuns(31, 29);
    const s = sweeper(30);
    try {
      await s.sweep();
    } finally {
      await s.close();
    }

    expect(await blobs.exists(old!.bundleKey)).toBe(false);
    expect(await deletedAt(old!.id)).not.toBeNull();
    expect(await blobs.exists(young!.bundleKey)).toBe(true);
    expect(await deletedAt(young!.id)).toBeNull();
  });

  it('keeps every raw log for ever at 0 days', async () => {
    const [old] = await seedRuns(4_000);
    const s = sweeper(0);
    try {
      await s.sweep();
    } finally {
      await s.close();
    }

    expect(await blobs.exists(old!.bundleKey)).toBe(true);
    expect(await deletedAt(old!.id)).toBeNull();
  });

  it('skips a run whose lock is held (a verify or recompute is working on it), and takes it next time', async () => {
    const [old] = await seedRuns(31);
    const holder = await pool.connect();
    const s = sweeper(30);
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, old!.id]);
      await s.sweep();
      expect(await blobs.exists(old!.bundleKey)).toBe(true);
      expect(await deletedAt(old!.id)).toBeNull();
      await holder.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, old!.id]);

      await s.sweep();
      expect(await blobs.exists(old!.bundleKey)).toBe(false);
      expect(await deletedAt(old!.id)).not.toBeNull();
    } finally {
      holder.release();
      await s.close();
    }
  });

  it('counts an object already missing as deleted', async () => {
    const [old] = await seedRuns(31);
    await blobs.delete(old!.bundleKey);
    const s = sweeper(30);
    try {
      await s.sweep();
    } finally {
      await s.close();
    }
    expect(await deletedAt(old!.id)).not.toBeNull();
  });

  it('settles a never-verified run as unverifiable/raw_log_deleted, and leaves a verified run verified', async () => {
    const [never, checked] = await seedRuns(31, 31);
    await verifications.markPending(never!.id);
    expect(await new VerifyService(config, prisma, pool, blobs).verify(checked!.id)).toBe('verified');
    const s = sweeper(30);
    try {
      await s.sweep();
    } finally {
      await s.close();
    }

    expect(await verifications.find(never!.id)).toMatchObject({ status: 'unverifiable', unverifiableReason: 'raw_log_deleted' });
    expect((await verifications.find(checked!.id))!.status).toBe('verified');
    expect(await deletedAt(checked!.id)).not.toBeNull();
    // Nothing selects either again, so no job is ever retried against a log that is gone.
    expect((await verifications.candidatePage(1, null, 10)).ids).toEqual([]);
  });
});
