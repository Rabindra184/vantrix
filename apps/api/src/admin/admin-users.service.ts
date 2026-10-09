import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { accessRefusal, type CreateUserRequest, type ProjectRole, type UpdateUserRequest } from '@perfportal/contracts';
import {
  OrgMemberRepository,
  ProjectMemberRepository,
  ProjectRepository,
  UserRepository,
  type OrgUserRow,
} from '@perfportal/persistence';
import { PrismaClient } from '@prisma/client';
import { APIError } from 'better-auth/api';
import { auth } from '../auth/better-auth.instance.js';
import { accessDenied, badRequest, conflict, sessionEnded, userNotFound } from '../common/validation.js';
import { prismaCode, prismaMeta } from '../common/prisma-errors.js';

/** The admin flag and the ban, as `countActiveAdmins` counts them: an admin who is not disabled. */
function isActiveAdmin(user: OrgUserRow): boolean {
  return user.role === 'admin' && !user.banned;
}

/**
 * The remediation names no list: the address may belong to an account in
 * another org, or in none, which `GET /v1/admin/users` never shows.
 */
function emailTaken(email: string) {
  return conflict('EMAIL_TAKEN', `An account with ${email} already exists.`, 'Use another email.');
}

/**
 * The unique index on `user.email` refusing an INSERT: a create of the same
 * address that committed between both checks and this INSERT (Prisma P2002,
 * its target naming the column).
 */
function isEmailUniqueViolation(err: unknown): boolean {
  if (prismaCode(err) !== 'P2002') return false;
  const target = prismaMeta(err)?.['target'];
  return Array.isArray(target) ? target.map(String).includes('email') : String(target).includes('email');
}

function lastAdmin() {
  return conflict(
    'LAST_ADMIN',
    'This is the last active admin, so the install would have none.',
    'Make someone else an admin first.',
  );
}

/**
 * Better Auth's own refusals, in this API's words. Its admin endpoints check
 * the CALLER's session again, authoritatively, on every call — so a caller
 * whose admin was taken away after `AccessGuard` let their request in is
 * refused there (403), and is told so the way `AccessGuard` would have told
 * them; a caller whose session ended in between (removed or disabled by
 * another admin) gets the 401 an ended session gets. An account that went
 * away in between (404) is the same 404 as one that was never in the org —
 * `userId` names it, or is null on a create, which names no account yet and
 * so maps no 404. Anything else is not a refusal this API knows, and stays
 * the 500 it is.
 */
function fromBetterAuth(err: unknown, userId: string | null): unknown {
  if (!(err instanceof APIError)) return err;
  if (err.statusCode === 401) return sessionEnded();
  if (err.statusCode === 403) {
    const r = accessRefusal('users:manage');
    return accessDenied(r.code, r.detail, r.remediation);
  }
  if (err.statusCode === 404 && userId !== null) return userNotFound(userId);
  return err;
}

/**
 * The account changes behind `/v1/admin/users`: Better Auth's admin plugin,
 * called server-side with the ADMIN's own request headers, so the plugin
 * re-checks that the caller is an admin on every call — and, for every change
 * to who is an active admin, the org's admin lock.
 *
 * ═══ THE LAST ACTIVE ADMIN ═══
 *
 * A demotion, a disable or a removal that would leave the org with no active
 * admin is refused 409 LAST_ADMIN, so an install cannot lock itself out. The
 * question "is this the last one?" is read and acted on inside
 * `UserRepository.withAdminLock`, which admits one admin change per org at a
 * time: two admins taking each other's admin at once are put in order, and
 * the second reads the count the first left.
 *
 * Inside the lock everything this service READS goes through the lock's own
 * transaction client `tx` — the person being changed, re-read, and the count
 * (Ruling 6). A read on the root client would hold a second pool connection
 * while the first waits, and N admin changes on a pool of N would starve it.
 * Better Auth's WRITES go through its own client and pool, and commit on
 * their own (see `withAdminLock`).
 *
 * The person is re-read under the lock, not trusted from the controller's
 * read before it: whether a change takes an active admin out depends on what
 * they are NOW, and an admin change queued ahead of this one may have just
 * made them one, or stopped them being one.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserRepository,
    private readonly projects: ProjectRepository,
  ) {}

  /**
   * Creates the account and joins it to the org and its projects
   * (spec section 3, "Create"):
   *
   *   1. Every project slug must name a project of this org: 400
   *      UNKNOWN_PROJECT, naming the first that does not, before anything
   *      is written.
   *   2. An address already in use, in any letter case and in any org: 409
   *      EMAIL_TAKEN. The same 409 answers the two ways a create of the same
   *      address can land after this check: before Better Auth's own check
   *      (it refuses USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL), or after it and
   *      before Better Auth's INSERT, which the unique index on
   *      `user.email` then refuses (P2002). Two simultaneous creates pass
   *      both checks; the index is what decides between them.
   *   3. Better Auth's admin `createUser`, with the admin's headers, sets the
   *      role and `mustChangePassword`, and the id: generated HERE and passed
   *      in `data` (Better Auth 1.6.26 keeps a supplied id — its
   *      `createWithHooks` creates with `forceAllowId`). It writes the user
   *      and then its credential account as two writes, on its own client.
   *   4. In ONE transaction: the org membership, then each project role,
   *      granted by `adminId`.
   *   5. If step 3 or step 4 throws, the account with THAT id is deleted —
   *      its credential account cascades — and the error is answered. The
   *      id is known before anything is written, so the delete is exact: it
   *      removes this create's half-made account wherever step 3 stopped,
   *      and can never touch an account another create made with the same
   *      address. A half-made account would refuse the admin's retry with
   *      EMAIL_TAKEN.
   *
   * Returns the new account's id.
   */
  async create(orgId: string, adminId: string, input: CreateUserRequest, headers: Headers): Promise<string> {
    const grants: { projectId: string; role: ProjectRole }[] = [];
    for (const { projectSlug, role } of input.projects) {
      const project = await this.projects.findBySlugInOrg(orgId, projectSlug);
      if (project === null) {
        throw badRequest(
          'UNKNOWN_PROJECT',
          `No project "${projectSlug}" in this organisation.`,
          'List the projects with GET /v1/admin/projects.',
        );
      }
      grants.push({ projectId: project.id, role });
    }

    if ((await this.users.findByEmail(input.email)) !== null) throw emailTaken(input.email);

    const userId = randomUUID();
    try {
      const { user } = await auth.api.createUser({
        body: {
          email: input.email,
          name: input.name,
          password: input.password,
          role: input.isAdmin ? 'admin' : 'user',
          data: { id: userId, mustChangePassword: true },
        },
        headers,
      });
      if (user.id !== userId) {
        // An upgrade that stopped keeping a supplied id. The account it made
        // is this call's own, so it goes; failing loudly beats a compensation
        // that would aim at an id nothing holds.
        await this.compensate(user.id);
        throw new Error(`Better Auth created account ${user.id} where ${userId} was supplied.`);
      }
    } catch (err) {
      await this.compensate(userId);
      if (err instanceof APIError && err.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
        throw emailTaken(input.email);
      }
      if (isEmailUniqueViolation(err)) throw emailTaken(input.email);
      throw fromBetterAuth(err, null);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await new OrgMemberRepository(tx).add(userId, orgId);
        const members = new ProjectMemberRepository(tx);
        for (const grant of grants) {
          await members.add({ projectId: grant.projectId, userId, role: grant.role, addedBy: adminId });
        }
      });
    } catch (err) {
      await this.compensate(userId);
      throw err;
    }
    return userId;
  }

  /**
   * Deletes `userId`, this create's own account, after a step failed. A no-op
   * when nothing was written under that id (a refusal before Better Auth's
   * INSERT, or that INSERT itself refused). It must not replace the error it
   * is cleaning up after: a failure here is logged, and the original is what
   * the caller sees.
   */
  private async compensate(userId: string): Promise<void> {
    await this.users.deleteUser(userId).catch((cleanup: unknown) => {
      console.error(`could not remove account ${userId} after its create failed`, cleanup);
    });
  }

  /**
   * Applies a PATCH (spec section 3, "Disable / enable", "Make / remove
   * admin"), all of it under the org's admin lock:
   *
   *   - re-read the person on `tx` (gone: 404);
   *   - a change that takes an active admin out — `isAdmin: false`, or
   *     `disabled: true`, on an admin who is not disabled — when they are the
   *     last one: 409 LAST_ADMIN, nothing changed;
   *   - then ONE `adminUpdateUser` carrying every field the body names: the
   *     name, the admin flag as `role`, and the ban.
   *
   * ONE call, so the change is all or nothing. As three (`setRole`, then
   * `banUser` / `unbanUser`) a self PATCH `{ isAdmin: false, disabled: false }`
   * applied the demotion and was then refused by the unban, which re-checks a
   * caller who had just stopped being an admin: a 403 over a change half
   * made. In Better Auth 1.6.26 `adminUpdateUser` runs every permission check
   * first — `role` needs "set-role", the ban fields need "ban", a ban of
   * oneself is refused — then makes one `updateUser`, and on `banned: true`
   * deletes the person's sessions, as `banUser` does.
   *
   * `data` is built by assignment, holding only the keys the body names:
   * Better Auth tests for a key with `hasOwnProperty`, so a present
   * `role: undefined` would be judged as a role (and refused, not a string).
   * `role` comes only from the boolean, `'admin'` or `'user'`; Better Auth
   * checks a role against a list only when the plugin is given `roles`, and
   * this one is not.
   */
  async update(orgId: string, userId: string, input: UpdateUserRequest, headers: Headers): Promise<void> {
    await this.users.withAdminLock(orgId, async (tx) => {
      const current = await this.users.findInOrg(orgId, userId, tx);
      if (current === null) throw userNotFound(userId);
      const takesOut = isActiveAdmin(current) && (input.isAdmin === false || input.disabled === true);
      if (takesOut && (await this.users.countActiveAdmins(orgId, tx)) <= 1) throw lastAdmin();

      const data: {
        name?: string;
        role?: 'admin' | 'user';
        banned?: boolean;
        banReason?: null;
        banExpires?: null;
      } = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.isAdmin !== undefined) data.role = input.isAdmin ? 'admin' : 'user';
      if (input.disabled === true) data.banned = true;
      if (input.disabled === false) {
        data.banned = false;
        data.banReason = null;
        data.banExpires = null;
      }
      try {
        await auth.api.adminUpdateUser({ body: { userId, data }, headers });
      } catch (err) {
        throw fromBetterAuth(err, userId);
      }
    });
  }

  /**
   * Resets a password to one the admin typed (spec section 3, "Reset"): the
   * new password, then the flag that makes its owner replace it, then every
   * session they hold ends. Better Auth's `setUserPassword` revokes nothing
   * itself, so without the last step a stolen cookie would outlive the reset.
   * Not under the admin lock: it changes nobody's admin. An account removed
   * between the password and the flag (P2025 from the flag's update) is the
   * same 404 as one that was never there.
   */
  async resetPassword(userId: string, password: string, headers: Headers): Promise<void> {
    try {
      await auth.api.setUserPassword({ body: { userId, newPassword: password }, headers });
    } catch (err) {
      throw fromBetterAuth(err, userId);
    }
    try {
      await this.users.setMustChangePassword(userId, true);
    } catch (err) {
      if (prismaCode(err) === 'P2025') throw userNotFound(userId);
      throw err;
    }
    try {
      await auth.api.revokeUserSessions({ body: { userId }, headers });
    } catch (err) {
      throw fromBetterAuth(err, userId);
    }
  }

  /**
   * Removes an account (spec section 3, "Remove") under the org's admin
   * lock: re-read on `tx` (gone: 404), the last active admin refused 409
   * LAST_ADMIN, then Better Auth's `removeUser`, which ends their sessions
   * and deletes the account. Their memberships cascade; a run note they wrote
   * keeps its text and loses its author (`run.note_updated_by` is
   * `ON DELETE SET NULL`).
   */
  async remove(orgId: string, userId: string, headers: Headers): Promise<void> {
    await this.users.withAdminLock(orgId, async (tx) => {
      const current = await this.users.findInOrg(orgId, userId, tx);
      if (current === null) throw userNotFound(userId);
      if (isActiveAdmin(current) && (await this.users.countActiveAdmins(orgId, tx)) <= 1) throw lastAdmin();
      try {
        await auth.api.removeUser({ body: { userId }, headers });
      } catch (err) {
        throw fromBetterAuth(err, userId);
      }
    });
  }
}
