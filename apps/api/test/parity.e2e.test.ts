import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const REPORT_DIR = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

/**
 * The bundle is the WHOLE reference report directory, exactly as a CI pipeline
 * would archive target/gatling/<run>. Not a hand-picked simulation.log.
 */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const results = join(dir, 'paritysimulation-20260807123456789');
  mkdirSync(results, { recursive: true });
  for (const entry of readdirSync(REPORT_DIR)) {
    copyFileSync(join(REPORT_DIR, entry), join(results, entry));
  }
  const out = join(dir, 'bundle.tgz');
  // COPYFILE_DISABLE suppresses AppleDouble ._name sidecar entries that
  // macOS bsdtar emits for files carrying extended attributes — a no-op
  // under GNU tar, so this is safe on Linux CI too.
  execFileSync('tar', ['-czf', out, '-C', dir, 'paritysimulation-20260807123456789'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

describe('end-to-end parity with the Gatling reference report', () => {
  it('reproduces every exact statistic through HTTP', async () => {
    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    await q.obliterate({ force: true });
    await q.close();

    ctx = await createTestApp();

    // 1. Ingest, asking for no synchronous wait.
    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'parity-1' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(accepted.status).toBe(202);
    const runId: string = accepted.body.id;

    // 2. Run the pipeline.
    await runPipelineFor(ctx, runId);

    // 3. The run is complete, with no rules configured.
    const run = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('complete');
    expect(run.body.verdict).toBe('not_evaluated');
    expect(run.body.toolVersion).toBe('3.15.1');

    // 4. Exact statistics — every one of these appears in the Gatling report.
    const stats = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    const global = stats.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(global.count).toBe(895);
    expect(global.okCount).toBe(871);
    expect(global.koCount).toBe(24);
    expect(Math.round(global.maxMs)).toBe(2503);
    expect(Math.round(global.meanMs)).toBe(228);
    expect(Math.round(global.stddevMs)).toBe(370);

    expect(stats.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });

    // 5. The error table, with both messages and their exact counts.
    const errors = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/errors`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(errors.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('500'))).toHaveLength(1);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('503'))).toHaveLength(1);

    // 6. Groups — Gatling reports cumulated response time and duration
    //    separately, and they diverge whenever requests inside a group overlap.
    const groups = stats.body.stats.filter((s: { scope: string }) => s.scope === 'group');
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(groups.map((g: { family: string }) => g.family))).toEqual(
      new Set(['group_cumulated', 'group_duration']),
    );
    expect(groups.some((g: { name: string }) => g.name === 'Catalog/Recommendations')).toBe(true);

    // 7. The time series accounts for every request, at both edges.
    const series = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=run&name=`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    const started = series.body.buckets.reduce(
      (a: number, b: { startedCount: number }) => a + b.startedCount, 0,
    );
    const ended = series.body.buckets.reduce(
      (a: number, b: { endedCount: number }) => a + b.endedCount, 0,
    );
    expect(started).toBe(895);
    expect(ended).toBe(895);

    // 8. Percentiles are ESTIMATES and are checked against ground truth, not
    //    against Gatling — Gatling's own printed percentiles are histogram
    //    estimates and three of its four never occur in the data (spec §A.9 F-6).
    //    DDSketch guarantees 1% relative error, and 1.000% is reachable, so
    //    this bound is <=, never <.
    expect(Math.abs(global.percentiles.p95 - 654) / 654).toBeLessThanOrEqual(0.01);
  });

  it('is idempotent end to end — re-posting the same key yields one run', async () => {
    ctx = await createTestApp();
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'same' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const a = await post();
    await runPipelineFor(ctx, a.body.id);
    const b = await post();

    expect(b.body.id).toBe(a.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });
});
