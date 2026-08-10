import type { INestApplication } from '@nestjs/common';
import { OrgMemberRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
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
    expect(res.body.code).toBe('PROJECT_REQUIRED');
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
