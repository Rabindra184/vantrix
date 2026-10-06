# ⌘K Search (PR 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an org-wide `GET /v1/tests`, a `number=` filter on `GET /v1/runs`, and a "find and go" ⌘K command palette in the app header.

**Architecture:** A new `TestRepository.listOrg` reads every test with its latest run (arrival order) and its last ten run-level p95s through two `LATERAL` queries; `listForProject` moves onto the same latest-run query. A new `OrgTestsController` serves it at `/v1/tests`. The browser palette (`apps/web/src/palette/`) composes the cached project list, `GET /v1/tests?q=`, `GET /v1/runs?q=` and `GET /v1/runs?…&number=` into grouped results inside a Radix Dialog driven by `cmdk`.

**Tech Stack:** Prisma raw SQL on PostgreSQL 16, NestJS, zod contracts, React 18, TanStack Query 5, `cmdk` 1.1.1, `@radix-ui/react-dialog`, Vitest (node + jsdom projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md` (sections "PR 1", "Testing → PR 1", "Verification").

## Global Constraints

- Node 22 (`nvm use` in EVERY Bash call; each call starts on Node 20, where the jsdom project silently skips).
- Branch: `feat/command-palette` (exists, holds the spec). `git log --oneline origin/main..HEAD` must show only this work.
- "Latest run" = `created_at DESC, id DESC` (arrival), read through `run_test_id_created_at_idx`. Never the run list's `COALESCE(tool_started_at, started_at)` order.
- `latestRun.startedAt` = `COALESCE(tool_started_at, started_at)` (when the load test ran), ISO string.
- p95 = the run-scope `response_time` `run_stat` row's `percentiles.p95`, clamped to that row's `min_ms`/`max_ms` — the same expression `RunRepository.list` uses for `metrics.p95Ms` (one shared helper, Task 2).
- `p95History`: ≤ 10 points, `status = 'complete'` runs only, oldest → newest; a run with no usable p95 contributes no point.
- `GET /v1/tests`: session → whole org; API token → its own project only; scope `read`; `limit` default 25, clamped 1–100 by the existing `parseLimit`; `q` trimmed, empty after trimming = no filter, `%` `_` `\` escaped.
- `number=`: positive integer ≤ 2147483647; needs a resolved test; 400 `NUMBER_NEEDS_TEST` / 400 `INVALID_RUN_NUMBER`. Never added to the `q` OR.
- Palette debounce: 150 ms. Group order: Projects, Pages, Tests, Runs, Run by number. Limits 5, 5, 5, 5, 3.
- Palette copy (exact): dialog title "Search PerfPortal"; input placeholder "Search projects, tests and runs"; group headings "Go to", "Projects", "Pages", "Tests", "Runs", "Run by number"; failure lines "Couldn't load projects", "Couldn't search tests", "Couldn't search runs", "Couldn't look up that run"; empty line `No results for “<q>”`; live region `N results` / `1 result`.
- Trigger: accessible name "Search", `aria-keyshortcuts="Meta+K Control+K"`, visible hint `⌘K` on Apple platforms and `Ctrl K` elsewhere; icon-only below 768 px (`useIsCompact`).
- Page labels are `ProjectShell`'s own: Tests, Runs, Packages, Add results, SLA rules, API tokens, plus New on-prem run; destinations come from `apps/web/src/routes/paths.ts`, never string literals.
- Repo guards that bite here: no `...(cond ? { … } : {})` object-literal spreads (eslint); every API 4xx through `badRequest`/`notFound` (remediation guard); no backticks inside SQL comments in template literals; a backticked `FooRepository`-style name in a comment must exist (named-symbols guard); new routes must appear in the OpenAPI document (route-coverage guard derives the list).

## Review Focus

1. **A `q` that is only whitespace** (`?q=%20%20`) must behave exactly like no `q`; a `q` of `50%_off` must match the literal string. → Task 4 test.
2. **Reopening the palette after a search** must show the empty "Go to" state, never the last query's results. → Task 7 test.
3. **⌘K pressed inside a text field** (the run list's "Search runs" box) opens the palette without typing a "k"; ⌘K while the palette is open closes it. → Task 8 test.
4. **Very long names** (a 56-character simulation class, a 120-character project name) in palette rows at 375 px must not scroll the page sideways. → Task 9 e2e.
5. **`<text> #N` that resolves to nothing** (no matching test, or no run N) shows no Run-by-number group and no failure line, and still lets "No results" appear; `#12` with no text never queries. → Tasks 6 and 7 tests.

---

### Task 1: Contracts — `OrgTestSummary` and `OrgTestListResponse`

**Files:**
- Modify: `packages/contracts/src/test.ts` (add the two schemas after `TestListResponseSchema`; correct `TestSummarySchema.latestRun`'s docstring)
- Test: `packages/contracts/test/test.test.ts`

**Interfaces:**
- Produces:
  ```ts
  OrgTestSummarySchema, type OrgTestSummary
  OrgTestListResponseSchema, type OrgTestListResponse   // { items: OrgTestSummary[]; nextCursor: string | null }
  ```
  Shape (spec "Row"): `{ id: uuid, slug, name, simulationClass, runCount: int ≥ 0, project: { slug, name }, latestRun: { id: uuid, runNumber: RunNumberSchema.nullable(), status: RunStatusSchema, verdict: RunVerdictSchema.nullable(), startedAt: datetime string, durationMs: int | null, checks: { failed: int, total: int } | null, p95Ms: number | null } | null, p95History: Array<{ runId: uuid, runNumber: RunNumberSchema.nullable(), p95Ms: number }> (max 10) }`. No string `.min`/`.max` (the trimmed-input guard would demand `.trim()`).

- [ ] **Step 1: Write the failing tests** in `test.test.ts`, a new `describe('OrgTestListResponseSchema')`:
  - `parses a test with a latest run and a p95 history` — a full row round-trips through `.parse` unchanged.
  - `parses a test that has never run` — `latestRun: null, p95History: []`.
  - `refuses a p95 history longer than ten points` — 11 points → `safeParse(...).success === false`.
  - `requires nextCursor to be present, null or a string` — omitting it fails.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run packages/contracts/test/test.test.ts` — FAIL (`OrgTestListResponseSchema` is not exported).
- [ ] **Step 3: Implement** the schemas in `test.ts`. Rewrite `latestRun`'s docstring to say it is the newest by ARRIVAL (`created_at`), the order run numbers follow, which is NOT the run list's order (that sorts by when the test ran) — per the spec's corrected bullet.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `git add packages/contracts && git commit -m "Add the org-wide test list contract"`.

---

### Task 2: Persistence — `TestRepository.listOrg` and one latest-run query

**Files:**
- Create: `packages/persistence/src/repositories/like.ts` — `export function escapeLike(value: string): string` MOVED from `run.ts` (delete it there; `run.ts` imports it).
- Modify: `packages/persistence/src/repositories/run.ts` — extract `export function runP95(stat: { percentiles: unknown; minMs: number | null; maxMs: number | null }): number | null` from `metricsFrom` (body = today's p95 + `clampPercentile` logic, unchanged); `metricsFrom` calls it.
- Modify: `packages/persistence/src/repositories/test.ts` — add `listOrg`, private `latestRuns` and `p95Histories`; `listForProject` and `findBySlug` read their `latestRun` through `latestRuns`.
- Test: `packages/persistence/test/org-tests.integration.test.ts` (new; setup copied from `run-number.integration.test.ts`: `createPool`/`createPrisma`, `TRUNCATE` of `SCHEMA_TABLES` in `beforeEach`, an org `acme` with project `checkout`).

**Interfaces:**
- Consumes: `TenantScope` (`{ orgId; projectId?: string }`) from `repositories/tenant.ts`; `clampPercentile` (already imported by `run.ts`).
- Produces (exported from `@perfportal/persistence` through the existing `export *`):
  ```ts
  interface OrgTestLatestRun {
    id: string; runNumber: number | null; status: string; verdict: string | null;
    startedAt: Date; durationMs: number | null;
    toolAssertions: RunRecord['toolAssertions'];   // same cast fromSqlRow uses
    p95Ms: number | null;
  }
  interface OrgTestRow {
    id: string; slug: string; name: string; simulationClass: string; runCount: number;
    project: { slug: string; name: string };
    latestRun: OrgTestLatestRun | null;
    p95History: Array<{ runId: string; runNumber: number | null; p95Ms: number }>;
  }
  interface ListOrgTestsOptions { readonly limit: number; readonly cursor?: string; readonly q?: string }
  TestRepository.listOrg(scope: TenantScope, opts: ListOrgTestsOptions):
    Promise<{ items: OrgTestRow[]; nextCursor: string | null }>
  export function escapeLike(value: string): string
  export function runP95(stat): number | null
  ```

**The query (pinned, because ordering + keyset with `NULLS LAST` is easy to get subtly wrong):**

```sql
SELECT t.id, t.slug, t.name, t.simulation_class, p.slug AS project_slug, p.name AS project_name,
       lr.created_at AS latest_at
FROM test t
JOIN project p ON p.id = t.project_id
LEFT JOIN LATERAL (
  SELECT r.created_at FROM run r WHERE r.test_id = t.id
  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
) lr ON true
WHERE t.org_id = $1
  [AND t.project_id = $n]                                   -- scope.projectId
  [AND (t.name ILIKE $q ESCAPE '\' OR t.slug ILIKE $q ESCAPE '\' OR t.simulation_class ILIKE $q ESCAPE '\'
        OR p.name ILIKE $q ESCAPE '\' OR p.slug ILIKE $q ESCAPE '\')]
  [AND <keyset>]
ORDER BY lr.created_at DESC NULLS LAST, t.name ASC, t.id ASC
LIMIT $limit + 1
```

Cursor = a test id. Resolve it first to `(latest_at, name, id)` with the same `LATERAL`, scoped to `scope`; an unresolvable cursor returns `{ items: [], nextCursor: null }` (the run list's rule). Keyset:
- cursor dated: `(lr.created_at < $at OR (lr.created_at = $at AND (t.name, t.id) > ($name, $id)) OR lr.created_at IS NULL)`
- cursor never-run: `(lr.created_at IS NULL AND (t.name, t.id) > ($name, $id))`

Then, for the page's test ids, three queries in parallel: `runCount` (`groupBy testId`, as today); `latestRuns(ids)` = `unnest($1::uuid[]) t(id) CROSS JOIN LATERAL (… WHERE r.test_id = t.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)` LEFT JOINing the run-scope `run_stat` triple (`scope='run' AND name='' AND family='response_time'`, same join keys as `RunRepository.list`) for `p95Ms = runP95(…)`; `p95Histories(ids)` = the same shape with `AND r.status = 'complete'`, an inner join on that `run_stat` row, `LIMIT 10`, then reversed per test with null-p95 points dropped. No backticks in SQL comments.

- [ ] **Step 1: Write the failing tests** in `org-tests.integration.test.ts`:
  - `lists every test in the org with its project` — two projects, one test each; both returned with `project.slug`.
  - `takes the newest ARRIVAL as the latest run, not the newest start` — test with run A (`created_at` 10:00, `tool_started_at` 09:00) and run B (`created_at` 11:00, `tool_started_at` 08:00): `latestRun.id === B.id`.
  - `agrees with listForProject about the latest run` — same fixture: `listForProject(...)[0].latestRun.id === listOrg(...).items[0].latestRun.id`.
  - `orders by latest arrival, never-run tests last by name` — tests with latest arrivals 12:00, 11:00, and two never-run named `b-test`, `a-test`: slugs in order `[t12, t11, a-test, b-test]`.
  - `pages through that order with a cursor` — `limit: 2` then `cursor: page1.nextCursor` covers all four with no duplicate; the never-run boundary crossed mid-page.
  - `answers an unresolvable cursor with an empty page` — random uuid cursor → `{ items: [], nextCursor: null }`.
  - `matches q against test name, slug, class and project, literally` — `q: '50%_off'` matches a test named `50%_off checkout` and NOT `500-offset`.
  - `narrows to the token's project` — `scope.projectId` set → only that project's tests.
  - `reads p95 history oldest first, complete runs only, clamped like the run list` — 12 complete runs with stat rows + 1 `failed` run: 10 points, oldest first, the failed run absent; one row whose stored `p95` exceeds `max_ms` reads as `max_ms` (seed `run_stat` with raw SQL as `apps/api/test/trends.integration.test.ts`'s `seedRun` does).
  - `leaves a run with no usable p95 out of the history` — a stat row whose `percentiles` has no `p95` contributes no point.
  - Set `createdAt` explicitly on every seeded run: `createMany` gives them all the same `now()`.
- [ ] **Step 2: Run** `nvm use && pnpm build && pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/org-tests.integration.test.ts` (stack env from CLAUDE.md; a scratch `DATABASE_URL`) — FAIL (`listOrg` is not a function).
- [ ] **Step 3: Implement** `like.ts`, `runP95`, `listOrg`, `latestRuns`, `p95Histories`; switch `listForProject`/`findBySlug` to `latestRuns` (they keep returning `{ id, status, verdict, runNumber }`).
- [ ] **Step 4: Run** the new file plus the regression files: `… packages/persistence/test/org-tests.integration.test.ts packages/persistence/test/repositories.integration.test.ts apps/api/test/tests.integration.test.ts` — all PASS, `tests.integration.test.ts` unchanged. Rebuild persistence before EVERY run (`find packages/persistence -name '*.tsbuildinfo' -delete && pnpm exec tsc -b packages/persistence`): integration resolves it through `dist`.
- [ ] **Step 5: Commit** `git commit -m "Read every test in the org with its latest run and p95 history"`.

---

### Task 3: `number=` on `GET /v1/runs`

**Files:**
- Modify: `packages/persistence/src/repositories/run.ts` — `RunListOptions.runNumber?: number`; export `function runNumberClause(param: number): string` returning `` `r.run_number = $${param}::int` `` and use it in `list` (only when `runNumber` is set).
- Modify: `apps/api/src/runs/runs.controller.ts` — `@Query('number') number?: string` on the org-wide `list`; validation after `testId` is resolved.
- Modify: `apps/api/src/openapi/document.ts` — parameter `RunNumberFilter` (query, integer ≥ 1) added to `listRuns`' `parameters`; its description names both 400 codes.
- Test: `apps/api/test/run-number.integration.test.ts`, `packages/persistence/test/run-number.integration.test.ts`

**Interfaces:**
- Produces: `GET /v1/runs?project=<slug>&test=<slug>&number=<n>` (session) or `?test=<slug>&number=<n>` (token) → that run alone or an empty page.
- Errors (exact): no resolved test → `badRequest('NUMBER_NEEDS_TEST', 'The "number" filter needs a test.', 'A run number names a run only within its test. Add "test=<slug>", and "project=<slug>" when using a session.')`; not `/^[1-9]\d{0,9}$/` or > 2147483647 → `badRequest('INVALID_RUN_NUMBER', '"number" must be a positive whole number.', 'Pass the number a run page shows, e.g. number=12 for "Run 12".')`.

- [ ] **Step 1: Write the failing tests:**
  - API: `narrows a test's runs to the one with that number` (three numbered runs; `number=2` → one item, `runNumber 2`); `answers an empty page for a number the test never reached`; `refuses number without a test` (`400`, `code: 'NUMBER_NEEDS_TEST'`); `refuses a number that is not a positive whole number` (`abc`, `0`, `-1`, `2147483648` each `400 INVALID_RUN_NUMBER`).
  - Persistence: `the run-number filter is served by run_test_id_run_number_key` — inside a transaction with `SET LOCAL enable_seqscan = off`, `EXPLAIN (COSTS OFF) SELECT r.id FROM run r WHERE r.test_id = $1::uuid AND ${runNumberClause(2)}` contains `run_test_id_run_number_key`.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files plus `apps/api/test/openapi.integration.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -m "Look a run up by its number within its test"`.

---

### Task 4: `GET /v1/tests`

**Files:**
- Create: `apps/api/src/runs/check-tally.ts` — `export function checkTally(toolAssertions): { failed: number; total: number } | null`, MOVED from `runs.controller.ts` (which imports it).
- Create: `apps/api/src/tests/org-tests.controller.ts` — `@Controller('/v1/tests') export class OrgTestsController`, one `@Get() @Scopes('read') list(@Req() req, @Query('q') q?, @Query('limit') limit = '25', @Query('cursor') cursor?): Promise<OrgTestListResponse>`.
- Modify: `apps/api/src/tests/tests.module.ts` — add `OrgTestsController` to `controllers`.
- Modify: `apps/api/src/openapi/document.ts` — path `/v1/tests`, `get.operationId: 'listTests'`, tag `tests`, parameters `Limit`, `Cursor`, new `TestSearch` (query `q`); responses `200 → OrgTestListResponse`, `401`, `403`. Description states the credential rule and that "latestRun" is the newest arrival.
- Modify: `apps/api/src/openapi/schemas.ts` — register `OrgTestSummary`, `OrgTestListResponse`.
- Test: `apps/api/test/org-tests.integration.test.ts` (new; `createTestApp`, `signUpAsOrgMember`, `ctx.readToken`)

**Interfaces:**
- Consumes: `TestRepository.listOrg` (Task 2), `OrgTestListResponseSchema` (Task 1), `parseLimit`/`parseCursor` from `common/validation.ts`.
- Produces: `GET /v1/tests` → `OrgTestListResponse`. The handler maps `OrgTestRow` with `startedAt.toISOString()` and `checks = checkTally(latestRun.toolAssertions)`, then `OrgTestListResponseSchema.parse`. `q` is `q?.trim() || undefined`. Scope: `{ orgId: tenant.orgId, projectId: tenant.projectId }`.

- [ ] **Step 1: Write the failing tests:**
  - `lists every test in the org for a session` — tests in `checkout` and a second project; both present.
  - `lists only the token's own project for an API token` — `Authorization: Bearer ${ctx.readToken}` sees `checkout`'s test only.
  - `never shows another org's tests` — a second org with a test; absent for the session.
  - `refuses an unauthenticated request` — `401`.
  - `treats a whitespace-only q as no filter` (Review Focus 1) — `?q=%20%20` returns the same ids as no `q`.
  - `matches a q containing % and _ literally` (Review Focus 1).
  - `clamps limit and pages with nextCursor` — `limit=1` → one item and a cursor that yields the next.
  - `reports the latest run's checks and p95` — a latest run with `toolAssertions` `[failed, passed]` → `checks: { failed: 1, total: 2 }`; its stat row's p95 → `p95Ms`.
  - The existing derived guards (`openapi.integration.test.ts` route coverage, schema validity) must pass unmodified once documented.
- [ ] **Step 2: Run** `… apps/api/test/org-tests.integration.test.ts apps/api/test/openapi.integration.test.ts` — FAIL (404 route; the route-coverage case names `get /v1/tests` once the controller exists).
- [ ] **Step 3: Implement** `check-tally.ts`, the controller, the module entry, the document path and schemas.
- [ ] **Step 4: Run** the two files plus `apps/api/test/session-auth.integration.test.ts` and `apps/api/test/read.integration.test.ts` — PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve every test in the org at GET /v1/tests"`.

---

### Task 5: Browser clients

**Files:**
- Modify: `apps/web/src/api/tests.ts` — `orgTestsQueryKey(q: string, limit: number)` = `['org-tests', q, limit] as const`; `fetchOrgTests(opts: { q?: string; limit?: number; cursor?: string | null }): Promise<OrgTestListResponse>`.
- Modify: `apps/web/src/api/runs.ts` — `searchRuns(q: string, limit: number): Promise<RunListResponse>` (`/v1/runs?limit=&q=`); `fetchRunByNumber(projectSlug: string, testSlug: string, n: number): Promise<RunListResponse>` (`/v1/runs?limit=1&project=&test=&number=`). `fetchRuns` is untouched.
- Test: `apps/web/test/searchApi.test.ts` (new; stub `fetch` with `vi.stubGlobal`, assert the URL, as `packagesApi.test.ts` does)

- [ ] **Step 1: Write the failing tests:** `fetchOrgTests sends q, limit and cursor only when given`; `fetchOrgTests encodes a q with spaces and #`; `searchRuns sends q and limit`; `fetchRunByNumber sends project, test, number and limit=1`.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/web/test/searchApi.test.ts` — FAIL.
- [ ] **Step 3: Implement** with `URLSearchParams` and `apiFetch(schema, url)`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Add browser clients for test and run lookup"`.

---

### Task 6: Palette logic — query parsing and destinations

**Files:**
- Create: `apps/web/src/palette/parseQuery.ts`
- Create: `apps/web/src/palette/destinations.ts`
- Test: `apps/web/test/paletteQuery.test.ts`, `apps/web/test/paletteDestinations.test.ts` (both `.ts`: they run in integration too)

**Interfaces:**
- Produces:
  ```ts
  // parseQuery.ts
  interface PaletteQuery { text: string; runNumber: { text: string; n: number } | null }
  function parsePaletteQuery(raw: string): PaletteQuery
  // text = raw.trim(); runNumber from /^(.+?)\s*#(\d+)$/ on text, n ≤ 2147483647 and ≥ 1, the inner text trimmed and non-empty

  // destinations.ts
  interface Destination { id: string; label: string; to: string }          // id unique, e.g. 'page:checkout:rules'
  interface ProjectRef { slug: string; name: string }
  function currentProjectSlug(pathname: string): string | null            // matchPath '/projects/:slug' and '/projects/:slug/*'; null for NEW_PROJECT_ROUTE's slug
  function goToDestinations(current: ProjectRef | null): Destination[]   // All runs, New project, then current's 7 pages
  function projectPages(project: ProjectRef): Destination[]               // labels "<page> · <project.name>" in ProjectShell order + New on-prem run
  function matchProjects(query: string, projects: readonly ProjectRef[], limit: number): ProjectRef[]
  function matchPages(query: string, candidate: ProjectRef | null): Destination[]
  ```
  `matchProjects`: case-insensitive substring of name or slug; prefix matches before inner matches, then by name. `matchPages`: every whitespace token of the query must be a substring of `"<page label> <project name> <project slug>"` (lowercased); at most 5.
  The candidate for `matchPages` is the current project, else `matchProjects(query, …, 1)[0]` (chosen by the caller in Task 7).

- [ ] **Step 1: Write the failing tests:**
  - `parsePaletteQuery`: `'checkout #12'` → `{ text: 'checkout #12', runNumber: { text: 'checkout', n: 12 } }`; `'checkout#12'` → same runNumber; `'#12'` → `runNumber: null` (Review Focus 5); `'checkout #0'` and `'checkout #99999999999'` → `runNumber: null`; `'  rules  '` → `text: 'rules'`.
  - `currentProjectSlug`: `'/projects/checkout/rules'` → `'checkout'`; `'/projects/checkout'` → `'checkout'`; `'/projects/_new'` → `null`; `'/runs/abc'` → `null`.
  - `goToDestinations(null)` → `['All runs', 'New project']` with `to` from `paths.ts`; with a project → those two then the seven pages, `to` equal to `projectRulesPath('checkout')` etc.
  - `matchProjects('che', …)` puts `checkout` (prefix) before `search-checkout` (inner).
  - `matchPages('rules', checkout)` → `['SLA rules · Checkout']`; `matchPages('tokens checkout', checkout)` → `['API tokens · Checkout']`; `matchPages('rules', null)` → `[]`.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Parse palette queries and build its destinations"`.

---

### Task 7: The palette dialog

**Files:**
- Modify: `apps/web/package.json` — add `cmdk@1.1.1` and `@radix-ui/react-dialog` (the version `cmdk` resolves) as dependencies; `pnpm install`; `pnpm audit --prod` must report no vulnerabilities.
- Create: `apps/web/src/palette/useDebouncedValue.ts` — `useDebouncedValue<T>(value: T, ms: number): T`.
- Create: `apps/web/src/palette/usePaletteSearch.ts` — `usePaletteSearch(raw: string): PaletteGroups`.
- Create: `apps/web/src/palette/CommandPalette.tsx` — `export default function CommandPalette(props: { open: boolean; onOpenChange(open: boolean): void })`.
- Test: `apps/web/test/CommandPalette.test.tsx` (new; `afterEach(cleanup)`; stub `fetch`; `QueryClient` with `retry: false`; `MemoryRouter`; stub `Element.prototype.scrollIntoView`, which jsdom lacks and `cmdk` calls)

**Interfaces:**
- Consumes: Task 5 clients; Task 6 functions; `projectsQueryKey`/`fetchProjects` (same key as the rail → a cache hit); `runName` (`runNumber.ts`), `STATUS`/`VERDICT`/`Marked` (`routes/marks.tsx`), `runPath`, `projectPath`, `projectTestPath`.
- Produces:
  ```ts
  type RunRow = RunListResponse['items'][number];   // the alias RunTally.tsx uses
  type GroupState<T> = { items: T[]; status: 'idle' | 'loading' | 'error' | 'ready' };
  interface PaletteGroups {
    query: PaletteQuery;
    goTo: Destination[];                       // only when query.text === ''
    projects: GroupState<ProjectRef>; pages: GroupState<Destination>;
    tests: GroupState<OrgTestSummary>; runs: GroupState<RunRow>;
    runByNumber: GroupState<{ run: RunRow; test: OrgTestSummary }>;
    settled: boolean;                           // every enabled group is 'ready' or 'error'
    total: number;                              // items across all groups
  }
  ```
  `usePaletteSearch` debounces `raw` by 150 ms, derives `currentProjectSlug(useLocation().pathname)`, and runs `useQuery` per remote group with `enabled: debounced.text !== ''` (Run by number: `enabled: debounced.runNumber !== null`; its `queryFn` = `fetchOrgTests({ q: text, limit: 3 })` then `Promise.all(fetchRunByNumber(...))`, keeping hits only) and `placeholderData: keepPreviousData`. A Run-by-number lookup that finds nothing is `ready` with no items, never `error`.
  `CommandPalette` renders `Dialog.Root/Portal/Overlay/Content` with an `sr-only` `Dialog.Title` "Search PerfPortal", and inside it `<Command shouldFilter={false} label="Search PerfPortal">` with `Command.Input` (controlled; reset to `''` whenever `open` turns false), `Command.List`, one `Command.Group` per non-empty group in the fixed order, a failure line per `error` group, the empty line only when `settled && total === 0 && query.text !== ''`, and a `role="status" aria-live="polite"` count rendered only once a non-empty query has settled. Item `value`s are unique (`project:<slug>`, `test:<id>`, `run:<id>`, `num:<run id>`, the destination's `id`). `onSelect` → `navigate(to)` then `onOpenChange(false)`.

- [ ] **Step 1: Write the failing tests** (fake timers where debouncing matters):
  - `shows Go to with the current project's pages before anything is typed` — route `/projects/checkout/rules` → "Go to" lists All runs, New project and seven "… · Checkout" rows.
  - `waits 150 ms after the last keystroke before searching` — typing `che`, advancing 149 ms → no `/v1/tests` request; 1 ms more → one request with `q=che`.
  - `renders groups in a fixed order` — fetch stubs answer all groups → group headings in DOM order `Projects, Pages, Tests, Runs`.
  - `keeps the other groups when one fails` — `/v1/tests` 500 → "Couldn't search tests" shown, runs still listed.
  - `says No results only after every group has answered` — runs stub delayed: no empty line while pending; after it resolves empty → `No results for “zzz”`.
  - `looks a run up by number within the matching tests` — `checkout #12` → `/v1/runs?…number=12` per matched test (≤ 3); hit shown under "Run by number" as "Run 12 · <test> · <project>".
  - `shows nothing and no failure for a run number that resolves to nothing` (Review Focus 5) — tests stub returns `[]` → no "Run by number" heading, no failure line, `No results` still appears.
  - `navigates to the chosen result and closes` — ArrowDown + Enter on a test row → location `projectTestPath(slug, testSlug)` and `onOpenChange(false)`.
  - `opens empty again after a search` (Review Focus 2) — type, close, reopen → input `''` and "Go to" shown, no Tests group.
  - `announces the result count only while open, once settled` — `role="status"` absent when closed and before the first settle; `"3 results"` after.
  - `keeps the last results on screen while the next query loads` — results for `che` shown; type `chec` with the stub held → the `che` rows stay until it answers.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/web/test/CommandPalette.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the three files. Status colours through inline `style={{ color: 'var(--color-status-…)' }}` (no Tailwind utility exists for them). Rows truncate (`min-w-0 truncate` with a `max-w`), never widen the dialog.
- [ ] **Step 4: Run** — PASS. Then `pnpm audit --prod` — "No known vulnerabilities found".
- [ ] **Step 5: Commit** `git commit -m "Add the command palette dialog"`.

---

### Task 8: Header trigger and the shortcut

**Files:**
- Create: `apps/web/src/palette/SearchTrigger.tsx` — `export default function SearchTrigger()`; owns `open` state and renders `CommandPalette`.
- Create: `apps/web/src/palette/shortcut.ts` — `isApplePlatform(nav?: Navigator): boolean`; `isPaletteShortcut(e: KeyboardEvent): boolean` = `(e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'`.
- Modify: `apps/web/src/AppShell.tsx` — render `<SearchTrigger />` between the brand `Link` and the `ml-auto` account group.
- Test: `apps/web/test/SearchTrigger.test.tsx` (new); one case added to `apps/web/test/AppShell.test.tsx`.

**Interfaces:**
- Consumes: `CommandPalette` (Task 7), `useIsCompact`.
- Produces: a `<button type="button" aria-label="Search" aria-keyshortcuts="Meta+K Control+K">` showing "Search" + `<kbd>` (`⌘K` / `Ctrl K`) when not compact, an icon only when compact. A `window` `keydown` listener in the CAPTURE phase (so an open Radix menu cannot swallow it) toggles `open` and calls `preventDefault()`. Focus returns to whatever was focused before opening (Radix Dialog's default; assert it).

- [ ] **Step 1: Write the failing tests:**
  - `opens on Meta+K and on Ctrl+K`; `ignores Alt+K and Shift+Meta+K`.
  - `opens from inside a text field without typing a k` (Review Focus 3) — focus an `<input>`, press Meta+K → dialog open, input value unchanged.
  - `closes on a second Meta+K` (Review Focus 3).
  - `returns focus to the element focused before it opened` — Esc → `document.activeElement` is the previously focused input.
  - `shows ⌘K on Apple platforms and Ctrl K elsewhere` — `isApplePlatform({ platform: 'MacIntel' })` true, `'Win32'` false; the rendered `kbd` text follows.
  - `is an icon button named Search below 768px` — `useIsCompact` true (stub `matchMedia`) → no visible "Search" text, name still "Search".
  - `opens while the account menu is open` — open `AccountMenu`, press Meta+K → the dialog opens (the capture-phase listener is what guarantees it).
  - AppShell: `renders exactly one Search control in the header`.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both plus `apps/web/test/AccountMenu.test.tsx` — PASS.
- [ ] **Step 5: Commit** `git commit -m "Open the palette from the header and with ⌘K"`.

---

### Task 9: Browser proof

**Files:**
- Create: `apps/web/e2e/command-palette.spec.ts`
- Modify (only if a fixture gap appears): `apps/web/e2e/fixtures.ts`

**Interfaces:**
- Consumes: `seedAdmin`, `seedTestWithRuns` (its runs are numbered `1..N`), `renameSimulation`, `signIn` (`helpers.ts`).

- [ ] **Step 1: Write the failing spec:**
  - `finds a test by name with the keyboard alone` — sign in, `page.keyboard.press('ControlOrMeta+k')`, type the test's name, wait for its option, Enter → `toHaveURL` the test's path and its `<h1>` names the test.
  - `opens a run from "<test> #N"` — type `<test name> #2` → the "Run by number" option → Enter → `toHaveURL(/\/runs\/<uuid>/)` and the page heading names Run 2.
  - `exposes a named dialog with a combobox and options to assistive technology` — `newCDPSession` + `Accessibility.getFullAXTree`: a node with role `dialog` named "Search PerfPortal", a `combobox`, and ≥ 1 `option` (Chromium only; `test.skip(browserName !== 'chromium')` INSIDE the test body).
  - `keeps long names inside the screen at 375 px` (Review Focus 4) — viewport 375x812, a project named with 120 characters and a test whose class is 56 characters (`com.acme.checkout.simulations.CheckoutPeakLoadSimulation`); open, type a shared word → `document.documentElement.scrollWidth === 375` and the dialog's right edge ≤ 375.
- [ ] **Step 2: Run** `nvm use && pnpm build && PERFPORTAL_E2E_PORT=3100 pnpm test:e2e apps/web/e2e/command-palette.spec.ts` against a scratch database — PASS. Then prove it can fail: remove `<SearchTrigger />` from `AppShell.tsx`, rebuild, re-run → every case FAILS; restore.
- [ ] **Step 3: Fix** whatever the browser shows that jsdom could not (layout, focus, portal stacking); add the fix's own unit case in the owning task's file.
- [ ] **Step 4: Run** the spec three times — 3 × PASS.
- [ ] **Step 5: Commit** `git commit -m "Prove the palette in a browser"`.

---

### Task 10: Gates, real runs, the record, the PR

**Files:**
- Modify: `CLAUDE.md` — a new entry at the top of "Verification" (this branch's files, cases, floors, what was red-verified, what was run), and the floor sentence (`201 files / 2757 tests`) updated.

- [ ] **Step 1: Predict the floors from the source** before running: unit 201 → 206 files (five new: `searchApi`, `paletteQuery`, `paletteDestinations`, `CommandPalette`, `SearchTrigger`), cases counted with `grep -c "it("` per touched file; integration 182 → 187 files (two `*.integration.test.ts` plus the three new `.ts` unit files); e2e 188 + the new spec's cases. Write the numbers down.
- [ ] **Step 2: Red-verify** from a checkpoint commit, asserting each mutation's replacement count, the tree clean after each: (a) `latestRuns` ordering by `COALESCE(tool_started_at, started_at)` → the arrival case alone; (b) `escapeLike` removed from `listOrg` → the literal-`q` cases; (c) the `scope.projectId` predicate removed → the token case alone; (d) `p95Histories` without `status = 'complete'` → the history case; (e) `NUMBER_NEEDS_TEST` check removed → that case alone; (f) debounce 0 ms → the 150 ms case alone; (g) `keepPreviousData` removed → the keeps-the-last-results case alone; (h) the listener switched to the bubbling phase → the account-menu case alone; (i) input not reset on close → Review Focus 2's case alone. A mutation that fails nothing means a missing case: add it to the owning task's file before going on. Rebuild `packages/persistence` around every persistence mutation.
- [ ] **Step 3: Run the gate**, each by its own exit code, on Node 22, scratch database, scratch Redis index, free e2e port: `pnpm typecheck; echo $?` → 0; `pnpm lint` → 0; `pnpm test:unit` → the predicted floor, zero `Errors` lines; `pnpm test:integration` → the predicted floor, exit 0; `pnpm test:e2e` → the predicted count, exit 0.
- [ ] **Step 4: Verify with real Gatling runs** (memory `verify-with-real-gatling-runs`): run `ParitySimulation` through the Gradle plugin into the developer database twice (so the test has Run N and Run N+1), then in the browser: ⌘K → the test by name; `<test> #N` → that run; a run's id prefix → that run. Revoke any token minted for it.
- [ ] **Step 5: Final review, record, ship:** dispatch `gh workflow run ci.yml --ref feat/command-palette` (three engines) and read its result; an Opus whole-branch review; fix what it finds (each fix with its own red-verified case); write the CLAUDE.md entry; push; open the PR to `main`; read CI's checks on the head SHA with the pinned-SHA check from CLAUDE.md; merge with `--merge` once green; delete the branch locally and on `origin`.
