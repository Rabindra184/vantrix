import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminLockKey, createPool, createPrisma, ProjectMemberRepository, UserRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const users = new UserRepository(prisma);
const members = new ProjectMemberRepository(prisma);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long an arrangement may wait for a state it is about to assert on. */
const ARRANGEMENT_DEADLINE_MS = 10_000;

async function waitUntil(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ARRANGEMENT_DEADLINE_MS;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

let orgA = '';
let orgB = '';
let checkout = '';
let search = '';
let billing = '';

async function user(
  id: string,
  over: { name?: string; email?: string; role?: string | null; banned?: boolean | null; createdAt?: Date } = {},
) {
  await prisma.user.create({
    data: {
      id,
      name: over.name ?? id,
      email: over.email ?? `${id}@example.test`,
      role: over.role === undefined ? 'user' : over.role,
      banned: over.banned === undefined ? false : over.banned,
      // Prisma reads an undefined field as "not provided", so the column default applies.
      createdAt: over.createdAt,
    },
  });
}

const join = (userId: string, orgId: string) => prisma.orgMember.create({ data: { userId, orgId } });

beforeEach(async () => {
  await resetDatabase(pool);
  orgA = (await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } })).id;
  orgB = (await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } })).id;
  checkout = (await prisma.project.create({ data: { orgId: orgA, slug: 'checkout', name: 'Checkout' } })).id;
  search = (await prisma.project.create({ data: { orgId: orgA, slug: 'search', name: 'Search' } })).id;
  billing = (await prisma.project.create({ data: { orgId: orgB, slug: 'billing', name: 'Billing' } })).id;
});

describe('UserRepository.listInOrg', () => {
  it("returns this org's people sorted by name, each with the memberships they hold in it", async () => {
    await user('u-zoe', { name: 'Zoe', role: 'admin' });
    await user('u-amy', { name: 'Amy' });
    await user('u-bob', { name: 'Bob' });
    await user('u-out', { name: 'Outsider' });
    await join('u-zoe', orgA);
    await join('u-amy', orgA);
    await join('u-bob', orgB);
    // u-out belongs to no org at all.
    await members.add({ projectId: search, userId: 'u-amy', role: 'manager', addedBy: null });
    await members.add({ projectId: checkout, userId: 'u-amy', role: 'viewer', addedBy: null });

    const rows = await users.listInOrg(orgA);

    expect(rows.map((r) => r.name)).toEqual(['Amy', 'Zoe']);
    const amy = rows[0]!;
    expect(amy).toMatchObject({ id: 'u-amy', email: 'u-amy@example.test', role: 'user', banned: false, mustChangePassword: false });
    // By project name: Checkout before Search.
    expect(amy.memberships).toEqual([
      { projectId: checkout, projectSlug: 'checkout', projectName: 'Checkout', role: 'viewer' },
      { projectId: search, projectSlug: 'search', projectName: 'Search', role: 'manager' },
    ]);
    expect(rows[1]).toMatchObject({ id: 'u-zoe', role: 'admin', memberships: [] });
  });

  it("lists a person in two orgs with only the memberships held in the org asked about", async () => {
    await user('u-both');
    await join('u-both', orgA);
    await join('u-both', orgB);
    await members.add({ projectId: checkout, userId: 'u-both', role: 'member', addedBy: null });
    await members.add({ projectId: billing, userId: 'u-both', role: 'manager', addedBy: null });

    const [inA] = await users.listInOrg(orgA);
    const [inB] = await users.listInOrg(orgB);
    expect(inA?.memberships.map((m) => m.projectSlug)).toEqual(['checkout']);
    expect(inB?.memberships.map((m) => m.projectSlug)).toEqual(['billing']);
  });

  it('reads the flags as booleans, and a NULL banned as not banned', async () => {
    await user('u-flags', { banned: null });
    await join('u-flags', orgA);
    await users.setMustChangePassword('u-flags', true);

    const [row] = await users.listInOrg(orgA);
    expect(row).toMatchObject({ banned: false, mustChangePassword: true });
  });

  /**
   * `user."createdAt"` is a bare `timestamp`, which node-postgres (the pg
   * pool) decodes in this PROCESS's zone and Prisma — its query API and its
   * `$queryRaw` alike — decodes as UTC (CLAUDE.md, "An instant column must be
   * timestamptz"). The repository reads it through Prisma, so the instant
   * written is the instant read in any zone. Pinned under a zone that is NOT
   * UTC, because in UTC the two decodings agree: what this catches is a
   * rewrite that moves the read onto the pg pool without converting.
   */
  it('reads createdAt as the instant that was written, whatever zone this process is in', async () => {
    const written = new Date('2026-03-04T05:06:07.000Z');
    await user('u-when', { createdAt: written });
    await join('u-when', orgA);

    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      expect(new Date('2026-08-07T00:00:00Z').getHours()).toBe(5);
      const [row] = await users.listInOrg(orgA);
      expect(row?.createdAt.toISOString()).toBe(written.toISOString());
      expect((await users.findInOrg(orgA, 'u-when'))?.createdAt.toISOString()).toBe(written.toISOString());
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('UserRepository.findInOrg', () => {
  it("finds this org's person, and nobody from another org or from no org", async () => {
    await user('u-in');
    await user('u-other');
    await user('u-none');
    await join('u-in', orgA);
    await join('u-other', orgB);

    expect((await users.findInOrg(orgA, 'u-in'))?.id).toBe('u-in');
    expect(await users.findInOrg(orgA, 'u-other')).toBeNull();
    expect(await users.findInOrg(orgA, 'u-none')).toBeNull();
    expect(await users.findInOrg(orgA, 'no-such-user')).toBeNull();
  });
});

describe('UserRepository.findByEmail', () => {
  it('matches the address in any letter case, and nothing else', async () => {
    await user('u-mail', { email: 'casey@example.test' });
    await user('u-under', { email: 'aXb@example.test' });

    expect(await users.findByEmail('Casey@Example.TEST')).toEqual({ id: 'u-mail' });
    expect(await users.findByEmail('casey@example.test')).toEqual({ id: 'u-mail' });
    expect(await users.findByEmail('nobody@example.test')).toBeNull();
    // A LIKE wildcard in the address is a character, not a pattern: `_` here
    // must not match the X of another account.
    expect(await users.findByEmail('a_b@example.test')).toBeNull();
  });
});

describe('UserRepository.countActiveAdmins', () => {
  it("counts this org's admins who are not disabled, and no one else", async () => {
    await user('a-active', { role: 'admin' });
    await user('a-null-banned', { role: 'admin', banned: null });
    await user('a-banned', { role: 'admin', banned: true });
    await user('a-other-org', { role: 'admin' });
    await user('a-no-org', { role: 'admin' });
    await user('u-plain');
    for (const id of ['a-active', 'a-null-banned', 'a-banned', 'u-plain']) await join(id, orgA);
    await join('a-other-org', orgB);

    expect(await users.countActiveAdmins(orgA)).toBe(2);
    expect(await users.countActiveAdmins(orgB)).toBe(1);
  });
});

describe('UserRepository.setMustChangePassword', () => {
  it('sets and clears the flag', async () => {
    await user('u-flag');
    await users.setMustChangePassword('u-flag', true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 'u-flag' } })).mustChangePassword).toBe(true);
    await users.setMustChangePassword('u-flag', false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 'u-flag' } })).mustChangePassword).toBe(false);
  });

  it('refuses an account that does not exist, rather than flagging nothing', async () => {
    await expect(users.setMustChangePassword('no-such-user', true)).rejects.toMatchObject({ code: 'P2025' });
  });
});

describe('UserRepository.deleteUser', () => {
  it('removes the account with its sessions, accounts and memberships', async () => {
    await user('u-gone');
    await user('u-stays');
    await join('u-gone', orgA);
    await join('u-stays', orgA);
    await members.add({ projectId: checkout, userId: 'u-gone', role: 'member', addedBy: null });
    await members.add({ projectId: checkout, userId: 'u-stays', role: 'member', addedBy: 'u-gone' });
    await prisma.session.create({
      data: { id: 's1', token: 't1', userId: 'u-gone', expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.account.create({ data: { id: 'acc1', accountId: 'u-gone', providerId: 'credential', userId: 'u-gone' } });

    await users.deleteUser('u-gone');

    expect(await prisma.user.findUnique({ where: { id: 'u-gone' } })).toBeNull();
    expect(await prisma.session.count({ where: { userId: 'u-gone' } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: 'u-gone' } })).toBe(0);
    expect(await prisma.orgMember.count({ where: { userId: 'u-gone' } })).toBe(0);
    expect(await prisma.projectMember.count({ where: { userId: 'u-gone' } })).toBe(0);
    // Somebody else's membership that this person granted survives them.
    expect(await prisma.projectMember.findMany({ where: { userId: 'u-stays' }, select: { addedBy: true } })).toEqual([
      { addedBy: null },
    ]);
  });

  it('is a no-op for an account that is already gone, so a compensation cannot throw over the error it is cleaning up after', async () => {
    await expect(users.deleteUser('no-such-user')).resolves.toBeUndefined();
  });
});

describe('UserRepository.withAdminLock', () => {
  it('derives a stable, distinct key per org', () => {
    expect(adminLockKey(orgA)).toBe(adminLockKey(orgA));
    expect(adminLockKey(orgA)).not.toBe(adminLockKey(orgB));
    // pg_advisory_xact_lock(bigint) takes a signed 64-bit key.
    expect(BigInt.asIntN(64, adminLockKey(orgA))).toBe(adminLockKey(orgA));
  });

  /**
   * The waiting proof, never a sleep: a raw connection holds the same lock,
   * the call is started, and a backend is OBSERVED blocked by the holder
   * (`pg_blocking_pids`) before the holder lets go. The callback must not have
   * run while the lock was held elsewhere, and must run once it is released.
   */
  it('waits for a holder of the same org lock, runs the callback once it is free, and releases on commit', async () => {
    const holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = rows[0]!.pid;
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [adminLockKey(orgA).toString()]);

      let ran = false;
      const call = users.withAdminLock(orgA, async () => {
        ran = true;
        return 'done';
      });
      pending = call;
      let failure: unknown;
      call.catch((error: unknown) => {
        failure = error;
      });

      await waitUntil('the call to queue behind the holder', async () => {
        if (failure !== undefined) throw failure;
        const blocked = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
          [holderPid],
        );
        return blocked.rows[0]!.n === 1;
      });
      expect(ran).toBe(false);

      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [adminLockKey(orgA).toString()]);
      expect(await call).toBe('done');
      expect(ran).toBe(true);

      // Released at commit: the holder can take it again at once.
      const again = await holder.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS got', [
        adminLockKey(orgA).toString(),
      ]);
      expect(again.rows[0]!.got).toBe(true);
      await holder.query('SELECT pg_advisory_unlock_all()');
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      holder.release();
      if (pending) await Promise.allSettled([pending]);
    }
  });

  /**
   * ═══ AN ADMIN CHANGE HOLDS ONE CONNECTION, NOT TWO ═══
   *
   * Every caller holds a pool connection for its whole wait on the lock. If
   * the holder then counted admins on ANOTHER connection, N same-org calls on
   * a pool of N would leave it nothing to count with: P2024 "Timed out
   * fetching a new connection" after Prisma's pool timeout, while the API's
   * shared pool starves every other request. So the count runs on the lock's
   * own transaction client.
   *
   * Forced rather than raced: a raw connection holds the lock until BOTH calls
   * are observed queued behind it (each on its own pool connection, the whole
   * pool of two), and only then lets go.
   */
  it('lets two same-org calls on a pool of two both finish, counting on the lock connection', async () => {
    await user('a-only', { role: 'admin' });
    await join('a-only', orgA);
    const limited = createPrisma(url, { connectionLimit: 2 });
    const repo = new UserRepository(limited);
    const holder = await pool.connect();
    let pending: Promise<unknown>[] = [];
    try {
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = rows[0]!.pid;
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [adminLockKey(orgA).toString()]);

      const started = [0, 1].map(() => repo.withAdminLock(orgA, (tx) => repo.countActiveAdmins(orgA, tx)));
      pending = started;
      const calls = Promise.allSettled(started);
      await waitUntil('both calls to queue behind the holder', async () => {
        const queued = await pool.query<{ n: number }>(
          `WITH RECURSIVE queued(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY (pg_blocking_pids(a.pid))
           )
           SELECT count(*)::int AS n FROM queued`,
          [holderPid],
        );
        return queued.rows[0]!.n === 2;
      });
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [adminLockKey(orgA).toString()]);

      const settled = await calls;
      const failures = settled.flatMap((s) => (s.status === 'rejected' ? [String(s.reason)] : []));
      expect(failures, 'a call failed instead of counting on its own connection').toEqual([]);
      expect(settled.map((s) => (s.status === 'fulfilled' ? s.value : null))).toEqual([1, 1]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      holder.release();
      await Promise.allSettled(pending);
      await limited.$disconnect();
    }
  });

  it("is not held up by another org's lock", async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [adminLockKey(orgB).toString()]);
      expect(await users.withAdminLock(orgA, async () => 'free')).toBe('free');
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      holder.release();
    }
  });

  it('rethrows what the callback threw, and releases the lock for the next caller', async () => {
    await expect(
      users.withAdminLock(orgA, async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(await users.withAdminLock(orgA, async () => 'next')).toBe('next');
  });

  it('starts its transaction with a budget that outlasts a queue behind a slow holder', async () => {
    const recorded: unknown[] = [];
    const recording = new Proxy(prisma, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (prop !== '$transaction') return fn.bind(target);
        return (...args: unknown[]) => {
          recorded.push(args[1]);
          return fn.apply(target, args);
        };
      },
    });
    await new UserRepository(recording).withAdminLock(orgA, async () => undefined);
    expect(recorded).toEqual([{ maxWait: 10_000, timeout: 30_000 }]);
  });
});
