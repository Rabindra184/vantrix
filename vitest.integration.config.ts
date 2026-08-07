import { defineConfig } from 'vitest/config';

export default defineConfig({
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
