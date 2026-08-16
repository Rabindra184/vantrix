import type { INestApplication } from '@nestjs/common';
import { OrgMemberRepository } from '@perfportal/persistence';
import request from 'supertest';
import type { TestContext } from './app.js';

/**
 * Signs up a brand-new user and returns { cookie, userId }. Better Auth's
 * emailAndPassword defaults to auto-sign-in on sign-up (proved directly by
 * the '/auth/*' test in session-auth.integration.test.ts, which checks the
 * cookie is set on sign-up alone), so this needs no separate sign-in call.
 */
export async function signUp(app: INestApplication, email: string): Promise<{ cookie: string; userId: string }> {
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
 * Signs up a brand-new user and returns the session cookie Better Auth
 * issues on sign-up. The user this creates has NO org_member row: use this
 * directly only for the no-membership case. Every other test needs
 * signUpAsOrgMember below.
 */
export async function signUpAndLogin(app: INestApplication, email: string): Promise<string> {
  const { cookie } = await signUp(app, email);
  return cookie;
}

/**
 * signUpAndLogin, plus the org_member row a real member has and a fresh
 * sign-up never gets. createTestApp()'s ctx.orgId is the org every other
 * fixture (tokens, projects) in a test file typically belongs to, so
 * joining it is what makes the session's tenant match a bearer token's.
 */
export async function signUpAsOrgMember(ctx: TestContext, email: string, role = 'member'): Promise<string> {
  const { cookie, userId } = await signUp(ctx.app, email);
  await ctx.app.get(OrgMemberRepository).add(userId, ctx.orgId, role);
  return cookie;
}
