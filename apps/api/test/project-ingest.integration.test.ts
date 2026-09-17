import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';
import { signUpAsOrgMember } from './support/session.js';

/**
 * `POST /v1/projects/:slug/runs` — the route review 09-13 M05's file picker
 * needed before it could exist (see `project-ingest.controller.ts`).
 *
 * ═══ THE FIRST CASE HERE IS THE ONE THAT JUSTIFIES THE ROUTE ═══
 *
 * "a session cannot post a bundle" was the finding's whole blocker, and it is
 * asserted here rather than assumed: if `POST /v1/runs` ever starts accepting a
 * session, this route is duplicate surface and somebody should be told. A
 * comment saying so would not survive that change; a failing test does.
 */

let ctx: TestContext;
let cookie: string;

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
let bundle: Buffer;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'project-ingest-'));
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

/** The upload as the browser sends it: a session, and `waitMs: 0` because the
 *  page polls the run rather than holding the request open. */
function upload(slug: string, metadata: object = { tool: 'gatling', waitMs: 0 }) {
  return request(ctx.app.getHttpServer())
    .post(`/v1/projects/${slug}/runs`)
    .set('Cookie', cookie)
    .field('metadata', JSON.stringify(metadata))
    .attach('bundle', bundle, 'bundle.tgz');
}

describe('POST /v1/projects/:slug/runs', () => {
  beforeEach(async () => {
    ctx = await createTestApp();
    // A real org MEMBER, not signUpAndLogin's org-less user: an org-less
    // session 403s for a reason that has nothing to do with this route, which
    // would make "accepts a session" pass for the wrong reason if it ever
    // stopped working. Same argument tokens.integration.test.ts records.
    cookie = await signUpAsOrgMember(ctx, 'uploader@example.test');
  });

  // ═══ THE BLOCKER, PINNED ═══
  it('exists because POST /v1/runs refuses a session', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Cookie', cookie)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');

    // Not 401 or 403: the session authenticates perfectly and carries the
    // `ingest` scope. It names no PROJECT, and that handler reads one off the
    // credential. The remediation is what sends a caller here.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_REQUIRED');
  });

  it('accepts a session and files the run under the project the URL names', async () => {
    const res = await upload('checkout');

    // 202, because `waitMs: 0` means nothing has parsed it yet — the status
    // this endpoint almost always answers, and the shape the browser must
    // therefore be able to read.
    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    // The project came from the URL and the org from the session — the join
    // this route exists to make. A run filed under the right org and the wrong
    // project would still answer 202.
    expect(row?.projectId).toBe(ctx.projectId);
    expect(row?.orgId).toBe(ctx.orgId);
  });

  it('stores a bundle that really parses, with the reference run\'s own numbers', async () => {
    // A route that wrote the bytes under a corrupt key would still answer 202
    // and still create the row above. This is the assertion that says the
    // UPLOAD arrived, not just the request.
    const res = await upload('checkout');
    await runPipelineFor(ctx, res.body.id);

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    expect(row?.status).toBe('complete');

    const runStat = await ctx.prisma.runStat.findFirst({
      where: { runId: res.body.id, scope: 'run' },
    });
    // The fixture's own figures, not written down anywhere else in this file.
    expect(runStat?.count).toBe(895);
    expect(runStat?.koCount).toBe(24);
  });

  // ═══ SESSION ONLY, BOTH DIRECTIONS ═══
  // Not a second way in for tokens: a project-scoped token already has
  // POST /v1/runs, and a route that took both would be surface bought for no
  // reader. Asserted for two DIFFERENT scopes, because a guard replaced with
  // `@Scopes('ingest')` — the plausible-looking simplification — would still
  // refuse the read token and let the ingest one through.
  it('refuses a bearer ingest token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects/checkout/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(res.status).toBe(403);
  });

  it('refuses a bearer read token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/projects/checkout/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(res.status).toBe(403);
  });

  it('answers 404 for a slug that names no project', async () => {
    expect((await upload('no-such-project')).status).toBe(404);
  });

  it("answers 404, never 403, for a project outside the caller's org", async () => {
    const other = await ctx.prisma.org.create({
      data: { slug: 'other-org-ingest', name: 'Other' },
    });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'other-project-ingest', name: 'Other Project' },
    });

    const res = await upload(otherProject.slug);
    // 404 and not 403, so the answer cannot confirm that another organisation
    // has a project by this name — the rule every project-scoped route here
    // follows. A 403 would make this endpoint an existence oracle.
    expect(res.status).toBe(404);

    const runs = await ctx.prisma.run.count({ where: { projectId: otherProject.id } });
    expect(runs).toBe(0);
  });

  it('validates metadata exactly as POST /v1/runs does', async () => {
    // Shared through `IngestService.parseMetadata` rather than re-implemented:
    // a second ingest path that accepted metadata the first refuses is the
    // two-decoders failure this repo refuses one layer down.
    expect((await upload('checkout', { waitMs: 0 })).status).toBe(400);
    expect((await upload('checkout', { tool: 'jmeter', waitMs: 0 })).status).toBe(400);
  });
});
