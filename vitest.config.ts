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
  resolve: {
    // Keep the suite reading TypeScript source: no build step, no stale dist.
    conditions: ['perfportal-source'],
  },
  test: {
    // Anything needing live Postgres, Redis, or MinIO is named
    // *.integration.test.ts or *.e2e.test.ts and runs only under
    // vitest.integration.config.ts, so `pnpm test` stays runnable with no Docker.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts', '**/*.e2e.test.ts'],
    testTimeout: 30_000,
    // Aligns Testing Library's async-query timeout with the one above — see
    // `apps/web/test/setup.ts` for why a 30s test containing a 1s `findByRole` is a
    // flake generator rather than a preference. It configures ONLY that; in
    // particular it deliberately does not register a global `cleanup`.
    setupFiles: ['./apps/web/test/setup.ts'],

    /**
     * ═══ TWO PROJECTS, BECAUSE ONE OF THEM NEEDS A DOCUMENT ═══
     *
     * This was `environmentMatchGlobs: [['apps/web/test/**\/*.test.tsx',
     * 'jsdom']]` — one include list, node by default, jsdom for the .tsx
     * files. Vitest 4 removed that option, and the failure mode is loud in
     * the best way: every DOM suite throws `ReferenceError: document is not
     * defined` at `render`, 410 tests across 42 files at once. (Contrast the
     * Node-20 trap CLAUDE.md opens with, where the same files vanish
     * SILENTLY and the run still reports a pass.)
     *
     * `projects` is the replacement, and it says the same thing more
     * explicitly: which files, in which environment. `extends: true` pulls in
     * the plugins, the `perfportal-source` condition and the shared `test`
     * options above, so nothing is duplicated except the two include lists
     * that are genuinely different.
     *
     * The counts to expect are in CLAUDE.md; `pnpm test:unit` reports the two
     * projects' files and tests as one total, so that floor still reads the
     * same way it always did.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          // Only the tests that mount React into a document. jsdom's startup
          // is much more expensive than node's, which is why this is a
          // separate project rather than the default for everything.
          name: 'jsdom',
          include: ['apps/*/test/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
