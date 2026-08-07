import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ErrorsResponseSchema,
  RunListResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
} from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'read-'));
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

describe('GET /v1/runs/:id/stats', () => {
  it('returns the run-scope statistics matching the fixture', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(() => StatsResponseSchema.parse(res.body)).not.toThrow();

    const runStat = res.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(runStat.count).toBe(895);
    expect(runStat.okCount).toBe(871);
    expect(runStat.koCount).toBe(24);
    expect(Math.round(runStat.maxMs)).toBe(2503);
  });

  it('reports the indicator bands the Gatling report shows', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
  });

  it('filters by scope', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats?scope=request`)
      .set(auth());
    expect(res.body.stats.length).toBeGreaterThan(0);
    expect(res.body.stats.every((s: { scope: string }) => s.scope === 'request')).toBe(true);
  });
});

describe('GET /v1/runs/:id/series', () => {
  it('returns buckets that account for every request', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=run&name=`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(() => SeriesResponseSchema.parse(res.body)).not.toThrow();
    expect(
      res.body.buckets.reduce((a: number, b: { startedCount: number }) => a + b.startedCount, 0),
    ).toBe(895);
  });
});

describe('GET /v1/runs/:id/errors', () => {
  it('returns the error table with the fixture counts', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/errors`).set(auth());

    expect(() => ErrorsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
  });
});

describe('GET /v1/projects/:slug/runs', () => {
  it('lists runs newest first and paginates by cursor', async () => {
    ctx = await createTestApp();
    await ingested();
    await ingested();

    const first = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=1')
      .set(auth());
    expect(() => RunListResponseSchema.parse(first.body)).not.toThrow();
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(ctx.app.getHttpServer())
      .get(`/v1/projects/checkout/runs?limit=1&cursor=${first.body.nextCursor}`)
      .set(auth());
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it('refuses a project the token does not belong to', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/some-other-project/runs')
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('is served and describes the ingest endpoint', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/v1/runs']).toBeTruthy();
  });
});
