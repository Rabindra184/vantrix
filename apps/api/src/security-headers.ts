import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';

/**
 * The HTTP security headers every response carries, and the Content-Security
 * Policy the SPA runs under.
 *
 * Hand-written rather than `helmet`, for two reasons that both come down to
 * this deployment's shape. The CSP here cannot be a default — it needs a hash
 * for `index.html`'s theme script, and a deliberately looser policy for the
 * one page that is not ours (`/v1/docs`, which is Swagger UI). And the API
 * ships a Gatling runtime, a Prisma client and a Nest server already; a
 * middleware whose whole job is eight `res.setHeader` calls does not need a
 * dependency with its own advisory surface behind it.
 *
 * `X-Powered-By` is NOT removed here — see `disablePoweredBy` below. Express
 * adds it inside `res.send`, after this middleware has run, so unsetting it
 * from here removes a header that has not been set yet.
 */

/**
 * The `'sha256-…'` source for every inline `<script>` in a document.
 *
 * ═══ COMPUTED FROM THE FILE, NEVER WRITTEN DOWN ═══
 *
 * `apps/web/index.html` carries an inline script on purpose — it applies the
 * stored theme before the first paint, and a module import there would be the
 * render-blocking round trip it exists to avoid (see that file's own comment).
 * A CSP with `script-src 'self'` blocks it, and the symptom is a white flash
 * on every load in dark mode plus a console error nobody is watching for.
 *
 * A hash pasted into this file would be correct exactly until somebody edits
 * those five lines. Reading the built `index.html` and hashing what is
 * actually in it cannot drift, costs one file read at boot, and means the
 * theme script can change freely.
 *
 * The bytes hashed are the script's content EXACTLY as the parser sees it —
 * no trimming — because that is what the CSP hash is defined over.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  // Deliberately narrow: `<script>` with no attributes, or with any
  // attributes but no `src`. A `<script src=…>` is covered by `'self'` and
  // has no body to hash.
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? '';
    if (body === '') continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * ═══ WHY `style-src` KEEPS `'unsafe-inline'` ═══
 *
 * ECharts writes inline `style` attributes on the container and the tooltip
 * it creates, on every render, and there are up to ten charts on a run page.
 * Nothing about that is under this repository's control, so the choice is
 * `'unsafe-inline'` for styles or no charts. It is the weakest line in this
 * policy and it is worth naming as such: CSS injection can exfiltrate through
 * selectors and background URLs. `script-src` — the directive that actually
 * stops XSS — carries no `'unsafe-inline'`, which is the part that matters.
 *
 * `connect-src 'self'` covers the live WebSocket. CSP Level 3 defines `'self'`
 * as matching `ws:`/`wss:` on the same host, and `liveUrl` builds the socket
 * URL from `location` itself (apps/web/src/api/live.ts), so it is same-origin
 * by construction. Listing `ws:` here instead would allow every host on the
 * internet.
 *
 * `img-src` allows `data:` and `blob:` because ECharts' "save as image" draws
 * the canvas into one.
 */
function appPolicy(scriptHashes: readonly string[]): string {
  const script = ["'self'", ...scriptHashes].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}

/**
 * Swagger UI is a third-party page this repository serves but does not write:
 * `@nestjs/swagger` emits an inline bootstrap script and inline styles whose
 * contents change with its own version, so hashing them here would break on a
 * dependency bump with a blank documentation page and no other signal.
 *
 * It gets `'unsafe-inline'` for scripts, and nothing else — no framing, no
 * plugins, no form posts, and `connect-src 'self'` so "Try it out" still
 * reaches this API and nowhere else. The blast radius is one read-only page
 * that renders a document this server generated.
 */
function docsPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join('; ');
}

/** `/v1/docs` itself and every asset `SwaggerModule.setup` serves beside it. */
function isDocsPath(path: string): boolean {
  return path === '/v1/docs' || path.startsWith('/v1/docs/') || path.startsWith('/v1/docs-');
}

/**
 * A year, with subdomains, and no `preload`.
 *
 * `preload` is deliberately absent: it is a submission to a browser-baked
 * list that is slow and awkward to leave, and this is a self-hosted product
 * whose operator may well be running it on a subdomain of a company domain
 * that has other, plain-HTTP things on it. That is the operator's call to
 * make, not this file's.
 */
const HSTS = 'max-age=31536000; includeSubDomains';

/**
 * HSTS is sent only on a request that arrived over TLS, because a browser
 * ignores it on a plain-HTTP response anyway and sending it there is noise in
 * every local development log.
 *
 * `x-forwarded-proto` is trusted for this ONE decision and nothing else. That
 * is safe in a way trusting it for `req.ip` would not be: the worst a spoofed
 * value achieves is a browser pinning itself to HTTPS for this host, which no
 * attacker wants. Express's own `req.secure` needs `trust proxy` enabled,
 * which grants far more than this needs.
 */
function overTls(req: express.Request): boolean {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() === 'https';
}

export interface SecurityHeaderOptions {
  /** `'sha256-…'` sources, from `inlineScriptHashes(indexHtml)`. */
  inlineScriptHashes?: readonly string[];
}

/**
 * Mounted FIRST, on the raw Express instance, so it covers the SPA's static
 * assets, Better Auth's `/auth/*` mount and every Nest route alike — all
 * three are registered on that same instance at different points, and only
 * something ahead of all of them sees every response.
 */
export function securityHeaders(
  opts: SecurityHeaderOptions = {},
): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  const app = appPolicy(opts.inlineScriptHashes ?? []);
  const docs = docsPolicy();

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', isDocsPath(req.path) ? docs : app);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // `frame-ancestors` above already says this to any browser that reads
    // CSP; this is the same statement for one that does not.
    res.setHeader('X-Frame-Options', 'DENY');
    // `no-referrer` rather than `strict-origin-when-cross-origin`: a run URL
    // carries a run id, and this product has no reason to leak one to
    // anywhere a reader might click through to.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );
    if (overTls(req)) res.setHeader('Strict-Transport-Security', HSTS);
    next();
  };
}

/**
 * `X-Powered-By: Express` names the server and its framework to anyone who
 * asks, which is free reconnaissance and buys nothing.
 *
 * It cannot be removed by the middleware above. Express sets it from inside
 * `res.send`/`res.json`, long after any middleware has run, so a
 * `removeHeader` there deletes a header that does not exist yet and the real
 * one is added afterwards. `app.disable('x-powered-by')` is the setting that
 * stops it being added at all.
 */
export function disablePoweredBy(instance: express.Express): void {
  instance.disable('x-powered-by');
}

/**
 * The single mount both entry points use — `main.ts` and the integration
 * harness (`test/support/app.ts`) — for the same reason `mountBetterAuth` is
 * shared: a production-only header, or a test-only one, fails invisibly.
 * Nothing would catch a deployment sending a policy no test ever saw.
 *
 * `distDir` is the built SPA. Its `index.html` is read once, here, to hash
 * the inline theme script; a missing dist (an API running against the Vite
 * dev server) simply contributes no hashes, which is right — there is no
 * inline script being served from this origin in that case.
 */
export function mountSecurityHeaders(instance: express.Express, distDir: string): void {
  disablePoweredBy(instance);
  const indexHtml = join(distDir, 'index.html');
  const hashes = existsSync(indexHtml)
    ? inlineScriptHashes(readFileSync(indexHtml, 'utf8'))
    : [];
  instance.use(securityHeaders({ inlineScriptHashes: hashes }));
}
