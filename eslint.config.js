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
      // `clients/**/build/**` is Gradle build output — the plugin's e2e run
      // regenerates Gatling's HTML report there, complete with vendored
      // Highcharts/Bootstrap minified JS (4000+ instant errors). Git already
      // ignores it via the module .gitignore; eslint has to be told
      // separately, exactly like the worktrees entry above. The COMMITTED
      // JS in clients/ (e2e/seed.mjs) stays linted — this only excludes
      // build output.
      'clients/**/build/**',
    ],
  },
  ...tseslint.configs.recommended,

  /*
   * ═══ A CONDITIONAL SPREAD IS A HOLE IN TYPE CHECKING ═══
   *
   * TypeScript's excess-property check applies to an object LITERAL assigned
   * to a typed target. A literal SPREAD into one is not that literal, so
   *
   *     ...(job.testSlug ? { test: job.testSlug } : {})
   *
   * compiles against a target whose field is `declaredTestSlug`, and the
   * value silently never arrives. That is not hypothetical: it is how the
   * on-prem runner's declared-test feature shipped completely broken with
   * every gate green, and it took executing a real Gatling run to find
   * (CLAUDE.md, `live-sink.ts`).
   *
   * MEASURED BOTH WAYS on `CreateLiveRunInput`, the same type that defect
   * was about — one typo, two spellings:
   *
   *     declaredTestSlugTYPO: cond ? v : undefined     TS2561, "Did you mean…"
   *     ...(cond ? { declaredTestSlugTYPO: v } : {})   exit 0, no errors
   *
   * THE FIX IS TO NAME THE KEY: `key: cond ? value : undefined`. That is a
   * real property of a real literal, so the compiler sees it again — and it
   * is equivalent at runtime, because `exactOptionalPropertyTypes` is off
   * here, `JSON.stringify` drops an undefined value, and Prisma reads
   * `undefined` as "not provided" (which is exactly what the spread meant).
   *
   * Where a branch is a whole object rather than a key — a `where` clause
   * with two shapes — annotate the value instead (`const w: Prisma.XWhereInput
   * = cond ? A : B`) and spread THAT: a typed value is checked, an inline
   * literal is not.
   *
   * ONLY LITERALS WITH PROPERTIES ARE FLAGGED. `...(cond ? typedValue : {})`
   * is safe — the value carries its own type — and the selector leaves it
   * alone.
   */
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'SpreadElement > ConditionalExpression > ObjectExpression[properties.length>0]',
          message:
            'A conditional spread hides a mistyped key from the compiler: an object literal spread into a typed target is not excess-property checked. Write `key: cond ? value : undefined`, or annotate the branches and spread a typed value. See eslint.config.js.',
        },
      ],
    },
  },
  /*
   * ═══ EXEMPT, AND THE REASON IS A MEASUREMENT ═══
   *
   * `Chart.tsx` assembles the ECharts option bag. The rule above exists
   * because a spread loses the excess-property check on a typed target — and
   * here there is no such check TO lose: `EChartsOption` carries index
   * signatures, so the literal handed to `setOption` accepts anything.
   * Measured, by putting a bogus key inside that literal as a plain property:
   *
   *     bogusKeyThatCannotExist: 1,      pnpm typecheck -> exit 0
   *
   * Converting its six conditional spreads would therefore buy no safety at
   * all, in the most delicate rendering file in the app. Recorded as an
   * exemption with its evidence rather than waved through — and if ECharts
   * ever tightens that type, delete this block and do the conversion.
   */
  {
    files: ['apps/web/src/charts/Chart.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  /*
   * ═══ AVERAGING PERCENTILES IS A DEFECT (FR-STAT-4, AC-STAT-3) ═══
   *
   * A percentile is an order statistic. The mean of two of them is not a
   * percentile of anything: `(p95 + p99) / 2` answers no question, and
   * averaging one endpoint's p95 with another's is the classic way to report
   * a latency nobody experienced. The whole reason this product stores a
   * DDSketch per row is that percentiles must be merged by combining sketches
   * and re-quantiling, never by arithmetic on the outputs.
   *
   * The PRD states this twice and says static analysis enforces it in CI
   * ("A violation fails CI", AC-STAT-3; "Static analysis enforces it in CI",
   * section 24). It did not exist. Measured before writing this: NOTHING in
   * the codebase currently averages a percentile, so this guards a property
   * that holds today rather than fixing one that is broken — which is the
   * only state in which a guard like this can be added at all.
   *
   * ═══ WHAT IT CATCHES, AND WHAT IT DOES NOT ═══
   *
   * It catches a SUM of percentile reads used as the numerator of a division
   * — the arithmetic-mean shape — and a `reduce` over a `percentiles` object
   * or array. It deliberately does NOT flag a bare division like
   * `p95 / 1000`, which is a unit conversion and correct.
   *
   * It is a syntactic guard and cannot see through an alias: assign a
   * percentile to `const x` and average `x`, and this says nothing. That is
   * the honest limit of a selector, and it is still worth having — the
   * shapes it does catch are the ones somebody writes by reflex when asked
   * to "roll these up".
   *
   * Placed AFTER the Chart.tsx exemption above deliberately. That block turns
   * `no-restricted-syntax` off entirely for one file; folding these selectors
   * into the same array would have exempted them there too, silently, for a
   * reason (ECharts index signatures) that has nothing to do with statistics.
   */
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // ONE report per offending expression, not one per percentile it
          // mentions: `:has()` puts the constraint on the SUM rather than
          // matching each operand, so `(p95 + p99) / 2` is a single error
          // rather than two for one defect.
          selector:
            "BinaryExpression[operator='/'] > BinaryExpression[operator='+']:has(Identifier[name=/^p[0-9]+(Ms)?$/], MemberExpression[property.name=/^p[0-9]+(Ms)?$/], MemberExpression[object.name=/[Pp]ercentiles/])",
          message:
            'Averaging percentiles is a defect (FR-STAT-4, AC-STAT-3): the mean of two order statistics is not a percentile of anything. Merge the sketches and re-quantile instead. See eslint.config.js.',
        },
        {
          selector: "CallExpression[callee.property.name='reduce'][callee.object.name=/[Pp]ercentiles/]",
          message:
            'Reducing a percentile set to one number averages or sums order statistics, which is a defect (FR-STAT-4, AC-STAT-3). Merge the sketches and re-quantile instead. See eslint.config.js.',
        },
      ],
    },
  },
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
