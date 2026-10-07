import { randomUUID } from 'node:crypto';
import { UserRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember } from './support/session.js';

/*
 * ═══ A SESSION THAT MUST CHANGE ITS PASSWORD REACHES NOTHING ELSE ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 3,
 * "First sign-in")
 *
 * An account an admin created or reset carries `user.mustChangePassword`.
 * Until its owner chooses a password, every `/v1` route answers 403
 * PASSWORD_CHANGE_REQUIRED except `PUT /v1/me/password`. The gate is
 * `PasswordChangeGuard`, a global guard between `AuthGuard` and
 * `AccessGuard`, so the cases below are chosen to tell it from the guard after
 * it: an invisible project, a missing one and an admin action each get
 * AccessGuard's own answer from an unflagged session, and the gate's answer
 * from a flagged one.
 *
 * The flag is set with `UserRepository.setMustChangePassword` on a session
 * that already exists — the state an admin's reset leaves an open session in
 * (the reset itself ends sessions, but nothing in the gate may rely on that).
 */

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const GATE = {
  status: 403,
  code: 'PASSWORD_CHANGE_REQUIRED',
  detail: 'Choose a new password before doing anything else.',
  remediation: 'Change it with PUT /v1/me/password.',
};

type Verb = 'get' | 'post' | 'put';

function send(verb: Verb, path: string, cookie: string, body?: object): request.Test {
  const req = request(ctx.app.getHttpServer())[verb](path).set('Cookie', cookie);
  return body === undefined ? req : req.send(body);
}

/** The body without its per-request traceId, for comparing two answers. */
function withoutTrace(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.traceId;
  return rest;
}

describe('the password gate', () => {
  /**
   * One route of each kind: a `@Requires` project route, a run route (whose
   * project comes from the run), a `@NotProjectScoped` list, and an admin
   * action. The caller is an ADMIN, who passes AccessGuard on every one of
   * them, so the only thing left to refuse them is the gate. `POST
   * /v1/projects` stands in for the admin action until `GET /v1/admin/users`
   * exists.
   */
  it('refuses a flagged session 403 PASSWORD_CHANGE_REQUIRED on every kind of route, and an unflagged one nowhere', async () => {
    ctx = await createTestApp();
    const { cookie, userId } = await signInAsAdmin(ctx, `gate-admin-${randomUUID()}@example.test`);
    const routes: ReadonlyArray<[Verb, string, object?]> = [
      ['get', '/v1/projects/checkout/tests'],
      ['get', `/v1/runs/${randomUUID()}`],
      ['get', '/v1/projects'],
      // An empty body, so the unflagged pass creates nothing: the admin passes
      // AccessGuard and meets the handler's own 400.
      ['post', '/v1/projects', {}],
    ];

    // Unflagged first: none of these is refused by the gate, so the refusal
    // below is the flag's and nothing else's.
    for (const [verb, path, body] of routes) {
      const res = await send(verb, path, cookie, body);
      expect(res.body.code, `${verb.toUpperCase()} ${path} before the flag`).not.toBe(GATE.code);
    }

    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    for (const [verb, path, body] of routes) {
      const res = await send(verb, path, cookie, body);
      expect([res.status, withoutTrace(res.body)], `${verb.toUpperCase()} ${path}`).toEqual([
        403,
        expect.objectContaining(GATE),
      ]);
    }
  });

  /**
   * THE GATE RUNS BEFORE AccessGuard, and this is the case that says so. A
   * non-admin asking about a project it cannot see, a project that does not
   * exist, or for an admin action, gets AccessGuard's 404 or ADMIN_REQUIRED
   * — answers that tell it which projects exist and what it may do. Flagged,
   * all three get the gate's one body, identical but for traceId: a person
   * who has not yet chosen a password learns nothing about the install.
   */
  it('answers a flagged non-admin before AccessGuard can say anything about a project', async () => {
    ctx = await createTestApp();
    await ctx.prisma.project.create({ data: { orgId: ctx.orgId, slug: 'search', name: 'Search' } });
    const { cookie, userId } = await signInAsProjectMember(ctx, `gate-member-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'viewer' },
    ]);
    const routes: ReadonlyArray<[Verb, string, object?, number?, string?]> = [
      ['get', '/v1/projects/search/tests', undefined, 404, 'NOT_FOUND'],
      ['get', '/v1/projects/no-such-project/tests', undefined, 404, 'NOT_FOUND'],
      ['post', '/v1/projects', { name: 'Gate', slug: 'gate' }, 403, 'ADMIN_REQUIRED'],
    ];

    for (const [verb, path, body, status, code] of routes) {
      const res = await send(verb, path, cookie, body);
      expect([res.status, res.body.code], `${verb.toUpperCase()} ${path} before the flag`).toEqual([status, code]);
    }

    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    const answers = [];
    for (const [verb, path, body] of routes) {
      const res = await send(verb, path, cookie, body);
      expect(res.status, `${verb.toUpperCase()} ${path}`).toBe(403);
      answers.push(withoutTrace(res.body));
    }
    expect(answers[0]).toMatchObject(GATE);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('leaves PUT /v1/me/password reachable, and lifts itself once the password is changed', async () => {
    ctx = await createTestApp();
    const { cookie, userId } = await signInAsProjectMember(ctx, `gate-change-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'viewer' },
    ]);
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);
    expect((await send('get', '/v1/projects', cookie)).body.code).toBe(GATE.code);

    // The route's own validation answers, which means the gate let it through.
    const invalid = await send('put', '/v1/me/password', cookie, {});
    expect([invalid.status, invalid.body.code]).toEqual([400, 'INVALID_PASSWORD_REQUEST']);

    await send('put', '/v1/me/password', cookie, {
      currentPassword: 'correct-horse-battery',
      newPassword: 'a-password-of-their-own',
    }).expect(204);
    await send('get', '/v1/projects', cookie).expect(200);
  });

  /**
   * A bearer token names nobody, so it carries no flag and the gate never
   * judges it. Asserted while a flagged session of the same org exists, on a
   * route the flagged session is refused.
   */
  it('does not touch a bearer token', async () => {
    ctx = await createTestApp();
    const { cookie, userId } = await signInAsAdmin(ctx, `gate-bearer-${randomUUID()}@example.test`);
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    expect((await send('get', '/v1/projects/checkout/tests', cookie)).body.code).toBe(GATE.code);
    await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/tests')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .expect(200);
  });
});

/*
 * ═══ A DISABLED ACCOUNT'S SURVIVING SESSION ANSWERS 401 ═══
 * (Review Focus 5, second half)
 *
 * The admin plugin's own ban deletes a person's sessions, but Better Auth's
 * `getSession` does not read `user.banned`: a ban written any other way — or a
 * session row that outlived one — would go on working. `authenticateSession`
 * refuses it, through the same 401 a missing cookie gets.
 */
describe('a disabled account', () => {
  it('is refused 401 on its surviving session, with the 401 every session refusal carries', async () => {
    ctx = await createTestApp();
    const { cookie, userId } = await signInAsAdmin(ctx, `disabled-${randomUUID()}@example.test`);
    const server = ctx.app.getHttpServer();
    await request(server).get('/v1/projects').set('Cookie', cookie).expect(200);

    await ctx.prisma.user.update({ where: { id: userId }, data: { banned: true } });
    // The session row is still there: what refuses it below is the ban, not
    // its absence.
    expect(await ctx.prisma.session.count({ where: { userId } })).toBeGreaterThan(0);

    const noCookie = await request(server).get('/v1/projects');
    expect(noCookie.status).toBe(401);
    for (const [verb, path] of [
      ['get', '/v1/projects'],
      ['put', '/v1/me/password'],
    ] as const) {
      const res = await send(verb, path, cookie, verb === 'put' ? {} : undefined);
      expect([res.status, res.body], `${verb.toUpperCase()} ${path}`).toEqual([
        401,
        { ...noCookie.body, detail: 'This account is disabled.' },
      ]);
    }
  });
});
