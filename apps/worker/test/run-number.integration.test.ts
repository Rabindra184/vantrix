import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma, SCHEMA_TABLES } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { attachLiveRunToTest, numberRunForTest } from '../src/pipeline/run-number.js';

/**
 * ═══ A RUN'S NUMBER, AT THE TWO PLACES A RUN JOINS ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * THE REAL STATEMENTS, NOT A MIRROR OF THEIR SQL: both writers call these two
 * functions, and this file calls them too. CLAUDE.md records a test-entity
 * suite that mirrored the resolver's SQL and stopped being valid the day the
 * rule moved out of the schema; this rule lives in code from the start.
 */
const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

const testRow = (slug: string, nextRunNumber = 1) =>
  prisma.test.create({
    data: { orgId, projectId, slug, name: slug, simulationClass: `example.${slug}`, nextRunNumber },
  });

const runRow = (status: 'running' | 'parsing' | 'complete', testId: string | null = null, runNumber: number | null = null) =>
  prisma.run.create({
    data: {
      orgId,
      projectId,
      testId,
      runNumber,
      status,
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-09-27T09:00:00Z'),
      startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });

const numberOf = async (runId: string) =>
  (await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { testId: true, runNumber: true } }));
const counterOf = async (testId: string) =>
  (await prisma.test.findUniqueOrThrow({ where: { id: testId } })).nextRunNumber;

/** One finalize transaction, the way PipelineService opens it. */
async function inFinalize<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('a live run joining its test at the log header', () => {
  it('numbers successive runs 1, 2 and moves the counter past them', async () => {
    const test = await testRow('checkout-smoke');
    const first = await runRow('running');
    const second = await runRow('running');

    expect(await attachLiveRunToTest(pool, first.id, test.id)).toBe(1);
    expect(await attachLiveRunToTest(pool, second.id, test.id)).toBe(2);

    expect(await numberOf(first.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await numberOf(second.id)).toEqual({ testId: test.id, runNumber: 2 });
    expect(await counterOf(test.id)).toBe(3);
  });

  /** A re-claimed fold (crash, rolling deploy) identifies the run again. It
   *  must find the run already in its test and take NOTHING. */
  it('burns no number when the same run is attached a second time', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');

    await attachLiveRunToTest(pool, run.id, test.id);
    expect(await attachLiveRunToTest(pool, run.id, test.id)).toBeNull();

    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });
});

describe('the pipeline deciding the number at finalize', () => {
  it('numbers an upload, which had no test until now', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('parsing');

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });

  it('keeps the number a live run took at its header when the test is the same', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await counterOf(test.id)).toBe(2);
  });

  /** B already holds runs, so its next number is 3 — a value the run's OLD
   *  number (1) cannot coincide with, which is what lets this tell "took B's
   *  next" from "kept A's". */
  it('takes the new test’s next number when finalize re-matches it, leaving a gap behind', async () => {
    const a = await testRow('checkout-smoke');
    const b = await testRow('checkout-soak', 3);
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, a.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, b.id))).toBe(3);
    expect(await numberOf(run.id)).toEqual({ testId: b.id, runNumber: 3 });
    expect(await counterOf(b.id)).toBe(4);
    // A's 1 is spent and not given back: numbers are never reused.
    expect(await counterOf(a.id)).toBe(2);
  });

  /** An upgrade window: the OLD worker attached this run to its test (set
   *  `test_id`) before the migration that taught it to number runs too, so
   *  the run sits in its test with a NULL number. Finalize must not keep that
   *  NULL for ever just because the run is "already in its resolved test". */
  it('numbers a run it finds already in its test with no number — an older worker attached it', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running', test.id, null);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });

  it('clears the number when the resolver found no test', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, null))).toBeNull();
    expect(await numberOf(run.id)).toEqual({ testId: null, runNumber: null });
  });

  /** The terminal UPDATE's own guard: a run already finished must not be
   *  re-numbered by a redelivered job. */
  it('leaves a run that is already terminal exactly as it was', async () => {
    const a = await testRow('checkout-smoke', 2);
    const b = await testRow('checkout-soak');
    const done = await runRow('complete', a.id, 1);

    await inFinalize((c) => numberRunForTest(c, done.id, b.id));

    expect(await numberOf(done.id)).toEqual({ testId: a.id, runNumber: 1 });
    expect(await counterOf(b.id)).toBe(1);
  });

  /** ═══ THE RACE A COUNTER EXISTS FOR ═══
   *  Eight runs of one test finalizing at once, each in its own transaction.
   *  A max-plus-one read would hand several of them the same number (and the
   *  unique index would then refuse all but one). */
  it('gives runs finalizing concurrently distinct numbers', async () => {
    const test = await testRow('checkout-smoke');
    const runs = await Promise.all(Array.from({ length: 8 }, () => runRow('parsing')));

    const numbers = await Promise.all(
      runs.map((run) => inFinalize((c) => numberRunForTest(c, run.id, test.id))),
    );

    expect([...numbers].sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await counterOf(test.id)).toBe(9);
  });
});

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
const blobs = new BlobStore(config.blob);
let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runno-'));
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(FIXTURE_LOG, join(dir, 'run-1', 'simulation.log'));
  execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'run-1']);
  bundle = readFileSync(join(dir, 'bundle.tgz'));
  await blobs.ensureBucket();
});

/** A pending upload of the reference bundle, the shape POST /v1/runs leaves. */
async function pendingUpload(): Promise<string> {
  const key = `runs/${projectId}/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'pending', tool: 'gatling',
      bundleKey: key,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('the pipeline, end to end', () => {
  /** THE WIRING, not the statement: two real uploads of one simulation,
   *  processed by the real PipelineService, land in one auto-created test as
   *  Run 1 and Run 2. Removing the call from the pipeline fails this alone. */
  it('numbers two uploads of one simulation 1 then 2', async () => {
    const pipeline = new PipelineService(config, prisma, pool, blobs);
    const first = await pendingUpload();
    await pipeline.process(first);
    const second = await pendingUpload();
    await pipeline.process(second);

    const a = await numberOf(first);
    const b = await numberOf(second);
    expect(a.testId).not.toBeNull();
    expect(b.testId).toBe(a.testId);
    expect([a.runNumber, b.runNumber]).toEqual([1, 2]);
  });
});
