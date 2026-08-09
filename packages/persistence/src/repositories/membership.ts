import type { PrismaClient } from '@prisma/client';

/**
 * A user belongs to at most one org for now. RBAC and multi-org membership are
 * M6; `findOrgForUser` returns a single row deliberately rather than a list, so
 * a caller cannot silently pick the wrong one.
 */
export class OrgMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOrgForUser(userId: string): Promise<{ orgId: string; role: string } | null> {
    const row = await this.prisma.orgMember.findFirst({
      where: { userId },
      select: { orgId: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return row ?? null;
  }

  async add(userId: string, orgId: string, role: string): Promise<void> {
    await this.prisma.orgMember.create({ data: { userId, orgId, role } });
  }
}
