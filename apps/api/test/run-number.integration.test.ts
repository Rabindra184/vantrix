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
import { signUpAsOrgMember } from './support/session.js';

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

/**
 * ═══ `number=` ON THE RUN LIST: A RUN BY THE NUMBER ITS PAGE SHOWS ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * A run number names a run only WITHIN its test (the unique index is
 * `(test_id, run_number)`), so the filter is meaningless without a resolved
 * test and is refused rather than guessed at. The runs come from the real
 * pipeline for the reason the top of this file gives.
 */
describe('number= on GET /v1/runs', () => {
  /** The one test the reference bundle's simulation class resolves to. */
  async function theTestSlug(): Promise<string> {
    const test = await ctx.prisma.test.findFirstOrThrow({ where: { projectId: ctx.projectId } });
    return test.slug;
  }

  it('narrows a test’s runs to the one with that number', async () => {
    const ids = [await ingested(), await ingested(), await ingested()];
    const slug = await theTestSlug();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs?test=${slug}&number=2`).set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Vacuity guard: without the filter the same call answers all three, so
    // a one-item answer is the filter's and not the fixture's.
    const unfiltered = await request(ctx.app.getHttpServer()).get(`/v1/runs?test=${slug}`).set(auth());
    expect(unfiltered.body.items).toHaveLength(3);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: ids[1], runNumber: 2 });
  });

  it('narrows a session’s read the same way, naming the project beside the test', async () => {
    const ids = [await ingested(), await ingested()];
    const slug = await theTestSlug();
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs?project=checkout&test=${slug}&number=1`)
      .set('Cookie', cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
  });

  it('answers an empty page for a number the test never reached', async () => {
    await ingested();
    await ingested();
    const slug = await theTestSlug();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs?test=${slug}&number=3`).set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('refuses number without a test', async () => {
    await ingested();

    const token = await request(ctx.app.getHttpServer()).get('/v1/runs?number=1').set(auth());
    expect(token.status).toBe(400);
    expect(token.body.code).toBe('NUMBER_NEEDS_TEST');
    expect(token.body.remediation).toContain('test=<slug>');

    // A session that names its project and still no test is the same mistake.
    const cookie = await signUpAsOrgMember(ctx, `member-${randomUUID()}@example.com`);
    const session = await request(ctx.app.getHttpServer()).get('/v1/runs?project=checkout&number=1').set('Cookie', cookie);
    expect(session.status).toBe(400);
    expect(session.body.code).toBe('NUMBER_NEEDS_TEST');
  });

  it.each(['abc', '0', '-1', '2147483648', '1.5', '01', ''])(
    'refuses a number that is not a positive whole number: %j',
    async (bad) => {
      await ingested();
      const slug = await theTestSlug();

      const res = await request(ctx.app.getHttpServer()).get(`/v1/runs?test=${slug}&number=${bad}`).set(auth());
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('INVALID_RUN_NUMBER');
      expect(res.body.remediation).toContain('number=12');
    },
  );

  it('accepts the largest number an int column holds', async () => {
    await ingested();
    const slug = await theTestSlug();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs?test=${slug}&number=2147483647`).set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
