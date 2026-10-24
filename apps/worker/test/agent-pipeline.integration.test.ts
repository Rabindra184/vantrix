import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AGENT_BUNDLE_FILE } from '@perfportal/core';
import { AgentReader, createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';

/**
 * ═══ THE AGENT FILE AT FINALIZE, AGAINST A REAL STACK ═══
 *
 * The paired fixture (`agent-run/`) is one JVM's `simulation.log` and agent
 * file, so their clocks agree and the agent's `status` lines are one per
 * request: 90 of each. That is what lets "the figures were built from THIS
 * run's log" be asserted as a number rather than as "some rows exist".
 *
 * The other three cases are the "never fails the run" half: a checksum that
 * does not match, a bundle carrying the file, and a run with no file at all
 * each finish `complete`, and say so on `run_agent` (or by its absence).
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url));
const LOG = readFileSync(join(FIXTURE_DIR, 'simulation.log'));
const AGENT = readFileSync(join(FIXTURE_DIR, 'agent.ndjson'));

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A results bundle holding `simulation.log`, and the agent file beside it when asked. */
function tarball(withAgent: boolean): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pipe-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'simulation.log'), join(results, 'simulation.log'));
  if (withAgent) copyFileSync(join(FIXTURE_DIR, 'agent.ndjson'), join(results, AGENT_BUNDLE_FILE));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  return readFileSync(out);
}

let plainBundle: Buffer;
let agentBundle: Buffer;

beforeAll(async () => {
  plainBundle = tarball(false);
  agentBundle = tarball(true);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

// The two bucket tables carry no foreign key to run (they are partitioned and
// FK-free like the other metrics tables), so TRUNCATE ... CASCADE from `run`
// does not reach them; `run_agent` it does.
const TABLES = [
  'run_agent_duration_bucket', 'run_agent_metric_bucket', 'run_agent',
  'run_assertion', 'run_error', 'run_error_bucket', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
];

const STARTED_ON = new Date('2026-10-24T00:00:00Z');

async function seed(opts: { bundle: Buffer; agentObject?: { sha256: string } }) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const runId = randomUUID();
  const bundleKey = `runs/test/${runId}.tgz`;
  await blobs.putStream(bundleKey, Readable.from([opts.bundle]), 100_000_000);
  let agentLogKey: string | null = null;
  if (opts.agentObject) {
    // Where the on-prem runner stores it (PR 1).
    agentLogKey = `runs/${runId}/agent.ndjson`;
    await blobs.putStream(agentLogKey, Readable.from([AGENT]), 100_000_000);
  }
  await prisma.run.create({
    data: {
      id: runId, orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey, bundleSha256: sha256(opts.bundle), bundleBytes: BigInt(opts.bundle.length),
      startedAt: new Date('2026-10-24T00:05:00Z'), startedOn: STARTED_ON, engineOptions: {},
      agentLogKey,
      agentLogSha256: opts.agentObject?.sha256 ?? null,
      agentLogBytes: opts.agentObject ? BigInt(AGENT.length) : null,
    },
  });
  return { scope: { orgId: org.id, projectId: project.id }, runId };
}

async function ingest(runId: string): Promise<void> {
  await new PipelineService(config, prisma, pool, blobs).process(runId, { queueWillRetry: false });
}

/**
 * The real store, except that reading the agent object fails with a socket
 * reset — a transient error — while every other key (the run's own bundle)
 * reads normally.
 */
class AgentReadResets extends BlobStore {
  override async get(key: string): Promise<Buffer> {
    if (key.endsWith('/agent.ndjson')) {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
    return super.get(key);
  }
}

async function runStatus(runId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM run WHERE id = $1', [runId]);
  return rows[0]!.status;
}

async function bucketRows(runId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM run_agent_duration_bucket WHERE run_id = $1)
          + (SELECT count(*) FROM run_agent_metric_bucket WHERE run_id = $1) AS n`,
    [runId],
  );
  return Number(rows[0]!.n);
}

async function requestCount(runId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM run_stat WHERE run_id = $1 AND scope = 'run' AND family = 'response_time'`,
    [runId],
  );
  return Number(rows[0]!.count);
}

async function statusSum(scope: { orgId: string; projectId: string }, runId: string): Promise<number> {
  const rows = await new AgentReader(pool).metrics(scope, runId, STARTED_ON, { metrics: ['status'], dim: '*' });
  return rows.reduce((acc, r) => acc + r.value, 0);
}

describe('PipelineService and the agent file', () => {
  it('collects figures from the stored object the runner wrote', async () => {
    const { scope, runId } = await seed({ bundle: plainBundle, agentObject: { sha256: sha256(AGENT) } });
    await ingest(runId);

    expect(await runStatus(runId)).toBe('complete');
    const summary = await new AgentReader(pool).summary(scope, runId);
    expect(summary?.status).toBe('collected');
    expect(summary?.header?.host).toBe('loadgen-1');
    // 90 requests in the log, one `status` line each in the agent file.
    expect(await requestCount(runId)).toBe(90);
    expect(await statusSum(scope, runId)).toBe(90);
  }, 60_000);

  it('completes the run and records why when the stored object fails its checksum', async () => {
    const { scope, runId } = await seed({ bundle: plainBundle, agentObject: { sha256: 'a'.repeat(64) } });
    await ingest(runId);

    expect(await runStatus(runId)).toBe('complete');
    const summary = await new AgentReader(pool).summary(scope, runId);
    expect(summary).toMatchObject({ status: 'unreadable', reason: 'checksum_mismatch' });
    expect(await bucketRows(runId)).toBe(0);
    expect(await requestCount(runId)).toBe(90);
  }, 60_000);

  it('rethrows a transient read of the agent object while the queue will retry', async () => {
    const { scope, runId } = await seed({ bundle: plainBundle, agentObject: { sha256: sha256(AGENT) } });
    const flaky = new PipelineService(config, prisma, pool, new AgentReadResets(config.blob));
    await expect(flaky.process(runId, { queueWillRetry: true })).rejects.toMatchObject({ code: 'ECONNRESET' });

    // Left for the retry, not failed and not recorded.
    expect(await runStatus(runId)).toBe('parsing');
    expect(await new AgentReader(pool).summary(scope, runId)).toBeNull();
  }, 60_000);

  it('records the same error on the last attempt and completes the run', async () => {
    const { scope, runId } = await seed({ bundle: plainBundle, agentObject: { sha256: sha256(AGENT) } });
    const flaky = new PipelineService(config, prisma, pool, new AgentReadResets(config.blob));
    await flaky.process(runId, { queueWillRetry: false });

    expect(await runStatus(runId)).toBe('complete');
    expect(await new AgentReader(pool).summary(scope, runId)).toMatchObject({
      status: 'unreadable',
      reason: 'read_failed: socket hang up',
    });
    expect(await bucketRows(runId)).toBe(0);
    expect(await requestCount(runId)).toBe(90);
  }, 60_000);

  it('collects figures from an uploaded bundle carrying the file beside simulation.log', async () => {
    const { scope, runId } = await seed({ bundle: agentBundle });
    await ingest(runId);

    expect(await runStatus(runId)).toBe('complete');
    expect((await new AgentReader(pool).summary(scope, runId))?.status).toBe('collected');
    expect(await statusSum(scope, runId)).toBe(90);
  }, 60_000);

  it('writes nothing for a run with neither an object nor a bundle entry', async () => {
    const { scope, runId } = await seed({ bundle: plainBundle });
    await ingest(runId);

    expect(await runStatus(runId)).toBe('complete');
    expect(await new AgentReader(pool).summary(scope, runId)).toBeNull();
    expect(await bucketRows(runId)).toBe(0);
  }, 60_000);
});

// Keep the fixture honest: the log the bundle carries is the one these
// expectations were written against.
it('the paired fixture is the one the expectations name', () => {
  expect(LOG.length).toBe(2_682);
});
