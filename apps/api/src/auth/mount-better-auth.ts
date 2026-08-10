import type { INestApplication } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './better-auth.instance.js';

/**
 * Mounted on the raw Express instance, outside /v1, and BEFORE Nest's body
 * parser (registered during app.init()/app.listen()): Better Auth needs the
 * raw, unparsed body for sign-up and sign-in. '/auth/*splat' is Express 5's
 * named-wildcard syntax; '/auth/*' does not match.
 *
 * Shared by main.ts (the production entry point) and
 * test/support/app.ts (the integration-test harness) so the auth surface
 * cannot silently diverge between them: this line is the entire mount, and a
 * production-only change here (or a test-only one) would fail invisibly —
 * no test would catch a production app mounting something the harness
 * doesn't, because the harness would simply never exercise it.
 */
export function mountBetterAuth(app: INestApplication): void {
  app.getHttpAdapter().getInstance().all('/auth/*splat', toNodeHandler(auth));
}
