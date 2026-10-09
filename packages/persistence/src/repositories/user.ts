import { createHash } from 'node:crypto';
import type { ProjectRole } from '@perfportal/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';
import { asProjectRole } from './project-member.js';
import { LOCK_WAITING_TX } from './transactions.js';

/** A person who belongs to an org, as an admin sees them. */
export interface OrgUserRow {
  id: string;
  name: string;
  email: string;
  /** The admin flag: exactly `'admin'` for an admin. */
  role: string | null;
  /** What the product calls "disabled". A NULL column reads as not banned. */
  banned: boolean;
  mustChangePassword: boolean;
  createdAt: Date;
  /** Only the memberships held in the org asked about, by project name. */
  memberships: { projectId: string; projectSlug: string; projectName: string; role: ProjectRole }[];
}

/**
 * The advisory-lock key `withAdminLock` takes for an org: the first eight
 * bytes of `sha256('<orgId>:admins')`, read as a signed 64-bit integer, which
 * is what `pg_advisory_xact_lock(bigint)` takes.
 *
 * Exported so a test can hold the very same lock from a raw connection —
 * `SELECT pg_advisory_lock($1::bigint)` with `adminLockKey(orgId).toString()`
 * (the string, cast in SQL, so nothing depends on how a driver serialises a
 * JS bigint).
 *
 * The single-bigint form, deliberately: PostgreSQL keeps one-bigint and
 * two-int4 advisory keys in separate key spaces (`pg_locks.objsubid` 1 and
 * 2), so this cannot collide with the worker's per-run locks, which are the
 * two-int4 `(RUN_INGEST_LOCK_NAMESPACE, hashtext(run_id))`.
 *
 * PER ORG, while the admin flag (`user.role`) is per ACCOUNT, install-wide.
 * That is correct because an install has one org (spec, section 1), and a
 * database holding several (the tests') does not share admins between them
 * in practice. It does mean this key serialises ONE org's admin changes and
 * must never be read as covering an account that is an admin of several.
 */
export function adminLockKey(orgId: string): bigint {
  return createHash('sha256').update(`${orgId}:admins`).digest().readBigInt64BE(0);
}

const ORG_USER_SELECT = (orgId: string) =>
  ({
    id: true,
    name: true,
    email: true,
    role: true,
    banned: true,
    mustChangePassword: true,
    createdAt: true,
    projectMembers: {
      where: { project: { orgId } },
      orderBy: [{ project: { name: 'asc' } }, { project: { slug: 'asc' } }],
      select: { role: true, project: { select: { id: true, slug: true, name: true } } },
    },
  }) satisfies Prisma.UserSelect;

type OrgUserRecord = Prisma.UserGetPayload<{ select: ReturnType<typeof ORG_USER_SELECT> }>;

/**
 * The accounts an admin manages. Every read of a PERSON (`listInOrg`,
 * `findInOrg`, `countActiveAdmins`) is scoped to ONE org through
 * `org_member`: a person of another org, or of none, is not found, so an
 * admin can never reach an account outside their own install by naming its
 * id. `findByEmail` alone looks across every org, because an address is
 * unique across the whole database and a create has to know it is taken
 * anywhere.
 *
 * Timestamps are read through Prisma, never the raw pool: `user."createdAt"`
 * is a bare `timestamp`, which Prisma decodes as UTC and node-postgres would
 * decode in this process's own zone.
 */
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Everyone with an `org_member` row in `orgId`, sorted by name. */
  async listInOrg(orgId: string): Promise<OrgUserRow[]> {
    const rows = await this.prisma.user.findMany({
      where: { orgMembers: { some: { orgId } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: ORG_USER_SELECT(orgId),
    });
    return rows.map(toOrgUserRow);
  }

  /**
   * `userId`, if it has an `org_member` row in `orgId`; otherwise null.
   *
   * `db` is the client to read on, as for `countActiveAdmins`: inside
   * `withAdminLock`, pass the lock's own transaction client, so a re-read of
   * the person being changed holds no second pool connection.
   */
  async findInOrg(
    orgId: string,
    userId: string,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<OrgUserRow | null> {
    const row = await db.user.findFirst({
      where: { id: userId, orgMembers: { some: { orgId } } },
      select: ORG_USER_SELECT(orgId),
    });
    return row ? toOrgUserRow(row) : null;
  }

  /**
   * Any account with this address, in any letter case, in any org. Compared
   * with lower() on both sides rather than ILIKE, which would read a `_` or a
   * `%` in an address as a wildcard.
   */
  async findByEmail(email: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "user" WHERE lower(email) = lower(${email}) ORDER BY id LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Admins of `orgId` who are not disabled. `banned IS NOT TRUE` rather than
   * `= false`, because the column is nullable and a NULL is not a ban.
   *
   * Counted per org although `user.role` is install-wide: see `adminLockKey`
   * for why that is correct, and what it does not cover.
   *
   * `db` is the client to count on. Inside `withAdminLock`, pass the lock's
   * own transaction client: counting on `this.prisma` there would hold a
   * SECOND pool connection while the first waits on the lock (see
   * `withAdminLock`).
   */
  async countActiveAdmins(orgId: string, db: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<number> {
    const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM "user" u
      JOIN org_member m ON m.user_id = u.id
      WHERE m.org_id = ${orgId}::uuid AND u.role = 'admin' AND u.banned IS NOT TRUE
    `;
    return row?.n ?? 0;
  }

  /**
   * Serialises every change to who is an active admin of `orgId`: `fn` runs
   * while this call holds `pg_advisory_xact_lock(adminLockKey(orgId))`, so a
   * second call for the same org waits until the first has committed. That
   * is what lets "is this the last active admin?" be read and acted on
   * without a second admin changing the answer in between.
   *
   * ═══ ONE CONNECTION PER ADMIN CHANGE: `fn` READS ON `tx` ═══
   *
   * Every caller holds one pool connection for its whole wait on the lock. A
   * holder that then read on `this.prisma` would need a SECOND, and N
   * same-org calls on a pool of N would leave it none: P2024 "Timed out
   * fetching a new connection", with every other request on that shared pool
   * starving behind it (measured: a pool of two, two concurrent calls). So
   * `fn` is handed the lock's own transaction client, and does its reads
   * (`countActiveAdmins(orgId, tx)`) on it. At READ COMMITTED each statement
   * there sees whatever the previous holder committed.
   *
   * Better Auth's own writes do NOT go through `tx`: they run on Better
   * Auth's client (`createAuth`'s own `createPrisma`, a separate pool) and
   * commit there, on their own. So the lock's transaction rolls back nothing
   * of theirs: when `fn` throws, the lock is released and what `fn` already
   * wrote through Better Auth stays written.
   *
   * Not re-entrant: `fn` calling `withAdminLock` for the same org opens a
   * second transaction on another connection, which queues behind this one,
   * and the two stall until a budget below runs out.
   *
   * Started with `LOCK_WAITING_TX`, because the budget runs from BEGIN and a
   * call queued behind another admin change spends it waiting — Prisma's 5 s
   * default would abandon a queue behind a holder that is only hashing a
   * password. The same 30 s also bounds a holder: an `fn` that outlives it
   * has its transaction rolled back (the lock goes with it) and the call
   * rejects, even though `fn`'s own writes stand.
   */
  async withAdminLock<T>(orgId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${adminLockKey(orgId).toString()}::bigint)`;
      return fn(tx);
    }, LOCK_WAITING_TX);
  }

  /** Throws (P2025) for an account that does not exist, rather than flagging nothing. */
  async setMustChangePassword(userId: string, value: boolean): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: value } });
  }

  /**
   * What follows a person changing their own password, once the new one is
   * written: every OTHER session of theirs ends, the one that asked
   * (`keepSessionId`) stays, and `mustChangePassword` clears. ONE transaction,
   * so a failure after the password write leaves one partial state — the new
   * password with everything else as it was — and never the sessions ended
   * with the flag still set, or the flag cleared with the old sessions still
   * live.
   *
   * Deletes the `session` rows directly. That is how Better Auth ends a
   * session too (its `revokeOtherSessions` deletes them through its adapter),
   * and with no cookie cache configured every `getSession` reads the row, so
   * a deleted session's cookie answers 401 on its next request.
   *
   * Throws (P2025) for an account that does not exist, and then deletes
   * nothing.
   */
  async finishPasswordChange(userId: string, keepSessionId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { userId, id: { not: keepSessionId } } }),
      this.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false } }),
    ]);
  }

  /**
   * Removes an account outright; its sessions, credential accounts and
   * memberships cascade with it. Only for undoing a create that failed after
   * the account existed, so it is a no-op for an account already gone: a
   * compensation must not throw over the error it is cleaning up after.
   */
  async deleteUser(userId: string): Promise<void> {
    await this.prisma.user.deleteMany({ where: { id: userId } });
  }
}

function toOrgUserRow(row: OrgUserRecord): OrgUserRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    banned: row.banned === true,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt,
    memberships: row.projectMembers.map((m) => ({
      projectId: m.project.id,
      projectSlug: m.project.slug,
      projectName: m.project.name,
      role: asProjectRole(m.role),
    })),
  };
}
