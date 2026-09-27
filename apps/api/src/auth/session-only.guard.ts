import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { forbidden } from '../common/validation.js';

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
 * ═══ IT GUARDS FAR MORE THAN TOKEN MINTING NOW, AND ITS SENTENCE SAYS SO ═══
 *
 * Token minting is the example above because it is the sharpest one, not the
 * only one: project creation, SLA rules, a test's PATCH and DELETE, and the
 * browser upload route carry this guard too. Its refusal used to read "API
 * tokens are minted by a signed-in user" — true of three routes and a
 * non-sequitur on the rest, where a CI token posting a rule was told about
 * minting tokens. The sentence below is true of every route that carries the
 * guard, and `openapi.integration.test.ts` derives that list from Nest's own
 * guard metadata rather than from anybody's memory of it.
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
      // The advice moved from the MESSAGE to the remediation, which is the
      // field a Problem document has for it — and which `ProblemFilter`
      // otherwise fills with "Check the request against the OpenAPI
      // description", useless for a request the document describes perfectly.
      throw forbidden(
        'This action needs a signed-in person; an API token cannot perform it, whatever its scopes.',
        'Sign in at POST /auth/sign-in/email and retry with the session cookie.',
      );
    }
    return true;
  }
}
