import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectListResponseSchema, ProjectSummarySchema } from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe('GET /v1/projects', () => {
  it('lists a project with no runs, carrying latestRun: null', async () => {
    ctx = await createTestApp();
    // ctx's org has exactly one project ('checkout') and no runs yet.
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status).toBe(200);
    expect(() => ProjectListResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      id: ctx.projectId,
      slug: 'checkout',
      name: 'Checkout',
      latestRun: null,
    });
  });

  it('reports the same run GET /v1/runs puts first, not the most recently ingested', async () => {
    ctx = await createTestApp();
    // Two runs whose ingest order and TOOL order disagree, so a query
    // ordering by the wrong column picks the wrong run. Ordering by
    // COALESCE(tool_started_at, started_at) must choose `later`; ordering by
    // started_at alone would choose `earlier`.
    const base = Date.UTC(2026, 7, 15, 12, 0, 0);
    const earlier = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'k1', bundleSha256: 's1', bundleBytes: BigInt(1),
        startedAt: new Date(base + 10 * 60_000),        // ingested LAST
        startedOn: new Date(Date.UTC(2026, 7, 15)),
        toolStartedAt: new Date(base - 10 * 60_000),    // but ran FIRST
        engineOptions: {},
      },
    });
    const later = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'failed',
        tool: 'gatling', bundleKey: 'k2', bundleSha256: 's2', bundleBytes: BigInt(1),
        startedAt: new Date(base),                      // ingested FIRST
        startedOn: new Date(Date.UTC(2026, 7, 15)),
        toolStartedAt: new Date(base + 20 * 60_000),    // but ran LAST
        engineOptions: {},
      },
    });

    const runs = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    const projects = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);

    // Unlike the "no runs" test above, latestRun is populated here, so this
    // is the assertion that actually exercises the inner object schema —
    // RunStatusSchema and RunVerdictSchema.nullable() only run when the
    // wrapping .nullable() sees a non-null value to hand them.
    expect(() => ProjectListResponseSchema.parse(projects.body)).not.toThrow();

    // Derived from the run list, not written down: these two must agree, and
    // asserting a literal id would prove only that this test is self-consistent.
    expect(projects.body.items[0].latestRun.id).toBe(runs.body.items[0].id);
    expect(projects.body.items[0].latestRun.id).toBe(later.id);
    expect(projects.body.items[0].latestRun.id).not.toBe(earlier.id);
    expect(projects.body.items[0].latestRun.status).toBe('complete');
    expect(projects.body.items[0].latestRun.verdict).toBe('failed');
  });

  it('shows a bearer token only the project it was minted against', async () => {
    ctx = await createTestApp();
    const other = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.body.items.map((p: { slug: string }) => p.slug)).toEqual(['checkout']);
    expect(res.body.items.map((p: { id: string }) => p.id)).not.toContain(other.id);
  });
});

describe('POST /v1/projects', () => {
  it('creates a project for a signed-in org member and lists it afterwards', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'project-create@example.test');
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Search API', slug: 'search-api' });

    expect(res.status).toBe(201);
    expect(() => ProjectSummarySchema.parse(res.body)).not.toThrow();
    expect(res.body).toMatchObject({ name: 'Search API', slug: 'search-api', latestRun: null });

    const list = await request(ctx.app.getHttpServer()).get('/v1/projects').set('Cookie', cookie);
    expect(list.body.items.map((p: { slug: string }) => p.slug)).toEqual(['checkout', 'search-api']);
  });

  it('refuses bearer credentials', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ name: 'Search API', slug: 'search-api' });
    expect(res.status).toBe(403);
  });

  it('rejects duplicate slugs inside the organisation, and says what to do about it', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'project-duplicate@example.test');
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Another Checkout', slug: 'checkout' });
    expect(res.status).toBe(409);

    // THE REMEDIATION IS THE POINT, not the status. A bare
    // ConflictException carries none, so `ProblemFilter` falls back to
    // "Check the request against the OpenAPI description" — advice that is
    // useless here, because the request matches the document exactly and the
    // slug is simply taken. This is the error a user hits routinely, and
    // `NewProject.tsx` renders `remediation` straight under the message.
    expect(res.body.code).toBe('PROJECT_SLUG_TAKEN');
    expect(res.body.detail).toContain('checkout');
    expect(res.body.remediation).toMatch(/different slug/i);
    expect(res.body.remediation).not.toMatch(/openapi/i);
  });

  it('rejects invalid project details', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'project-invalid@example.test');
    for (const body of [
      { name: '  ', slug: 'search-api' },
      { name: 'Search', slug: 'Search API' },
      { name: 'Search', slug: 'a' },
    ]) {
      const res = await request(ctx.app.getHttpServer()).post('/v1/projects').set('Cookie', cookie).send(body);
      expect(res.status).toBe(400);
    }
  });
});
