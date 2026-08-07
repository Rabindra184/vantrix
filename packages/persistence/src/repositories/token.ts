import type { PrismaClient } from '@prisma/client';

export interface TokenRecord {
  id: string;
  orgId: string;
  projectId: string;
  prefix: string;
  tokenHash: string;
  scopes: string[];
  revokedAt: Date | null;
}

export class TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** One indexed row read; the caller then performs exactly one hash verification. */
  async findByPrefix(prefix: string): Promise<TokenRecord | null> {
    const row = await this.prisma.apiToken.findUnique({ where: { prefix } });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      prefix: row.prefix,
      tokenHash: row.tokenHash,
      scopes: row.scopes,
      revokedAt: row.revokedAt,
    };
  }

  /** Unscoped by design: the auth guard, on a token it has just verified. */
  async touch(id: string): Promise<void> {
    await this.prisma.apiToken.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
