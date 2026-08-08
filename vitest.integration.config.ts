import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      // Only apps use decorators; packages stay on the faster esbuild path.
      include: /apps\/.*\.ts$/,
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
    // unplugin-swc's vite() unconditionally sets `esbuild: false` at the Vite
    // config level to avoid double-transforming the files it handles — but
    // that also switches off esbuild for every package .ts file our include
    // filter above deliberately left alone, so packages need it restored.
    //
    // Restoring it naively (`esbuild: {}`) is not enough: Vite's esbuild
    // plugin would then also run on apps/**.ts, and it runs before
    // unplugin-swc's transform hook in the pipeline. It strips the
    // `@Injectable()`-style decorators into plain calls (using esbuild's own
    // `__decorateClass` helper, no metadata) before swc ever sees the file,
    // so by the time swc runs there is no decorator syntax left to add
    // `design:paramtypes` metadata to — Nest then reports a clean boot and
    // silently injects `undefined`. Excluding apps/**.ts from esbuild here
    // keeps swc as the only transform apps files ever go through.
    { name: 'restore-esbuild-for-packages', config: () => ({ esbuild: { exclude: [/apps\/.*\.ts$/] } }) },
  ],
  resolve: { conditions: ['perfportal-source'] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Integration tests share one Postgres; running files in parallel would
    // let one file's truncate wipe another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
