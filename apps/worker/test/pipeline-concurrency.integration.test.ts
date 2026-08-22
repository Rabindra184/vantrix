// Forces, in about a second, the collision that used to surface as an
// intermittent failure roughly one full integration run in four — and never
// once when a file was run on its own.
//
// PipelineService.process() opened with a check-then-act:
//
//     const run = await runs.findByIdUnscoped(runId);
//     if (run.status === 'complete' || run.status === 'failed') return;
//     await runs.markParsing(runId);
//
// Two processors both read a non-terminal status, both passed, and both went
// on to write run_stat, where the loser died on
// `run_stat_run_id_scope_name_family_key` having already done the whole
// parse. One failing run was measured producing 74 of those, every one
// discarded by runPipelineFor's old `.catch(() => undefined)` — which is why
// the damage always showed up somewhere else, as a 200 where a test wanted
// 202, or `new Date(undefined)` throwing RangeError in an unrelated helper.
//
// An advisory lock in process() now admits one processor per run. These two
// cases are what tell you if it goes: without the lock the first fails with
// the duplicate key, and BOTH still pass on the data (the loser's transaction
// rolls back), so the second case alone would not notice the regression.
//
// TWO client pairs, not one: a single PrismaClient serialises these calls
// across its own connection pool, so they would never actually overlap and
// the test would pass against the broken code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../src/config.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });

const poolA = createPool(config.databaseUrl);
const prismaA = createPrisma(config.databaseUrl);
const poolB = createPool(config.databaseUrl);
const prismaB = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
  'org_member', 'session', 'account', 'verification', 'user',
];

let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collide-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await poolA.end();
  await prismaA.$disconnect();
  await poolB.end();
  await prismaB.$disconnect();
});

async function seedRun(): Promise<string> {
  await poolA.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prismaA.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prismaA.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/collide/${randomKey()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prismaA.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

let counter = 0;
function randomKey(): string {
  counter += 1;
  return `k${counter}`;
}

describe('two pipelines racing one run', () => {
  it('neither processor fails with a duplicate key', async () => {
    const runId = await seedRun();
    const a = new PipelineService(config, prismaA, poolA, blobs);
    const b = new PipelineService(config, prismaB, poolB, blobs);

    const settled = await Promise.allSettled([a.process(runId), b.process(runId)]);
    const reasons = settled.map((r) =>
      r.status === 'rejected' ? String(r.reason).slice(0, 160) : 'fulfilled',
    );
    console.error('COLLISION_RESULT', JSON.stringify(reasons));

    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);
  });

  it('writes exactly one set of stats for the raced run', async () => {
    const runId = await seedRun();
    const a = new PipelineService(config, prismaA, poolA, blobs);
    const b = new PipelineService(config, prismaB, poolB, blobs);

    await Promise.allSettled([a.process(runId), b.process(runId)]);

    const dupes = await poolA.query(
      `SELECT scope, name, family, count(*) AS n
         FROM run_stat WHERE run_id = $1
        GROUP BY scope, name, family HAVING count(*) > 1`,
      [runId],
    );
    console.error('COLLISION_DUPES', JSON.stringify(dupes.rows));
    expect(dupes.rows).toHaveLength(0);
  });
});
