import { existsSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
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
 * ═══ CACHING: EVERYTHING HERE IS EITHER FOREVER OR NEVER ═══
 *
 * Vite fingerprints every emitted asset (`index-oRcKcgSw.js`), so the CONTENT
 * of a given URL under /assets/ cannot change — a rebuild produces a
 * different URL. That is exactly the condition `immutable` describes, and
 * without it `express.static`'s default is `max-age=0`: every reload
 * revalidates a megabyte of JavaScript, and a reader on a slow link pays a
 * round trip per asset for a file that could never have changed.
 *
 * `index.html` is the opposite and must be `no-cache`, because its URL is
 * stable while its content names the current fingerprints. A cached copy
 * points at assets a redeploy has deleted, and the app is blank until
 * somebody hard-reloads. `no-cache` still allows a 304 — it forbids using
 * the copy WITHOUT asking, which is the part that matters.
 *
 * Anything else in dist (a favicon, a robots.txt) has a stable URL and
 * mutable content, so it takes index.html's rule rather than the assets one.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/**
 * Judged on the path RELATIVE to dist, not the absolute one: a checkout that
 * happens to live under a directory called `assets` would otherwise mark
 * index.html immutable, and the symptom is a blank app after every redeploy
 * until each reader hard-reloads — for a year.
 */
function cacheControlFor(distDir: string, filePath: string): string {
  const rel = relative(distDir, filePath).split(sep).join('/');
  return rel.startsWith('assets/') ? IMMUTABLE : REVALIDATE;
}

/**
 * ═══ PRECOMPRESSED, NOT COMPRESSED PER REQUEST ═══
 *
 * `pnpm build:web` writes `<asset>.br` and `<asset>.gz` beside every
 * compressible asset (see apps/web/vite.config.ts's `precompress` plugin), so
 * this only has to negotiate and rewrite. Compressing on the fly instead
 * would spend CPU re-deriving the same bytes on every request, and would have
 * to do it at a low quality level to stay cheap — brotli at build time is
 * both faster to serve and roughly a third smaller than on-the-fly gzip.
 *
 * The rewrite works because `send` sets `Content-Type` only if the response
 * does not already have one, and this sets it from the ORIGINAL extension
 * before handing over: without that, `index-oRcKcgSw.js.br` is served as
 * `application/octet-stream` and the browser downloads the bundle instead of
 * running it.
 *
 * A dist with no precompressed files (the integration fixture, or a build
 * from before this existed) simply never matches, and every asset is served
 * exactly as it was.
 */
const ENCODINGS = [
  { encoding: 'br', suffix: '.br' },
  { encoding: 'gzip', suffix: '.gz' },
] as const;

/**
 * Spelled out rather than looked up through `mime-types`. Only the five
 * extensions the build precompresses can reach here, and an explicit map is
 * one fewer transitive dependency to be right about.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * `req.path` is the raw pathname — Express does not decode it and does not
 * normalise it — so a request for `/assets/../../secret.js` arrives with the
 * `..` intact. `express.static` refuses to serve outside its root either way,
 * but this handler reaches the filesystem itself (`existsSync`) one step
 * earlier, and a traversal probe must not get so far as a stat call. Anything
 * with a `..` segment, encoded or not, simply does not qualify for the
 * precompressed variant and is passed straight to `express.static`.
 */
function isSafeAssetPath(path: string): boolean {
  // A NUL byte truncates the string a C-level syscall sees; Node rejects it
  // outright these days, but not reaching the syscall is cheaper than
  // relying on that.
  if (/\u0000/.test(path)) return false;
  const lower = path.toLowerCase();
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c')) return false;
  return !path.split('/').includes('..');
}

function acceptsEncoding(header: string | undefined, encoding: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim().split(';')[0]?.trim().toLowerCase())
    .includes(encoding);
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
  const assets = express.static(distDir, {
    index: false,
    setHeaders: (res, filePath) => {
      // `filePath` is the file ACTUALLY being sent, so for a rewritten
      // request it ends in .br/.gz — the cache rule keys off the directory,
      // which is unchanged either way.
      res.setHeader('Cache-Control', cacheControlFor(distDir, filePath));
    },
  });

  instance.use((req, res, next) => {
    if (isApiPath(req.path)) return next();

    // Only GET/HEAD can be served from disk; anything else falls through to
    // the API's own 404 rather than being answered with a page.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const type = CONTENT_TYPES[extname(req.path).toLowerCase()];
      if (type !== undefined && isSafeAssetPath(req.path)) {
        // Announced whether or not a variant is chosen: a cache that saw the
        // identity response must not replay it to a client that would have
        // been given brotli.
        res.setHeader('Vary', 'Accept-Encoding');
        const accept = req.headers['accept-encoding'];
        for (const { encoding, suffix } of ENCODINGS) {
          if (!acceptsEncoding(typeof accept === 'string' ? accept : undefined, encoding)) continue;
          if (!existsSync(join(distDir, `${req.path}${suffix}`))) continue;
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Type', type);
          req.url = `${req.path}${suffix}`;
          break;
        }
      }
    }

    assets(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      // Reaching here means the static handler declined, so whatever the
      // negotiation above decided is now about a file that is not being
      // sent. Leaving `Content-Encoding: br` on an uncompressed index.html
      // gives the browser a decode error instead of a page — and the only
      // way to get here with those set is a file that vanished between the
      // `existsSync` and the read, which is exactly the kind of thing that
      // would otherwise be debugged from a corrupt-response report.
      res.removeHeader('Content-Encoding');
      res.removeHeader('Content-Type');
      // Never `immutable`: this URL is stable and its content names the
      // current asset fingerprints. See cacheControlFor above.
      res.setHeader('Cache-Control', REVALIDATE);
      res.sendFile(join(distDir, 'index.html'));
    });
  });
}
