import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma, VerificationRepository } from '@perfportal/persistence';
import { Histogram } from '@perfportal/statistics';
import { BlobStore } from '@perfportal/storage';
import { VERIFIER_VERSION } from '@perfportal/verify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { VerifyService } from '../src/verify/verify.service.js';

/**
 * ═══ THE AGENT FIGURES, VERIFIED AGAINST THE RAW AGENT FILE ═══
 *
 * The paired fixture (`agent-run/`) through the real pipeline — the stored
 * object the on-prem runner writes — then `VerifyService.verify`: the agent
 * rows `@perfportal/statistics` stored are held to what `packages/verify`
 * re-derives from the same file, into the run's one ledger. A clean answer is
 * only evidence if a stored nudge is caught, so one value per agent table is
 * corrupted and the mismatch has to name it.
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url));
const AGENT = readFileSync(join(FIXTURE_DIR, 'agent.ndjson'));

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);
const verifications = new VerificationRepository(pool);

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-agent-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'simulation.log'), join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

// The two agent bucket tables carry no foreign key to run, so TRUNCATE ...
// CASCADE from `run` does not reach them; they are named.
const TABLES = [
  'run_verification', 'run_verdict_change', 'run_agent_duration_bucket', 'run_agent_metric_bucket', 'run_agent',
  'run_assertion', 'run_error', 'run_error_bucket', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
];

const STARTED_ON = new Date('2026-10-24T00:00:00Z');

/**
 * One run of the paired fixture, ingested by the real pipeline. `agent` stores
 * the agent object where the runner would (with a matching checksum, or a
 * wrong one), or leaves the run with no agent file at all.
 */
async function ingested(agent: 'stored' | 'bad_checksum' | 'none'): Promise<{ runId: string; agentKey: string }> {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({ data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} } });
  const runId = randomUUID();
  const bundleKey = `runs/test/${runId}.tgz`;
  await blobs.putStream(bundleKey, Readable.from([bundle]), 100_000_000);
  const agentKey = `runs/${runId}/agent.ndjson`;
  if (agent !== 'none') await blobs.putStream(agentKey, Readable.from([AGENT]), 100_000_000);
  await prisma.run.create({
    data: {
      id: runId, orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey, bundleSha256: sha256(bundle), bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-10-24T00:05:00Z'), startedOn: STARTED_ON, engineOptions: {},
      agentLogKey: agent === 'none' ? null : agentKey,
      agentLogSha256: agent === 'stored' ? sha256(AGENT) : agent === 'bad_checksum' ? 'a'.repeat(64) : null,
      agentLogBytes: agent === 'none' ? null : BigInt(AGENT.length),
    },
  });
  await new PipelineService(config, prisma, pool, blobs).process(runId, { queueWillRetry: false });
  return { runId, agentKey };
}

const verify = (runId: string) => new VerifyService(config, prisma, pool, blobs).verify(runId);

async function agentStatus(runId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM run_agent WHERE run_id = $1', [runId]);
  return rows[0]?.status ?? null;
}

describe('VerifyService and the agent file', () => {
  it('verifies a collected run clean, checking more figures than the same run without its agent file', async () => {
    const { runId: plain } = await ingested('none');
    expect(await verify(plain)).toBe('verified');
    const without = (await verifications.find(plain))!.figuresChecked;

    const { runId } = await ingested('stored');
    expect(await agentStatus(runId)).toBe('collected');
    const outcome = await verify(runId);
    const row = await verifications.find(runId);
    expect(row?.mismatches).toEqual([]);
    expect(outcome).toBe('verified');
    expect(row).toMatchObject({ status: 'verified', verifierVersion: VERIFIER_VERSION });
    expect(VERIFIER_VERSION).toBe(3);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM run_agent_duration_bucket WHERE run_id = $1)
            + (SELECT count(*) FROM run_agent_metric_bucket WHERE run_id = $1) AS n`,
      [runId],
    );
    // At least one figure per stored agent row on top of the simulation.log figures.
    expect(row!.figuresChecked - without).toBeGreaterThanOrEqual(Number(rows[0]!.n));
    expect(Number(rows[0]!.n)).toBeGreaterThan(50);
  }, 120_000);

  it('names the table, metric and bucket of one corrupted stored metric value', async () => {
    const { runId } = await ingested('stored');
    const { rows } = await pool.query<{ metric: string; dim: string; label: string; start_offset_ms: number; value: number }>(
      `UPDATE run_agent_metric_bucket SET value = value + 1
        WHERE ctid = (SELECT ctid FROM run_agent_metric_bucket WHERE run_id = $1 AND metric = 'status'
                       ORDER BY dim, label, start_offset_ms LIMIT 1)
        RETURNING metric, dim, label, start_offset_ms, value`,
      [runId],
    );
    const hit = rows[0]!;

    expect(await verify(runId)).toBe('mismatch');
    expect((await verifications.find(runId))!.mismatches).toEqual([
      {
        scope: hit.metric, name: hit.dim, family: hit.label, population: null, bucket: hit.start_offset_ms,
        table: 'run_agent_metric_bucket', figure: 'value', stored: hit.value, recomputed: hit.value - 1,
      },
    ]);
  }, 120_000);

  it('reports a mismatch on the bucket whose stored histogram was replaced', async () => {
    const { runId } = await ingested('stored');
    const forged = new Histogram();
    forged.accept(98_765);
    const { rows } = await pool.query<{ family: string; dim: string; start_offset_ms: number }>(
      `UPDATE run_agent_duration_bucket SET histogram_ok = $2
        WHERE ctid = (SELECT ctid FROM run_agent_duration_bucket
                       WHERE run_id = $1 AND family = 'tcp_connect' AND dim = '*' AND ok_count > 0
                       ORDER BY start_offset_ms LIMIT 1)
        RETURNING family, dim, start_offset_ms`,
      [runId, Buffer.from(forged.serialize())],
    );
    const hit = rows[0]!;

    expect(await verify(runId)).toBe('mismatch');
    const mismatches = (await verifications.find(runId))!.mismatches;
    expect(mismatches.length).toBeGreaterThan(0);
    for (const m of mismatches) {
      expect(m).toMatchObject({
        table: 'run_agent_duration_bucket', scope: hit.family, name: hit.dim, bucket: hit.start_offset_ms, population: 'ok',
      });
    }
    expect(mismatches.map((m) => m.figure)).toContain('max');
    expect(mismatches.find((m) => m.figure === 'max')!.stored).toBe(98_765);
  }, 120_000);

  it('is unverifiable raw_log_missing when the agent object is gone and the raw log kept', async () => {
    const { runId, agentKey } = await ingested('stored');
    await blobs.delete(agentKey);

    expect(await verify(runId)).toBe('raw_log_missing');
    expect(await verifications.find(runId)).toMatchObject({ status: 'unverifiable', unverifiableReason: 'raw_log_missing' });
  }, 120_000);

  it('is unverifiable raw_log_unreadable when the agent object no longer matches its checksum', async () => {
    const { runId, agentKey } = await ingested('stored');
    await blobs.putStream(agentKey, Readable.from([Buffer.concat([AGENT, Buffer.from('\n')])]), 100_000_000);

    expect(await verify(runId)).toBe('raw_log_unreadable');
    expect(await verifications.find(runId)).toMatchObject({ status: 'unverifiable', unverifiableReason: 'raw_log_unreadable' });
  }, 120_000);

  it('verifies a run whose agent file was unreadable at ingest on simulation.log alone', async () => {
    const { runId: plain } = await ingested('none');
    await verify(plain);
    const without = (await verifications.find(plain))!.figuresChecked;

    const { runId } = await ingested('bad_checksum');
    expect(await agentStatus(runId)).toBe('unreadable');
    expect(await verify(runId)).toBe('verified');
    expect((await verifications.find(runId))!.figuresChecked).toBe(without);
  }, 120_000);
});
