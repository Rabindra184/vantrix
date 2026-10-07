import type { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { Express, NextFunction, Request, Response } from 'express';
import { auth } from './better-auth.instance.js';

/**
 * Mounted on the raw Express instance, outside /v1, and BEFORE Nest's body
 * parser (registered during app.init()/app.listen()): Better Auth needs the
 * raw, unparsed body for sign-in. '/auth/*splat' is Express 5's
 * named-wildcard syntax; '/auth/*' does not match.
 *
 * Shared by main.ts (the production entry point) and
 * test/support/app.ts (the integration-test harness) so the auth surface
 * cannot silently diverge between them: this function is the entire mount,
 * and a production-only change here (or a test-only one) would fail
 * invisibly — no test would catch a production app mounting something the
 * harness doesn't, because the harness would simply never exercise it.
 */
export function mountBetterAuth(app: INestApplication): void {
  const express: Express = app.getHttpAdapter().getInstance();
  express.all('/auth/*splat', refuseAdminRoutes);
  express.all('/auth/*splat', toNodeHandler(auth));
}

/* ═══ THE ADMIN PLUGIN'S OWN ROUTES ARE REFUSED, AHEAD OF BETTER AUTH ═══
 *
 * `createAuth` registers Better Auth's admin plugin for its SERVER-SIDE calls
 * (bootstrap, and the `/v1/admin` routes to come). Its HTTP surface —
 * list-users, create-user, set-role, ban-user, impersonate-user and the rest
 * — would otherwise be served here too, to any admin's cookie: a second,
 * undocumented admin API answering in Better Auth's shapes rather than
 * problem+json, beside the one place admin operations are meant to go and be
 * recorded.
 *
 * The answer is a bare 404 with no body, which is what Better Auth itself
 * gives a path it does not serve, so these routes read as absent rather than
 * as present-and-forbidden.
 *
 * ═══ WHY NOT JUST `express.all('/auth/admin/*splat', …)` ═══
 *
 * That was the first version, and it was bypassable. Express matches the path
 * AS SENT; Better Auth resolves it through `new URL()` first, which collapses
 * dot segments. Measured against this mount with an admin's cookie:
 *
 *     /auth/admin/list-users          404  (the route guard)
 *     /auth/./admin/list-users        200  every account in the install
 *     /auth/foo/../admin/list-users   200  likewise
 *     /auth/%2e/admin/list-users      200  likewise: WHATWG URL reads %2e as a dot
 *
 * A browser normalises those before sending; `curl --path-as-is` and any raw
 * client do not. So the guard asks the question the way Better Auth will
 * answer it: resolve the path with the same WHATWG URL parser, decode it,
 * and refuse anything that lands under
 * `/auth/admin`, in any case. A path that cannot be resolved at all is
 * refused too — the strict reading of a request nobody legitimate sends. */
function refuseAdminRoutes(req: Request, res: Response, next: NextFunction): void {
  if (resolvesToAdminRoute(req.originalUrl)) {
    res.status(404).end();
    return;
  }
  next();
}

function resolvesToAdminRoute(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch {
    return true;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  return /^\/auth\/admin(\/|$)/i.test(path);
}
