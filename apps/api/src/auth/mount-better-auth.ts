import type { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './better-auth.instance.js';

/**
 * Mounted on the raw Express instance, outside /v1, and BEFORE Nest's body
 * parser (registered during app.init()/app.listen()): Better Auth needs the
 * raw, unparsed body for sign-in. '/auth/*splat' is Express 5's
 * named-wildcard syntax; '/auth/*' does not match.
 *
 * Shared by main.ts (the production entry point) and
 * test/support/app.ts (the integration-test harness) so the auth surface
 * cannot silently diverge between them: this line is the entire mount, and a
 * production-only change here (or a test-only one) would fail invisibly —
 * no test would catch a production app mounting something the harness
 * doesn't, because the harness would simply never exercise it.
 *
 * NOTHING HERE MAY BE TRUSTED TO FILTER WHAT BETTER AUTH ROUTES. Its Node
 * adapter builds the URL it routes from `X-Forwarded-Proto` and `Host` as
 * well as the path, so a request Express sees as `/auth/get-session` can be
 * routed by Better Auth as `/auth/admin/list-users`. The admin plugin's HTTP
 * routes are therefore refused inside Better Auth's own pipeline — the
 * `refuseServerOnlyRoutes` plugin in `createAuth`, which also refuses
 * `/auth/change-password` and `/auth/verify-password` — and not by a guard in
 * front of this handler, which is where two bypassable versions of it used to
 * live.
 */
export function mountBetterAuth(app: INestApplication): void {
  app.getHttpAdapter().getInstance().all('/auth/*splat', toNodeHandler(auth));
}
