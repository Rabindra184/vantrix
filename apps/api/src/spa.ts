import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

/**
 * Every path prefix the API owns. The SPA handler must decline all of them.
 *
 * This is a list rather than a pattern because it has to be exhaustive, and an
 * omission is silent: the missing prefix simply starts returning index.html
 * with a 200. The first version of this file listed only /v1 and /auth and so
 * swallowed /healthz and /readyz - which is worse than a broken page, because a
 * readiness probe that answers 200 with HTML tells an orchestrator the process
 * is healthy while its database is unreachable.
 *
 * ADDING A ROUTE OUTSIDE /v1 MEANS ADDING IT HERE. The companion test asserts
 * each entry individually, so a new prefix without a new assertion is visible.
 *
 * /v1/docs and /v1/openapi.json need no entry of their own - they are under /v1.
 */
export const API_PREFIXES = ['/v1', '/auth', '/healthz', '/readyz'] as const;

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Mounted BEFORE Nest's router, because Nest terminates unmatched requests
 * with its own 404 - static registered after it would never be reached.
 * Being early is what forces this handler to exclude the API surface itself.
 *
 * The exclusion is the point: without it, GET /v1/nonsense falls into the SPA
 * fallback and returns index.html with a 200. A client expecting RFC 9457
 * then parses HTML as a problem document, and fails somewhere unrelated.
 *
 * No-op when dist is absent, so `pnpm --filter @perfportal/api dev` works
 * without a web build.
 */
export function mountSpa(instance: express.Express, distDir: string): void {
  if (!existsSync(join(distDir, 'index.html'))) return;
  const assets = express.static(distDir, { index: false });

  instance.use((req, res, next) => {
    if (isApiPath(req.path)) return next();
    assets(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(distDir, 'index.html'));
    });
  });
}
