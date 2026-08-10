import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';

/**
 * Mounted BEFORE Nest's router, because Nest terminates unmatched requests
 * with its own 404 - static registered after it would never be reached.
 * Being early means this handler must exclude the API prefixes itself.
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
    if (req.path.startsWith('/v1') || req.path.startsWith('/auth')) return next();
    assets(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(distDir, 'index.html'));
    });
  });
}
