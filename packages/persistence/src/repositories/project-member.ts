import { PROJECT_ROLES, type ProjectRole } from '@perfportal/contracts';
import type { PrismaClient } from '@prisma/client';

/**
 * A person's role in each project they may see. An admin needs no row here:
 * the admin flag is `user.role`, and an admin sees every project whether or
 * not they hold one.
 */
export class ProjectMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

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
   */
  async add(input: { projectId: string; userId: string; role: ProjectRole; addedBy: string | null }): Promise<void> {
    await this.prisma.projectMember.create({ data: input });
  }

  /** A no-op for a membership that does not exist. */
  async remove(projectId: string, userId: string): Promise<void> {
    await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
  }
}

/**
 * The table's CHECK refuses anything outside the three roles, so this throws
 * only if that constraint and `PROJECT_ROLES` have drifted apart — loudly,
 * rather than handing an unranked role to a permission check.
 */
function asProjectRole(role: string): ProjectRole {
  const known = PROJECT_ROLES.find((r) => r === role);
  if (known === undefined) {
    throw new Error(`project_member holds role '${role}', which is not one of ${PROJECT_ROLES.join(', ')}.`);
  }
  return known;
}
