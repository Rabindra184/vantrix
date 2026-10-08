import { Injectable } from '@nestjs/common';
import { ACCESS_ACTIONS, type CreateUserRequest, type ProjectRole, type UpdateUserRequest } from '@perfportal/contracts';
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

/** The admin flag and the ban, as `countActiveAdmins` counts them: an admin who is not disabled. */
function isActiveAdmin(user: OrgUserRow): boolean {
  return user.role === 'admin' && !user.banned;
}

function emailTaken(email: string) {
  return conflict(
    'EMAIL_TAKEN',
    `An account with ${email} already exists.`,
    'Use another email, or find the account with GET /v1/admin/users.',
  );
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
    return accessDenied('ADMIN_REQUIRED', `${ACCESS_ACTIONS['users:manage'].label} needs an admin.`, 'Ask an admin to do this.');
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
   *      EMAIL_TAKEN. Better Auth refuses a duplicate too, for one created
   *      between this check and its own; that refusal answers the same.
   *   3. Better Auth's admin `createUser`, with the admin's headers, sets the
   *      role and `mustChangePassword`. It writes the user and then its
   *      credential account as two writes, on its own client.
   *   4. In ONE transaction: the org membership, then each project role,
   *      granted by `adminId`.
   *   5. If step 4 throws, the account is deleted — its credential account
   *      cascades with it — and the error is rethrown. A half-made account
   *      would refuse the admin's retry with EMAIL_TAKEN.
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

    let userId: string;
    try {
      const { user } = await auth.api.createUser({
        body: {
          email: input.email,
          name: input.name,
          password: input.password,
          role: input.isAdmin ? 'admin' : 'user',
          data: { mustChangePassword: true },
        },
        headers,
      });
      userId = user.id;
    } catch (err) {
      if (err instanceof APIError && err.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
        throw emailTaken(input.email);
      }
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
      // The compensation must not replace the error it is cleaning up after:
      // a failure here is logged, and the original is what the caller sees.
      await this.users.deleteUser(userId).catch((cleanup: unknown) => {
        console.error(`could not remove account ${userId} after its create failed`, cleanup);
      });
      throw err;
    }
    return userId;
  }

  /**
   * Applies a PATCH (spec section 3, "Disable / enable", "Make / remove
   * admin"), all of it under the org's admin lock:
   *
   *   - re-read the person on `tx` (gone: 404);
   *   - a change that takes an active admin out — `isAdmin: false`, or
   *     `disabled: true`, on an admin who is not disabled — when they are the
   *     last one: 409 LAST_ADMIN, nothing changed;
   *   - then the name (`adminUpdateUser`), the admin flag (`setRole`) and the
   *     ban (`banUser`, which also ends their sessions, or `unbanUser`), in
   *     that order, each only if the body names it.
   *
   * The three are three Better Auth calls, so a failure part-way leaves the
   * earlier ones applied; a retry of the same PATCH converges.
   */
  async update(orgId: string, userId: string, input: UpdateUserRequest, headers: Headers): Promise<void> {
    await this.users.withAdminLock(orgId, async (tx) => {
      const current = await this.users.findInOrg(orgId, userId, tx);
      if (current === null) throw userNotFound(userId);
      const takesOut = isActiveAdmin(current) && (input.isAdmin === false || input.disabled === true);
      if (takesOut && (await this.users.countActiveAdmins(orgId, tx)) <= 1) throw lastAdmin();

      try {
        if (input.name !== undefined) {
          await auth.api.adminUpdateUser({ body: { userId, data: { name: input.name } }, headers });
        }
        if (input.isAdmin !== undefined) {
          await auth.api.setRole({ body: { userId, role: input.isAdmin ? 'admin' : 'user' }, headers });
        }
        if (input.disabled === true) await auth.api.banUser({ body: { userId }, headers });
        if (input.disabled === false) await auth.api.unbanUser({ body: { userId }, headers });
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
   * Not under the admin lock: it changes nobody's admin.
   */
  async resetPassword(userId: string, password: string, headers: Headers): Promise<void> {
    try {
      await auth.api.setUserPassword({ body: { userId, newPassword: password }, headers });
    } catch (err) {
      throw fromBetterAuth(err, userId);
    }
    await this.users.setMustChangePassword(userId, true);
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
