import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

describe('GET /v1/runs/:id', () => {
  it('rejects a malformed id with 400 and remediation that says what a valid value looks like, not "retry"', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/not-a-uuid').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.remediation).toMatch(/uuid/i);
    // The old failure mode's remediation told the caller to retry — which
    // can never succeed for a malformed id, since the id itself is the
    // problem. Guard against regressing to that shape.
    expect(res.body.remediation.toLowerCase()).not.toContain('retry the request');
  });
});

describe('GET /v1/runs/:id/stats', () => {
  it('rejects a malformed id with 400, not a 500 that leaks a Prisma error', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/not-a-uuid/stats')
      .set(auth());
    expect(res.status).toBe(400);
    expect(res.body.remediation).toMatch(/uuid/i);
  });

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

  it('reports indicators.failed from run_indicator, not recomputed from run_stat.ko_count', async () => {
    // The two sources normally agree because the engine writes both from the
    // same loop. Seed them to DISAGREE so the assertion below can only pass
    // if the API actually reads run_indicator.failed rather than
    // re-deriving it from run_stat.ko_count — a same-value fixture (as in
    // "reports the indicator bands...") cannot tell the two code paths apart.
    ctx = await createTestApp();

    const run = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        status: 'complete',
        verdict: 'passed',
        tool: 'gatling',
        bundleKey: 'k',
        bundleSha256: 'a'.repeat(64),
        bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-07T10:00:00Z'),
        startedOn: new Date('2026-08-07T00:00:00Z'),
        ingestedAt: new Date('2026-08-07T10:00:05Z'),
        engineOptions: {},
      },
    });

    // run_stat.ko_count says 24 KOs...
    await ctx.pool.query(
      `INSERT INTO run_stat
         (id, run_id, org_id, project_id, scope, name, family,
          count, ok_count, ko_count, error_rate, min_ms, max_ms, mean_ms,
          stddev_ms, throughput_rps, percentiles, sketch, sketch_kind)
       VALUES ($1, $2, $3, $4, 'run', '', 'response_time',
               100, 76, 24, 0.24, 1, 200, 50, 10, 5,
               $5::jsonb, $6, 'ddsketch')`,
      [randomUUID(), run.id, ctx.orgId, ctx.projectId, JSON.stringify({ p50: 0, p95: 0, p99: 0 }), Buffer.from([0])],
    );

    // ...but run_indicator.failed — the engine's own precise count — says 99.
    await ctx.pool.query(
      `INSERT INTO run_indicator (id, run_id, org_id, project_id, under, between_, over, failed)
       VALUES ($1, $2, $3, $4, 10, 0, 5, 99)`,
      [randomUUID(), run.id, ctx.orgId, ctx.projectId],
    );

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${run.id}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.indicators.failed).toBe(99);
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

  it('orders by the real run start when known, not by upload/ingest order', async () => {
    // A same-value fixture (upload order agrees with tool-start order) would
    // pass under either the old ORDER BY started_at or the new coalesce —
    // this seeds them to DISAGREE so only the new ordering can pass.
    ctx = await createTestApp();

    // Uploaded first, but the load test itself ran later (e.g. a delayed
    // upload of an earlier CI artifact isn't the case here — this is the
    // opposite: prompt upload of a run that started later in wall-clock terms).
    const runA = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'a', bundleSha256: 'a'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-01T10:00:00Z'),
        startedOn: new Date('2026-08-01T00:00:00Z'),
        toolStartedAt: new Date('2026-08-01T20:00:00Z'),
        ingestedAt: new Date('2026-08-01T10:00:05Z'),
        engineOptions: {},
      },
    });

    // Uploaded second (after A), but its own run started earlier than A's.
    const runB = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'b', bundleSha256: 'b'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-01T11:00:00Z'),
        startedOn: new Date('2026-08-01T00:00:00Z'),
        toolStartedAt: new Date('2026-08-01T09:00:00Z'),
        ingestedAt: new Date('2026-08-01T11:00:05Z'),
        engineOptions: {},
      },
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs')
      .set(auth());
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);

    // Upload order (started_at desc) would list B before A.
    // Real-start order (coalesce(tool_started_at, started_at) desc) lists A before B.
    expect(ids.indexOf(runA.id)).toBeLessThan(ids.indexOf(runB.id));
  });

  it('returns each run exactly once across cursor pages under the new ordering', async () => {
    ctx = await createTestApp();

    const seeds: { startedAt: string; toolStartedAt: string | null }[] = [
      { startedAt: '2026-08-01T09:00:00Z', toolStartedAt: '2026-08-01T23:00:00Z' },
      { startedAt: '2026-08-01T10:00:00Z', toolStartedAt: null },
      { startedAt: '2026-08-01T11:00:00Z', toolStartedAt: '2026-08-01T08:00:00Z' },
      { startedAt: '2026-08-01T12:00:00Z', toolStartedAt: '2026-08-01T22:00:00Z' },
      { startedAt: '2026-08-01T13:00:00Z', toolStartedAt: null },
    ];
    const ids: string[] = [];
    for (const [i, s] of seeds.entries()) {
      const run = await ctx.prisma.run.create({
        data: {
          orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
          tool: 'gatling', bundleKey: `k${i}`, bundleSha256: String(i).repeat(64).slice(0, 64),
          bundleBytes: BigInt(1),
          startedAt: new Date(s.startedAt),
          startedOn: new Date(`${s.startedAt.slice(0, 10)}T00:00:00Z`),
          toolStartedAt: s.toolStartedAt ? new Date(s.toolStartedAt) : null,
          ingestedAt: new Date(s.startedAt),
          engineOptions: {},
        },
      });
      ids.push(run.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await request(ctx.app.getHttpServer())
        .get(`/v1/projects/checkout/runs?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(auth());
      expect(res.status).toBe(200);
      for (const item of res.body.items as { id: string }[]) seen.push(item.id);
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(seen.length).toBe(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('refuses a project the token does not belong to', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/some-other-project/runs')
      .set(auth());
    expect(res.status).toBe(404);
  });

  it('clamps a negative limit instead of silently returning zero items', async () => {
    // Math.min(-5, 100) === -5, and Array.prototype.slice(0, -5) on a
    // handful of rows returns [] — a paginating client would read that as
    // "this project has no runs," a silent wrong answer, not an error it
    // could act on. limit=-5 must behave like a sane positive limit instead.
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=-5')
      .set(auth());
    expect(res.status).toBe(200);
    expect(() => RunListResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('clamps limit=0 to at least one item rather than returning an empty page', async () => {
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=0')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('clamps an excessive limit to the 100-item cap instead of passing it through', async () => {
    ctx = await createTestApp();
    await ingested();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=99999')
      .set(auth());
    expect(res.status).toBe(200);
    // Only one run was seeded, so this mainly asserts the request succeeds
    // (does not 500 or otherwise choke on an out-of-range limit) — the cap
    // itself is exercised directly in the parseLimit unit coverage.
    expect(res.body.items.length).toBeGreaterThan(0);
  });
});
