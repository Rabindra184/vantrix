import { Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { MintTokenRequestSchema, MintedTokenSchema, type MintedToken } from '@perfportal/contracts';
import { hashToken, mintToken, splitToken } from '@perfportal/core';
import { ProjectRepository, TokenRepository } from '@perfportal/persistence';
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

    const project = await this.projects.findBySlugInOrg(tenant.orgId, slug);
    // 404, never 403: matches how a foreign run/project is treated elsewhere
    // in this API — the status must never confirm that another org's
    // project exists.
    if (!project) throw new NotFoundException(`No project "${slug}" in this organisation.`);

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
}
