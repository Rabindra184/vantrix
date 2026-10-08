import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AdminProjectListResponseSchema,
  AdminUserListResponseSchema,
  AdminUserSchema,
} from '@perfportal/contracts';
import {
  adminLockKey,
  createPrisma,
  OrgMemberRepository,
  ProjectMemberRepository,
  UserRepository,
} from '@perfportal/persistence';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/auth/better-auth.instance.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signIn, signInAsAdmin, signInAsProjectMember, TEST_PASSWORD } from './support/session.js';

/*
 * ═══ /v1/admin: AN ADMIN MANAGES EVERY ACCOUNT, AND SEES EVERY PROJECT ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 3)
 *
 * Every route here is `users:manage`: `AccessGuard` lets an admin's session
 * through and refuses anyone else's ADMIN_REQUIRED, which the role matrix in
 * access-routes.integration.test.ts pins. What is checked here is what an
 * admin who IS let through gets: each change read back from the database and
 * from Better Auth's own `GET /auth/get-session`, the refusals the routes
 * themselves send, and the four Review Focus properties this task owns —
 * a reset or a disable ends the person's sessions now (5), the last active
 * admin cannot be taken out even by two admins at once (2), another org's
 * account or one in no org answers 404 and does not change (3), and a create
 * that fails after the account exists leaves no account behind (4).
 */

let ctx: TestContext;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.close();
});

/** A temporary password an admin types for someone else. */
const TEMPORARY = 'temporary-pass-1';

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * A DEADLINE ON EVERY REQUEST: a request queued behind the admin lock does
 * not fail when something is wrong, it waits — and a wait with no deadline
 * takes the file's whole timeout with it.
 */
function api(verb: Verb, path: string, cookie: string, body?: object): request.Test {
  const req = request(ctx.app.getHttpServer())[verb](path)
    .set('Cookie', cookie)
    .timeout({ deadline: 60_000, response: 60_000 });
  return body === undefined ? req : req.send(body);
}

const email = (who: string): string => `${who}-${randomUUID().slice(0, 8)}@example.test`;

/**
 * An account made the way bootstrap makes one — the admin plugin's headless
 * create — joined to `orgId`, or to no org at all when it is null.
 */
async function account(address: string, role: 'admin' | 'user', orgId: string | null): Promise<string> {
  const { user } = await auth.api.createUser({ body: { email: address, password: TEST_PASSWORD, name: address, role } });
  if (orgId !== null) await new OrgMemberRepository(ctx.prisma).add(user.id, orgId);
  return user.id;
}

async function otherOrg(): Promise<string> {
  const org = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
  return org.id;
}

/** Whether `password` signs `address` in, read off the real sign-in route. */
async function signInStatus(address: string, password: string): Promise<request.Response> {
  return request(ctx.app.getHttpServer()).post('/auth/sign-in/email').send({ email: address, password });
}

/** The session Better Auth itself reports for a cookie. */
async function sessionOf(cookie: string): Promise<{ user: Record<string, unknown> } | null> {
  const res = await request(ctx.app.getHttpServer()).get('/auth/get-session').set('Cookie', cookie).expect(200);
  return res.body as { user: Record<string, unknown> } | null;
}

/** Everything about an account a route could change, for "nothing changed" checks. */
async function snapshot(userId: string): Promise<unknown> {
  return {
    user: await ctx.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, role: true, banned: true, mustChangePassword: true, updatedAt: true },
    }),
    passwords: (await ctx.prisma.account.findMany({ where: { userId }, select: { password: true } })).map((a) => a.password),
    sessions: await ctx.prisma.session.count({ where: { userId } }),
    orgs: (await ctx.prisma.orgMember.findMany({ where: { userId }, select: { orgId: true } })).map((m) => m.orgId),
    projects: await ctx.prisma.projectMember.count({ where: { userId } }),
  };
}

async function usersWithEmail(address: string): Promise<number> {
  const rows = await ctx.prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "user" WHERE lower(email) = lower(${address})
  `;
  return rows[0]?.n ?? 0;
}

async function seedRun(): Promise<string> {
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status: 'complete',
      verdict: 'not_evaluated',
      tool: 'gatling',
      bundleKey: `runs/${ctx.projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-10-07T09:00:00Z'),
      startedOn: new Date('2026-10-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * How many backends are queued behind `holderPid`, directly or behind another
 * waiter — the waiters on one advisory lock queue behind each other as well
 * as behind its holder.
 */
async function queuedBehind(holderPid: number): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(
    `WITH RECURSIVE queued(pid) AS (
       SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
       UNION
       SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY (pg_blocking_pids(a.pid))
     )
     SELECT count(*)::int AS n FROM queued`,
    [holderPid],
  );
  return rows[0]!.n;
}

/**
 * Sends a request while a raw connection holds the org's admin lock, waits
 * until it is OBSERVED queued behind that holder, runs `meanwhile`, and only
 * then lets go — so `meanwhile`'s change is committed before the request's
 * own check runs, which is exactly the state another admin's change leaves a
 * queued request in. Forced, never raced: nothing here sleeps.
 */
async function whileQueued(
  send: () => request.Test,
  meanwhile: () => Promise<void>,
): Promise<request.Response> {
  const holder = await ctx.pool.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holderPid = rows[0]!.pid;
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [adminLockKey(ctx.orgId).toString()]);

    let settled = false;
    pending = send().then((res) => {
      settled = true;
      return res;
    });
    await waitUntil('the request to queue behind the held admin lock', async () => {
      if (settled) throw new Error('the request finished while another connection held the admin lock');
      return (await queuedBehind(holderPid)) === 1;
    });

    await meanwhile();
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [adminLockKey(ctx.orgId).toString()]);
    return await pending;
  } finally {
    await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    holder.release();
    if (pending) await Promise.allSettled([pending]);
  }
}

const LAST_ADMIN = {
  code: 'LAST_ADMIN',
  detail: 'This is the last active admin, so the install would have none.',
  remediation: 'Make someone else an admin first.',
};

describe('GET /v1/admin/users', () => {
  it('lists every account in the org, with its flags and memberships, and none outside it', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const viewer = await signInAsProjectMember(ctx, email('viewer'), [{ projectId: ctx.projectId, role: 'viewer' }]);
    const disabledId = await account(email('disabled'), 'user', ctx.orgId);
    await ctx.prisma.user.update({ where: { id: disabledId }, data: { banned: true } });
    const flaggedId = await account(email('flagged'), 'user', ctx.orgId);
    await new UserRepository(ctx.prisma).setMustChangePassword(flaggedId, true);
    const outsiderId = await account(email('outsider'), 'admin', await otherOrg());
    const orphanId = await account(email('orphan'), 'user', null);

    const res = await api('get', '/v1/admin/users', admin.cookie).expect(200);
    const { users } = AdminUserListResponseSchema.parse(res.body);
    const byId = new Map(users.map((u) => [u.id, u]));

    expect([...byId.keys()].sort()).toEqual([admin.userId, viewer.userId, disabledId, flaggedId].sort());
    expect(byId.has(outsiderId) || byId.has(orphanId)).toBe(false);
    expect(byId.get(admin.userId)).toMatchObject({ isAdmin: true, disabled: false, mustChangePassword: false, memberships: [] });
    expect(byId.get(viewer.userId)).toMatchObject({
      isAdmin: false,
      disabled: false,
      memberships: [{ projectSlug: 'checkout', projectName: 'Checkout', role: 'viewer' }],
    });
    expect(byId.get(disabledId)).toMatchObject({ disabled: true, isAdmin: false });
    expect(byId.get(flaggedId)).toMatchObject({ mustChangePassword: true });
  });

  it('refuses a bearer token, whatever its scopes', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
  });
});

describe('GET /v1/admin/projects', () => {
  it('lists every project in the org by name, with how many people hold a role in each', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const alpha = await ctx.prisma.project.create({ data: { orgId: ctx.orgId, slug: 'alpha', name: 'Alpha' } });
    await signInAsProjectMember(ctx, email('viewer'), [{ projectId: ctx.projectId, role: 'viewer' }]);
    await signInAsProjectMember(ctx, email('manager'), [{ projectId: ctx.projectId, role: 'manager' }]);
    const elsewhere = await otherOrg();
    await ctx.prisma.project.create({ data: { orgId: elsewhere, slug: 'aardvark', name: 'Aardvark' } });

    const res = await api('get', '/v1/admin/projects', admin.cookie).expect(200);
    const { projects } = AdminProjectListResponseSchema.parse(res.body);
    const checkout = await ctx.prisma.project.findUniqueOrThrow({ where: { id: ctx.projectId } });
    expect(projects).toEqual([
      { slug: 'alpha', name: 'Alpha', memberCount: 0, createdAt: alpha.createdAt.toISOString() },
      { slug: 'checkout', name: 'Checkout', memberCount: 2, createdAt: checkout.createdAt.toISOString() },
    ]);
  });
});

describe('POST /v1/admin/users', () => {
  it('creates an account that must choose its password, in the org, with its project roles', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('New.Person');
    const typed = `  ${address.toUpperCase()} `;
    const createUser = vi.spyOn(auth.api, 'createUser');

    const res = await api('post', '/v1/admin/users', admin.cookie, {
      email: typed,
      name: 'New Person',
      password: TEMPORARY,
      projects: [{ projectSlug: 'checkout', role: 'member' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = AdminUserSchema.parse(res.body);
    // The id is chosen before Better Auth writes anything, so a compensation
    // can delete exactly it. Better Auth must keep it: an upgrade that stops
    // doing so fails here, by name, rather than in a compensation aimed at an
    // id nothing holds.
    expect(createUser).toHaveBeenCalledTimes(1);
    const supplied = (createUser.mock.calls[0]?.[0] as { body: { data?: { id?: unknown } } }).body.data?.id;
    expect(typeof supplied).toBe('string');
    expect(created.id).toBe(supplied);
    expect(created).toMatchObject({
      email: address.toLowerCase(),
      name: 'New Person',
      isAdmin: false,
      disabled: false,
      mustChangePassword: true,
      memberships: [{ projectSlug: 'checkout', projectName: 'Checkout', role: 'member' }],
    });

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect([row.email, row.role, row.mustChangePassword, row.banned]).toEqual([address.toLowerCase(), 'user', true, false]);
    expect(await ctx.prisma.orgMember.findMany({ where: { userId: created.id }, select: { orgId: true } })).toEqual([
      { orgId: ctx.orgId },
    ]);
    expect(
      await ctx.prisma.projectMember.findMany({
        where: { userId: created.id },
        select: { projectId: true, role: true, addedBy: true },
      }),
    ).toEqual([{ projectId: ctx.projectId, role: 'member', addedBy: admin.userId }]);

    // Better Auth's own view of the account, through the person's own sign-in.
    const cookie = await signIn(ctx.app, address.toLowerCase(), TEMPORARY);
    const session = await sessionOf(cookie);
    expect(session?.user).toMatchObject({ id: created.id, role: 'user', mustChangePassword: true });
  });

  it('creates an admin when asked, and only then', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('second-admin');

    const res = await api('post', '/v1/admin/users', admin.cookie, {
      email: address,
      name: 'Second Admin',
      password: TEMPORARY,
      isAdmin: true,
    }).expect(201);
    expect(AdminUserSchema.parse(res.body)).toMatchObject({ isAdmin: true, mustChangePassword: true, memberships: [] });

    const cookie = await signIn(ctx.app, address, TEMPORARY);
    expect((await sessionOf(cookie))?.user).toMatchObject({ role: 'admin', mustChangePassword: true });
  });

  /**
   * Review Focus 1 from the created person's side: the account the admin just
   * made reaches nothing until its owner has chosen a password, and then
   * reaches what its role allows.
   */
  it('lets the created person sign in, refuses them every /v1 route until they choose a password, and not after', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('first-sign-in');
    await api('post', '/v1/admin/users', admin.cookie, {
      email: address,
      name: 'First Sign In',
      password: TEMPORARY,
      projects: [{ projectSlug: 'checkout', role: 'viewer' }],
    }).expect(201);

    const cookie = await signIn(ctx.app, address, TEMPORARY);
    for (const [verb, path] of [
      ['get', '/v1/projects'],
      ['get', '/v1/projects/checkout/tests'],
      ['get', '/v1/runs'],
      ['get', '/v1/admin/users'],
    ] as const) {
      const res = await api(verb, path, cookie);
      expect([res.status, res.body.code], path).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
    }

    await api('put', '/v1/me/password', cookie, { currentPassword: TEMPORARY, newPassword: 'chosen-by-them-1' }).expect(204);

    const projects = await api('get', '/v1/projects', cookie).expect(200);
    expect(projects.body.items).toEqual([expect.objectContaining({ slug: 'checkout', role: 'viewer' })]);
    expect((await api('get', '/v1/admin/users', cookie)).body.code).toBe('ADMIN_REQUIRED');
  });

  it('refuses an email already in use, in any letter case and in any org, 409 EMAIL_TAKEN', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const here = email('taken');
    const there = email('taken-elsewhere');
    await account(here, 'user', ctx.orgId);
    await account(there, 'user', await otherOrg());

    for (const address of [here.toUpperCase(), there]) {
      const res = await api('post', '/v1/admin/users', admin.cookie, { email: address, name: 'Dup', password: TEMPORARY });
      expect([res.status, res.body], address).toEqual([
        409,
        expect.objectContaining({
          code: 'EMAIL_TAKEN',
          detail: `An account with ${address.toLowerCase()} already exists.`,
          remediation: 'Use another email.',
        }),
      ]);
      expect(await usersWithEmail(address)).toBe(1);
    }
  });

  /**
   * The check before the create can be beaten by a create that lands between
   * the two. Better Auth then refuses the duplicate itself, and that refusal
   * must read as the same 409 — the gap is opened here by letting the check
   * miss the account that already exists.
   */
  it('answers Better Auth’s own duplicate refusal with the same 409', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('raced');
    await account(address, 'user', ctx.orgId);
    vi.spyOn(UserRepository.prototype, 'findByEmail').mockResolvedValueOnce(null);

    const res = await api('post', '/v1/admin/users', admin.cookie, { email: address, name: 'Raced', password: TEMPORARY });
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([409, 'EMAIL_TAKEN']);
    expect(await usersWithEmail(address)).toBe(1);
  });

  /**
   * Two creates of one address at the same moment both pass both checks —
   * ours and Better Auth's read before its INSERT — and the unique index on
   * `user.email` is what decides. The other create is a raw transaction here,
   * its INSERT made and held uncommitted: this request's INSERT is OBSERVED
   * waiting on it, and when it commits, this one is refused by the index.
   * That refusal is the same 409 as any taken address, never a 500.
   */
  it('answers a create that loses the race for an address 409 EMAIL_TAKEN', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('raced-insert');
    const holder = await ctx.pool.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = rows[0]!.pid;
      await holder.query('BEGIN');
      await holder.query('INSERT INTO "user" (id, name, email, "updatedAt") VALUES ($1, $2, $3, now())', [
        `other-${randomUUID()}`,
        'The Other Create',
        address,
      ]);

      let settled = false;
      pending = api('post', '/v1/admin/users', admin.cookie, { email: address, name: 'Raced', password: TEMPORARY }).then(
        (res) => {
          settled = true;
          return res;
        },
      );
      await waitUntil('the create’s INSERT to wait on the uncommitted one', async () => {
        if (settled) throw new Error('the create finished while another INSERT of its address was uncommitted');
        return (await queuedBehind(holderPid)) === 1;
      });
      await holder.query('COMMIT');

      const res = await pending;
      expect([res.status, res.body], JSON.stringify(res.body)).toEqual([
        409,
        expect.objectContaining({ code: 'EMAIL_TAKEN', detail: `An account with ${address} already exists.` }),
      ]);
      expect(await usersWithEmail(address)).toBe(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  it('refuses a project the org does not hold 400 UNKNOWN_PROJECT, naming it, and leaves no account', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const elsewhere = await otherOrg();
    await ctx.prisma.project.create({ data: { orgId: elsewhere, slug: 'theirs', name: 'Theirs' } });

    for (const slug of ['no-such-project', 'theirs']) {
      const address = email('unknown-project');
      const res = await api('post', '/v1/admin/users', admin.cookie, {
        email: address,
        name: 'Unknown Project',
        password: TEMPORARY,
        projects: [
          { projectSlug: 'checkout', role: 'viewer' },
          { projectSlug: slug, role: 'member' },
        ],
      });
      expect([res.status, res.body], slug).toEqual([
        400,
        expect.objectContaining({
          code: 'UNKNOWN_PROJECT',
          detail: `No project "${slug}" in this organisation.`,
          remediation: 'List the projects with GET /v1/admin/projects.',
        }),
      ]);
      expect(await usersWithEmail(address), slug).toBe(0);
    }
  });

  it('refuses a body the schema refuses 400 INVALID_USER_REQUEST, and creates nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('short-password');
    const res = await api('post', '/v1/admin/users', admin.cookie, { email: address, name: 'Short', password: 'seven77' });
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_USER_REQUEST']);
    expect(res.body.detail).toContain('password');
    expect(await usersWithEmail(address)).toBe(0);
  });

  /**
   * Review Focus 4. The account exists once Better Auth's create returns; the
   * memberships come after it, in a transaction of their own. Made to fail
   * there, once, the create must leave no account — or the retry an admin
   * naturally makes would be refused EMAIL_TAKEN by the half-made one. The
   * retry upper-cases the address: the account is matched ignoring case, so a
   * leftover would refuse it as surely as the same spelling.
   */
  it('removes the account when a later step fails, so a retry with the same email succeeds', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('compensated');
    const add = vi
      .spyOn(ProjectMemberRepository.prototype, 'add')
      .mockRejectedValueOnce(new Error('the membership insert failed'));

    const failed = await api('post', '/v1/admin/users', admin.cookie, {
      email: address,
      name: 'Compensated',
      password: TEMPORARY,
      projects: [{ projectSlug: 'checkout', role: 'viewer' }],
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    expect(add).toHaveBeenCalledTimes(1);
    // Read before the retry, asserted together with it, so a leftover account
    // reports both what it is and what it costs: the retry's EMAIL_TAKEN.
    const leftover = await usersWithEmail(address);

    const retry = await api('post', '/v1/admin/users', admin.cookie, {
      email: address.toUpperCase(),
      name: 'Compensated',
      password: TEMPORARY,
      projects: [{ projectSlug: 'checkout', role: 'viewer' }],
    });
    expect({ leftover, retry: [retry.status, retry.body.code] }).toEqual({ leftover: 0, retry: [201, undefined] });
    expect(AdminUserSchema.parse(retry.body).memberships).toEqual([
      { projectSlug: 'checkout', projectName: 'Checkout', role: 'viewer' },
    ]);
  });
});

/**
 * Review Focus 4, the other place a create can fail: INSIDE Better Auth's
 * `createUser`, after it has written the user and before its credential
 * account. A trigger refuses that account INSERT, for this address alone and
 * once. The create must leave no user behind — the id it supplied is the one
 * deleted — and the admin's retry, the address upper-cased, must succeed.
 */
describe('a create that fails inside Better Auth', () => {
  it('removes the half-written account, so a retry with the same email succeeds', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('half-written');
    const trigger = `refuse_account_${randomUUID().replaceAll('-', '')}`;
    let failed: request.Response;
    try {
      // The address is test-made ([a-z-] and hex), so it is safe to write into the function body.
      await ctx.pool.query(`
        CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF EXISTS (SELECT 1 FROM "user" WHERE id = NEW."userId" AND email = '${address}') THEN
            RAISE EXCEPTION 'account insert refused for the test';
          END IF;
          RETURN NEW;
        END
        $fn$`);
      await ctx.pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);

      failed = await api('post', '/v1/admin/users', admin.cookie, {
        email: address,
        name: 'Half Written',
        password: TEMPORARY,
        projects: [{ projectSlug: 'checkout', role: 'viewer' }],
      });
    } finally {
      await ctx.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON account`);
      await ctx.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    const leftover = await usersWithEmail(address);

    const retry = await api('post', '/v1/admin/users', admin.cookie, {
      email: address.toUpperCase(),
      name: 'Half Written',
      password: TEMPORARY,
      projects: [{ projectSlug: 'checkout', role: 'viewer' }],
    });
    expect({ leftover, retry: [retry.status, retry.body.code] }).toEqual({ leftover: 0, retry: [201, undefined] });
  });
});

describe('PATCH /v1/admin/users/:userId', () => {
  it('renames an account', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('rename'), [{ projectId: ctx.projectId, role: 'viewer' }]);

    const res = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, { name: '  Renamed Person ' }).expect(200);
    expect(AdminUserSchema.parse(res.body)).toMatchObject({ id: target.userId, name: 'Renamed Person' });
    expect((await sessionOf(target.cookie))?.user).toMatchObject({ name: 'Renamed Person' });
  });

  it('makes an account an admin, and takes it away again, effective on their next request', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('promoted'), []);
    expect((await api('get', '/v1/admin/users', target.cookie)).body.code).toBe('ADMIN_REQUIRED');

    const up = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, { isAdmin: true }).expect(200);
    expect(AdminUserSchema.parse(up.body).isAdmin).toBe(true);
    expect((await sessionOf(target.cookie))?.user).toMatchObject({ role: 'admin' });
    await api('get', '/v1/admin/users', target.cookie).expect(200);

    const down = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, { isAdmin: false }).expect(200);
    expect(AdminUserSchema.parse(down.body).isAdmin).toBe(false);
    expect((await sessionOf(target.cookie))?.user).toMatchObject({ role: 'user' });
    expect((await api('get', '/v1/admin/users', target.cookie)).body.code).toBe('ADMIN_REQUIRED');
  });

  /**
   * Review Focus 5. A disable ends the person's sessions at once — the cookie
   * they hold answers 401 on its next request — and refuses their sign-in,
   * in "disabled" words rather than Better Auth's "banned … contact support".
   * Enabling reverses both: they can sign in again, and that session works.
   */
  it('disables an account, ending its sessions and refusing its sign-in, and enables it again', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('disabled');
    const target = await signInAsProjectMember(ctx, address, [{ projectId: ctx.projectId, role: 'viewer' }]);
    await api('get', '/v1/projects', target.cookie).expect(200);

    const off = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, { disabled: true }).expect(200);
    expect(AdminUserSchema.parse(off.body).disabled).toBe(true);
    await api('get', '/v1/projects', target.cookie).expect(401);
    const refused = await signInStatus(address, TEST_PASSWORD);
    expect([refused.status, refused.body.code]).toEqual([403, 'BANNED_USER']);
    expect(refused.body.message).toMatch(/disabled/i);
    expect(refused.body.message).not.toMatch(/banned/i);

    const on = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, { disabled: false }).expect(200);
    expect(AdminUserSchema.parse(on.body).disabled).toBe(false);
    const again = await signIn(ctx.app, address);
    await api('get', '/v1/projects', again).expect(200);
  });

  /**
   * All or nothing. Applied as separate calls, the demotion landed and the
   * enable was then refused 403 — Better Auth re-checking a caller who had
   * just stopped being an admin — leaving half the change made under a
   * refusal. One call applies both.
   */
  it('applies a self PATCH that drops your own admin and enables you, whole', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    await signInAsAdmin(ctx, email('other-admin'));

    const res = await api('patch', `/v1/admin/users/${admin.userId}`, admin.cookie, { isAdmin: false, disabled: false });
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([200, undefined]);
    expect(AdminUserSchema.parse(res.body)).toMatchObject({ isAdmin: false, disabled: false });
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect([row.role, row.banned]).toEqual(['user', false]);
  });

  it('refuses disabling yourself 400 CANNOT_DISABLE_SELF, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    await signInAsAdmin(ctx, email('other-admin'));
    const before = await snapshot(admin.userId);

    const res = await api('patch', `/v1/admin/users/${admin.userId}`, admin.cookie, { disabled: true });
    expect([res.status, res.body]).toEqual([
      400,
      expect.objectContaining({
        code: 'CANNOT_DISABLE_SELF',
        detail: 'You cannot disable your own account.',
        remediation: 'Ask another admin to disable it.',
      }),
    ]);
    expect(await snapshot(admin.userId)).toEqual(before);
    await api('get', '/v1/admin/users', admin.cookie).expect(200);
  });

  it('refuses a body the schema refuses 400 INVALID_USER_UPDATE', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('target'), []);
    for (const body of [{}, { email: 'new@example.test' }, { name: '' }]) {
      const res = await api('patch', `/v1/admin/users/${target.userId}`, admin.cookie, body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_USER_UPDATE']);
    }
  });

  it('refuses the only active admin removing their own admin 409 LAST_ADMIN', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const res = await api('patch', `/v1/admin/users/${admin.userId}`, admin.cookie, { isAdmin: false });
    expect([res.status, res.body]).toEqual([409, expect.objectContaining(LAST_ADMIN)]);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).role).toBe('admin');
  });

  /** "A disabled admin does not count as active" (Review Focus 2). */
  it('does not count a disabled admin as active', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const other = await signInAsAdmin(ctx, email('other-admin'));
    await api('patch', `/v1/admin/users/${other.userId}`, admin.cookie, { disabled: true }).expect(200);

    const res = await api('patch', `/v1/admin/users/${admin.userId}`, admin.cookie, { isAdmin: false });
    expect([res.status, res.body.code]).toEqual([409, 'LAST_ADMIN']);
  });

  /**
   * The count is read UNDER the lock, after whatever the admin change ahead
   * of this one committed. Here the change ahead takes the CALLER's own admin
   * away while their request waits, which leaves the target the last active
   * admin: a demote or a disable of them must now be refused, though the
   * count read before the wait would have allowed it.
   */
  /**
   * The person is re-read UNDER the lock. Here the change queued ahead
   * disables the target, so they are no longer an active admin and a
   * demotion of them takes nobody out: it must go through. A read taken
   * before the wait still sees an active last admin and answers a false 409.
   */
  it('judges the target as they are once the lock is held, not as they were before it', async () => {
    ctx = await createTestApp();
    const caller = await signInAsAdmin(ctx, email('caller'));
    const target = await signInAsAdmin(ctx, email('target'));

    const res = await whileQueued(
      () => api('patch', `/v1/admin/users/${target.userId}`, caller.cookie, { isAdmin: false }),
      async () => {
        await ctx.prisma.user.update({ where: { id: target.userId }, data: { banned: true } });
      },
    );
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([200, undefined]);
    expect(AdminUserSchema.parse(res.body)).toMatchObject({ isAdmin: false, disabled: true });
  });

  for (const [what, body] of [
    ['demote', { isAdmin: false }],
    ['disable', { disabled: true }],
  ] as const) {
    it(`refuses to ${what} the last active admin 409 LAST_ADMIN, counted after the change queued ahead of it`, async () => {
      ctx = await createTestApp();
      const caller = await signInAsAdmin(ctx, email('caller'));
      const target = await signInAsAdmin(ctx, email('target'));
      const before = await snapshot(target.userId);

      const res = await whileQueued(
        () => api('patch', `/v1/admin/users/${target.userId}`, caller.cookie, body),
        async () => {
          await ctx.prisma.user.update({ where: { id: caller.userId }, data: { role: 'user' } });
        },
      );
      expect([res.status, res.body], JSON.stringify(res.body)).toEqual([409, expect.objectContaining(LAST_ADMIN)]);
      expect(await snapshot(target.userId)).toEqual(before);
    });
  }
});

/*
 * ═══ THE CALLER CHANGED WHILE THEIR REQUEST WAITED ═══
 *
 * `AccessGuard` judges the caller once, as the request arrives; Better
 * Auth's admin endpoints judge them again, authoritatively, on every call.
 * Between the two another admin can take the caller's admin away or end
 * their session (a removal or a disable does). Each is answered as it would
 * have been on arrival — ADMIN_REQUIRED, or a 401 — never as a 500, and the
 * account named is untouched.
 */
describe('a caller changed while their request waited', () => {
  it('refuses a caller whose admin was taken away 403 ADMIN_REQUIRED', async () => {
    ctx = await createTestApp();
    const caller = await signInAsAdmin(ctx, email('caller'));
    await signInAsAdmin(ctx, email('other-admin'));
    const target = await signInAsProjectMember(ctx, email('target'), []);
    const before = await snapshot(target.userId);

    const res = await whileQueued(
      () => api('patch', `/v1/admin/users/${target.userId}`, caller.cookie, { name: 'Renamed' }),
      async () => {
        await ctx.prisma.user.update({ where: { id: caller.userId }, data: { role: 'user' } });
      },
    );
    expect([res.status, res.body], JSON.stringify(res.body)).toEqual([
      403,
      expect.objectContaining({ code: 'ADMIN_REQUIRED', detail: 'Managing users needs an admin.' }),
    ]);
    expect(await snapshot(target.userId)).toEqual(before);
  });

  it('answers a caller whose session ended 401', async () => {
    ctx = await createTestApp();
    const caller = await signInAsAdmin(ctx, email('caller'));
    const target = await signInAsProjectMember(ctx, email('target'), []);
    const before = await snapshot(target.userId);

    const res = await whileQueued(
      () => api('patch', `/v1/admin/users/${target.userId}`, caller.cookie, { name: 'Renamed' }),
      async () => {
        await ctx.prisma.session.deleteMany({ where: { userId: caller.userId } });
      },
    );
    expect([res.status, res.body], JSON.stringify(res.body)).toEqual([
      401,
      expect.objectContaining({
        detail: 'This session ended while the request was being handled.',
        remediation: 'Sign in at POST /auth/sign-in/email and retry.',
      }),
    ]);
    expect(await snapshot(target.userId)).toEqual(before);
  });
});

describe('PUT /v1/admin/users/:userId/password', () => {
  /**
   * Review Focus 5. A reset sets the typed password, raises the flag again,
   * and ends every session the person holds: their cookie answers 401 on its
   * next request, and a sign-in with the new password lands on the password
   * gate.
   */
  it('sets a temporary password, raises the flag, and ends every session the person holds', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const address = email('reset');
    const target = await signInAsProjectMember(ctx, address, [{ projectId: ctx.projectId, role: 'viewer' }]);
    await api('get', '/v1/projects', target.cookie).expect(200);

    const res = await api('put', `/v1/admin/users/${target.userId}/password`, admin.cookie, { password: TEMPORARY });
    expect([res.status, res.text]).toEqual([204, '']);

    await api('get', '/v1/projects', target.cookie).expect(401);
    expect(await ctx.prisma.session.count({ where: { userId: target.userId } })).toBe(0);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).mustChangePassword).toBe(true);

    expect((await signInStatus(address, TEST_PASSWORD)).status).toBe(401);
    const fresh = await signIn(ctx.app, address, TEMPORARY);
    expect((await sessionOf(fresh))?.user).toMatchObject({ mustChangePassword: true });
    expect((await api('get', '/v1/projects', fresh)).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('refuses resetting your own password 400 CANNOT_RESET_OWN_PASSWORD, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const before = await snapshot(admin.userId);
    const res = await api('put', `/v1/admin/users/${admin.userId}/password`, admin.cookie, { password: TEMPORARY });
    expect([res.status, res.body]).toEqual([
      400,
      expect.objectContaining({
        code: 'CANNOT_RESET_OWN_PASSWORD',
        detail: 'You cannot reset your own password here.',
        remediation: 'Change your own password with PUT /v1/me/password.',
      }),
    ]);
    expect(await snapshot(admin.userId)).toEqual(before);
  });

  /**
   * The account is removed after its password is set and before the flag is
   * raised — forced by removing it as the flag's write begins. The reset
   * answers the 404 a missing account gets, not a 500.
   */
  it('answers a reset that races a removal 404', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('leaving'), []);
    const setFlag = UserRepository.prototype.setMustChangePassword;
    vi.spyOn(UserRepository.prototype, 'setMustChangePassword').mockImplementationOnce(async function (
      this: UserRepository,
      ...args: Parameters<UserRepository['setMustChangePassword']>
    ) {
      await ctx.prisma.user.delete({ where: { id: target.userId } });
      return setFlag.apply(this, args);
    });

    const res = await api('put', `/v1/admin/users/${target.userId}/password`, admin.cookie, { password: TEMPORARY });
    expect([res.status, res.body], JSON.stringify(res.body)).toEqual([
      404,
      expect.objectContaining({ detail: `No user ${target.userId} in this organisation.` }),
    ]);
  });

  it('refuses a body the schema refuses 400 INVALID_PASSWORD_RESET, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('target'), []);
    const before = await snapshot(target.userId);
    for (const body of [{}, { password: 'seven77' }, { password: TEMPORARY, extra: true }]) {
      const res = await api('put', `/v1/admin/users/${target.userId}/password`, admin.cookie, body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_PASSWORD_RESET']);
    }
    expect(await snapshot(target.userId)).toEqual(before);
  });
});

describe('DELETE /v1/admin/users/:userId', () => {
  it('removes the account and its memberships, and a run note they wrote keeps its text and loses its author', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const target = await signInAsProjectMember(ctx, email('leaver'), [{ projectId: ctx.projectId, role: 'member' }]);
    const runId = await seedRun();
    await api('put', `/v1/runs/${runId}/note`, target.cookie, { note: 'flaky environment, ignore' }).expect(200);

    const res = await api('delete', `/v1/admin/users/${target.userId}`, admin.cookie);
    expect([res.status, res.text]).toEqual([204, '']);

    expect(await ctx.prisma.user.findUnique({ where: { id: target.userId } })).toBeNull();
    expect(await ctx.prisma.orgMember.count({ where: { userId: target.userId } })).toBe(0);
    expect(await ctx.prisma.projectMember.count({ where: { userId: target.userId } })).toBe(0);
    await api('get', '/v1/projects', target.cookie).expect(401);

    const row = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect([row.note, row.noteUpdatedBy]).toEqual(['flaky environment, ignore', null]);
    const read = await api('get', `/v1/runs/${runId}`, admin.cookie).expect(200);
    expect(read.body.note).toMatchObject({ text: 'flaky environment, ignore', updatedBy: null });
  });

  it('refuses removing yourself 400 CANNOT_REMOVE_SELF, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    await signInAsAdmin(ctx, email('other-admin'));
    const before = await snapshot(admin.userId);
    const res = await api('delete', `/v1/admin/users/${admin.userId}`, admin.cookie);
    expect([res.status, res.body]).toEqual([
      400,
      expect.objectContaining({
        code: 'CANNOT_REMOVE_SELF',
        detail: 'You cannot remove your own account.',
        remediation: 'Ask another admin to remove it.',
      }),
    ]);
    expect(await snapshot(admin.userId)).toEqual(before);
  });

  it('refuses to remove the last active admin 409 LAST_ADMIN, counted after the change queued ahead of it', async () => {
    ctx = await createTestApp();
    const caller = await signInAsAdmin(ctx, email('caller'));
    const target = await signInAsAdmin(ctx, email('target'));
    const before = await snapshot(target.userId);

    const res = await whileQueued(
      () => api('delete', `/v1/admin/users/${target.userId}`, caller.cookie),
      async () => {
        await ctx.prisma.user.update({ where: { id: caller.userId }, data: { role: 'user' } });
      },
    );
    expect([res.status, res.body], JSON.stringify(res.body)).toEqual([409, expect.objectContaining(LAST_ADMIN)]);
    expect(await snapshot(target.userId)).toEqual(before);
  });
});

/*
 * ═══ ANOTHER ORG'S ACCOUNT, OR ONE IN NO ORG, IS NOT FOUND, AND NOT TOUCHED ═══
 * (Review Focus 3)
 *
 * Each `:userId` route is sent a body it would act on for an account of this
 * org, naming instead an admin of another org (signed in, so a session it
 * could lose exists) and an account that belongs to no org. Both get the 404
 * an id that names nobody gets, and everything about the account reads the
 * same afterwards.
 */
describe('an account outside the org', () => {
  it('answers every :userId route 404, the same as an id naming nobody, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const outsider = await signInAsAdmin({ ...ctx, orgId: await otherOrg() }, email('outsider'));
    const orphanId = await account(email('orphan'), 'user', null);
    const nobody = `no-such-user-${randomUUID()}`;

    const routes = (id: string): ReadonlyArray<[Verb, string, object?]> => [
      ['patch', `/v1/admin/users/${id}`, { name: 'Taken Over', isAdmin: true, disabled: true }],
      ['put', `/v1/admin/users/${id}/password`, { password: 'taken-over-pass' }],
      ['delete', `/v1/admin/users/${id}`],
    ];

    for (const [who, id] of [
      ['another org’s admin', outsider.userId],
      ['an account in no org', orphanId],
      ['an id naming nobody', nobody],
    ] as const) {
      const before = await snapshot(id);
      for (const [verb, path, body] of routes(id)) {
        const res = await api(verb, path, admin.cookie, body);
        expect([res.status, res.body], `${who}: ${verb.toUpperCase()} ${path}`).toEqual([
          404,
          expect.objectContaining({
            code: 'NOT_FOUND',
            detail: `No user ${id} in this organisation.`,
            remediation: 'List the users with GET /v1/admin/users.',
          }),
        ]);
      }
      expect(await snapshot(id), who).toEqual(before);
    }
    // The outsider's own session survived it all.
    await api('get', '/v1/admin/users', outsider.cookie).expect(200);
  });
});

/*
 * ═══ TWO ADMINS TAKING ADMIN AWAY AT ONCE ═══
 * (Review Focus 2)
 *
 * A and B are the only active admins, and each sends, at the same moment, a
 * change that takes an admin away. Both requests are held at the admin lock
 * by a raw connection until both are OBSERVED queued (`pg_blocking_pids`),
 * then let go: the lock admits them one at a time, so the second reads the
 * count the first left, and exactly one is refused LAST_ADMIN.
 *
 * Three pairs. In the first, the one the spec names, each demotes the OTHER.
 * Better Auth re-checks the caller on every admin call, so without the lock
 * that pair can still be half-saved by luck: the later caller has just been
 * demoted and is refused 403 — or is not, if both checks run before either
 * write. In the second each demotes THEMSELVES, which Better Auth's re-check
 * cannot see at all (each caller is still an admin when it checks): there the
 * lock is the only thing between the install and no admin. The third removes
 * each other, so the DELETE's own count is held to the same rule.
 *
 * TWO THINGS MAKE THIS ABLE TO FAIL FOR WHAT IT NAMES.
 *
 *   - The interleaving is forced, not hoped for. `countActiveAdmins` is
 *     wrapped so that each call, having counted, waits for the other request
 *     to count too (for at most 1.5 s). Under the lock the other cannot arrive
 *     — it is queued behind this one — so the wait simply lapses; without the
 *     lock both count before either writes, and both are let past the check.
 *   - The app's pool holds TWO connections, so the two queued requests hold
 *     all of it. The one admitted first must therefore read on the lock's own
 *     transaction (Ruling 6): a read on another connection would find none
 *     free, fail after Prisma's pool timeout, and leave a 500 where a 200 or
 *     409 belongs.
 */
describe('two admins taking admin away at the same moment', () => {
  for (const pair of ['demoting each other', 'demoting themselves', 'removing each other'] as const) {
    it(`lets exactly one through and refuses the other 409 LAST_ADMIN, ${pair}, on a pool of two`, async () => {
      const url = process.env.DATABASE_URL;
      if (url === undefined) throw new Error('DATABASE_URL is not set');
      ctx = await createTestApp({}, [], [{ provide: PrismaClient, useValue: createPrisma(url, { connectionLimit: 2 }) }]);
      const a = await signInAsAdmin(ctx, email('admin-a'));
      const b = await signInAsAdmin(ctx, email('admin-b'));
      const removing = pair === 'removing each other';
      const changes: ReadonlyArray<readonly [cookie: string, target: string]> =
        pair === 'demoting themselves'
          ? [
              [a.cookie, a.userId],
              [b.cookie, b.userId],
            ]
          : [
              [a.cookie, b.userId],
              [b.cookie, a.userId],
            ];

      const count = UserRepository.prototype.countActiveAdmins;
      let counted = 0;
      vi.spyOn(UserRepository.prototype, 'countActiveAdmins').mockImplementation(async function (
        this: UserRepository,
        ...args: Parameters<UserRepository['countActiveAdmins']>
      ) {
        const n = await count.apply(this, args);
        counted += 1;
        const until = Date.now() + 1_500;
        while (counted < 2 && Date.now() < until) await delay(20);
        return n;
      });

      const holder = await ctx.pool.connect();
      const requests: Promise<request.Response>[] = [];
      let observed = false;
      try {
        const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const holderPid = rows[0]!.pid;
        await holder.query('SELECT pg_advisory_lock($1::bigint)', [adminLockKey(ctx.orgId).toString()]);

        let settled = 0;
        for (const [cookie, target] of changes) {
          const sent = (
            removing
              ? api('delete', `/v1/admin/users/${target}`, cookie)
              : api('patch', `/v1/admin/users/${target}`, cookie, { isAdmin: false })
          ).then((res) => res);
          sent.then(
            () => (settled += 1),
            () => (settled += 1),
          );
          requests.push(sent);
        }

        // Stops early, unobserved, if both requests finish first — which only a
        // missing lock lets them do — so the statuses below report what that
        // looks like instead of a bare timeout.
        await waitUntil('both changes to queue behind the held admin lock', async () => {
          if (settled === 2) return true;
          observed = (await queuedBehind(holderPid)) === 2;
          return observed;
        });
        await holder.query('SELECT pg_advisory_unlock($1::bigint)', [adminLockKey(ctx.orgId).toString()]);

        const responses = await Promise.all(requests);
        const statuses = responses.map((r) => r.status).sort();
        expect(statuses, `observed both queued: ${observed}; ${JSON.stringify(responses.map((r) => r.body))}`).toEqual([
          removing ? 204 : 200,
          409,
        ]);
        expect(responses.find((r) => r.status === 409)?.body).toMatchObject(LAST_ADMIN);
        expect(observed, 'both requests finished without queuing behind the held admin lock').toBe(true);
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        holder.release();
        await Promise.allSettled(requests);
      }

      vi.restoreAllMocks();
      expect(await new UserRepository(ctx.prisma).countActiveAdmins(ctx.orgId)).toBe(1);
      expect(await ctx.prisma.user.count({ where: { id: { in: [a.userId, b.userId] } } })).toBe(removing ? 1 : 2);
    });
  }
});
