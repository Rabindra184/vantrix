import type { PrismaClient } from '@prisma/client';

/**
 * A user belongs to at most one org for now. `findOrgForUser` returns a single
 * row deliberately rather than a list, so a caller cannot silently pick the
 * wrong one.
 *
 * The membership says only "this person belongs to this install". It carries
 * no role: the admin flag is `user.role`, and what a non-admin may do in a
 * project is a `project_member` row (ProjectMemberRepository).
 */
export class OrgMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOrgForUser(userId: string): Promise<{ orgId: string } | null> {
    const row = await this.prisma.orgMember.findFirst({
      where: { userId },
      select: { orgId: true },
      orderBy: { createdAt: 'asc' },
    });
    return row ?? null;
  }

  async add(userId: string, orgId: string): Promise<void> {
    await this.prisma.orgMember.create({ data: { userId, orgId } });
  }
}
