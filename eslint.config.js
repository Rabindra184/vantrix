import tseslint from 'typescript-eslint';

const FORBIDDEN_IN_PURE = [
  { group: ['node:fs', 'node:fs/*'],   message: 'Pure packages must not touch the filesystem (PRD 15.1).' },
  { group: ['node:http', 'node:https', 'node:net'], message: 'Pure packages must not do I/O (PRD 15.1).' },
  { group: ['pg', 'prisma', '@prisma/*'], message: 'Pure packages must not reach the database (PRD 15.1).' },
  { group: ['@nestjs/*'], message: 'Pure packages must not depend on the web framework (PRD 15.1).' },
];

// apps/web/package.json declares @perfportal/persistence and
// @perfportal/storage as devDependencies so apps/web/e2e/fixtures.ts can
// import them (Node-side, run by Playwright, never bundled) — see Task 3's
// report. That makes them resolvable from apps/web/src too, where nothing
// stops Vite from happily bundling `pg`/`@prisma/client` and every Node
// builtin they pull in for the BROWSER. Nothing imports them from src today;
// this only guards against a future import doing it by accident.
const FORBIDDEN_IN_BROWSER = [
  {
    group: ['@perfportal/persistence', '@perfportal/storage'],
    message: 'Browser code must not import server-only, Prisma/pg-backed packages.',
  },
  { group: ['pg', '@prisma/client'], message: 'Browser code must not reach the database directly.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'spikes/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/{core,plugin-gatling,statistics,sla}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_PURE }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_BROWSER }],
    },
  },
);
