import { PROJECT_ROLES, type ProjectRole } from '@perfportal/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * A person's role in each project they may see. An admin needs no row here:
 * the admin flag is `user.role`, and an admin sees every project whether or
 * not they hold one.
 *
 * Takes a transaction client as readily as the root one (see
 * `OrgMemberRepository`): a create writes a person's roles in the same
 * transaction as their membership of the install.
 */
export class ProjectMemberRepository {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  /**
   * Every project the user holds a role in, keyed by project id. Meant to be
   * read per request and never cached on the session, so a removal or a role
   * change takes effect on the very next request.
   */
  async rolesForUser(userId: string): Promise<Map<string, ProjectRole>> {
    const rows = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true, role: true },
    });
    return new Map(rows.map((r) => [r.projectId, asProjectRole(r.role)]));
  }

  /**
   * A plain create: a second membership for the same person in the same
   * project is refused by the primary key and throws, rather than quietly
   * changing the role it already holds.
   *
   * The four fields are named, never `data: input`: a caller handing over a
   * wider object (a request body, say) would otherwise pass its extra fields
   * through, and Prisma refuses an unknown one outright.
   */
  async add(input: { projectId: string; userId: string; role: ProjectRole; addedBy: string | null }): Promise<void> {
    await this.prisma.projectMember.create({
      data: { projectId: input.projectId, userId: input.userId, role: input.role, addedBy: input.addedBy },
    });
  }

  /** Everyone holding a role in the project, by name. */
  async listForProject(projectId: string): Promise<ProjectMemberRow[]> {
    const rows = await this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
      select: MEMBER_SELECT,
    });
    return rows.map(toMemberRow);
  }

  /** One person's membership of the project, in `listForProject`'s shape; null when they hold none. */
  async find(projectId: string, userId: string): Promise<ProjectMemberRow | null> {
    const row = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: MEMBER_SELECT,
    });
    return row ? toMemberRow(row) : null;
  }

  /** Changes an existing membership's role. False when there is none: this never creates one. */
  async setRole(projectId: string, userId: string, role: ProjectRole): Promise<boolean> {
    const { count } = await this.prisma.projectMember.updateMany({ where: { projectId, userId }, data: { role } });
    return count > 0;
  }

  /** Members per project, with an entry (0) for every id asked about that has none. */
  async memberCounts(projectIds: string[]): Promise<Map<string, number>> {
    const counts = new Map(projectIds.map((id) => [id, 0]));
    if (projectIds.length === 0) return counts;
    const groups = await this.prisma.projectMember.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    });
    for (const g of groups) counts.set(g.projectId, g._count._all);
    return counts;
  }

  /**
   * Ends a membership. False when there was none, and then nothing changed:
   * the delete itself says whether it found a row, so a caller answering
   * "not a member" needs no read before it that a concurrent removal could
   * make stale.
   */
  async remove(projectId: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
    return count > 0;
  }
}

/**
 * A membership as the members routes answer it. `addedAt` is the row's
 * `created_at`, a timestamptz, so it is the same instant whoever reads it.
 */
export interface ProjectMemberRow {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  addedAt: Date;
}

const MEMBER_SELECT = {
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
} as const;

function toMemberRow(r: {
  userId: string;
  role: string;
  createdAt: Date;
  user: { name: string; email: string };
}): ProjectMemberRow {
  return { userId: r.userId, name: r.user.name, email: r.user.email, role: asProjectRole(r.role), addedAt: r.createdAt };
}

/**
 * The table's CHECK refuses anything outside the three roles, so this throws
 * only if that constraint and `PROJECT_ROLES` have drifted apart — loudly,
 * rather than handing an unranked role to a permission check. Shared with
 * `UserRepository`, which reads the same column.
 */
export function asProjectRole(role: string): ProjectRole {
  const known = PROJECT_ROLES.find((r) => r === role);
  if (known === undefined) {
    throw new Error(`project_member holds role '${role}', which is not one of ${PROJECT_ROLES.join(', ')}.`);
  }
  return known;
}
