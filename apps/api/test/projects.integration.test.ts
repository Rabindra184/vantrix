import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectListResponseSchema } from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';

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
