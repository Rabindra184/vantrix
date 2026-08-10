import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { hashToken, mintToken } from '@perfportal/core';
import { OrgMemberRepository } from '@perfportal/persistence';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

// Built once at module load (execFileSync is synchronous) and reused by
// every test that needs a run with real stats/series/distribution/scatter
// data, rather than seedCompleteRun's bare row — see ingestFullRun below.
const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
let bundle: Buffer;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'session-auth-cross-org-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

describe('/auth/*', () => {
  it('serves /auth/* without a session', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/sign-up/email')
      .send({ email: 'a@example.test', password: 'correct-horse-battery', name: 'A' });

    // A real sign-up, not just "not a 500": with nothing mounted, Nest 404s
    // and ProblemFilter renders a non-empty problem+json body, which would
    // make the brief's original `status < 500 && body !== {}` assertion pass
    // even though /auth/* is not served at all.
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('a@example.test');
    // An empty body on a 404 here would mean basePath is misconfigured
    // (Better Auth 404s with an empty body when basePath doesn't match) —
    // a different failure from Nest's 404, useful to know when debugging.
    expect(res.headers['set-cookie']).toBeTruthy();
  });
});

/**
 * Signs up a brand-new user and returns the session cookie Better Auth
 * issues on sign-up (emailAndPassword defaults to auto-sign-in — see the
 * '/auth/*' test above, which already proves sign-up alone sets a cookie).
 * The user this creates has NO org_member row: use this directly only for
 * the no-membership case. Every other test needs signUpAsOrgMember below.
 */
async function signUpAndLogin(app: INestApplication, email: string): Promise<string> {
  const { cookie } = await signUp(app, email);
  return cookie;
}

async function signUp(app: INestApplication, email: string): Promise<{ cookie: string; userId: string }> {
  const res = await request(app.getHttpServer())
    .post('/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery', name: email });

  const setCookie = res.headers['set-cookie'] as unknown;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof raw !== 'string') {
    throw new Error(
      `sign-up for ${email} did not set a session cookie (status ${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  const userId = (res.body as { user?: { id?: string } }).user?.id;
  if (!userId) {
    throw new Error(`sign-up for ${email} did not return a user id: ${JSON.stringify(res.body)}`);
  }

  return { cookie: raw.split(';')[0] ?? raw, userId };
}

/**
 * signUpAndLogin, plus the org_member row a real member has and a fresh
 * sign-up never gets. createTestApp()'s ctx.orgId is the org every other
 * fixture (tokens, projects) in this test file already belongs to, so
 * joining it is what makes the session's tenant match the bearer token's.
 */
async function signUpAsOrgMember(ctx: TestContext, email: string, role = 'member'): Promise<string> {
  const { cookie, userId } = await signUp(ctx.app, email);
  await ctx.app.get(OrgMemberRepository).add(userId, ctx.orgId, role);
  return cookie;
}

/** A 'complete', passing run in ctx's org — statusFor() only returns 200 for this. */
async function seedCompleteRun(ctx: TestContext): Promise<string> {
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: 'session-auth-fixture',
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: new Date('2026-08-01T10:00:00Z'),
      startedOn: new Date('2026-08-01T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

/**
 * Ingests the real Gatling reference bundle via `token` and runs the
 * pipeline synchronously (mirrors parity-endpoints.integration.test.ts's
 * ingested()). Defaults to ctx's own ingest token; pass a different
 * project's token (see mintIngestTokenFor below) to seed real data — a
 * histogram, series buckets, scatter points — in a DIFFERENT org/project
 * than ctx's own. Needed wherever seedCompleteRun's bare row would not do:
 * GET .../distribution 404s without a histogram regardless of tenancy, so a
 * cross-org distribution check against a dataless run would 404 for "no
 * data" even with the org filter removed — proving nothing. Only a run with
 * real histogram/series data makes that endpoint's negative case falsifiable.
 */
async function ingestFullRun(ctx: TestContext, token = ctx.ingestToken): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${token}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

/** Mints and persists a fresh ingest-scoped token for an org/project other
 *  than ctx's own — mirrors support/app.ts's own token seeding exactly, so
 *  ingestFullRun's real POST /v1/runs + pipeline run can seed a genuinely
 *  cross-org run with real data. */
async function mintIngestTokenFor(ctx: TestContext, orgId: string, projectId: string): Promise<string> {
  const minted = mintToken();
  const secret = minted.token.split('_')[2] ?? '';
  await ctx.prisma.apiToken.create({
    data: {
      orgId, projectId, name: 'other-org-ci',
      prefix: minted.prefix, tokenHash: await hashToken(secret),
      scopes: ['ingest', 'read'],
    },
  });
  return minted.token;
}

describe('AuthMiddleware — session cookie branch on /v1', () => {
  it('accepts a session cookie on /v1', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    const cookie = await signUpAsOrgMember(ctx, 'b@example.test');
    await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(200);
  });

  // The regression that would break CI ingest.
  it('still accepts a bearer token, unchanged', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(200);
  });

  // Regression guard only: nothing under AuthMiddleware exists yet to grant
  // a credential-less request anything, so this was already 401 before the
  // session branch — see the report for the RED evidence that DOES exercise
  // the new code (the cookie test above and the logout test below).
  it('401s with no credential at all', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).expect(401);
  });

  it('401s a stale cookie after logout', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    const cookie = await signUpAsOrgMember(ctx, 'd@example.test');
    await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(200);
    await request(ctx.app.getHttpServer()).post('/auth/sign-out').set('Cookie', cookie).expect(200);
    // The same cookie string, now revoked server-side. A session store that only
    // expires by time would still accept this.
    await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set('Cookie', cookie).expect(401);
  });

  // Regression guard for the blanket rejection, PLUS the one assertion here
  // that is discriminating: 403, not 401. A valid session with no org is an
  // authorization failure (spec §7), distinct from having no credential at
  // all — and the problem body's message is what proves the middleware told
  // the two apart, not just the status code.
  it('403s a user with no org membership', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    const cookie = await signUpAndLogin(ctx.app, 'orphan@example.test'); // no org_member row
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Cookie', cookie)
      .expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.detail).toContain('no organization');
  });
});

// A session is org-scoped and names no project, but a run must belong to
// one, and this list route's only tenancy check is "the token names the
// project" — meaningless for a session. Both routes must refuse rather than
// guess or (worse, for the list route) silently widen to every run in the org.
describe('project-scoped routes require a project, which a session does not have', () => {
  it('refuses to ingest with a session, naming the fix', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'ingest-session@example.test');
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Cookie', cookie)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', Buffer.from('irrelevant — the guard fires before the body is read'), 'bundle.tgz')
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('PROJECT_REQUIRED');
    expect(res.body.remediation).toMatch(/token/i);
  });

  it('refuses GET /v1/projects/:slug/runs with a session', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'list-session@example.test');
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs')
      .set('Cookie', cookie)
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('PROJECT_REQUIRED');
    // The actionable half of the ruling — "use GET /v1/runs" — left unpinned
    // would let the remediation text drift or go stale without failing.
    expect(res.body.remediation).toMatch(/\/v1\/runs/);
  });

  // The regression guard that matters most: this route's behaviour for a
  // bearer token — what CI's read tooling depends on — must not move.
  it('still lists runs for a bearer token, unchanged', async () => {
    ctx = await createTestApp();
    await seedCompleteRun(ctx);
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
  });
});

// The assertion whose failure is a security bug, not a wrong number. A
// session is org-scoped: it may read any run in its own org, and no run
// outside it — across every route a session can reach, not just
// GET /v1/runs/:id.
describe('cross-org isolation on every session-reachable endpoint', () => {
  // A real request name the reference fixture actually produces (see
  // packages/plugin-gatling/test/records.test.ts, and the identical comment
  // in parity-endpoints.integration.test.ts) — the brief's placeholder
  // 'Catalog / List' does not exist here, and a name that doesn't exist
  // would fail the scatter positive control for a fixture reason, not a
  // tenancy one.
  const SCATTER_NAME = 'List Products';

  // The one builder both the negative and positive case call — so the URL
  // SHAPE can never diverge between "must 404" and "must 200"; only the id
  // does. Do not collapse this list to one endpoint: the list is the point,
  // and a future endpoint added here without a tenancy filter is exactly
  // what the negative loop below is meant to catch.
  const endpoints = (id: string): string[] => [
    `/v1/runs/${id}`,
    `/v1/runs/${id}/stats`,
    `/v1/runs/${id}/series?scope=run&name=`,
    `/v1/runs/${id}/errors`,
    `/v1/runs/${id}/distribution?scope=run&name=&family=response_time`,
    `/v1/runs/${id}/users`,
    `/v1/runs/${id}/scatter?name=${encodeURIComponent(SCATTER_NAME)}`,
  ];

  it('404s every endpoint for a run in another org, and 200s the identical URL shape for a run in its own org', async () => {
    ctx = await createTestApp();
    const cookie = await signUpAsOrgMember(ctx, 'cross-org@example.test');

    // Own-org run: really ingested, not seedCompleteRun's bare row.
    // GET .../distribution 404s with no histogram, and the scatter/series
    // URLs need real buckets to mean anything — a bare row would make the
    // positive control fail (or vacuously pass with empty bodies) for a
    // fixture reason, not a tenancy one.
    const ownRunId = await ingestFullRun(ctx);

    // A run in a genuinely different org — created directly via Prisma for
    // the org/project themselves (as parity-endpoints.integration.test.ts's
    // cross-project 404 test does; not a second createTestApp(), which would
    // TRUNCATE the tables this test's own ctx just populated), but REALLY
    // ingested via its own fresh token, exactly like ownRunId above. A bare
    // stub row would make the distribution (and scatter/series) negative
    // cases pass vacuously: distribution 404s on ANY run with no histogram,
    // org filter bug or not, so without real data there that 404 would prove
    // nothing about tenancy — see ingestFullRun's comment.
    const otherOrg = await ctx.prisma.org.create({ data: { slug: 'other-org', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'other-project', name: 'Other Project' },
    });
    const otherToken = await mintIngestTokenFor(ctx, otherOrg.id, otherProject.id);
    const otherRunId = await ingestFullRun(ctx, otherToken);

    // The negative case: every one of the seven URLs, for a run outside
    // org A, with org A's session cookie. Not 200, and not 500 — 404.
    for (const url of endpoints(otherRunId)) {
      const res = await request(ctx.app.getHttpServer()).get(url).set('Cookie', cookie);
      expect(
        res.status,
        `expected 404 across orgs for ${url}, got ${res.status}: ${JSON.stringify(res.body)}`,
      ).toBe(404);
    }

    // The positive control: the identical URL shape, same session, a run
    // that IS in this org. This is what keeps the loop above meaningful —
    // without it, a typo'd or moved URL would 404 for "route doesn't exist"
    // and the negative loop would pass having proven nothing about tenancy.
    for (const url of endpoints(ownRunId)) {
      const res = await request(ctx.app.getHttpServer()).get(url).set('Cookie', cookie);
      expect(
        res.status,
        `expected 200 within org for ${url}, got ${res.status}: ${JSON.stringify(res.body)}`,
      ).toBe(200);
    }
  });

  // Two credential systems that disagree about the same run is the drift
  // this catches. seedCompleteRun's bare row is enough here — the point is
  // that session and token compute the identical body for the identical
  // run, not that the run has rich data.
  it('a session and a project token see identical data for the same run', async () => {
    ctx = await createTestApp();
    const runId = await seedCompleteRun(ctx);
    const cookie = await signUpAsOrgMember(ctx, 'session-token-parity@example.test');

    const viaToken = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(200);
    const viaSession = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`)
      .set('Cookie', cookie)
      .expect(200);
    expect(viaSession.body).toEqual(viaToken.body);
  });
});
