import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  MintTokenRequestSchema,
  MintedTokenSchema,
  TokenListResponseSchema,
  TokenSummarySchema,
  type MintedToken,
  type TokenListResponse,
  type TokenSummary,
} from '@perfportal/contracts';
import { hashToken, mintToken, splitToken } from '@perfportal/core';
import { ProjectRepository, TokenRepository, type TokenSummaryRow } from '@perfportal/persistence';
import type { Request } from 'express';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest } from '../common/validation.js';

/**
 * Mints a project API token — the one credential-issuing route on this API.
 *
 * `@UseGuards(SessionOnlyGuard)` on the CLASS, not the handler, and no
 * `@Scopes(...)` anywhere in this file. See session-only.guard.ts for why: a
 * scope check would let any bearer credential holding that scope mint itself
 * a broader one, which is the exact escalation this route exists to prevent.
 * Class-level also means a second handler added to this controller later
 * (GET, DELETE — see Task 4) inherits the guard rather than needing to
 * remember it.
 */
@Controller('/v1/projects/:slug/tokens')
@UseGuards(SessionOnlyGuard)
export class TokensController {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly projects: ProjectRepository,
  ) {}

  @Post()
  @HttpCode(201)
  async mint(@Param('slug') slug: string, @Req() req: Request, @Body() body: unknown): Promise<MintedToken> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const parsed = MintTokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_TOKEN_REQUEST',
        `The token request is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'Send a non-empty "name" and at least one scope from ["ingest", "read", "telemetry"].',
      );
    }

    const minted = mintToken();
    const parts = splitToken(minted.token);
    // UNREACHABLE: mintToken() always produces the "pp_<hex>_<hex>" layout
    // splitToken() itself parses — both live in @perfportal/core specifically
    // so they cannot drift apart. Kept so a future format change to one
    // without the other fails loudly here instead of hashing `undefined`.
    if (!parts) throw new Error('mintToken() produced a token splitToken() could not parse.');
    const tokenHash = await hashToken(parts.secret);

    const row = await this.tokens.create({
      orgId: tenant.orgId,
      projectId: project.id,
      name: parsed.data.name,
      prefix: minted.prefix,
      tokenHash,
      scopes: parsed.data.scopes,
    });

    // ═══ THE TENANT COMES FROM THE TOKEN ═══ — see TelemetryController for
    // the same rule the other direction. `row.token` does not exist (see
    // TokenSummaryRow's docstring); the plaintext returned below comes only
    // from `minted`, computed above and never persisted, because this is the
    // one moment it will ever be readable again.
    return MintedTokenSchema.parse({
      token: minted.token,
      prefix: row.prefix,
      name: row.name,
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
    });
  }

  /**
   * Lists this project's tokens — never the secret, never the hash. See
   * `TokenSummaryRow`'s docstring in @perfportal/persistence for why
   * `listForProject`'s own `select` already makes that true one layer down;
   * `toSummary` below is what carries the guarantee through to the wire
   * shape, converting `Date` to the ISO string `TokenSummarySchema` expects.
   */
  @Get()
  async list(@Param('slug') slug: string, @Req() req: Request): Promise<TokenListResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const rows = await this.tokens.listForProject(tenant.orgId, project.id);
    return TokenListResponseSchema.parse({ tokens: rows.map((row) => this.toSummary(row)) });
  }

  /**
   * Revokes by prefix, scoped to this project. `revokeByPrefix` returns null
   * when the prefix names no token in this project (unknown, or belonging to
   * a different project/org) — turned into a 404 here, the same "never
   * confirm what exists elsewhere" rule `resolveProject` applies to the slug
   * itself. Idempotent: a second call on an already-revoked token still
   * returns 200 with the ORIGINAL `revokedAt` (see revokeByPrefix), not a
   * fresh one — this handler does not need to know that to be idempotent
   * itself, since it just forwards whatever the repository returns.
   */
  @Delete(':prefix')
  async revoke(
    @Param('slug') slug: string,
    @Param('prefix') prefix: string,
    @Req() req: Request,
  ): Promise<TokenSummary> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const row = await this.tokens.revokeByPrefix(tenant.orgId, project.id, prefix);
    if (!row) throw new NotFoundException(`No token "${prefix}" in project "${slug}".`);
    return this.toSummary(row);
  }

  /**
   * Shared by `mint`, `list`, and `revoke`. 404, never 403, for a slug
   * outside the caller's org — the status must never confirm that another
   * org's project exists.
   */
  private async resolveProject(orgId: string, slug: string) {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (!project) throw new NotFoundException(`No project "${slug}" in this organisation.`);
    return project;
  }

  private toSummary(row: TokenSummaryRow): TokenSummary {
    return TokenSummarySchema.parse({
      prefix: row.prefix,
      name: row.name,
      scopes: row.scopes,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    });
  }
}
