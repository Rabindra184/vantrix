import { randomUUID } from 'node:crypto';
import { UserRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
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
 * that asked; and clears `mustChangePassword`.
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
    const { cookie, email } = await member();

    for (const body of [
      {},
      { currentPassword: TEST_PASSWORD },
      { currentPassword: '', newPassword: NEW_PASSWORD },
      { currentPassword: TEST_PASSWORD, newPassword: 'x'.repeat(7) },
      { currentPassword: TEST_PASSWORD, newPassword: 'x'.repeat(129) },
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
    ]) {
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
