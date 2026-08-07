import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, SCOPES_KEY, type TokenScope } from './scopes.decorator.js';
import { splitToken, verifyToken } from './tokens.js';

export interface Tenant {
  orgId: string;
  projectId: string;
  tokenId: string;
  scopes: string[];
}

declare module 'express' {
  interface Request {
    tenant?: Tenant;
  }
}

/**
 * The bearer-token check shared by AuthGuard (route-level, scope-aware) and
 * AuthMiddleware (perimeter-level, applied to the whole /v1 prefix — see
 * that file for why routing alone cannot do this). Throws UnauthorizedException
 * on any failure; never returns a partial or unverified tenant.
 */
export async function authenticateRequest(req: Request, tokens: TokenRepository): Promise<Tenant> {
  const header = req.headers.authorization ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const parts = raw ? splitToken(raw) : null;
  if (!parts) throw new UnauthorizedException('A bearer API token is required.');

  const record = await tokens.findByPrefix(parts.prefix);
  if (!record) throw new UnauthorizedException('Unknown API token.');
  if (record.revokedAt) throw new UnauthorizedException('This API token has been revoked.');
  if (!(await verifyToken(record.tokenHash, parts.secret))) {
    throw new UnauthorizedException('Invalid API token.');
  }

  return {
    orgId: record.orgId,
    projectId: record.projectId,
    tokenId: record.id,
    scopes: record.scopes,
  };
}

/**
 * Registered globally via APP_GUARD in auth.module.ts, so every route on
 * the app authenticates and has its @Scopes() enforced by default — a
 * handler can no longer skip scope enforcement just by forgetting
 * @UseGuards(AuthGuard). Routes that must stay reachable with no token
 * (/healthz, /readyz) opt out explicitly with @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();

    // Reuse req.tenant when AuthMiddleware already authenticated this
    // request (true for everything under /v1) to avoid a second database
    // round-trip; only routes outside that prefix hit the database here.
    const tenant = req.tenant ?? (await authenticateRequest(req, this.tokens));

    const required = this.reflector.getAllAndOverride<TokenScope[]>(SCOPES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) ?? [];
    for (const scope of required) {
      if (!tenant.scopes.includes(scope)) {
        throw new ForbiddenException(
          `This token lacks the "${scope}" scope. A CI credential is not automatically a read credential.`,
        );
      }
    }

    req.tenant = tenant;
    return true;
  }
}
