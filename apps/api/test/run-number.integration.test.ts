import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ A RUN'S NUMBER, ON EVERY READ THAT CARRIES A RUN ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Numbers come from the REAL pipeline here (runPipelineFor), never written by
 * the fixture: a fixture that set run_number itself would prove the reads and
 * nothing about whether a real run ever has one.
 *
 * BOTH identity builders are pinned, separately: a finished run is answered by
 * RunsService.toResponse and a live one by respondWithRun's hand-written 202,
 * and a field reaching only one of them is missing exactly while a reader
 * watches (CLAUDE.md, warmupMs).
 */
const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'runno-api-'));
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(FIXTURE_LOG, join(dir, 'run-1', 'simulation.log'));
  execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'run-1']);
  bundle = readFileSync(join(dir, 'bundle.tgz'));
});

beforeEach(async () => {
  ctx = await createTestApp();
});

afterEach(async () => {
  await ctx?.close();
});

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

/** Upload the reference bundle and process it with the real pipeline. */
async function ingested(): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

/** A RUNNING run in a test with a number — the state LiveFoldOwner leaves at
 *  the header — read through the 202 builder. */
async function runningNumbered(runNumber: number | null): Promise<string> {
  const test =
    runNumber === null
      ? null
      : await ctx.prisma.test.create({
          data: { orgId: ctx.orgId, projectId: ctx.projectId, slug: `live-${randomUUID().slice(0, 8)}`, name: 'Live', simulationClass: 'example.Live', nextRunNumber: runNumber + 1 },
        });
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId, projectId: ctx.projectId, status: 'running', tool: 'gatling',
      testId: test?.id ?? null, runNumber,
      bundleKey: `live/${randomUUID()}/simulation.log`, bundleSha256: 'a'.repeat(64), bundleBytes: 1n,
      startedAt: new Date('2026-09-27T09:00:00Z'), startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('runNumber on the wire', () => {
  it('reports a finished run’s number from the terminal builder', async () => {
    await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${second}`).set(auth());
    expect(res.status).not.toBe(202);
    expect(res.body.runNumber).toBe(2);
  });

  it('reports a live run’s number from the 202 builder', async () => {
    const id = await runningNumbered(7);

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}`).set(auth());
    expect(res.status).toBe(202);
    expect(res.body.runNumber).toBe(7);
  });

  it('reports null for a run with no test', async () => {
    const id = await runningNumbered(null);

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}`).set(auth());
    expect(res.body.runNumber).toBeNull();
  });

  it('carries it on every run-list row', async () => {
    const first = await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((i: { id: string; runNumber: number }) => [i.id, i.runNumber]));
    expect([byId.get(first), byId.get(second)]).toEqual([1, 2]);
  });

  it('carries it on every trends row', async () => {
    const first = await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${second}/trends`).set(auth());
    expect(res.status).toBe(200);
    const byId = new Map(res.body.runs.map((r: { id: string; runNumber: number }) => [r.id, r.runNumber]));
    expect([byId.get(first), byId.get(second)]).toEqual([1, 2]);
  });

  it('carries it on a test’s latest run in the catalogue', async () => {
    await ingested();
    await ingested();

    const res = await request(ctx.app.getHttpServer()).get('/v1/projects/checkout/tests').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.tests).toHaveLength(1);
    expect(res.body.tests[0].latestRun.runNumber).toBe(2);
  });
});
