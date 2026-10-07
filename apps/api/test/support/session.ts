import type { INestApplication } from '@nestjs/common';
import type { ProjectRole } from '@perfportal/contracts';
import { OrgMemberRepository, ProjectMemberRepository } from '@perfportal/persistence';
import request from 'supertest';
import { auth } from '../../src/auth/better-auth.instance.js';
import type { TestContext } from './app.js';

/**
 * ═══ SIGN-UP IS CLOSED, SO EVERY ACCOUNT HERE IS CREATED THE WAY AN ADMIN
 * CREATES ONE ═══
 *
 * `emailAndPassword.disableSignUp` refuses `POST /auth/sign-up/email`, which
 * is what these helpers used to call. They create the account with the app's
 * OWN Better Auth instance — the one `mountBetterAuth` serves — through the
 * admin plugin's server-side create. Called with no headers that handler
 * needs no session (it refuses a session-less call only when it carries a
 * request or headers), so a test can mint an admin with nobody signed in,
 * exactly as bootstrap does.
 *
 * Then they sign in over HTTP, because the cookie a test sends has to be one
 * the real `/auth/sign-in/email` issued: a session forged into the database
 * would prove nothing about sign-in itself.
 */
const PASSWORD = 'correct-horse-battery';

/** The admin flag is exactly `user.role === 'admin'`; every other account is `'user'`. */
type AccountRole = 'admin' | 'user';

async function createAccount(email: string, role: AccountRole): Promise<string> {
  const { user } = await auth.api.createUser({ body: { email, password: PASSWORD, name: email, role } });
  return user.id;
}

async function signIn(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/sign-in/email')
    .send({ email, password: PASSWORD });

  const setCookie = res.headers['set-cookie'] as unknown;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof raw !== 'string') {
    throw new Error(
      `sign-in for ${email} did not set a session cookie (status ${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  return raw.split(';')[0] ?? raw;
}

/**
 * An account with NO `org_member` row: the session is real and belongs to
 * nobody's install. Only for the no-membership case.
 */
export async function signInWithoutOrg(app: INestApplication, email: string): Promise<string> {
  await createAccount(email, 'user');
  return signIn(app, email);
}

/**
 * An admin of `ctx.orgId`: sees and does everything in the org. This is what
 * every caller of the old `signUpAsOrgMember` became, because a plain org
 * member used to have full access and an admin is what has it now — so those
 * tests still mean what they meant.
 *
 * To make an admin of ANOTHER org, pass `{ ...ctx, orgId: other.id }`.
 */
export async function signInAsAdmin(ctx: TestContext, email: string): Promise<{ cookie: string; userId: string }> {
  const userId = await createAccount(email, 'admin');
  await new OrgMemberRepository(ctx.prisma).add(userId, ctx.orgId);
  return { cookie: await signIn(ctx.app, email), userId };
}

/**
 * A non-admin member of `ctx.orgId` holding exactly `projects`, each at its
 * role. An empty array is a member of the install who belongs to no project —
 * a real state, and a different one from `signInWithoutOrg`.
 */
export async function signInAsProjectMember(
  ctx: TestContext,
  email: string,
  projects: ReadonlyArray<{ projectId: string; role: ProjectRole }>,
): Promise<{ cookie: string; userId: string }> {
  const userId = await createAccount(email, 'user');
  await new OrgMemberRepository(ctx.prisma).add(userId, ctx.orgId);
  const members = new ProjectMemberRepository(ctx.prisma);
  for (const { projectId, role } of projects) {
    await members.add({ projectId, userId, role, addedBy: null });
  }
  return { cookie: await signIn(ctx.app, email), userId };
}
