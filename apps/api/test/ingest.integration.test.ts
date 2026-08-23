import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  const results = join(dir, 'paritysimulation-20260807');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'paritysimulation-20260807']);
  bundle = readFileSync(out);
});

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

async function drainQueue(): Promise<void> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
}

describe('POST /v1/runs', () => {
  it('accepts a bundle and returns a status URL', async () => {
    await drainQueue();
    ctx = await createTestApp();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.statusUrl).toBe(`/v1/runs/${res.body.id}`);
  });

  it('commits the run row before enqueuing, so the only reachable gap is a run with no job', async () => {
    await drainQueue();
    ctx = await createTestApp();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    expect(row?.status).toBe('pending');
    expect(row?.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row?.bundleBytes)).toBe(bundle.length);

    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data.runId)).toContain(res.body.id);
    await q.close();
  });

  it('freezes the engine options onto the run', async () => {
    await drainQueue();
    ctx = await createTestApp({ warmupMs: 5000, percentiles: [50, 90, 99] });

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    expect(row?.engineOptions).toMatchObject({ warmupMs: 5000, percentiles: [50, 90, 99] });
  });

  // ═══ THE ONE SUBMIT PATH THAT ALWAYS WORKED, AND HAD NO TEST EITHER ═══
  //
  // `metadata.test` reaches four entry points; three of them dropped it for
  // their whole life because `RunRepository.createLive` never wrote the
  // column, and nothing anywhere failed. This one — the bundle upload, through
  // `create` rather than `createLive` — was the survivor by accident of which
  // method it happened to call, not by anything asserting it. Pinning it here
  // is what stops the surviving path becoming the next silent casualty.
  //
  // The column, not the response: `POST /v1/runs` answers 202 before the
  // worker has parsed anything, so the run has no RESOLVED test yet and the
  // body's `test` field is null either way.
  it('freezes the test a caller declares onto the run, and null when it declared none', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const post = (metadata: Record<string, unknown>) =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        // `waitMs: 0` because this case cares about a column that is written
        // BEFORE the response (see "commits the run row before enqueuing"),
        // not about a verdict. Without it each post sits out the full
        // INGEST_WAIT_MS default waiting for a terminal notification no worker
        // in this process will ever send — 25 seconds each, for nothing.
        .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...metadata }))
        .attach('bundle', bundle, 'bundle.tgz');

    const declared = await post({ test: 'checkout-soak', idempotencyKey: 'declared' });
    const undeclared = await post({ idempotencyKey: 'undeclared' });

    const declaredRow = await ctx.prisma.run.findUnique({ where: { id: declared.body.id } });
    const undeclaredRow = await ctx.prisma.run.findUnique({ where: { id: undeclared.body.id } });
    expect(declaredRow?.declaredTestSlug).toBe('checkout-soak');
    // Not filler: it is what makes the assertion above mean "the caller's
    // slug" rather than "some value is present".
    expect(undeclaredRow?.declaredTestSlug).toBeNull();
  });

  it('is idempotent — the same key returns the original run and creates no second row', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const first = await post();
    const second = await post();

    expect(second.body.id).toBe(first.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });

  it('a concurrent duplicate POST is idempotent, not a 500, and leaves exactly one row', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'concurrent-race' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const [first, second] = await Promise.all([post(), post()]);

    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    expect(first.body.id).toBe(second.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });

  it('rejects a token without the ingest scope', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('ingest');
  });

  it('rejects invalid metadata with a remediable problem document', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'notatool' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
    expect(await ctx.prisma.run.count()).toBe(0);
  });

  it('rejects a bundle past the size cap without creating a run', async () => {
    await drainQueue();
    ctx = await createTestApp({ maxBundleBytes: 1024 });
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    expect(await ctx.prisma.run.count()).toBe(0);
  });

  it('rejects a request with no bundle part', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }));

    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });

  it('does not update provenance on an idempotent re-post', async () => {
    await drainQueue();
    ctx = await createTestApp();

    const first = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42', branch: 'main' }))
      .attach('bundle', bundle, 'bundle.tgz');

    const second = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42', branch: 'corrected' }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(second.body.id).toBe(first.body.id);   // one run, by idempotency

    const row = await ctx.prisma.run.findUnique({ where: { id: first.body.id } });
    // accept() returns the existing run BEFORE writing anything, so the second
    // post is a no-op. Pinned because the first person to fix a typo in a
    // pipeline and re-run it will expect otherwise.
    expect(row?.branch).toBe('main');
  });
});
