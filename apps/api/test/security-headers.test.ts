import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { inlineScriptHashes, mountSecurityHeaders } from '../src/security-headers.js';
import { mountSpa } from '../src/spa.js';

/**
 * A real Express app over a real (tiny) dist directory. No Nest, no database:
 * everything under test here is middleware on the raw instance, and the
 * integration harness is eight minutes away.
 *
 * `mountSecurityHeaders` and `mountSpa` are mounted in the same ORDER
 * `main.ts` uses, because that order is load-bearing — headers first, so they
 * cover the static handler's own responses too.
 */
const INLINE_SCRIPT = "\n      console.log('theme');\n    ";
const INDEX_HTML = `<!doctype html><html><head><script>${INLINE_SCRIPT}</script><script src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`;
// Over spa.ts's 1 KiB precompression floor, so the build would really have
// emitted variants for it.
const APP_JS = `console.log(${JSON.stringify('x'.repeat(4096))});\n`;

let app: express.Express;
let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'perfportal-spa-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(distDir, 'assets', 'app.js'), APP_JS);
  writeFileSync(join(distDir, 'assets', 'app.js.br'), brotliCompressSync(Buffer.from(APP_JS)));
  writeFileSync(join(distDir, 'assets', 'app.js.gz'), gzipSync(Buffer.from(APP_JS)));
  // Not precompressed, to prove the negotiation declines rather than 404s.
  writeFileSync(join(distDir, 'assets', 'plain.js'), 'export default 1;\n');

  app = express();
  mountSecurityHeaders(app, distDir);
  mountSpa(app, distDir);
  app.get('/v1/ping', (_req, res) => void res.json({ ok: true }));
  // Stands in for SwaggerModule.setup's page.
  app.get('/v1/docs', (_req, res) => void res.type('html').send('<html></html>'));
});

describe('inlineScriptHashes', () => {
  it('hashes an inline script and ignores one with a src', () => {
    const hashes = inlineScriptHashes(INDEX_HTML);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });

  it('hashes the body EXACTLY as the parser sees it, untrimmed', () => {
    // The whole reason this is computed rather than written down: a hash over
    // trimmed content is a hash of bytes no browser ever evaluates, and the
    // failure is a silently blocked script, not an error.
    const [ofFile] = inlineScriptHashes(INDEX_HTML);
    const [ofTrimmed] = inlineScriptHashes(`<script>${INLINE_SCRIPT.trim()}</script>`);
    expect(ofFile).not.toBe(ofTrimmed);
  });

  it('finds nothing in a document with no inline script', () => {
    expect(inlineScriptHashes('<html><script src="/a.js"></script></html>')).toEqual([]);
  });
});

describe('security headers', () => {
  it('sends the full set on an API response', async () => {
    const res = await request(app).get('/v1/ping').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
  });

  it('sends them on the SPA document too, not only on the API', async () => {
    // The regression this catches is mounting the middleware after the static
    // handler, which would leave every asset and the index document bare.
    const res = await request(app).get('/runs/abc').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('never names the framework', async () => {
    const res = await request(app).get('/v1/ping').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('carries the index.html script hash, so the theme script still runs', async () => {
    const [hash] = inlineScriptHashes(INDEX_HTML);
    const res = await request(app).get('/').expect(200);
    expect(res.headers['content-security-policy']).toContain(hash);
  });

  it("forbids inline script on the app's own policy", async () => {
    const res = await request(app).get('/').expect(200);
    const csp = res.headers['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    // The directive that actually stops XSS. `style-src` keeps
    // 'unsafe-inline' on purpose (ECharts); this one must never gain it.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('gives /v1/docs its own, looser policy — and only /v1/docs', async () => {
    const docs = await request(app).get('/v1/docs').expect(200);
    const other = await request(app).get('/v1/ping').expect(200);
    expect(docs.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(other.headers['content-security-policy']).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  it('withholds HSTS over plain HTTP and sends it behind a TLS-terminating proxy', async () => {
    const plain = await request(app).get('/v1/ping').expect(200);
    expect(plain.headers['strict-transport-security']).toBeUndefined();

    const proxied = await request(app)
      .get('/v1/ping')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    expect(proxied.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('static asset delivery', () => {
  it('serves brotli when the client accepts it, with the original content type', async () => {
    const res = await request(app)
      .get('/assets/app.js')
      .set('Accept-Encoding', 'br, gzip')
      // supertest/superagent decodes the body, so this asserts the wire
      // headers and the decoded content together.
      .expect(200);
    expect(res.headers['content-encoding']).toBe('br');
    // The trap this exists to catch: serving `app.js.br` lets `send` type it
    // from the `.br` extension, and the browser downloads the bundle instead
    // of running it.
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['vary']).toContain('Accept-Encoding');
  });

  it('falls back to gzip for a client that does not take brotli', async () => {
    const res = await request(app)
      .get('/assets/app.js')
      .set('Accept-Encoding', 'gzip, deflate')
      .expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('serves the identity bytes when nothing is accepted', async () => {
    const res = await request(app).get('/assets/app.js').set('Accept-Encoding', '').expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text).toBe(APP_JS);
  });

  it('serves an asset with no precompressed variant unchanged', async () => {
    const res = await request(app)
      .get('/assets/plain.js')
      .set('Accept-Encoding', 'br')
      .expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('marks a fingerprinted asset immutable and index.html no-cache', async () => {
    const asset = await request(app).get('/assets/plain.js').expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // The failure this pins: index.html's URL is stable while its content
    // names the current fingerprints, so an immutable copy points at assets
    // the next deploy deleted and the app is blank until a hard reload.
    const doc = await request(app).get('/').expect(200);
    expect(doc.headers['cache-control']).toBe('no-cache');
    const deepLink = await request(app).get('/runs/abc').expect(200);
    expect(deepLink.headers['cache-control']).toBe('no-cache');
  });

  /**
   * `req.path` is neither decoded nor normalised by Express, so `..` arrives
   * intact. `express.static` refuses to serve outside its root either way;
   * what this pins is that the encoding negotiation IN FRONT of it declines
   * to build a filesystem path out of such a request at all.
   *
   * A 200 here is correct and is the SPA fallback doing its job — every
   * unmatched GET returns index.html so a deep link survives a refresh. The
   * assertion is therefore about WHAT came back, not the status: the app
   * document, with no `Content-Encoding` claimed over it.
   */
  it.each([
    '/assets/../../etc/passwd.js',
    '/assets/%2e%2e/%2e%2e/etc/passwd.js',
    '/assets/..%2f..%2fetc/passwd.js',
  ])('never serves a precompressed variant for the traversal path %s', async (path) => {
    const res = await request(app).get(path);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.text).not.toContain('root:');
  });
});
