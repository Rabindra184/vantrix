import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-endpoints-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

async function ingested(): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

describe('GET /v1/runs/:id/distribution, /users, /scatter', () => {
  it('serves a Gatling-shaped distribution', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/distribution?scope=run&name=&family=response_time`)
      .set(auth())
      .expect(200);
    expect(res.body.labels.length).toBe(100);
    expect(res.body.overflowCount).toBe(0);
    const sum = [...res.body.okPercent, ...res.body.koPercent].reduce(
      (a: number, b: number) => a + b, 0,
    );
    expect(sum).toBeCloseTo(100, 6);
  });

  it('serves per-scenario users plus a summed total', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/users`)
      .set(auth())
      .expect(200);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
    const first = res.body.total[0];
    const perScenario = res.body.scenarios
      .map((s: { buckets: { startOffsetMs: number; maxConcurrent: number }[] }) =>
        s.buckets.find((b) => b.startOffsetMs === first.startOffsetMs)?.maxConcurrent ?? 0)
      .reduce((a: number, b: number) => a + b, 0);
    expect(first.maxConcurrent).toBe(perScenario);
  });

  // 'List Products' is one of the seven real request names the reference
  // fixture actually produces (see packages/plugin-gatling/test/records.test.ts) —
  // not the brief's placeholder 'Catalog / List', which does not exist here.
  it('serves the scatter as one point per bucket with a truncated p95', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/scatter?name=${encodeURIComponent('List Products')}`)
      .set(auth())
      .expect(200);
    expect(res.body.ok.length).toBeGreaterThan(0);
    for (const [x, y] of res.body.ok) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });

  it('404s for a run in another project', async () => {
    ctx = await createTestApp();

    // A run that exists, but not in ctx's org/project — created directly via
    // Prisma (as read.integration.test.ts's cursor-ordering tests do) rather
    // than a second createTestApp(), which would TRUNCATE the tables this
    // test's own ctx just populated.
    const otherOrg = await ctx.prisma.org.create({ data: { slug: 'other-org', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'other-project', name: 'Other Project' },
    });
    const otherRun = await ctx.prisma.run.create({
      data: {
        orgId: otherOrg.id, projectId: otherProject.id, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'other', bundleSha256: 'f'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date(), startedOn: new Date(), ingestedAt: new Date(), engineOptions: {},
      },
    });

    await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${otherRun.id}/distribution?scope=run&name=&family=response_time`)
      .set(auth())
      .expect(404);
  });
});
