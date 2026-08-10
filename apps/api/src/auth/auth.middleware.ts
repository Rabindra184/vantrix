import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
  type NestMiddleware,
} from '@nestjs/common';
import { OrgMemberRepository, TokenRepository } from '@perfportal/persistence';
import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { authenticateRequest, type Tenant } from './auth.guard.js';
import { auth } from './better-auth.instance.js';
import { internalProblem, logInternalError, problem } from '../common/problem.js';

/**
 * Express exposes req.headers as a plain object with string | string[]
 * values; Better Auth's server API needs a real Headers instance and calls
 * .get() on it. fromNodeHeaders does the conversion — `new Headers(req.headers)`
 * almost works but mishandles multi-value headers, which the Cookie path can
 * produce.
 *
 * getSession() returns null (it does not throw) for a missing, invalid or
 * expired session; that maps to 401, exactly as an unrecognised bearer token
 * does. A valid session with no org membership is a DIFFERENT failure —
 * authentication succeeded, so that one is a 403 (spec §7), not a 401.
 */
async function authenticateSession(req: Request, members: OrgMemberRepository): Promise<Tenant> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) throw new UnauthorizedException('No valid session cookie.');

  const membership = await members.findOrgForUser(session.user.id);
  if (!membership) throw new ForbiddenException('This user belongs to no organization.');

  // No projectId: a session is org-scoped (spec §4.1) — a human may read any
  // run in their org. Scopes are full within the org; RBAC is M6.
  return {
    orgId: membership.orgId,
    tokenId: `session:${session.session.id}`,
    scopes: ['read', 'ingest'],
  };
}

/**
 * AuthGuard (auth.guard.ts) only runs for requests Nest has already matched
 * to a controller — that is how NestJS guards work, and it is not something
 * `useGlobalGuards`/`APP_GUARD` changes. A request under a path this app
 * hasn't wired a controller for yet (e.g. GET /v1/runs/:id before Task 13
 * adds it) never reaches any guard at all; Nest/Express answer it with a
 * plain 404 before authentication is even considered.
 *
 * Every route this API will ever serve lives under /v1, so this middleware
 * is mounted on that whole prefix (see app.module.ts) to authenticate the
 * request before routing decides whether a handler exists — closing that
 * gap for API-shaped requests, not just ones that happen to match a route
 * that exists today. It does not check scopes: scope requirements are
 * declared per-route with @Scopes(), which needs handler metadata that
 * doesn't exist yet at the middleware stage. AuthGuard still runs afterward
 * on routes that use it and enforces those.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly members: OrgMemberRepository,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Dispatch on the credential present. `Authorization: Bearer …` takes
      // the existing, untouched bearer path — CI ingest depends on this not
      // shifting. Anything else (a session cookie, or no credential at all)
      // attempts the session: getSession() rejects a missing cookie exactly
      // like an absent bearer token, so "neither" naturally falls out of
      // that same branch as a 401 rather than needing a third case here.
      const authHeader = req.headers.authorization;
      const hasBearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ');
      req.tenant = hasBearer
        ? await authenticateRequest(req, this.tokens)
        : await authenticateSession(req, this.members);
      next();
    } catch (err) {
      // A deliberate rejection from the authentication path itself (bad,
      // missing, or revoked token; missing/invalid/expired session; or a
      // valid session belonging to no org) — safe to surface as-is; it never
      // contains anything but the messages authenticateRequest/
      // authenticateSession construct.
      if (err instanceof HttpException) {
        const status = err.getStatus();
        // 403 (valid session, no org membership) gets its own code and
        // remediation; every other HttpException here is a 401, and its
        // code/remediation are exactly what they were before the session
        // branch existed — the bearer-token path must not shift by a byte.
        const body =
          status === 403
            ? problem(
                'FORBIDDEN',
                status,
                err.message,
                'Ask an administrator to add this account to an organization.',
              )
            : problem(
                'UNAUTHENTICATED',
                status,
                err.message,
                'Provide a bearer API token in the Authorization header (for CI/machine ' +
                  'callers), or sign in at POST /auth/sign-in/email to obtain a session ' +
                  'cookie (for a browser).',
              );
        res.status(status).type('application/problem+json').send(body);
        return;
      }

      // Anything else (e.g. the database is unreachable) is an outage, not
      // an authentication failure, and its message may contain internal
      // infrastructure detail (hosts, ports, ORM internals) that must never
      // reach an unauthenticated caller. Mirror ProblemFilter's catch-all
      // exactly via the shared helpers so the two paths can't drift apart.
      const traceId = randomUUID();
      logInternalError(err, traceId);
      res.status(500).type('application/problem+json').send(internalProblem(traceId));
    }
  }
}
