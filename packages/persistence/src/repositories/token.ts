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

/**
 * What a token looks like to anything outside this repository.
 *
 * NO `tokenHash`. The hash never leaves this layer — a list endpoint that
 * returned it would hand an attacker the one value that makes an offline
 * attack possible, and a `select` that names its columns is what keeps that
 * true when someone later adds a field.
 */
export interface TokenSummaryRow {
  prefix: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const SUMMARY_SELECT = {
  prefix: true, name: true, scopes: true,
  createdAt: true, lastUsedAt: true, revokedAt: true,
} as const;

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
   * Stores a minted token. The caller mints and hashes — this layer never sees
   * a plaintext secret, which is why `tokenHash` is a parameter rather than
   * something computed here.
   */
  async create(input: {
    orgId: string; projectId: string; name: string;
    prefix: string; tokenHash: string; scopes: string[];
  }): Promise<TokenSummaryRow> {
    return this.prisma.apiToken.create({ data: input, select: SUMMARY_SELECT });
  }

  /** Newest first — the one just minted is the one being looked for. */
  async listForProject(orgId: string, projectId: string): Promise<TokenSummaryRow[]> {
    return this.prisma.apiToken.findMany({
      where: { orgId, projectId },
      select: SUMMARY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes by PREFIX, scoped to the project.
   *
   * By prefix rather than id because of what an operator holds during an
   * incident: the leaked token string, whose middle segment IS the prefix
   * (`pp_<prefix>_<secret>`). An id would need a lookup first.
   *
   * IDEMPOTENT: an already-revoked token keeps its original `revokedAt` rather
   * than having it moved, so a retry after a timeout returns the same answer
   * and the record still says when the credential actually stopped working.
   * Returns null when no such token exists in this project — the caller turns
   * that into a 404.
   */
  async revokeByPrefix(orgId: string, projectId: string, prefix: string): Promise<TokenSummaryRow | null> {
    const existing = await this.prisma.apiToken.findFirst({
      where: { orgId, projectId, prefix },
      select: SUMMARY_SELECT,
    });
    if (!existing) return null;
    if (existing.revokedAt) return existing;

    return this.prisma.apiToken.update({
      where: { prefix },
      data: { revokedAt: new Date() },
      select: SUMMARY_SELECT,
    });
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
