import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Refuses any BEARER credential, allowing only a signed-in human's session.
 *
 * ═══ WHY THIS IS NOT `@Scopes(...)` ═══
 *
 * A scope check passes for any credential that holds the scope — including a
 * bearer token. `@Scopes('read')` on a token-minting route therefore lets a
 * leaked read-only CI credential mint itself an `ingest` token: privilege
 * escalation through the front door, with every guard behaving exactly as
 * designed. Authorisation here is not "which scope" but "is this a human".
 *
 * The discriminator already existed and needs no new plumbing:
 * `AuthMiddleware.authenticateSession` sets `tenant.tokenId` to
 * `session:<session-id>`, while `authenticateRequest` sets it to the token
 * row's id. A bearer credential cannot produce the prefix.
 *
 * A GUARD rather than a line in each handler, so it reads as a policy and a
 * second credential-issuing route added later cannot quietly omit it.
 *
 * Ordering is safe: the global APP_GUARD (`AuthGuard`) runs before route
 * guards, so `req.tenant` is always populated by the time this runs.
 */
export const SESSION_TOKEN_ID_PREFIX = 'session:';

@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tokenId = req.tenant?.tokenId ?? '';
    if (!tokenId.startsWith(SESSION_TOKEN_ID_PREFIX)) {
      throw new ForbiddenException(
        'API tokens are minted by a signed-in user, not by a machine credential. ' +
          'Sign in at POST /auth/sign-in/email and retry with the session cookie.',
      );
    }
    return true;
  }
}
