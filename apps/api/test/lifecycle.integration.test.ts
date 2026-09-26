import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ THE LIFECYCLE STAMPS, THROUGH BOTH IDENTITY BUILDERS ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * `GET /v1/runs/{id}` has two builders: `RunsService.toResponse` for a
 * finished run, and the hand-written 202 in `respondWithRun` for a pending,
 * parsing or running one. A field reaching only the first is missing exactly
 * while a run is live — the defect CLAUDE.md records for `warmupMs`. So each
 * stamp is read through the real API on the builder that run's shape gets.
 */
const LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

function read(runId: string) {
  return request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}`)
    .set('Authorization', `Bearer ${ctx.readToken}`);
}

async function openLive(): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs/live')
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .send({ tool: 'gatling' });
  expect(res.status).toBe(201);
  return res.body.runId as string;
}

async function streamFirstChunk(runId: string): Promise<void> {
  const res = await request(ctx.app.getHttpServer())
    .post(`/v1/runs/${runId}/stream`)
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Stream-Offset', '0')
    .send(readFileSync(LOG).subarray(0, 64 * 1024));
  expect(res.status).toBe(202);
}

describe('the lifecycle stamps, on both identity builders', () => {
  it('a streaming run carries its last chunk on the 202, and nothing about processing yet', async () => {
    ctx = await createTestApp();
    const runId = await openLive();

    const before = await read(runId);
    expect(before.status).toBe(202);
    expect(before.body.streamUpdatedAt).toBeNull();

    await streamFirstChunk(runId);
    const after = await read(runId);
    expect(after.status).toBe(202);
    expect(after.body.streamUpdatedAt).toMatch(ISO);
    expect(after.body.parsingStartedAt).toBeNull();
    expect(after.body.queuedAt).toBeNull();
  });

  it('a stream being closed carries when processing began, still on the 202', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    await streamFirstChunk(runId);
    expect(await new RunRepository(ctx.prisma).claimForClose(runId)).toBe(true);

    const res = await read(runId);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('parsing');
    expect(res.body.parsingStartedAt).toMatch(ISO);
  });

  it('a finished upload carries its processing span, and no stream', async () => {
    ctx = await createTestApp();
    const posted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(posted.status).toBe(202);
    const runId = posted.body.id as string;
    await runPipelineFor(ctx, runId);

    const res = await read(runId);
    expect(res.status).toBe(200);
    expect(res.body.parsingStartedAt).toMatch(ISO);
    expect(res.body.ingestedAt).toMatch(ISO);
    expect(Date.parse(res.body.parsingStartedAt)).toBeLessThanOrEqual(Date.parse(res.body.ingestedAt));
    expect(res.body.streamUpdatedAt).toBeNull();
    expect(res.body.queuedAt).toBeNull();
  });

  it('an incomplete stream keeps its last chunk on the finished body', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    await streamFirstChunk(runId);
    await ctx.prisma.run.update({
      where: { id: runId },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });

    const res = await read(runId);
    expect(res.status).toBe(200);
    expect(res.body.streamUpdatedAt).toMatch(ISO);
    expect(res.body.parsingStartedAt).toBeNull();
  });

  it('a runner’s run carries when its job was queued, live and once finished', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    const artifact = await ctx.prisma.runnerArtifact.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        name: 'lifecycle',
        filename: 'bundle.tgz',
        kind: 'gatling_bundle',
        simulationClass: 'example.ParitySimulation',
        sha256: '0'.repeat(64),
        bytes: BigInt(1),
        storagePath: 'lifecycle/none',
      },
    });
    const queuedAt = new Date(Date.now() - 41_000);
    await ctx.prisma.runnerJob.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        artifactId: artifact.id,
        runId,
        status: 'running',
        requestedBy: 'lifecycle-test',
        createdAt: queuedAt,
      },
    });

    const live = await read(runId);
    expect(live.status).toBe(202);
    expect(live.body.queuedAt).toBe(queuedAt.toISOString());

    await ctx.prisma.run.update({
      where: { id: runId },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });
    const done = await read(runId);
    expect(done.status).toBe(200);
    expect(done.body.queuedAt).toBe(queuedAt.toISOString());
  });
});
