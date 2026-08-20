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

// `apps/web/src/charts/echarts.ts` is the ONE module allowed to import from
// ECharts, so the bundle cost of a new chart type is a single visible line in
// a single diff rather than a hard-to-notice import in the eighth chart
// component. That was a comment in echarts.ts and nothing enforced it; eight
// chart components are about to be written against it, and `import * as
// echarts from 'echarts'` in one of them pulls the entire library — every
// chart type, every component — into the browser bundle while looking
// completely ordinary in review.
//
// SPLIT ACROSS `paths` AND `patterns` DELIBERATELY. `patterns` uses
// gitignore-style matching, in which a pattern containing no slash matches a
// BASENAME at any depth — so a `group: ['echarts']` entry also rejects
// `./echarts`, the relative import every chart component is supposed to use.
// (Confirmed, not assumed: it flagged Chart.tsx's own `from './echarts'`.)
// `paths` is exact-string, so it catches the bare package without catching the
// relative sibling; `echarts/*` carries a slash and so stays anchored.
const ECHARTS_MESSAGE =
  'Only apps/web/src/charts/echarts.ts may import ECharts — import { echarts } from it ' +
  'instead, and register any new chart type or component THERE so its bundle cost is visible.';

const FORBIDDEN_ECHARTS_PATHS = [{ name: 'echarts', message: ECHARTS_MESSAGE }];
const FORBIDDEN_ECHARTS_PATTERNS = [{ group: ['echarts/*'], message: ECHARTS_MESSAGE }];

export default tseslint.config(
  // `.claude/worktrees/**` holds ENTIRE OTHER CHECKOUTS of this repository, not
  // source. The harness creates a worktree there per background task, so while
  // one exists a repo-wide `pnpm lint` walks into it and reports that
  // checkout's files as if they were this one's — and the root `fixtures/**`
  // entry above does not cover it, because that pattern is anchored at the
  // config root and a nested copy lives at `.claude/worktrees/*/fixtures/**`.
  // Observed as `pnpm lint` failing on a require() in a nested
  // fixtures/gatling-*/simulation/target-server.js belonging to a different
  // branch entirely. Git already ignores the directory; eslint has to be told
  // separately.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'spikes/**',
      'fixtures/**',
      '.claude/worktrees/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/{core,plugin-gatling,statistics,sla}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_PURE }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    // The one exemption, and the reason this is a rule rather than a comment.
    ignores: ['apps/web/src/charts/echarts.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FORBIDDEN_ECHARTS_PATHS,
          patterns: [...FORBIDDEN_IN_BROWSER, ...FORBIDDEN_ECHARTS_PATTERNS],
        },
      ],
    },
  },
  {
    // The registration module itself: still browser code, so it keeps the
    // server-only bans — it simply may import ECharts.
    files: ['apps/web/src/charts/echarts.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_BROWSER }],
    },
  },
);
