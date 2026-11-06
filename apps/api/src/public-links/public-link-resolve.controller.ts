import { Controller, Get, Req } from '@nestjs/common';
import { PublicLinkResolveResponseSchema, type PublicLinkResolveResponse } from '@perfportal/contracts';
import type { Request } from 'express';
import { PublicLinkOnly } from '../auth/access.decorator.js';
import { onlyAPublicLink } from '../common/validation.js';

/**
 * ═══ GET /v1/public-link — WHICH RUN THIS LINK READS ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md,
 * section 4.3)
 *
 * The public page's first call: its URL carries only the secret, so this is
 * how it learns which run it is reading, and until when.
 *
 * `@PublicLinkOnly`, the sixth exclusive access marker: `AccessGuard` lets a
 * link tenant through and answers every other caller 404, so the answer comes
 * from the tenant `authenticatePublicLink` built for THIS request — the link's
 * row as it read a moment ago, revocation, the switch and the expiry already
 * checked. Nothing here reads the database again.
 */
@Controller('/v1/public-link')
export class PublicLinkResolveController {
  @Get()
  @PublicLinkOnly()
  resolve(@Req() req: Request): PublicLinkResolveResponse {
    const link = req.tenant?.publicLink;
    const runId = link?.runIds[0];
    // Unreachable past AccessGuard, which admits no other tenant here; refused
    // as that guard refuses any other caller, should a later change open it.
    if (link === undefined || runId === undefined) throw onlyAPublicLink();
    return PublicLinkResolveResponseSchema.parse({ runId, expiresAt: link.expiresAt.toISOString() });
  }
}
