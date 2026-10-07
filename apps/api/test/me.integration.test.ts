import { randomUUID } from 'node:crypto';
import { UserRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisCommands } from '../src/common/redis-commands.js';
import {
  PASSWORD_ATTEMPT_LIMIT,
  PASSWORD_ATTEMPT_WINDOW_SECONDS,
  passwordAttemptKey,
} from '../src/me/password-attempts.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signIn, signInAsProjectMember, TEST_PASSWORD } from './support/session.js';

/*
 * ═══ PUT /v1/me/password: CHANGE YOUR OWN PASSWORD ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 3,
 * "Own password")
 *
 * Used by the account menu and by the first-sign-in step. It changes the
 * password through Better Auth's own `changePassword`, which checks the
 * current one; ends every OTHER session the person holds, keeping the one
 * that asked; and clears `mustChangePassword`. It is throttled per account,
 * and it is the only way in: Better Auth's own `/auth/change-password` 404s.
 */

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const NEW_PASSWORD = 'a-password-of-their-own';

async function member(): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `me-${randomUUID()}@example.test`;
  const { cookie, userId } = await signInAsProjectMember(ctx, email, [{ projectId: ctx.projectId, role: 'viewer' }]);
  return { cookie, userId, email };
}

function change(cookie: string, body: object) {
  return request(ctx.app.getHttpServer()).put('/v1/me/password').set('Cookie', cookie).send(body);
}

async function flagOf(userId: string): Promise<boolean> {
  const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mustChangePassword: true } });
  return row.mustChangePassword;
}

/**
 * Ends `userId`'s throttle window now, as its TTL would: for a case that sends
 * more attempts than one window allows for a reason that is not the throttle.
 */
async function endWindow(userId: string): Promise<void> {
  await ctx.app.get(RedisCommands).client.del(passwordAttemptKey(userId));
}

/** Whether `password` signs `email` in, read off the real sign-in route. */
async function signsIn(email: string, password: string): Promise<boolean> {
  const res = await request(ctx.app.getHttpServer()).post('/auth/sign-in/email').send({ email, password });
  return res.status === 200;
}

describe('PUT /v1/me/password', () => {
  it('changes the password with the right current one, answers 204, and clears the flag', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    const res = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect([res.status, res.text]).toEqual([204, '']);

    expect(await flagOf(userId)).toBe(false);
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
    expect(await signsIn(email, TEST_PASSWORD)).toBe(false);
  });

  /**
   * Better Auth's own `revokeOtherSessions` option on `changePassword`
   * deletes EVERY session, the asking one included, and hands back a new
   * cookie — which this route's 204 would drop. So the handler keeps the
   * asking session and ends the rest, and this is the case that tells the two
   * apart: the other cookie is dead, this one still works.
   */
  it('ends the person’s other sessions and keeps the one that asked', async () => {
    ctx = await createTestApp();
    const { cookie: here, userId, email } = await member();
    const elsewhere = await signIn(ctx.app, email);
    const server = ctx.app.getHttpServer();
    await request(server).get('/v1/projects').set('Cookie', elsewhere).expect(200);
    expect(await ctx.prisma.session.count({ where: { userId } })).toBe(2);

    await change(here, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);

    await request(server).get('/v1/projects').set('Cookie', elsewhere).expect(401);
    await request(server).get('/v1/projects').set('Cookie', here).expect(200);
    expect(await ctx.prisma.session.count({ where: { userId } })).toBe(1);
  });

  it('refuses a wrong current password 400 INVALID_CURRENT_PASSWORD, and changes nothing', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    const res = await change(cookie, { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });
    expect([res.status, res.body]).toEqual([
      400,
      expect.objectContaining({
        code: 'INVALID_CURRENT_PASSWORD',
        detail: 'The current password is not correct.',
        remediation: 'Type the password you signed in with.',
      }),
    ]);
    expect(await flagOf(userId)).toBe(true);
    expect(await signsIn(email, TEST_PASSWORD)).toBe(true);
  });

  /**
   * Better Auth does not refuse a new password equal to the current one; the
   * request schema does. Equal AND too short reports the length issue first
   * in zod's list, and the answer is still PASSWORD_UNCHANGED — the second
   * pair below — because the handler finds that issue by its code, not by
   * position.
   */
  it('refuses a new password equal to the current one 400 PASSWORD_UNCHANGED', async () => {
    ctx = await createTestApp();
    const { cookie, userId } = await member();
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    for (const same of [TEST_PASSWORD, 'short']) {
      const res = await change(cookie, { currentPassword: same, newPassword: same });
      expect([res.status, res.body], `"${same}"`).toEqual([
        400,
        expect.objectContaining({
          code: 'PASSWORD_UNCHANGED',
          detail: 'The new password is the same as the current one.',
          remediation: 'Choose a different password.',
        }),
      ]);
    }
    expect(await flagOf(userId)).toBe(true);
  });

  it('refuses a body outside the bounds 400 INVALID_PASSWORD_REQUEST', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();

    for (const body of [
      {},
      { currentPassword: TEST_PASSWORD },
      { currentPassword: '', newPassword: NEW_PASSWORD },
      { currentPassword: TEST_PASSWORD, newPassword: 'x'.repeat(7) },
      { currentPassword: TEST_PASSWORD, newPassword: 'x'.repeat(129) },
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
    ]) {
      // Six bodies is more than one window allows; this case is about the bodies.
      await endWindow(userId);
      const res = await change(cookie, body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_PASSWORD_REQUEST']);
    }
    expect(await signsIn(email, TEST_PASSWORD)).toBe(true);
  });

  it('refuses a bearer token 403 — only a person changes their own password', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .put('/v1/me/password')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
    expect(res.body.detail).toMatch(/signed-in person/);
  });
});

/*
 * ═══ THROTTLED PER ACCOUNT ═══
 *
 * A wrong current password answers 400 and a right one 204, so the route is
 * an oracle for the plaintext password to anyone holding the cookie. Better
 * Auth's own limiter does not cover it — `auth.api.*` skips the router it
 * runs in — so the route counts every call per account, and the 4th within a
 * window answers 429 before any password is hashed.
 */
describe('PUT /v1/me/password, throttled', () => {
  it('refuses the 4th attempt within the window 429 RATE_LIMITED with a Retry-After, even with the right password', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();

    for (let i = 0; i < PASSWORD_ATTEMPT_LIMIT; i += 1) {
      const res = await change(cookie, { currentPassword: `wrong-guess-${i}`, newPassword: NEW_PASSWORD });
      expect([res.status, res.body.code], `attempt ${i + 1}`).toEqual([400, 'INVALID_CURRENT_PASSWORD']);
    }
    const refused = await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect([refused.status, refused.body]).toEqual([
      429,
      expect.objectContaining({
        code: 'RATE_LIMITED',
        detail: 'Too many password attempts.',
        remediation: 'Wait a few seconds and try again.',
      }),
    ]);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(PASSWORD_ATTEMPT_WINDOW_SECONDS);
    // Refused before the password was checked: it is still the old one.
    expect(await signsIn(email, TEST_PASSWORD)).toBe(true);
    // And the window does end: the counter carries an expiry within it.
    const ttl = await ctx.app.get(RedisCommands).client.ttl(passwordAttemptKey(userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PASSWORD_ATTEMPT_WINDOW_SECONDS);
  });

  /**
   * The window's end is the key's expiry, asserted above; it is brought
   * forward here by deleting the key rather than by sleeping ten seconds.
   */
  it('counts afresh once the window ends, and the right password then succeeds', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();
    for (let i = 0; i < PASSWORD_ATTEMPT_LIMIT; i += 1) {
      await change(cookie, { currentPassword: `wrong-guess-${i}`, newPassword: NEW_PASSWORD }).expect(400);
    }
    await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(429);

    await endWindow(userId);

    await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
  });

  it('throttles one account without touching another', async () => {
    ctx = await createTestApp();
    const one = await member();
    const other = await member();
    for (let i = 0; i < PASSWORD_ATTEMPT_LIMIT; i += 1) {
      await change(one.cookie, { currentPassword: `wrong-guess-${i}`, newPassword: NEW_PASSWORD }).expect(400);
    }
    await change(one.cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(429);

    await change(other.cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
  });
});

/*
 * ═══ THE ONLY WAY TO CHANGE ONE'S OWN PASSWORD ═══
 *
 * Better Auth's own `POST /auth/change-password` skips the unchanged-password
 * rule, the throttle and the flag, so it answers 404 over HTTP
 * (`refuseServerOnlyRoutes` in createAuth). The route above calls the same
 * endpoint server-side, which skips the router where that refusal runs, and
 * still works. session-auth.integration.test.ts drives the path spellings.
 */
describe('Better Auth’s own /auth/change-password', () => {
  it('answers 404 to a valid session and changes nothing, while PUT /v1/me/password still changes it', async () => {
    ctx = await createTestApp();
    const { cookie, userId, email } = await member();
    await new UserRepository(ctx.prisma).setMustChangePassword(userId, true);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(404);
    expect(await signsIn(email, TEST_PASSWORD)).toBe(true);
    expect(await flagOf(userId)).toBe(true);

    await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(204);
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
    expect(await flagOf(userId)).toBe(false);
  });
});
