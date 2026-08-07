import { randomUUID } from 'node:crypto';
import { HttpException, Injectable, type NestMiddleware } from '@nestjs/common';
import { TokenRepository } from '@perfportal/persistence';
import type { NextFunction, Request, Response } from 'express';
import { authenticateRequest } from './auth.guard.js';
import { internalProblem, logInternalError, problem } from '../common/problem.js';

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
  constructor(private readonly tokens: TokenRepository) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      req.tenant = await authenticateRequest(req, this.tokens);
      next();
    } catch (err) {
      // A deliberate rejection from the authentication path itself (bad,
      // missing, or revoked token) — safe to surface as-is; it never
      // contains anything but the messages authenticateRequest constructs.
      if (err instanceof HttpException) {
        const status = err.getStatus();
        const body = problem(
          'UNAUTHENTICATED',
          status,
          err.message,
          'Provide a valid bearer API token in the Authorization header.',
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
