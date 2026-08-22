import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestApp();
  // A REAL MEMBER of ctx's own org. A no-membership session 403s the same way
  // SessionOnlyGuard refuses a bearer token, so the wrong helper would make
  // "accepts a session" pass for entirely the wrong reason.
  cookie = await signUpAsOrgMember(ctx, 'test-reader@example.test');
});

afterEach(async () => {
  await ctx?.close();
});

const TESTS = '/v1/projects/checkout/tests';

const asSession = (method: 'get' | 'patch', path: string) =>
  request(ctx.app.getHttpServer())[method](path).set('Cookie', cookie);

async function seedTest(over: Partial<{ slug: string; name: string; simulationClass: string }> = {}) {
  return ctx.prisma.test.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      slug: over.slug ?? 'example-paritysimulation',
      name: over.name ?? 'example.ParitySimulation',
      simulationClass: over.simulationClass ?? 'example.ParitySimulation',
    },
  });
}

async function seedRun(testId: string | null, over: Record<string, unknown> = {}) {
  return ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      testId,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: `k-${Math.random()}`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: new Date('2026-08-01T10:00:00Z'),
      startedOn: new Date('2026-08-01T00:00:00Z'),
      engineOptions: {},
      ...over,
    },
  });
}

describe('GET /v1/projects/:slug/tests', () => {
  it('lists a test with its run count and newest run', async () => {
    const test = await seedTest();
    await seedRun(test.id, { startedAt: new Date('2026-08-01T10:00:00Z') });
    const newest = await seedRun(test.id, {
      startedAt: new Date('2026-08-03T10:00:00Z'),
      verdict: 'failed',
    });

    const res = await asSession('get', TESTS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tests).toHaveLength(1);
    expect(res.body.tests[0]).toMatchObject({
      slug: 'example-paritysimulation',
      simulationClass: 'example.ParitySimulation',
      runCount: 2,
      latestRun: { id: newest.id, status: 'complete', verdict: 'failed' },
    });
  });

  /**
   * ═══ THE COUNTS MUST NOT COME FROM THE WRONG TEST ═══
   *
   * `listForProject` fetches every count in one `groupBy` and every latest run
   * in one ordered scan, then reduces. That is the shape a per-test loop would
   * have avoided the risk of — and the risk it introduces is exactly this:
   * attributing one test's rows to another. Two tests with different run
   * counts is the smallest case that catches a mis-keyed reduce.
   */
  it('attributes each run to its own test, not to whichever came first', async () => {
    const a = await seedTest({ slug: 'alpha', simulationClass: 'a.Sim' });
    const b = await seedTest({ slug: 'bravo', simulationClass: 'b.Sim' });
    await seedRun(a.id);
    await seedRun(b.id);
    await seedRun(b.id);

    const res = await asSession('get', TESTS);
    const bySlug = Object.fromEntries(
      (res.body.tests as { slug: string; runCount: number }[]).map((t) => [t.slug, t.runCount]),
    );
    expect(bySlug).toEqual({ alpha: 1, bravo: 2 });
  });

  /**
   * A run with no test — still pending, or a bundle that never parsed — must
   * not be counted against any test. It is not a run of one yet.
   */
  it('ignores runs that have no test', async () => {
    const test = await seedTest();
    await seedRun(test.id);
    await seedRun(null, { status: 'pending', verdict: null });

    const res = await asSession('get', TESTS);
    expect(res.body.tests[0].runCount).toBe(1);
  });

  it('reports a test whose runs have all gone, rather than hiding it', async () => {
    await seedTest();
    const res = await asSession('get', TESTS);
    expect(res.body.tests[0]).toMatchObject({ runCount: 0, latestRun: null });
  });

  it('says a project has no tests rather than erroring', async () => {
    const res = await asSession('get', TESTS);
    expect(res.status).toBe(200);
    expect(res.body.tests).toEqual([]);
  });

  /**
   * EITHER CREDENTIAL, unlike the SLA rule routes beside it. Resolving "which
   * test am I about to add a run to" is exactly what a CI job needs.
   */
  it('accepts a bearer token, because reading which tests exist is an ordinary read', async () => {
    await seedTest();
    const res = await request(ctx.app.getHttpServer())
      .get(TESTS)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tests).toHaveLength(1);
  });

  it('404s for a project in another organisation', async () => {
    const res = await asSession('get', '/v1/projects/not-mine/tests');
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/projects/:slug/tests/:testSlug', () => {
  it('returns one test', async () => {
    await seedTest();
    const res = await asSession('get', `${TESTS}/example-paritysimulation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'example-paritysimulation', runCount: 0 });
  });

  it('404s for a slug that names no test', async () => {
    const res = await asSession('get', `${TESTS}/nope`);
    expect(res.status).toBe(404);
  });

  /**
   * The same 404 as "no such test", never a 403: the status code must not tell
   * a caller that a test exists in an organisation they cannot see.
   */
  it('404s for a test that exists in another organisation', async () => {
    const otherOrg = await ctx.prisma.org.create({ data: { slug: 'other-org', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'theirs', name: 'Theirs', settings: {} },
    });
    await ctx.prisma.test.create({
      data: {
        orgId: otherOrg.id,
        projectId: otherProject.id,
        slug: 'secret-test',
        name: 'secret',
        simulationClass: 'secret.Sim',
      },
    });

    const res = await asSession('get', `${TESTS}/secret-test`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/projects/:slug/tests/:testSlug', () => {
  it('renames a test without touching what it matches on', async () => {
    await seedTest();
    const res = await asSession('patch', `${TESTS}/example-paritysimulation`).send({
      name: 'Checkout smoke',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Checkout smoke',
      // UNCHANGED, and this is the assertion that matters: the runs are matched
      // on this, so a rename that moved it would split the test's history.
      simulationClass: 'example.ParitySimulation',
      slug: 'example-paritysimulation',
    });
  });

  it('clears a description when told to, and leaves it alone when not', async () => {
    await seedTest();
    await asSession('patch', `${TESTS}/example-paritysimulation`).send({ description: 'why' });

    const kept = await asSession('patch', `${TESTS}/example-paritysimulation`).send({ name: 'x' });
    expect(kept.body.description).toBe('why');

    const cleared = await asSession('patch', `${TESTS}/example-paritysimulation`).send({
      description: null,
    });
    expect(cleared.body.description).toBeNull();
  });

  /**
   * ═══ THE REFUSAL THE WHOLE ENDPOINT IS SHAPED AROUND ═══
   *
   * `simulationClass` is the key the worker matches a parsed run on. Accepting
   * it would not rename the test — it would SPLIT it: future runs of the old
   * class would create a second test and start a second history while the runs
   * already recorded stayed here, with nothing erroring.
   */
  it('refuses to re-aim a test at a different simulation class', async () => {
    await seedTest();
    const res = await asSession('patch', `${TESTS}/example-paritysimulation`).send({
      name: 'fine',
      simulationClass: 'other.Simulation',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TEST_UPDATE');
    // And nothing was written — a `.strict()` rejection must not half-apply.
    const after = await asSession('get', `${TESTS}/example-paritysimulation`);
    expect(after.body).toMatchObject({
      name: 'example.ParitySimulation',
      simulationClass: 'example.ParitySimulation',
    });
  });

  it('refuses an empty body rather than reporting a write it never made', async () => {
    await seedTest();
    const res = await asSession('patch', `${TESTS}/example-paritysimulation`).send({});
    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });

  /**
   * A name is a human's choice about how their organisation reads. A CI job
   * that could rename a test would rename it on every run.
   */
  it('refuses a bearer token, however wide its scopes', async () => {
    await seedTest();
    const res = await request(ctx.app.getHttpServer())
      .patch(`${TESTS}/example-paritysimulation`)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ name: 'renamed by CI' });

    expect(res.status).toBe(403);
  });

  it('404s for a test in another project', async () => {
    const res = await asSession('patch', `${TESTS}/nope`).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/runs?test=', () => {
  it('narrows to one test, leaving the other test\'s runs out', async () => {
    const a = await seedTest({ slug: 'alpha', simulationClass: 'a.Sim' });
    const b = await seedTest({ slug: 'bravo', simulationClass: 'b.Sim' });
    const mine = await seedRun(a.id);
    await seedRun(b.id);

    const res = await asSession('get', '/v1/runs?project=checkout&test=alpha');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([mine.id]);
  });

  /**
   * ═══ A TEST SLUG IS UNIQUE PER PROJECT, NOT PER ORG ═══
   *
   * So it means nothing on its own. Searching the whole org for a slug would
   * answer differently depending on how many projects happened to use the same
   * simulation name — a wrong answer that looks right. 400, because the
   * request is malformed rather than pointing at something absent.
   */
  it('refuses "test" without "project" rather than guessing which project', async () => {
    await seedTest({ slug: 'alpha', simulationClass: 'a.Sim' });
    const res = await asSession('get', '/v1/runs?test=alpha');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEST_NEEDS_PROJECT');
  });

  it('404s for a test slug that names nothing in that project', async () => {
    const res = await asSession('get', '/v1/runs?project=checkout&test=nope');
    expect(res.status).toBe(404);
  });

  it('leaves runs with no test out, because they are runs of nothing yet', async () => {
    const a = await seedTest({ slug: 'alpha', simulationClass: 'a.Sim' });
    await seedRun(a.id);
    await seedRun(null, { status: 'pending', verdict: null });

    const res = await asSession('get', '/v1/runs?project=checkout&test=alpha');
    expect(res.body.items).toHaveLength(1);
  });

  /**
   * A bearer token already names a project, so it needs only `test` — and the
   * filter must still resolve against ITS project rather than requiring the
   * caller to repeat what the credential already said.
   */
  it('lets a bearer token name a test without repeating its own project', async () => {
    const a = await seedTest({ slug: 'alpha', simulationClass: 'a.Sim' });
    const mine = await seedRun(a.id);

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?test=alpha')
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([mine.id]);
  });
});
