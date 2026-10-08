import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ACCESS_ACTIONS,
  MemberListResponseSchema,
  ProjectListResponseSchema,
  ProjectMemberSchema,
  type ProjectRole,
} from '@perfportal/contracts';
import { OrgMemberRepository, ProjectMemberRepository } from '@perfportal/persistence';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { auth } from '../src/auth/better-auth.instance.js';
import { projectNotFound } from '../src/common/validation.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember, TEST_PASSWORD } from './support/session.js';

/*
 * ═══ /v1/projects/:slug/members: WHO HOLDS A ROLE IN A PROJECT ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, sections 1-2)
 *
 * Listing is `members:read`, which every role in the project has; adding,
 * changing and removing are `members:manage`, an admin's. `AccessGuard`
 * answers who may call what, and the role matrix in
 * access-routes.integration.test.ts pins it route by route. What is checked
 * here is what the routes themselves do once a caller is let through: the
 * change each makes, read back from the database and from the person's own
 * next request — roles are read per request and never cached, so a role
 * granted, changed or taken away is in force at once — and the refusals the
 * routes send. Among them Review Focus 3: an account of another org, or of
 * none, gets the 404 an id naming nobody gets, and nothing changes.
 */

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

type Verb = 'get' | 'post' | 'patch' | 'delete';

/**
 * A DEADLINE ON EVERY REQUEST: the race cases hold a row lock a request
 * waits behind, and a wait with no deadline takes the file's whole timeout
 * with it when something is wrong.
 */
function api(verb: Verb, path: string, cookie: string, body?: object): request.Test {
  const req = request(ctx.app.getHttpServer())[verb](path)
    .set('Cookie', cookie)
    .timeout({ deadline: 60_000, response: 60_000 });
  return body === undefined ? req : req.send(body);
}

const email = (who: string): string => `${who}-${randomUUID().slice(0, 8)}@example.test`;

const MEMBERS = '/v1/projects/checkout/members';
const member = (userId: string): string => `${MEMBERS}/${userId}`;

/**
 * An account made the way bootstrap makes one, joined to `orgId`, or to no
 * org at all when it is null. Named after its address, as every account the
 * session helpers make is.
 */
async function account(address: string, orgId: string | null): Promise<string> {
  const { user } = await auth.api.createUser({ body: { email: address, password: TEST_PASSWORD, name: address, role: 'user' } });
  if (orgId !== null) await new OrgMemberRepository(ctx.prisma).add(user.id, orgId);
  return user.id;
}

async function otherOrg(): Promise<string> {
  const org = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
  return org.id;
}

/** A second project of the fixture's org. */
async function secondProject(): Promise<string> {
  const project = await ctx.prisma.project.create({
    data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
  });
  return project.id;
}

/** Every membership row `userId` holds, by project id, with who added it. */
async function rowsOf(userId: string): Promise<{ projectId: string; role: string; addedBy: string | null }[]> {
  return ctx.prisma.projectMember.findMany({
    where: { userId },
    orderBy: { projectId: 'asc' },
    select: { projectId: true, role: true, addedBy: true },
  });
}

/** The projects a session's own `GET /v1/projects` shows it, with its role in each. */
async function projectsOf(cookie: string): Promise<[string, ProjectRole | null | undefined][]> {
  const res = await api('get', '/v1/projects', cookie).expect(200);
  return ProjectListResponseSchema.parse(res.body).items.map((p) => [p.slug, p.role]);
}

async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** How many backends wait on `holderPid`, directly or behind another waiter. */
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
 * Runs `hold` in a raw transaction and leaves it uncommitted, sends a
 * request, waits until the request is OBSERVED waiting on that transaction,
 * then commits — so the request meets the committed change at the one point
 * it can, its own write. Forced, never raced: nothing here sleeps.
 */
async function whileHeld(
  hold: (client: PoolClient) => Promise<void>,
  send: () => request.Test,
): Promise<request.Response> {
  const holder = await ctx.pool.connect();
  let pending: Promise<request.Response> | undefined;
  try {
    const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holderPid = rows[0]!.pid;
    await holder.query('BEGIN');
    await hold(holder);

    let settled = false;
    pending = send().then((res) => {
      settled = true;
      return res;
    });
    await waitUntil('the request’s write to wait on the held transaction', async () => {
      if (settled) throw new Error('the request finished while the held transaction was uncommitted');
      return (await queuedBehind(holderPid)) === 1;
    });
    await holder.query('COMMIT');
    return await pending;
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
    if (pending) await Promise.allSettled([pending]);
  }
}

const NOT_A_MEMBER = (userId: string) => ({
  code: 'NOT_FOUND',
  detail: `No member ${userId} in project "checkout".`,
  remediation: 'List the members with GET /v1/projects/{slug}/members.',
});

const NOT_IN_ORG = (userId: string) => ({
  code: 'NOT_FOUND',
  detail: `No user ${userId} in this organisation.`,
  remediation: 'List the users with GET /v1/admin/users.',
});

describe('GET /v1/projects/:slug/members', () => {
  it('lists everyone holding a role in the project, by name, with their email and role, to a viewer of it', async () => {
    ctx = await createTestApp();
    const search = await secondProject();
    const viewer = await signInAsProjectMember(ctx, email('carol'), [{ projectId: ctx.projectId, role: 'viewer' }]);
    const manager = await signInAsProjectMember(ctx, email('alice'), [{ projectId: ctx.projectId, role: 'manager' }]);
    const memberOf = await signInAsProjectMember(ctx, email('bob'), [
      { projectId: ctx.projectId, role: 'member' },
      { projectId: search, role: 'manager' },
    ]);
    // Neither is listed: an admin needs no row to see the project, and a
    // member of another project holds none here.
    await signInAsAdmin(ctx, email('admin'));
    await signInAsProjectMember(ctx, email('dave'), [{ projectId: search, role: 'viewer' }]);

    const res = await api('get', MEMBERS, viewer.cookie).expect(200);
    const { members } = MemberListResponseSchema.parse(res.body);

    const rows = await ctx.prisma.projectMember.findMany({
      where: { projectId: ctx.projectId },
      select: { userId: true, createdAt: true, user: { select: { name: true, email: true } } },
    });
    const at = new Map(rows.map((r) => [r.userId, r]));
    const expected = (who: { userId: string }, role: ProjectRole) => ({
      userId: who.userId,
      name: at.get(who.userId)!.user.name,
      email: at.get(who.userId)!.user.email,
      role,
      addedAt: at.get(who.userId)!.createdAt.toISOString(),
    });
    expect(members).toEqual([
      expected(manager, 'manager'),
      expected(memberOf, 'member'),
      expected(viewer, 'viewer'),
    ]);
    expect(members.map((m) => m.name.split('-')[0])).toEqual(['alice', 'bob', 'carol']);
  });

  it('refuses a bearer token, whatever its scopes', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get(MEMBERS).set('Authorization', `Bearer ${ctx.readToken}`);
    expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('answers an admin naming a project the org does not hold with the project 404', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await account(email('person'), ctx.orgId);
    for (const [verb, path, body] of [
      ['get', '/v1/projects/no-such-project/members'],
      ['post', '/v1/projects/no-such-project/members', { userId: person, role: 'viewer' }],
      ['patch', `/v1/projects/no-such-project/members/${person}`, { role: 'viewer' }],
      ['delete', `/v1/projects/no-such-project/members/${person}`],
    ] as const) {
      const res = await api(verb, path, admin.cookie, body);
      expect([res.status, res.body.detail], `${verb.toUpperCase()} ${path}`).toEqual([
        404,
        projectNotFound('no-such-project').message,
      ]);
    }
    expect(await rowsOf(person)).toEqual([]);
  });
});

describe('who may manage members', () => {
  it('refuses a manager of the project ADMIN_REQUIRED on every change, and changes nothing', async () => {
    ctx = await createTestApp();
    const manager = await signInAsProjectMember(ctx, email('manager'), [{ projectId: ctx.projectId, role: 'manager' }]);
    const viewer = await signInAsProjectMember(ctx, email('viewer'), [{ projectId: ctx.projectId, role: 'viewer' }]);
    const outsider = await account(email('outsider'), ctx.orgId);
    const before = { viewer: await rowsOf(viewer.userId), outsider: await rowsOf(outsider) };

    for (const [verb, path, body] of [
      ['post', MEMBERS, { userId: outsider, role: 'viewer' }],
      ['patch', member(viewer.userId), { role: 'manager' }],
      ['delete', member(viewer.userId)],
    ] as const) {
      const res = await api(verb, path, manager.cookie, body);
      expect([res.status, res.body.code, res.body.detail], `${verb.toUpperCase()} ${path}`).toEqual([
        403,
        'ADMIN_REQUIRED',
        `${ACCESS_ACTIONS['members:manage'].label} needs an admin.`,
      ]);
    }
    expect({ viewer: await rowsOf(viewer.userId), outsider: await rowsOf(outsider) }).toEqual(before);
  });
});

describe('an admin manages a project’s members', () => {
  /**
   * The spec's "removing someone takes effect on their next request", and
   * granting and changing too. Each step is followed by the person's OWN next
   * requests: what `GET /v1/projects` shows them, with their role, and what
   * the guard answers a route that needs more than they hold.
   */
  it('adds, changes and removes a member, each in force on that person’s next request', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await signInAsProjectMember(ctx, email('person'), []);
    const name = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).name;
    const rulesEdit = ACCESS_ACTIONS['rules:edit'].label;
    const tokens = ACCESS_ACTIONS['tokens:manage'].label;

    expect(await projectsOf(person.cookie)).toEqual([]);

    // ADD, as a viewer.
    const added = await api('post', MEMBERS, admin.cookie, { userId: person.userId, role: 'viewer' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const row = await ctx.prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: ctx.projectId, userId: person.userId } },
    });
    expect(ProjectMemberSchema.parse(added.body)).toEqual({
      userId: person.userId,
      name,
      email: (await ctx.prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).email,
      role: 'viewer',
      addedAt: row.createdAt.toISOString(),
    });
    expect(await rowsOf(person.userId)).toEqual([{ projectId: ctx.projectId, role: 'viewer', addedBy: admin.userId }]);
    const listed = MemberListResponseSchema.parse((await api('get', MEMBERS, admin.cookie).expect(200)).body);
    expect(listed.members.map((m) => [m.userId, m.role])).toEqual([[person.userId, 'viewer']]);

    expect(await projectsOf(person.cookie)).toEqual([['checkout', 'viewer']]);
    await api('get', MEMBERS, person.cookie).expect(200);
    const asViewer = await api('post', '/v1/projects/checkout/rules', person.cookie, {});
    expect([asViewer.status, asViewer.body.code, asViewer.body.detail]).toEqual([
      403,
      'ROLE_REQUIRED',
      `${rulesEdit} needs the Member role in this project.`,
    ]);

    // CHANGE, to a member: past the rules guard to the handler's own 400, and
    // still short of the tokens a manager holds.
    const toMember = await api('patch', member(person.userId), admin.cookie, { role: 'member' });
    expect(toMember.status, JSON.stringify(toMember.body)).toBe(200);
    expect(ProjectMemberSchema.parse(toMember.body)).toMatchObject({ userId: person.userId, name, role: 'member' });
    // The row it changed is the row it added: same instant, same adder.
    expect(toMember.body.addedAt).toBe(row.createdAt.toISOString());
    expect(await rowsOf(person.userId)).toEqual([{ projectId: ctx.projectId, role: 'member', addedBy: admin.userId }]);

    expect(await projectsOf(person.cookie)).toEqual([['checkout', 'member']]);
    const asMember = await api('post', '/v1/projects/checkout/rules', person.cookie, {});
    expect([asMember.status, asMember.body.code]).toEqual([400, 'INVALID_SLA_RULE']);
    const tokensAsMember = await api('get', '/v1/projects/checkout/tokens', person.cookie);
    expect([tokensAsMember.status, tokensAsMember.body.code, tokensAsMember.body.detail]).toEqual([
      403,
      'ROLE_REQUIRED',
      `${tokens} needs the Manager role in this project.`,
    ]);

    // CHANGE, to a manager.
    await api('patch', member(person.userId), admin.cookie, { role: 'manager' }).expect(200);
    expect(await projectsOf(person.cookie)).toEqual([['checkout', 'manager']]);
    await api('get', '/v1/projects/checkout/tokens', person.cookie).expect(200);

    // REMOVE: the project is gone from their list, and naming it is the 404
    // a project that does not exist gets.
    const removed = await api('delete', member(person.userId), admin.cookie);
    expect([removed.status, removed.text]).toEqual([204, '']);
    expect(await rowsOf(person.userId)).toEqual([]);
    expect(await projectsOf(person.cookie)).toEqual([]);
    const gone = await api('get', MEMBERS, person.cookie);
    expect([gone.status, gone.body.detail]).toEqual([404, projectNotFound('checkout').message]);
  });

  it('removes only the membership named, and someone’s last one leaves their account in the org', async () => {
    ctx = await createTestApp();
    const search = await secondProject();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const both = await signInAsProjectMember(ctx, email('both'), [
      { projectId: ctx.projectId, role: 'member' },
      { projectId: search, role: 'viewer' },
    ]);
    const only = await signInAsProjectMember(ctx, email('only'), [{ projectId: ctx.projectId, role: 'viewer' }]);

    await api('delete', member(both.userId), admin.cookie).expect(204);
    expect(await rowsOf(both.userId)).toEqual([{ projectId: search, role: 'viewer', addedBy: null }]);
    expect(await projectsOf(both.cookie)).toEqual([['search', 'viewer']]);

    await api('delete', member(only.userId), admin.cookie).expect(204);
    expect(await rowsOf(only.userId)).toEqual([]);
    // The account, its place in the org and its session all remain: its next
    // request is answered, with no project in it.
    expect(await ctx.prisma.user.count({ where: { id: only.userId } })).toBe(1);
    expect(await ctx.prisma.orgMember.count({ where: { userId: only.userId, orgId: ctx.orgId } })).toBe(1);
    expect(await projectsOf(only.cookie)).toEqual([]);
  });

  it('refuses adding someone who is already a member 409 MEMBER_EXISTS, naming them, and leaves their role', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await signInAsProjectMember(ctx, email('person'), [{ projectId: ctx.projectId, role: 'viewer' }]);
    const name = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).name;

    const res = await api('post', MEMBERS, admin.cookie, { userId: person.userId, role: 'manager' });
    expect([res.status, res.body]).toEqual([
      409,
      expect.objectContaining({
        code: 'MEMBER_EXISTS',
        detail: `${name} is already a member of this project.`,
        remediation: 'Change their role with PATCH /v1/projects/{slug}/members/{userId}.',
      }),
    ]);
    expect(await rowsOf(person.userId)).toEqual([{ projectId: ctx.projectId, role: 'viewer', addedBy: null }]);
  });

  /**
   * Two admins adding one person at the same moment: the primary key decides,
   * as it does for every add. The other add is a raw transaction here, its
   * INSERT made and held uncommitted: this request's INSERT is OBSERVED
   * waiting on it, and when it commits, this one is refused by the key. That
   * refusal is the same 409 as any existing membership, never a 500, and the
   * role the other add gave stands.
   */
  it('answers an add that loses the race for the membership 409 MEMBER_EXISTS', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await account(email('raced'), ctx.orgId);

    const res = await whileHeld(
      async (holder) => {
        await holder.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'manager')`, [
          ctx.projectId,
          person,
        ]);
      },
      () => api('post', MEMBERS, admin.cookie, { userId: person, role: 'viewer' }),
    );
    expect([res.status, res.body.code, res.body.detail], JSON.stringify(res.body)).toEqual([
      409,
      'MEMBER_EXISTS',
      `${(await ctx.prisma.user.findUniqueOrThrow({ where: { id: person } })).name} is already a member of this project.`,
    ]);
    expect(await rowsOf(person)).toEqual([{ projectId: ctx.projectId, role: 'manager', addedBy: null }]);
  });

  /**
   * An account removed between the add's check that it is in the org and the
   * add's own INSERT: the removal is a raw transaction, held uncommitted, that
   * the INSERT's foreign-key check is OBSERVED waiting on. When it commits the
   * account is gone, and the add answers the 404 any account outside the org
   * gets — not the 500 a foreign-key violation would be.
   */
  it('answers an add whose account is removed while it waits 404', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await account(email('removed'), ctx.orgId);

    const res = await whileHeld(
      async (holder) => {
        await holder.query('DELETE FROM "user" WHERE id = $1', [person]);
      },
      () => api('post', MEMBERS, admin.cookie, { userId: person, role: 'viewer' }),
    );
    expect([res.status, res.body], JSON.stringify(res.body)).toEqual([404, expect.objectContaining(NOT_IN_ORG(person))]);
    expect(await ctx.prisma.projectMember.count({ where: { projectId: ctx.projectId } })).toBe(0);
  });

  it('refuses an add body the schema refuses 400 INVALID_MEMBER_REQUEST, and adds nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await account(email('person'), ctx.orgId);

    for (const body of [
      {},
      { userId: person },
      { userId: person, role: 'admin' },
      { userId: '   ', role: 'viewer' },
      { userId: person, role: 'viewer', projectSlug: 'search' },
    ]) {
      const res = await api('post', MEMBERS, admin.cookie, body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_MEMBER_REQUEST']);
      expect(res.body.remediation).toBe(
        'Send a "userId" from GET /v1/admin/users and a "role" of "viewer", "member" or "manager", and no other field.',
      );
    }
    expect(await rowsOf(person)).toEqual([]);
  });

  it('refuses a change body the schema refuses 400 INVALID_MEMBER_UPDATE, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const person = await signInAsProjectMember(ctx, email('person'), [{ projectId: ctx.projectId, role: 'viewer' }]);

    for (const body of [{}, { role: 'admin' }, { role: 'manager', userId: person.userId }]) {
      const res = await api('patch', member(person.userId), admin.cookie, body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_MEMBER_UPDATE']);
      expect(res.body.remediation).toBe('Send a "role" of "viewer", "member" or "manager", and no other field.');
    }
    expect(await rowsOf(person.userId)).toEqual([{ projectId: ctx.projectId, role: 'viewer', addedBy: null }]);
  });

  it('answers changing or removing someone in the org who is not a member 404, and makes no membership', async () => {
    ctx = await createTestApp();
    const search = await secondProject();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const elsewhere = await signInAsProjectMember(ctx, email('elsewhere'), [{ projectId: search, role: 'viewer' }]);

    for (const [verb, body] of [
      ['patch', { role: 'manager' }],
      ['delete', undefined],
    ] as const) {
      const res = await api(verb, member(elsewhere.userId), admin.cookie, body);
      expect([res.status, res.body], verb).toEqual([404, expect.objectContaining(NOT_A_MEMBER(elsewhere.userId))]);
    }
    expect(await rowsOf(elsewhere.userId)).toEqual([{ projectId: search, role: 'viewer', addedBy: null }]);
  });
});

/*
 * ═══ AN ACCOUNT OUTSIDE THE ORG IS NOT FOUND ═══
 * (Review Focus 3)
 *
 * An admin of this org naming another org's admin, an account in no org, and
 * an id naming nobody, on every members route that takes a person. All get the
 * 404 an id naming nobody gets, and nothing about their memberships changes.
 *
 * Asked in two states, because each half needs a different one to be able to
 * fail. The add is asked while they hold no membership here, so an add that
 * skipped the org check would WRITE one — the foreign key admits any account
 * that exists. The change and the removal are asked once the first two hold a
 * membership of THIS org's project, made by hand — a row no product path
 * writes, since an account belongs to the org whose admin created it — so a
 * PATCH or DELETE that skipped the org check would find a row to change.
 * Without it, "not a member" would answer them 404 anyway, and the case could
 * not tell an org check from no check at all.
 */
describe('an account outside the org', () => {
  it('answers POST, PATCH and DELETE 404, the same as an id naming nobody, and changes nothing', async () => {
    ctx = await createTestApp();
    const admin = await signInAsAdmin(ctx, email('admin'));
    const outsider = await signInAsAdmin({ ...ctx, orgId: await otherOrg() }, email('outsider'));
    const orphan = await account(email('orphan'), null);
    const nobody = `no-such-user-${randomUUID()}`;
    const ACCOUNTS = [
      ['another org’s admin', outsider.userId],
      ['an account in no org', orphan],
      ['an id naming nobody', nobody],
    ] as const;

    const expectNotInOrg = async (who: string, verb: Verb, path: string, id: string, body?: object) => {
      const res = await api(verb, path, admin.cookie, body);
      expect([res.status, res.body], `${who}: ${verb.toUpperCase()} ${path}`).toEqual([
        404,
        expect.objectContaining(NOT_IN_ORG(id)),
      ]);
    };

    for (const [who, id] of ACCOUNTS) {
      await expectNotInOrg(who, 'post', MEMBERS, id, { userId: id, role: 'manager' });
      expect(await rowsOf(id), who).toEqual([]);
    }

    const memberships = new ProjectMemberRepository(ctx.prisma);
    await memberships.add({ projectId: ctx.projectId, userId: outsider.userId, role: 'viewer', addedBy: null });
    await memberships.add({ projectId: ctx.projectId, userId: orphan, role: 'viewer', addedBy: null });

    for (const [who, id] of ACCOUNTS) {
      const before = await rowsOf(id);
      await expectNotInOrg(who, 'patch', member(id), id, { role: 'manager' });
      await expectNotInOrg(who, 'delete', member(id), id);
      expect(await rowsOf(id), who).toEqual(before);
    }
    // The outsider's own session survived it all.
    await api('get', '/v1/admin/users', outsider.cookie).expect(200);
  });
});
