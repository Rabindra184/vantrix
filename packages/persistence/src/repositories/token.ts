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
   * incident: the leaked token string. `mintToken` (`@perfportal/core`)
   * builds the token as `${prefix}_${secret}` where `prefix` is already
   * `pp_<hex>` — so the prefix is everything up to the LAST underscore of
   * `pp_<hex>_<secret>`, not merely the middle segment between two
   * underscores. An id would need a lookup first.
   *
   * IDEMPOTENT: an already-revoked token keeps its original `revokedAt` rather
   * than having it moved, so a retry after a timeout returns the same answer
   * and the record still says when the credential actually stopped working.
   * Returns null when no such token exists in this project — the caller turns
   * that into a 404.
   */
  async revokeByPrefix(orgId: string, projectId: string, prefix: string): Promise<TokenSummaryRow | null> {
    // `revokedAt: null` belongs in the WHERE, not in a preceding read. Read
    // first and update second and two concurrent revocations both see an
    // active row, both update, and the later timestamp overwrites the
    // earlier — which breaks the idempotency promised just above, since the
    // first caller's answer stops matching what the record says. With the
    // condition in the statement the database settles it: exactly one update
    // matches, and a loser matches zero rows and writes nothing.
    await this.prisma.apiToken.updateMany({
      where: { orgId, projectId, prefix, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Then read back whatever now stands. One query covers all three
    // outcomes — won the race, lost it (and so returns the winner's
    // timestamp, not a second one), or was revoked long ago — and null still
    // means no such token in this project, which the caller turns into a 404.
    return this.prisma.apiToken.findFirst({
      where: { orgId, projectId, prefix },
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
