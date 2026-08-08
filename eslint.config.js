import tseslint from 'typescript-eslint';

const FORBIDDEN_IN_PURE = [
  { group: ['node:fs', 'node:fs/*'],   message: 'Pure packages must not touch the filesystem (PRD 15.1).' },
  { group: ['node:http', 'node:https', 'node:net'], message: 'Pure packages must not do I/O (PRD 15.1).' },
  { group: ['pg', 'prisma', '@prisma/*'], message: 'Pure packages must not reach the database (PRD 15.1).' },
  { group: ['@nestjs/*'], message: 'Pure packages must not depend on the web framework (PRD 15.1).' },
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
);
