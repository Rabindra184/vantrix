import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunResponseSchema } from '@perfportal/contracts';
import type { RunRecord } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';
import { RunsService } from '../src/runs/runs.service.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
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

async function clearQueue() {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
}

function post(waitMs?: number) {
  const metadata: Record<string, unknown> = { tool: 'gatling' };
  if (waitMs !== undefined) metadata.waitMs = waitMs;
  return request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify(metadata))
    .attach('bundle', bundle, 'bundle.tgz');
}

/**
 * Polls for the run row the POST above is creating concurrently. Bounded
 * (300 attempts, 100ms apart = 30s — generous headroom over the typical
 * sub-100ms latency, to absorb occasional Docker/OS scheduling hiccups
 * without masking a real regression) so a regression that stops the row
 * from ever appearing fails the test with a clear message instead of
 * hanging the suite forever on an unresolved promise.
 */
async function pollForLatestRun(ctx: TestContext): Promise<string> {
  const MAX_ATTEMPTS = 300;
  const INTERVAL_MS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await ctx.prisma.run.findFirst({ orderBy: { createdAt: 'desc' } });
    if (row) return row.id;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  throw new Error(
    `No run row appeared within ${(MAX_ATTEMPTS * INTERVAL_MS) / 1000}s of posting.`,
  );
}

describe('the adaptive verdict', () => {
  it('answers 202 with a status URL when the wait window is zero', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const res = await post(0);

    expect(res.status).toBe(202);
    expect(res.body.statusUrl).toBe(`/v1/runs/${res.body.id}`);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('answers 200 with verdict not_evaluated when there are no rules', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('not_evaluated');
    expect(() => RunResponseSchema.parse(res.body)).not.toThrow();
  });

  it('answers 422 when a rule fails, listing the failing assertion', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(422);
    expect(res.body.verdict).toBe('failed');
    expect(res.body.assertions[0].outcome).toBe('failed');
  });

  it('answers 200 when a rule passes', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 100_000,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('passed');
  });

  it('answers 200 with not_evaluated when every rule is not_applicable', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'request', targetName: 'GET /nonexistent',
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 10,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('not_evaluated');
    expect(res.body.assertions[0].outcome).toBe('not_applicable');
    expect(res.body.assertions[0].actualValue).toBeNull();
  });

  it('answers 400 with the structured ingest error when the bundle was rejected', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', Buffer.from('not a tarball'), 'bundle.tgz');
    await runPipelineFor(ctx, accepted.body.id).catch(() => undefined);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUNDLE_NOT_ARCHIVE');
    expect(res.body.remediation).toBeTruthy();
  });

  it('answers 413 — not a flat 400 — when the failed run\'s own ingest error carries a different status', async () => {
    await clearQueue();
    ctx = await createTestApp();

    // Seeded directly via Prisma: producing a real BUNDLE_TOO_LARGE requires
    // an actual oversized upload, but the point of this test is only that a
    // 'failed' run's status code tracks its own ingest error's code
    // (413 for BUNDLE_TOO_LARGE) rather than a hardcoded 400.
    const run = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'failed', tool: 'gatling',
        bundleKey: 'runs/oversized.tgz', bundleSha256: 'z'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-07T10:00:00Z'),
        startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {},
        ingestedAt: new Date('2026-08-07T10:00:01Z'),
        error: {
          code: 'BUNDLE_TOO_LARGE',
          message: 'The bundle exceeds the configured size limit.',
          remediation: 'Reduce the bundle size or raise the configured limit.',
        },
      },
    });

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${run.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    expect(res.body.remediation).toBeTruthy();
  });

  it('statusFor() itself — not just the response respondWithRun happens to build — maps a failed run through its own ingest error status', async () => {
    // respondWithRun currently gets the wire status right for the 413 case
    // above by recomputing it independently via problemFromIngestError and
    // discarding statusFor()'s answer, so the end-to-end test alone does not
    // exercise the bug: statusFor() is documented ("400+ bundle rejected —
    // the ingest error's own status") but returns a hardcoded 400 for every
    // failed run regardless of its error code. This calls statusFor()
    // directly so a regression here fails even if some future caller trusts
    // its return value instead of recomputing.
    ctx = await createTestApp();
    const runsService = ctx.app.get(RunsService);

    const run: RunRecord = {
      id: 'unseeded', orgId: ctx.orgId, projectId: ctx.projectId, status: 'failed',
      verdict: null, tool: 'gatling', toolVersion: null, bundleKey: 'k',
      bundleSha256: 'x'.repeat(64), bundleBytes: 1, idempotencyKey: null,
      startedAt: new Date(), startedOn: new Date(), ingestedAt: new Date(), engineOptions: {},
      error: { code: 'BUNDLE_TOO_LARGE', message: 'too big', remediation: 'shrink it' },
    };

    expect(runsService.statusFor(run)).toBe(413);
  });

  it('returns 404 for a run belonging to another project', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await post(0);

    const other = await ctx.prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'p', name: 'P', settings: {} },
    });
    const { mintToken, hashToken } = await import('../src/auth/tokens.js');
    const t = mintToken();
    await ctx.prisma.apiToken.create({
      data: {
        orgId: other.id, projectId: otherProject.id, name: 'x',
        prefix: t.prefix, tokenHash: await hashToken(t.token.split('_')[2]!), scopes: ['read'],
      },
    });

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${t.token}`);

    expect(res.status).toBe(404);
  });

  it('POST and GET return the identical code for the identical state', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });

    // Long window; the pipeline runs concurrently and the waiter is woken by
    // the post-commit notification.
    //
    // supertest/superagent requests are lazy: constructing `post(...)` does
    // NOT put anything on the wire — the underlying http.request() is only
    // made once something invokes .then()/.catch() on the Test object (which
    // `await` does). Without this eager .catch(), the request would never
    // actually fire until the `await posted` below, by which point
    // pollForLatestRun has already given up waiting for a row that was never
    // going to appear. The real result is still awaited via `posted` further
    // down; this just starts the request now instead of later.
    const posted = post(20_000);
    void posted.catch(() => {});
    const accepted = await pollForLatestRun(ctx);
    await runPipelineFor(ctx, accepted);
    const postRes = await posted;

    const getRes = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(postRes.status).toBe(422);
    expect(getRes.status).toBe(postRes.status);
    expect(getRes.body.verdict).toBe(postRes.body.verdict);
  });
});
