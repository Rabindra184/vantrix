# Portfolio Home (PR 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/` a portfolio home page — "Tests that need attention" with a 7-day glance, running now, runs by project, and every test in the org — served by a new `GET /v1/activity`.

**Architecture:** `needsAttention` moves into `@perfportal/contracts` with a `reasons` companion, and one SQL fragment in persistence mirrors it (an integration case holds the two to agreement). `ActivityRepository.read` answers the day counts, the attention list, `running`, `byProject` and `lastRun` from `run.created_at`; `ActivityController` computes DST-correct day boundaries in Node with `Intl` and serves `GET /v1/activity?tz=`. The browser's `Home` page composes that response with the existing `GET /v1/tests` and `GET /v1/projects`; `AuthGate`'s membership probe moves onto the activity query.

**Tech Stack:** Prisma raw SQL on PostgreSQL 16, NestJS, zod contracts, React 18, TanStack Query 5, Tailwind v4 tokens, Vitest (node + jsdom projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md` (sections "PR 2", "Testing → PR 2", "Verification"). Corrected on this branch: "latest run" is USUALLY, not always, the highest-numbered run; the day counts get a new `(org_id, created_at)` index.

## Global Constraints

- Node 22 (`nvm use` in EVERY Bash call — each call starts on Node 20, where the jsdom project silently skips).
- Branch `feat/portfolio-home` (exists, holds the spec correction and this plan). `git log --oneline origin/main..HEAD` must show only this work. Never `git add -A`; name paths (`docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs` stay untracked).
- Integration and e2e run with CLAUDE.md's env block but `DATABASE_URL` on a SCRATCH database (e.g. `perfportal_palette`, migrated) and `REDIS_URL` on a scratch index — never the developer database `perfportal`, which holds real runs.
- Every window is on `run.created_at` (arrival). Attention window: the 604 800 000 ms before now, `created_at >= now - 604800000 AND created_at <= now`. Glance days: the 7 local calendar days in `tz` ending today; a run counts in day `i` when `boundaries[i] <= created_at < boundaries[i+1]`.
- "Latest run in the window" per test = `created_at DESC, id DESC` among that test's runs inside the attention window.
- Needs attention = status `failed` or `incomplete`, OR verdict `failed`, OR `checks.failed > 0`. Reasons, in this order: `failed`, `incomplete`, `gate_failed`, `assertion_failed`.
- `successful` = status `complete` AND not needing attention. In-flight runs (pending, parsing, running) count toward `total` only.
- `passRate` on the wire is a fraction in [0, 1] or null; the UI shows `Math.floor(rate * 100)`%, so 199 of 200 reads 99%, never 100%.
- `running` = count of `status = 'running'`, not windowed. Its link is `/runs?status=running`.
- `tz`: absent or blank after trimming → `UTC`; a zone `Intl.DateTimeFormat` rejects → 400 `INVALID_TIMEZONE`; repeated → 400 `INVALID_QUERY` (`singleValue`). The response echoes the zone AS SENT (trimmed), never `resolvedOptions()`'s canonical name (`Asia/Kolkata` must not come back as `Asia/Calcutta`).
- Credential rule = `GET /v1/tests`: session → whole org; token → its own project; scope `read`.
- Limits: attention ≤ 20 rows (`attentionTotal` carries the true count); `byProject` ≤ 5, by runs DESC then project name ASC; tests table 25 per page.
- Reserved link names: "Home", "All runs" and every project name belong to the rail. On Home, a project name is TEXT in every table and card; the one exception is "Runs by project", whose links go to `projectPath(slug)` — the rail row's own destination (same name, same place). No Home link may be named "Home" or "All runs".
- Copy (exact): h1 `Hello, <name>`; line `Activity in the last 7 days (<from> – <to>)`; card `Tests that need attention`, header datum `<N> tests · last 7 days` / `1 test · last 7 days` (filled state only); columns `Test` · `Project` · `Last run`; reasons `SLA failed`, `1 assertion failed` / `<N> assertions failed`, `Could not be ingested`, `Incomplete`; clean `Clean week`, `<P>% pass rate · <N> runs` (`<N> runs` alone when passRate is null), `No test needs attention.`; gap `Coverage gap`, `No runs in the last 7 days`, `Add results`; empty `No runs yet`, `Add results`, `New project`; side `Running now` with link `<N> running`, `Runs by project`; tests `Tests`, label `Filter tests`, columns `Name` · `Project` · `Last run` · `p95 · last 10`, pager `Previous` / `Next` (nav name `Test pages`), empty `No tests yet` / `No tests match “<q>”`; glance figure name `Runs per day`.
- Clean-UI rule: no description line under a card or section title (`Card` has no `description` prop); the attention count rides in `Card`'s `actions` slot.
- Status colours are inline `style` (`var(--color-status-passed)` etc.), never a `[var(--…)]` utility (`tokens.test.ts`). An outcome tint is a 3 px left rule, never coloured text.
- Repo guards that bite: no `...(cond ? { … } : {})` literal spreads (eslint); every 4xx through `badRequest` (remediation guard); no backticks in SQL comments inside template literals; a backticked `FooRepository`/`FooSchema` in a comment must exist; every route in the OpenAPI document (route-coverage guard); a contracts `z.string()` with `.min`/`.max` must `.trim()`; never `prisma format` over `schema.prisma`; persistence resolves through `dist` in integration — rebuild it (`pnpm build`) before integration runs and around every persistence mutation.

## Rulings made while planning (each a decision, not an oversight)

- **`attentionTotal` is added to the response.** The list is capped at 20; a header counting the rows sent would say "20 tests" over 35. One `count(*) OVER ()`. Cost if wrong: one extra field.
- **`tz` is echoed as sent, an empty `tz` is UTC.** ICU canonicalises `Asia/Kolkata` to `Asia/Calcutta` (measured on Node 22), and a response naming a zone the caller never sent reads as a bug.
- **The attention count rides in `Card`'s `actions` slot and only in the filled state.** `Card` forbids a description line; "0 tests" beside "No test needs attention." would say one thing twice.
- **Project names are text in tables; Runs by project links go to the rail's own destination.** A second link named after a project with a DIFFERENT destination is the collision CLAUDE.md records twice; the same name and place is not.
- **Previous/Next is a cursor stack in component state**, `RunList`'s reason for keeping cursors out of the URL. The filter's `q` is in the URL.
- **The glance draws in-flight runs as a third, neutral segment**, so a bar's height is always its day's `total`.
- **Home joins the palette's "Go to" list, first.** It is a destination, and the palette is "find and go".
- **A new `(org_id, created_at)` index.** `AuthGate` asks this endpoint on every cold load, and nothing served an org-wide arrival range; the EXPLAIN case holds it.
- **"Latest run" stays arrival** (the spec's rule and PR 1's shipped behaviour); the spec's "always the highest-numbered" is corrected to "usually". Cost if wrong: in the rare overlap, a test's last run reads "Run 5" while Run 6 exists — exactly what `GET /v1/tests` already shows.

## Review Focus

1. **A zone whose local midnight does not exist** (America/Santiago, 2026-09-06, clocks jump 00:00 → 01:00): that day's boundary is local 01:00 (`2026-09-06T04:00:00Z`). Naive two-pass offset arithmetic returns `03:00Z`, which is 23:00 on the 5th, and silently files an hour into the wrong day. → Task 2 test.
2. **`tool_assertions` holding JSON `null`** (not SQL NULL): the SQL predicate must neither error (`jsonb_array_elements` rejects a non-array) nor count it. → Task 3 combination case.
3. **A pass rate just under 100%** (199 successful, 1 needing attention) reads `99% pass rate`, never `100%`. → Task 5 test.
4. **More than 20 tests needing attention**: the card lists 20 and its header says the true total (`22 tests · last 7 days`). → Tasks 3 and 5 tests.
5. **Changing the tests filter while on a later page** returns to page 1: Previous disabled, and no request carries the old filter's cursor. → Task 6 test.

---

### Task 1: Contracts — `needsAttention`, `attentionReasons`, `ActivityResponse`

**Files:**
- Create: `packages/contracts/src/attention.ts`, `packages/contracts/src/activity.ts`; export both from `packages/contracts/src/index.ts`
- Modify: `apps/web/src/routes/RunTally.tsx` (delete its local `needsAttention`; import the contract's)
- Test: `packages/contracts/test/attention.test.ts`, `packages/contracts/test/activity.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export const ATTENTION_REASONS = ['failed', 'incomplete', 'gate_failed', 'assertion_failed'] as const;
  export const AttentionReasonSchema: z.ZodEnum<…>;  export type AttentionReason;
  export interface AttentionInput {
    readonly status: RunStatus;
    readonly verdict?: RunVerdict | null;
    readonly checks?: { readonly failed: number; readonly total: number } | null;
  }
  export function attentionReasons(run: AttentionInput): AttentionReason[];  // ATTENTION_REASONS order
  export function needsAttention(run: AttentionInput): boolean;            // reasons.length > 0
  export const ActivityAttentionRowSchema, ActivityResponseSchema; export type ActivityResponse;
  ```
  `ActivityResponseSchema` is the spec's `ActivityResponse` plus `attentionTotal: int ≥ 0`: `window: { from: datetime, to: datetime, tz: string }`; `days`: exactly 7 × `{ date: /^\d{4}-\d{2}-\d{2}$/, total, successful, needsAttention }` (ints ≥ 0); `runCount`; `passRate: number in [0,1] | null`; `running`; `byProject` (≤ 5) of `{ project: { slug, name }, runs }`; `attention` (≤ 20) of `{ test: { slug, name } | null, project: { slug, name }, run: { id: uuid, runNumber: RunNumberSchema.nullable(), status: RunStatusSchema, verdict: RunVerdictSchema.nullable(), startedAt: datetime, durationMs: int | null, checks: { failed, total } | null, simulation: string | null }, reasons: AttentionReasonSchema[] (min 1) }`; `attentionTotal`; `lastRun: { id, runNumber, test: { slug, name } | null, project: { slug, name }, startedAt } | null`. No string `.min`/`.max`.

- [ ] **Step 1: Write the failing tests.** `attention.test.ts`: `it.each` over every status × verdict (`passed`, `failed`, `not_evaluated`, null, absent) × checks (null, absent, `{0,2}`, `{1,2}`) asserting `needsAttention(x) === attentionReasons(x).length > 0` and the exact reasons, e.g. `{ status: 'failed', verdict: 'failed', checks: { failed: 1, total: 2 } }` → `['failed', 'gate_failed', 'assertion_failed']`, `{ status: 'complete', verdict: 'passed', checks: { failed: 0, total: 3 } }` → `[]`. `activity.test.ts`: a full response round-trips; `days` of 6 or 8 fails; an attention row with `reasons: []` fails; `passRate: 1.2` fails; `lastRun: null` passes.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run packages/contracts/test/attention.test.ts packages/contracts/test/activity.test.ts` — FAIL (no such exports).
- [ ] **Step 3: Implement** the two modules; point `RunTally.tsx` at the contract (its four counts and `RunTally.test.tsx` unchanged).
- [ ] **Step 4: Run** the two files plus `apps/web/test/RunTally.test.tsx` — PASS.
- [ ] **Step 5: Commit** `git add packages/contracts/src/attention.ts packages/contracts/src/activity.ts packages/contracts/src/index.ts packages/contracts/test/attention.test.ts packages/contracts/test/activity.test.ts apps/web/src/routes/RunTally.tsx && git commit -m "Move needsAttention into contracts and add the activity contract"`.

---

### Task 2: API — time zone and glance-day boundaries

**Files:**
- Create: `apps/api/src/activity/days.ts`
- Test: `apps/api/test/activity-days.test.ts` (new; a `.ts` file, so it runs in both unit and integration)

**Interfaces:**
- Consumes: `badRequest(code, message, remediation)` from `apps/api/src/common/validation.ts`.
- Produces:
  ```ts
  export const ATTENTION_WINDOW_MS = 604_800_000;
  export const GLANCE_DAYS = 7;
  export function resolveTimeZone(raw: string | undefined): string;
  export function glanceDays(tz: string, now: Date): { readonly dates: string[]; readonly boundaries: Date[] };
  ```
  `dates`: 7 `YYYY-MM-DD`, oldest → newest, the last being today in `tz`. `boundaries`: 8; `boundaries[i]` is the FIRST instant whose local date in `tz` is `dates[i]`; `boundaries[7]` is the first instant of the day after today. Only `Intl` is used, never Postgres's zone data. `INVALID_TIMEZONE` message `"<raw>" is not a time zone this server recognises.`, remediation `Send an IANA time zone name such as Europe/London, or leave "tz" out for UTC.`

- [ ] **Step 1: Write the failing tests:**
  - `treats a missing or blank zone as UTC` — `undefined`, `''`, `'  '` → `'UTC'`.
  - `echoes an accepted zone as sent` — `'Asia/Kolkata'` → `'Asia/Kolkata'`.
  - `refuses a zone Intl does not know` — `'Mars/Base'` throws, `code === 'INVALID_TIMEZONE'`, `remediation` contains `Europe/London`.
  - `gives a daylight-saving day its 25 hours` — `glanceDays('America/New_York', new Date('2026-11-07T20:00:00Z'))`: dates `2026-11-01` … `2026-11-07`; `boundaries[0]` = `2026-11-01T04:00:00Z`; `boundaries[1]` = `2026-11-02T05:00:00Z` (a 25 h gap); `boundaries[7]` = `2026-11-08T05:00:00Z`; every other gap exactly 24 h.
  - `starts a day whose midnight is skipped at its first real instant` (Review Focus 1) — `glanceDays('America/Santiago', new Date('2026-09-06T15:00:00Z'))`: `dates[6] === '2026-09-06'`, `boundaries[6]` = `2026-09-06T04:00:00Z`.
  - `puts every boundary on its own date` — for UTC, Asia/Kolkata, New York and Santiago: the local date of `boundaries[i]` is `dates[i]` and the local date of `boundaries[i] - 1 ms` is the date before.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/api/test/activity-days.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Read a zone's local fields with `Intl.DateTimeFormat('en-CA', { timeZone, year/month/day/hour/minute/second, hourCycle: 'h23' }).formatToParts`; derive the offset at an instant; candidate = `Date.UTC(y, m - 1, d) - offset`, recomputed once at the candidate; if the candidate's local date is still the previous day, advance to the first instant whose local date is the target (the skipped-midnight case). Build formatters per call, never at module scope (CLAUDE.md records why).
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `git add apps/api/src/activity/days.ts apps/api/test/activity-days.test.ts && git commit -m "Compute the home page's local day boundaries with Intl"`.

---

### Task 3: Persistence — the `(org_id, created_at)` index and `ActivityRepository`

**Files:**
- Create: `packages/persistence/prisma/migrations/20261006120000_run_org_created_at/migration.sql` — `CREATE INDEX "run_org_id_created_at_idx" ON "run" ("org_id", "created_at" DESC);`
- Modify: `packages/persistence/prisma/schema.prisma` — one line in `model Run`: `@@index([orgId, createdAt(sort: Desc)])` (hand-placed beside `@@index([testId, createdAt(sort: Desc)])`; do NOT run `prisma format`), then `prisma generate`
- Create: `packages/persistence/src/repositories/activity.ts`; export from `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/activity.integration.test.ts` (new; setup copied from `org-tests.integration.test.ts`)

**Interfaces:**
- Consumes: `TenantScope` (`repositories/tenant.ts`), `RunRecord['toolAssertions']`.
- Produces:
  ```ts
  export const ACTIVITY_ATTENTION_LIMIT = 20;
  export const ACTIVITY_PROJECT_LIMIT = 5;
  export function needsAttentionSql(alias: string): string;
  export function activityDaysQuery(scope: TenantScope, boundaries: readonly Date[]): { sql: string; params: unknown[] };
  export interface ActivityWindow { readonly attentionFrom: Date; readonly attentionTo: Date; readonly dayBoundaries: readonly Date[] }
  export interface ActivityRunRow { id: string; runNumber: number | null; status: string; verdict: string | null;
    startedAt: Date /* COALESCE(tool_started_at, started_at) */; durationMs: number | null;
    simulation: string | null; toolAssertions: RunRecord['toolAssertions'] }
  export interface ActivityAttentionRow { test: { slug: string; name: string } | null; project: { slug: string; name: string }; run: ActivityRunRow }
  export interface ActivityRows {
    days: Array<{ total: number; successful: number; needsAttention: number }>;   // 7
    running: number;
    byProject: Array<{ project: { slug: string; name: string }; runs: number }>;
    attention: ActivityAttentionRow[]; attentionTotal: number;
    lastRun: { id: string; runNumber: number | null; test: { slug: string; name: string } | null;
               project: { slug: string; name: string }; startedAt: Date } | null;
  }
  export class ActivityRepository { constructor(prisma: PrismaClient); read(scope: TenantScope, window: ActivityWindow): Promise<ActivityRows> }
  ```
  `needsAttentionSql` is the one SQL spelling of the rule; the checks clause must read the array through a CASE so a JSON `null` or a non-array never reaches `jsonb_array_elements` (SQL does not promise to short-circuit `AND`):
  ```sql
  (a.status IN ('failed', 'incomplete') OR a.verdict = 'failed' OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.tool_assertions) = 'array'
       THEN a.tool_assertions ELSE '[]'::jsonb END) e WHERE e->>'outcome' = 'failed'))
  ```
  The five reads run in parallel. Counts are cast `::int`. Attention = the latest-in-window run per test (`DISTINCT ON (test_id) … ORDER BY test_id, created_at DESC, id DESC`) UNION ALL every in-window run with `test_id IS NULL`, filtered by `needsAttentionSql`, `count(*) OVER ()` for `attentionTotal`, ordered `created_at DESC, id DESC`, `LIMIT 20`. `byProject` counts runs in `[boundaries[0], boundaries[7])`. `lastRun` is the scope's newest arrival with no window. A token scope (`projectId` set) narrows every read.

- [ ] **Step 1: Write the failing integration cases:**
  - `agrees with needsAttention on every status × verdict × checks combination` — insert 6 statuses × 4 verdicts (`passed`, `failed`, `not_evaluated`, NULL) × 5 `tool_assertions` (SQL NULL, JSON `null`, `[]`, `[passed]`, `[passed, failed]`) = 120 runs inside one glance day; (a) `SELECT id, ${needsAttentionSql('r')} AS needs FROM run r` matches the contract's `needsAttention` per row (checks = null for NULL/`null`/`[]`, else the failed/total tally); (b) that day's `total`, `successful` and `needsAttention` equal the counts computed from the contract.
  - `lists a test only when its latest run in the window needs attention` — test A: failed then passed (later `created_at`) → absent; test B: passed then failed → present with the failed run.
  - `lists each failed upload with no test as its own row, and not an in-flight one` — two `test_id IS NULL` failed runs → two rows, `test: null`; a `test_id IS NULL` pending run → absent.
  - `bounds the attention window at 168 hours` — failed runs of two tests at now − 167 h (listed) and now − 169 h (absent).
  - `reports the true total beyond the limit` (Review Focus 4) — 22 tests whose latest run failed → `attention.length === 20`, `attentionTotal === 22`, newest first.
  - `counts running regardless of the window` — a `running` run created 30 days ago counts; a `pending` one does not.
  - `orders byProject by runs, then name, and keeps five` — six projects.
  - `never counts another org's runs, and a token sees its own project` — another org's runs in every bucket change nothing; with `projectId` set, only that project counts.
  - `answers lastRun by arrival with no window` — only runs from 60 days ago → `lastRun` is the newest-created, every day zero.
  - `serves the day counts from run_org_id_created_at_idx` — `EXPLAIN (COSTS OFF)` of `activityDaysQuery(...)` under `SET LOCAL enable_seqscan = off` (the shape `run-number.integration.test.ts` uses) mentions the index.
- [ ] **Step 2: Run** `nvm use && pnpm build && pnpm vitest run -c vitest.integration.config.ts packages/persistence/test/activity.integration.test.ts` against the scratch database — FAIL.
- [ ] **Step 3: Implement** the migration, the schema line, and `activity.ts`; `pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma` on the scratch database.
- [ ] **Step 4: Run** `pnpm build` then the file — PASS; `bash infra/test/schema-matches-migrations.sh` (as CI runs it) agrees.
- [ ] **Step 5: Commit** the migration, `schema.prisma`, `activity.ts`, `index.ts` and the test, `-m "Add ActivityRepository and the org arrival index"`.

---

### Task 4: API — `GET /v1/activity`

**Files:**
- Create: `apps/api/src/activity/activity.controller.ts`, `apps/api/src/activity/activity.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `ActivityModule`), `apps/api/src/auth/auth.module.ts` (provide and export `ActivityRepository` beside `TestRepository`), `apps/api/src/openapi/schemas.ts` (register `ActivityResponse`), `apps/api/src/openapi/document.ts` (path, `TimeZone` parameter, `ActivityBadRequest` response)
- Test: `apps/api/test/activity.integration.test.ts` (new; setup copied from `apps/api/test/org-tests.integration.test.ts`), one case in `apps/api/test/session-auth.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's contract functions and schema, Task 2's `resolveTimeZone`/`glanceDays`/`ATTENTION_WINDOW_MS`, Task 3's `ActivityRepository`, `checkTally` (`apps/api/src/runs/check-tally.ts`), `singleValue`.
- Produces: `GET /v1/activity?tz=` → `ActivityResponse`, `@Scopes('read')`, either credential; OpenAPI `operationId: 'getActivity'`. Mapping: `checks = checkTally(toolAssertions)`, `reasons = attentionReasons({ status, verdict, checks })`, instants `toISOString()`, `window = { from: now − 168 h, to: now, tz }`, `runCount = Σ days.total`, `passRate = Σsuccessful ÷ (Σsuccessful + ΣneedsAttention)` or null, every field NAMED (no spreads), then `ActivityResponseSchema.parse` — so a row the SQL listed whose reasons come back empty is a loud 500, not a silent disagreement.

- [ ] **Step 1: Write the failing cases:** `answers a session its organisation's activity, in the response schema` (parse succeeds; 7 days; `window.tz === 'UTC'`); `echoes the zone it was asked for` (`tz=Asia/Kolkata` → `window.tz === 'Asia/Kolkata'`, and `days[6].date` equals today's date in that zone, computed by the test with `Intl`); `refuses an unknown zone` (400, `code: 'INVALID_TIMEZONE'`, remediation names `Europe/London`); `refuses a repeated tz` (400 `INVALID_QUERY`); `shows a project token only its own project` (`byProject` holds that project alone); `names why each listed run needs attention` (an SLA-failed run with one failed of two assertions → `reasons: ['gate_failed', 'assertion_failed']`, `checks: { failed: 1, total: 2 }`); `answers passRate null when nothing has finished` (only running and pending runs). In `session-auth.integration.test.ts`: `shows each org's session its own activity at GET /v1/activity, and never the other's`, shaped like that file's `GET /v1/tests` case.
- [ ] **Step 2: Run** `nvm use && pnpm build && pnpm vitest run -c vitest.integration.config.ts apps/api/test/activity.integration.test.ts apps/api/test/openapi.integration.test.ts apps/api/test/session-auth.integration.test.ts` — FAIL (route missing; the route-coverage guard also fails).
- [ ] **Step 3: Implement** the controller, module, provider and OpenAPI entries (a `description` saying both windows are by arrival, that `tz` defaults to UTC, and that `attentionTotal` is the uncapped count).
- [ ] **Step 4: Run** the same three files — PASS.
- [ ] **Step 5: Commit** the five source files and two test files, `-m "Serve GET /v1/activity"`.

---

### Task 5: Web — activity client, home helpers, `Glance`, `LastRunCell`, `AttentionCard`

**Files:**
- Create: `apps/web/src/api/activity.ts`, `apps/web/src/home/homeFormat.ts`, `apps/web/src/home/Glance.tsx`, `apps/web/src/home/LastRunCell.tsx`, `apps/web/src/home/AttentionCard.tsx`
- Test: `apps/web/test/homeFormat.test.ts`, `apps/web/test/Glance.test.tsx`, `apps/web/test/AttentionCard.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's contract; `apiFetch`; `runName`; `formatListInstant`; `Badge`, `Card`, `EmptyState`; `projectTestPath`, `runPath`, `projectSetupPath`, `NEW_PROJECT_ROUTE`; `useIsCompact`.
- Produces:
  ```ts
  // api/activity.ts
  export const activityQueryKey = (tz: string) => ['activity', tz] as const;
  export function browserTimeZone(): string;                 // resolvedOptions().timeZone, 'UTC' if empty or throwing
  export function fetchActivity(tz: string): Promise<ActivityResponse>;  // /v1/activity?tz=<encoded>
  export const ACTIVITY_POLL_MS = 30_000;
  export function activityRefetchInterval(data: ActivityResponse | undefined): number | false;  // running > 0 → 30 000
  // home/homeFormat.ts
  export type AttentionState = 'filled' | 'clean' | 'gap' | 'empty';
  export function attentionState(a: ActivityResponse): AttentionState;  // attention > 0; else runCount > 0; else lastRun; else empty
  export function greetingName(user: { name: string; email: string }): string;  // first word of the trimmed name, else the email's local part
  export function passRateLabel(rate: number): string;       // `${Math.floor(rate * 100)}%`
  export function reasonLabel(reason: AttentionReason, checks: { failed: number; total: number } | null): string;
  export function daysAgo(iso: string, now: Date): string;   // 'today' | '1 day ago' | '<n> days ago' (whole days, floored)
  export function attentionRowLabel(row: ActivityResponse['attention'][number]): string;  // test name, else simulation, else `Upload <first 8 of id>`
  // components (default exports)
  Glance({ days }: { days: ActivityResponse['days'] })
  LastRunCell({ run, reasons }: { run: { id: string; runNumber: number | null; status: RunStatus; verdict: RunVerdict | null; startedAt: string }; reasons: readonly AttentionReason[] })
  AttentionCard({ activity, projects, now }: { activity: ActivityResponse; projects: readonly { slug: string; name: string }[]; now: Date })
  ```
  `Glance`: a `<figure aria-label="Runs per day">` of seven columns; bar height = the day's `total` ÷ the busiest day's; stacked bottom-up successful (passed colour), needs attention (failed colour), the in-flight remainder (neutral); a zero day hatched (`repeating-linear-gradient` over `var(--color-border-default)`); the column label is `Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })` of `${date}T12:00:00Z`; each column carries an `sr-only` sentence `<label>: <n> run(s), <s> successful, <a> need(s) attention.` (`<label>: no runs.` for zero) and the same numbers in an `aria-hidden` box shown on hover; nothing focusable. `LastRunCell`: a link to `runPath(id)` named `runName(n)` (or `Run <first 8 of id>`), the short start time, one `Badge` per reason, and a 3 px left rule: failed colour when reasons is non-empty, pending colour in flight, passed colour for verdict `passed`, else `var(--color-border-default)`. `AttentionCard` renders the four states with the Global Constraints' exact copy; in the filled state a table (cards when compact) whose Test cell links `projectTestPath(project, test)` or `runPath(run.id)` for a test-less row; the glance sits beside it on desktop and below it compact; the gap state's box is `<name> · Run N · <daysAgo>` with `Add results` → `projectSetupPath(lastRun.project.slug)`; the empty state's `Add results` → the first project (omitted with none) and `New project` → `NEW_PROJECT_ROUTE`.

- [ ] **Step 1: Write the failing tests.** `homeFormat.test.ts`: the four `attentionState` cases; `greetingName({ name: '  Ada Lovelace ', email: 'x@y' }) === 'Ada'` and `({ name: ' ', email: 'grace@navy.mil' }) === 'grace'`; `passRateLabel(199 / 200) === '99%'` (Review Focus 3) and `passRateLabel(1) === '100%'`; `reasonLabel('assertion_failed', { failed: 1, total: 3 }) === '1 assertion failed'` and `{ failed: 2 }` → `'2 assertions failed'`; `daysAgo` at 0, 1 and 51 days; `attentionRowLabel` falls back to the simulation and then to `Upload 1a2b3c4d`; `activityRefetchInterval` 30 000 at `running: 1`, false at 0 and undefined. `Glance.test.tsx`: seven columns; each sentence computed from the payload with the same `Intl` call (never written down); the busiest day's bar at 100% and a half day at 50%; a zero day says "no runs" and is hatched; no element is focusable. `AttentionCard.test.tsx`: each state's exact copy; the filled header datum reads `22 tests · last 7 days` when `attentionTotal` is 22 and 20 rows are sent (Review Focus 4); a test-less row's link goes to the run; reason badges per row; Project cells contain no link; the gap state's `Add results` points at the last run's project.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/web/test/homeFormat.test.ts apps/web/test/Glance.test.tsx apps/web/test/AttentionCard.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the five files.
- [ ] **Step 4: Run** the three files — PASS.
- [ ] **Step 5: Commit** the eight files, `-m "Add the attention card and the 7-day glance"`.

---

### Task 6: Web — the tests table and its sparkline

**Files:**
- Create: `apps/web/src/home/HomeTests.tsx`, `apps/web/src/home/Sparkline.tsx`
- Modify: `apps/web/src/api/tests.ts` — `export const orgTestsPageQueryKey = (q: string, limit: number, cursor: string | null) => ['org-tests', q, limit, cursor] as const;` beside `orgTestsQueryKey` (whose docstring says the palette's key deliberately carries no cursor; a paged table's must). `fetchOrgTests` already takes `cursor`.
- Test: `apps/web/test/HomeTests.test.tsx`, `apps/web/test/Sparkline.test.tsx` (new)

**Interfaces:**
- Consumes: `fetchOrgTests`, `useDebouncedValue` (`apps/web/src/palette/useDebouncedValue.ts`), `LastRunCell` (Task 5), `attentionReasons`, `CopyIdButton`, `SectionHeading`, `EmptyState`, `ErrorState`, `SkeletonTable`, `useIsCompact`, `projectTestPath`.
- Produces: `HomeTests()` (default export) and `Sparkline({ points, lastNeedsAttention }: { points: readonly { p95Ms: number }[]; lastNeedsAttention: boolean })`. `HOME_TESTS_LIMIT = 25`, `HOME_FILTER_DEBOUNCE_MS = 250`. The filter's value lives in `?q=` (written with `replace: true`, removed when blank); the cursor is a STACK in component state (not the URL — `RunList` records why), reset to empty whenever the debounced `q` changes; Previous pops, Next pushes `nextCursor`; the pager renders only when the page has rows, Previous disabled at the first page, Next disabled when `nextCursor` is null or the next page is in flight. The Name cell is a link to `projectTestPath` with the slug and `CopyIdButton` (`label: \`Copy test slug ${slug}\``, `size: 'row'`, `'touch'` on cards) beneath; Project is text; Last run is `LastRunCell` with `attentionReasons(latestRun)`, or `Never run`; the p95 cell is `Sparkline` with `lastNeedsAttention = latestRun needs attention AND latestRun.id === last point's runId`. `Sparkline`: an `aria-hidden` 80×24 SVG polyline (one point → a dot; none → no SVG), the last point's circle in the failed colour when `lastNeedsAttention`; visible text = the last point's `${Math.round(p95Ms)} ms` (`—` with none); `sr-only` `last <n> runs: <min>–<max> ms` (`No completed runs with a p95` with none).

- [ ] **Step 1: Write the failing tests.** `HomeTests.test.tsx` (fetch stubbed; assertions computed from the fixture): the four columns; typing `chec` writes `?q=chec` after the debounce and requests `q=chec`; Next sends the first page's `nextCursor`, Previous returns to the first page; **changing the filter on page 2 resets to page 1** — Previous disabled, and the request after the change carries no `cursor` (Review Focus 5); `No tests match “zzz”` and `No tests yet`; a failed list shows `ErrorState` only inside this section. `Sparkline.test.tsx`: the polyline has as many points as the history; the sr summary's min and max come from the points; the last circle takes the failed colour only when `lastNeedsAttention`; zero points render `—`, no SVG.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/web/test/HomeTests.test.tsx apps/web/test/Sparkline.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the two components and the query key.
- [ ] **Step 4: Run** the two files and `apps/web/test/CommandPalette.test.tsx` (it shares `fetchOrgTests`) — PASS.
- [ ] **Step 5: Commit** the five files, `-m "Add the home page's tests table with p95 sparklines"`.

---

### Task 7: Web — the `Home` page, routing, the rail, the probe

**Files:**
- Create: `apps/web/src/routes/Home.tsx`; `HomeIcon = icon(House)` in `apps/web/src/components/icons.tsx`
- Modify: `apps/web/src/routes/paths.ts` (`export const HOME_ROUTE = '/';` `DEFAULT_ROUTE = HOME_ROUTE`; update both docstrings), `apps/web/src/App.tsx` (drop the top-level `/` redirect; `<Route path={HOME_ROUTE} element={<Home />} />` inside the `AppShell` layout; lazy-import `Home`), `apps/web/src/AppShell.tsx` (brand link → `HOME_ROUTE`), `apps/web/src/ProjectRail.tsx` (a `Home` NavLink row above All runs, `end`, same collapse treatment; All runs → `ALL_RUNS_ROUTE`), `apps/web/src/routes/ProjectShell.tsx`, `apps/web/src/routes/RunDetail.tsx` and `NewProject.tsx`'s "Runs" back link (→ `ALL_RUNS_ROUTE`; `NewProject`'s Cancel stays `DEFAULT_ROUTE`, now Home), `apps/web/src/AuthGate.tsx` (probe = `useQuery({ queryKey: activityQueryKey(browserTimeZone()), queryFn: () => fetchActivity(...) })`; docstring updated), `apps/web/src/palette/destinations.ts` (`{ id: 'go:home', label: 'Home', to: HOME_ROUTE }` FIRST in `ALWAYS`)
- Test: `apps/web/test/Home.test.tsx` (new); update `AuthGate.test.tsx`, `ProjectRail.test.tsx`, `ProjectShell.test.tsx`, `paths.test.ts`, `paletteDestinations.test.ts`, `CommandPalette.test.tsx`; `apps/web/e2e/run-detail.spec.ts` gains the back-link `href` assertion (run in Task 8)

**Interfaces:**
- Consumes: Tasks 5 and 6; `getSession`/`sessionQueryKey`; `fetchProjects`/`projectsQueryKey`; `useDocumentTitle`; `Card`; `projectPath`.
- Produces: `Home` renders `<h1>Hello, {greetingName(user)}</h1>`, the activity line (`from`/`to` = `window.from`/`window.to` with `Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })`), then a desktop grid — `AttentionCard` in the main column; `Running now` (link `<N> running` → `` `${ALL_RUNS_ROUTE}?status=running` ``) and `Runs by project` (rows: link `project.name` → `projectPath(slug)`, the count as text, an `aria-hidden` bar proportional to the top project) beside it — then `HomeTests`. Compact: one column in that order. The activity query uses `refetchInterval: (q) => activityRefetchInterval(q.state.data)`. Each card has its own skeleton and `ErrorState`; a failed activity read never blanks `HomeTests`, nor the reverse. `useDocumentTitle('Home')`.

- [ ] **Step 1: Write the failing tests.** `Home.test.tsx`: the greeting from the name and from the email; the activity line's dates computed with the same `Intl` call; an activity failure shows `ErrorState` where the attention card was while the tests table still renders, and the reverse; `Running now` links to `/runs?status=running`; no link on the page is named `Home` or `All runs`. `AuthGate.test.tsx`: a `/v1/activity` 403 sends the user to the no-org page; the probe's request URL starts `/v1/activity`. `ProjectRail.test.tsx`: a `Home` row precedes All runs; Home is current on `/` and All runs is not; Home is not current on `/runs`; All runs' `href` is `/runs` and Home's is `/`; the row textContent pins updated for the new row. `ProjectShell.test.tsx`'s "offers a way out that leaves the project" case also asserts that link's `href` is `/runs`; `run-detail.spec.ts`'s "another org run is not readable" case asserts "Back to all runs" goes to `/runs` (Task 8 runs it). `paths.test.ts`: `DEFAULT_ROUTE === HOME_ROUTE === '/'` and `ALL_RUNS_ROUTE === '/runs'`. Palette files: `Home` leads the Go-to list.
- [ ] **Step 2: Run** `nvm use && pnpm vitest run apps/web/test/Home.test.tsx apps/web/test/AuthGate.test.tsx apps/web/test/ProjectRail.test.tsx apps/web/test/ProjectShell.test.tsx apps/web/test/paths.test.ts apps/web/test/paletteDestinations.test.ts apps/web/test/CommandPalette.test.tsx` — FAIL.
- [ ] **Step 3: Implement** everything in Files.
- [ ] **Step 4: Run** the seven files, then `pnpm typecheck` and `pnpm lint` — PASS, each by its own exit code.
- [ ] **Step 5: Commit** the named source and test files, `-m "Make / the portfolio home page"`.

---

### Task 8: Browser proof and e2e fallout

**Files:**
- Create: `apps/web/e2e/home.spec.ts`
- Modify (known fallout of landing on `/` after sign-in): `apps/web/e2e/auth.spec.ts` lines 28 and 41 (expect `/$` and the Home heading), `apps/web/e2e/resilience.spec.ts` (the two `run-row` waits right after `signIn` at lines 21 and 150 gain `page.goto('/runs')`; the `Alpha Service` click scopes to `getByRole('navigation', { name: 'Projects', exact: true })`; its comment about the bootstrap caching the run list's first page is now false — a cold `/runs` fetches its own first page — and is rewritten), `apps/web/e2e/run-list.spec.ts` lines 55 and 86 (`page.goto('/runs')` first)

**Interfaces:**
- Consumes: `seedAdmin`, `seedProjectWithRuns`, `seedRunWithFailedAssertion`, `renameSimulation`, `signIn` (`apps/web/e2e/fixtures.ts`, `helpers.ts`).

- [ ] **Step 1: Write `home.spec.ts`:** `signing in lands on Home, and the brand link returns there` (URL `/$`, h1 `/^Hello, /`; from `/runs` the brand link → `/`); `a run whose assertion failed is listed with its reason, and its last-run link opens it` (`seedRunWithFailedAssertion` → a row with `1 assertion failed`; its `Run N` link → `/runs/<id>`); `the page never scrolls sideways at 320, 375 and 414 px` (two projects, one run renamed to `com.acme.checkout.simulations.CheckoutPeakLoadSimulation`; `documentElement.scrollWidth <= innerWidth` at each); `only the rail names a link Home or All runs` (`getByRole('link', { name: 'Home', exact: true })` and `'All runs'` each count 1, inside the Projects nav); `filtering the tests writes ?q= and narrows the table`.
- [ ] **Step 2: Run** `nvm use && pnpm test:e2e --workers=2` against the scratch stack — the new spec passes, and every failure is read: fix each by navigating where the spec meant to be or by scoping a query, never by changing the product to suit a test. Record each fixed spec in the commit message.
- [ ] **Step 3: Run** it again — all pass, exit 0.
- [ ] **Step 4: Commit** the spec and every fixed spec by name, `-m "Prove the home page in a browser"`.

---

### Task 9: Gates, real runs, the record, the PR

**Files:**
- Modify: `CLAUDE.md` — a new entry at the top of "Verification" (files, cases, floors, rulings, what was red-verified and run), the floor sentence updated, and "Home" added to the rail's reserved vocabulary in "Conventions that bite".

- [ ] **Step 1: Predict the floors from the source** before running anything: unit from 206 files (or whatever `main` measures — re-measure if it moved) plus Tasks 1, 2 and 5–7's new files, cases counted with `grep -c "it("`/`it.each` rows; integration plus the new `.ts` unit files and the two integration files; e2e plus `home.spec.ts`'s cases. Write them down.
- [ ] **Step 2: Red-verify** from a checkpoint commit, replacement counts asserted, tree clean after each, persistence rebuilt around its mutations: (a) the CASE in `needsAttentionSql` removed → the combination case errors on JSON `null`; (b) the latest-in-window `DISTINCT ON` ordered ascending → the failed-then-passed case alone; (c) the skipped-midnight correction removed → the Santiago case alone; (d) `Math.floor` → `Math.round` → the 99% case alone; (e) `attentionTotal` replaced by `attention.length` in the card → the 22-tests case alone; (f) the cursor stack not reset on filter change → Review Focus 5's case alone; (g) the `tz` echo switched to `resolvedOptions().timeZone` → the Kolkata echo case alone; (h) the token's `projectId` predicate dropped → the token cases; (i) the probe left on `/v1/runs` → the AuthGate URL case alone. A mutation that fails nothing is a missing case: add it to the owning task first.
- [ ] **Step 3: Run the gate**, each by its own exit code (redirect to a file, then `echo $?`), on Node 22, scratch database (`perfportal_palette` or a fresh one, migrated), scratch Redis index, a free e2e port: `pnpm typecheck` → 0; `pnpm lint` → 0; `pnpm test:unit` → the prediction, zero `Errors` lines; `pnpm test:integration` → the prediction, exit 0; `pnpm test:e2e --workers=2` → the prediction, exit 0.
- [ ] **Step 4: Verify with real Gatling runs** (memory `verify-with-real-gatling-runs`): `ParitySimulation` through the Gradle plugin and once through the on-prem runner into the developer database; Home lists it under "Tests that need attention" with `1 assertion failed`; ⌘K `<test> #N` opens it; the glance's today column counts the new runs; `Running now` reads 1 while the runner run streams. Revoke every token minted, stop processes by PID.
- [ ] **Step 5: Ship.** `gh workflow run ci.yml --ref feat/portfolio-home` (three engines) and read it; an Opus whole-branch review; each fix with its own red-verified case; the CLAUDE.md entry; push; open the PR to `main`; read CI on the head SHA with CLAUDE.md's pinned-SHA check; merge with `--merge` once green; delete the branch locally and on `origin`.
