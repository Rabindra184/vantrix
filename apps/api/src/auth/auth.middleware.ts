import { HttpException, Injectable, type NestMiddleware } from '@nestjs/common';
import { TokenRepository } from '@perfportal/persistence';
import type { NextFunction, Request, Response } from 'express';
import { authenticateRequest } from './auth.guard.js';
import { problem } from '../common/problem.js';

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
      const status = err instanceof HttpException ? err.getStatus() : 401;
      const detail = err instanceof Error ? err.message : 'Authentication failed.';
      const body = problem(
        'UNAUTHENTICATED',
        status,
        detail,
        'Provide a valid bearer API token in the Authorization header.',
      );
      res.status(status).type('application/problem+json').send(body);
    }
  }
}
