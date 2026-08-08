import type { PrismaClient } from '@prisma/client';

export interface TokenRecord {
  id: string;
  orgId: string;
  projectId: string;
  prefix: string;
  tokenHash: string;
  scopes: string[];
  revokedAt: Date | null;
  lastUsedAt: Date | null;
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
      lastUsedAt: row.lastUsedAt,
    };
  }

  /**
   * Records that this token was just used. Unscoped by design: the caller
   * (authenticateRequest) has just verified the token itself, which is a
   * stronger check than any tenancy scope this method could additionally
   * demand.
   *
   * Callers should not do this on every request — see
   * apps/api/src/auth/auth.guard.ts, which only calls it when the loaded
   * record's last_used_at is missing or stale, so an active token costs at
   * most one extra write per interval instead of one per request.
   */
  async touch(id: string): Promise<void> {
    await this.prisma.apiToken.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
