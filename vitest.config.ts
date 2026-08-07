import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Keep the suite reading TypeScript source: no build step, no stale dist.
    conditions: ['perfportal-source'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Anything needing live Postgres, Redis, or MinIO is named
    // *.integration.test.ts and runs only under vitest.integration.config.ts,
    // so `pnpm test` stays runnable with no Docker.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
