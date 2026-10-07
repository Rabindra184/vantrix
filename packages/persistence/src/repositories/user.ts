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

  /** `userId`, if it has an `org_member` row in `orgId`; otherwise null. */
  async findInOrg(orgId: string, userId: string): Promise<OrgUserRow | null> {
    const row = await this.prisma.user.findFirst({
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
   */
  async countActiveAdmins(orgId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
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
   * The transaction holds NOTHING BUT THE LOCK. `fn` takes no transaction
   * client, and the Better Auth calls it makes run on Better Auth's own
   * connections and commit there, on their own: when `fn` throws, the lock is
   * released and what `fn` already wrote stays written. A read `fn` makes
   * through this repository (`countActiveAdmins`) runs on another connection
   * at READ COMMITTED, so it sees what the previous holder committed.
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
  async withAdminLock<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${adminLockKey(orgId).toString()}::bigint)`;
      return fn();
    }, LOCK_WAITING_TX);
  }

  /** Throws (P2025) for an account that does not exist, rather than flagging nothing. */
  async setMustChangePassword(userId: string, value: boolean): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: value } });
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
