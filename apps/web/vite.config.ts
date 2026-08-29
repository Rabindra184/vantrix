import { constants, brotliCompressSync, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * ═══ COMPRESS ONCE, AT BUILD TIME ═══
 *
 * `apps/api/src/spa.ts` serves `<asset>.br` / `<asset>.gz` when the client
 * accepts them, and plain bytes when it does not. Producing those files here
 * rather than compressing per request is what lets brotli run at quality 11:
 * the bundle is compressed once per build instead of once per reader, so the
 * expensive setting is free at serve time, and it is roughly a third smaller
 * than the level an on-the-fly middleware could afford.
 *
 * Only the text formats the API knows how to serve compressed are handled
 * (`spa.ts`'s CONTENT_TYPES is the other half of this pair — an extension
 * added here and not there is emitted and never served). Fonts and images are
 * skipped: woff2 is already brotli-compressed internally, and re-compressing
 * it costs build time to make the file marginally larger.
 *
 * The 1 KiB floor is because a small file compresses to more bytes than it
 * saves once framing is counted, and a response that has to be inflated for
 * no gain is slower on a phone, not faster.
 */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg']);
const MIN_BYTES = 1024;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function precompress(): Plugin {
  return {
    name: 'perfportal-precompress',
    // `closeBundle` and not `writeBundle`: it runs once, after every emitted
    // file is on disk, including anything a later plugin wrote.
    apply: 'build',
    closeBundle() {
      const outDir = join(import.meta.dirname, 'dist');
      let compressed = 0;
      for (const file of walk(outDir)) {
        if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
        if (statSync(file).size < MIN_BYTES) continue;
        const bytes = readFileSync(file);
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(bytes, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 11,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        );
        // gzip as well as brotli: brotli over plain HTTP is not offered by
        // some older clients and by a few corporate proxies that strip
        // `br` from Accept-Encoding, and those readers should still not be
        // sent a megabyte.
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
        compressed += 1;
      }
      this.info(`precompressed ${compressed} asset(s) as .br and .gz`);
    },
  };
}

/**
 * The proxy is what makes dev same-origin. The session cookie is
 * sameSite: 'strict' and the API has no CORS, so hitting :3000 directly from
 * :5173 would send no cookie - a login that appears to succeed and then 401s
 * on every call. Proxying keeps dev and production behaviourally identical.
 */
export default defineConfig({
  plugins: [react(), tailwind(), precompress()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
