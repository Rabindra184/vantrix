# AI Run Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored, three-section AI analysis of a finished run on its Summary page, every number in it checked against facts PerfPortal computed itself, opted into by an operator's environment and an admin's org switch.

**Architecture:** A pure `@perfportal/insight` package builds `RunFacts` from the run's stored figures and checks every number in generated text against them. The worker owns an `ai-analysis` BullMQ queue that builds facts, calls a provider (Claude through `@anthropic-ai/sdk`, or an OpenAI-compatible endpoint), checks, retries once, and stores the result in `run_ai_analysis`. The API exposes GET/POST `/v1/runs/{id}/ai-analysis` and an admin org setting; the web draws a card in `RunSummary` and a Settings tab in Administration.

**Tech Stack:** TypeScript, zod 4, NestJS, BullMQ, Prisma + raw `pg`, React + TanStack Query, `@anthropic-ai/sdk` (structured output via `zodOutputFormat`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md` (read it first); research `docs/superpowers/research/2026-11-02-ge-ai-run-analysis/README.md`.

## Global Constraints

- AI never changes a verdict, assertion, run status or alert.
- Nothing is sent unless BOTH `AI_PROVIDER` is set AND the org's `ai_enabled` is true. `ai_enabled` defaults to **false**.
- Env (blank = unset): `AI_PROVIDER` = `anthropic` | `openai-compatible`; `AI_MODEL` (default `claude-opus-5-5` for `anthropic`, required for `openai-compatible`); `ANTHROPIC_API_KEY` (required for `anthropic`); `AI_BASE_URL` (required for `openai-compatible`), `AI_API_KEY` (optional). A provider without its required companion stops API and worker at startup naming the missing variable. Compose maps `PERFPORTAL_AI_PROVIDER`, `PERFPORTAL_AI_MODEL`, `PERFPORTAL_ANTHROPIC_API_KEY`, `PERFPORTAL_AI_BASE_URL`, `PERFPORTAL_AI_API_KEY` through `app_env` as `${…:-}`.
- Sent to a provider: aggregates and labels only (facts). Never the raw log, never a user identity.
- Unavailable reasons, in this order of precedence: `not_configured`, `org_disabled`, `not_terminal`, `no_statistics`, `estimated`, `verification_mismatch`.
- Stale = run `recomputed_at` or `ingested_at` later than the analysis `generated_at`. A facts-version bump never makes an analysis stale.
- Generate: session only, action `run:analyze`, lowest role **member**. Read: `project:read`, any role, session or bearer.
- Error shares are of recorded errors (the Errors table's figure), never of requests.
- Card placement: in `RunSummary`, after the run totals and both assertion bars, before the "over time" charts section. `mobile.spec.ts` and `run-tables.spec.ts` bounds do not change.
- Not editable. No regenerate except when stale or failed.
- Copy: card title "AI run analysis"; button "Analyze with AI"; pending "Analysing this run…"; sections "Health", "Insights" (sub-headings "Errors", "Assertions", "Injection profile", "Response times"), "Recommendations".
- Repo rules: Node 22 (`nvm use`), every gate by its own exit code, red-verify every new guard from a committed checkpoint, a CLAUDE.md entry with floors, merge commit.

## Review Focus

1. **A run with nothing to say in a sub-section** (no errors, no assertions): the model returns an empty array; the card renders no empty heading. → Task 10 test `omits an Insights sub-section that has no bullets`.
2. **A run with hundreds of requests**: facts stay bounded (top 20 requests by count, plus every request that always failed, owns the tail, or has the slowest p95). → Task 4 test `bounds per-request facts on a wide run`.
3. **A provider that is down or slow**: BullMQ retries; the final attempt stores `failed` with `provider_error`; a `pending` row older than 10 minutes may be requested again. → Task 7 test `records provider_error on the last attempt`, Task 8 test `re-enqueues a pending row older than ten minutes`.
4. **A unit the model converts** ("2.38s" for 2383 ms) or a sum it invents ("342 failures"): rejected by the check, retried once with the offending numbers named. → Task 5 tests `refuses a converted unit` and `refuses an invented sum`.
5. **AI switched off after analyses exist** (admin flips the switch, operator unsets the provider): GET answers the unavailable reason and the card disappears; stored rows are kept. → Task 8 test `hides a stored analysis once the org switch is off`.

---

## PR 1 — backend (`feat/ai-run-analysis`)

### Task 1: Contracts

**Files:**
- Create: `packages/contracts/src/ai-analysis.ts`, `packages/contracts/test/ai-analysis.test.ts`
- Modify: `packages/contracts/src/index.ts` (export), `packages/contracts/src/access.ts` (`run:analyze`), `packages/contracts/src/admin.ts` (org settings)

**Interfaces — Produces:**
- `AiAnalysisContentSchema`: `{ health: Section, insights: { headline, errors[], assertions[], injectionProfile[], responseTimes[] }, recommendations: Section }`, `Section = { headline: string (1..300), bullets: string[] }`. Bounds: health bullets 1..6; recommendations bullets 1..6; each insights array 0..6; every string trimmed, 1..400 chars. `.strict()` on every object (the output schema is also the model's JSON schema).
- `AI_UNAVAILABLE_REASONS = ['not_configured','org_disabled','not_terminal','no_statistics','estimated','verification_mismatch'] as const`
- `AiAnalysisStateSchema = z.enum(['none','pending','ready','failed'])`
- `AiAnalysisResponseSchema` = discriminated union on `available`: `{ available: false, reason }` | `{ available: true, state, content: Content | null, failureReason: string | null, generatedAt: datetime | null, model: string | null, stale: boolean }`
- `ACCESS_ACTIONS['run:analyze'] = { role: 'member', scope: null, label: 'Generating AI run analyses' }`
- `OrgSettingsSchema = { aiEnabled: boolean, aiProviderConfigured: boolean, aiProvider: 'anthropic' | 'openai-compatible' | null, aiModel: string | null }`; `UpdateOrgSettingsRequestSchema = { aiEnabled: boolean }.strict()`

- [ ] **Step 1: Write failing tests** in `ai-analysis.test.ts`: `accepts empty insights arrays but not empty health bullets`; `refuses an unknown key at every level`; `refuses a 401-character bullet`; `parses each unavailable reason and refuses another`; `carries content exactly when the state is ready` (`{state:'ready', content:null}` and `{state:'pending', content:{…}}` both refused, via a `.superRefine` on the available branch).
- [ ] **Step 2:** `pnpm test:unit -- packages/contracts/test/ai-analysis.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement the schemas; add `run:analyze`; add the two admin schemas.
- [ ] **Step 4:** Tests PASS; `pnpm typecheck` exit 0 (the access table is a typed record — `apps/web` access helpers must still compile).
- [ ] **Step 5:** Commit `Add the AI run analysis contracts and the run:analyze action`.

### Task 2: Config parsing and the queue name (`@perfportal/core`)

**Files:**
- Create: `packages/core/src/ai-config.ts`, `packages/core/test/ai-config.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/ingest-queue.ts` (add `AI_ANALYSIS_QUEUE = 'ai-analysis'` beside `INGEST_QUEUE`)

**Interfaces — Produces:**
- `type AiConfig = { provider: 'anthropic'; model: string; apiKey: string } | { provider: 'openai-compatible'; model: string; baseUrl: string; apiKey: string | null }`
- `parseAiConfig(env: Record<string, string | undefined>): AiConfig | null` — null when `AI_PROVIDER` is blank; throws `Error` naming the missing or invalid variable otherwise. `baseUrl` stripped of a trailing `/`.
- `AI_ANALYSIS_QUEUE`

- [ ] **Step 1: Failing tests:** `answers null for a blank provider`; `defaults the anthropic model to claude-opus-5-5`; `throws naming ANTHROPIC_API_KEY when it is missing`; `throws naming AI_MODEL for openai-compatible without one`; `throws naming AI_BASE_URL`; `refuses an unknown provider, naming it`; `treats whitespace as unset`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (`parseRawLogRetentionDays`'s shape). **Step 4:** PASS.
- [ ] **Step 5:** Commit `Parse the AI provider configuration in one place`.

### Task 3: One definition of the run's concurrent users

**Files:**
- Create: `packages/statistics/src/users-total.ts`, `packages/statistics/test/users-total.test.ts`
- Modify: `packages/statistics/src/index.ts`, `apps/api/src/metrics/parity.controller.ts:107-135` (call it)

**Interfaces — Produces:** `sumUsersByOffset(rows: readonly { startOffsetMs: number; started: number; ended: number; maxConcurrent: number }[]): { startOffsetMs; started; ended; maxConcurrent }[]` — summed per offset, ascending (exactly the controller's current loop).

- [ ] **Step 1:** Failing test `sums scenarios per offset, never each scenario's own maximum` (two scenarios peaking at different offsets → peak of totals < sum of peaks).
- [ ] **Step 2–4:** FAIL → implement → PASS; the existing `parity` integration tests still pass (run `apps/api/test/parity-endpoints.integration.test.ts` if the stack is up, else CI).
- [ ] **Step 5:** Commit `Move the users total into statistics so the facts reuse it`.

### Task 4: The facts (`@perfportal/insight`, new pure package)

**Files:**
- Create: `packages/insight/{package.json,tsconfig.json,src/index.ts,src/facts.ts,src/format.ts,test/facts.test.ts}` (mirror `packages/verify`'s package.json `exports` with the `perfportal-source` condition; depends on `@perfportal/statistics` and `@perfportal/contracts`)
- Modify: root `tsconfig.json` references; `eslint.config.js` pure-package glob `packages/{core,plugin-gatling,statistics,sla,insight}/src/**/*.ts`

**Interfaces — Produces:**
```ts
export const FACTS_VERSION = 1;
export interface Fact { id: string; label: string; display: string; value: number | null; text: string | null }
export interface RunFacts { version: number; facts: Fact[] }
export interface FactsInput {
  run: { simulation: string | null; status: string; durationMs: number | null; activityMs: number | null };
  figures: StoredFigures;            // persistence's type, structurally re-declared here (insight may not import persistence)
  platformAssertions: { description: string; outcome: string; actualDisplay: string | null }[];
  toolAssertions: ToolAssertion[];   // contracts' type
}
export function buildRunFacts(input: FactsInput): RunFacts;
```
`format.ts`: `formatMs(n)` → integer ms with thousands separators (`"2,383 ms"`), `formatCount`, `formatPercent(fraction)` → 2 decimals (`"16.76%"`), `formatRate` → 2 decimals (`"18.95/s"`), `formatElapsed(ms)` → `hh:mm:ss`. Every fact's `display` comes from these; `value` is the unrounded raw number (percent facts carry the percentage, not the fraction).

Facts to emit (ids are stable, dot-separated): run totals (`run.requests`, `run.ok`, `run.ko`, `run.errorRate`, `run.throughput`, `run.duration`, `run.peakUsers` via `sumUsersByOffset`, `run.mean`, `run.p50`, `run.p95`, `run.p99`, `run.max`, `run.stddev`); per request and per group (`request.<i>.name` text fact, `.count`, `.ko`, `.errorRate`, `.p95`, `.p99`, `.max`); errors (`errors.total`, `error.<i>.message` text, `.count`, `.share`); assertions (`assertion.platform.<i>`, `assertion.tool.<i>`: text = description/expression, display = outcome + actual); derived: `derived.alwaysFailed` (text: names with count > 0 and ok = 0), `derived.koByRequest.<i>` (sums to `run.ko`), `derived.tailOwner` (request whose max equals the run max; text = name, display = its max), `derived.p99Owner`, `derived.slowestP95`, `derived.okZero` (absent when OK never fell to zero; else text `"only in the final drain"` or `"during the run"`, display = first offset via `formatElapsed`). "Final drain" = every run-scope series bucket with `okCount = 0 && koCount > 0` starts after the last user bucket with `started > 0`.

Bound: per-request facts for the top 20 requests by count, plus any request named by a derived fact.

- [ ] **Step 1: Failing tests** (fixtures built in the test from small literal `StoredFigures`, modelled on the GE run in the research README): `partitions KO by request so the parts sum to the run's KO`; `names a request that failed every time`; `names the tail's owner by the run maximum, not by failures` (Add To Cart holds max 4159 with 0 KO; Place Order has 172 KO → owner is Add To Cart); `says an OK drop happened only in the final drain`; `says an OK drop happened during the run`; `emits no okZero fact when OK never fell to zero`; `shares errors of recorded errors, which may exceed KO`; `bounds per-request facts on a wide run` (300 requests → ≤ 20 + derived names); `displays with the page's rounding` (`16.76%`, `2,383 ms`, `18.95/s`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `pnpm lint` exit 0 (pure-package rule applies).
- [ ] **Step 5:** Commit `Build a run's facts deterministically for the AI analysis`.

### Task 5: The number check

**Files:** Create `packages/insight/src/check.ts`, `packages/insight/test/check.test.ts`; export from index.

**Interfaces — Produces:** `checkNumbers(content: AiAnalysisContent, facts: RunFacts): string[]` — the numeric tokens (as written) that trace to no fact; empty = pass.

Rules: tokens match `/\d[\d,]*(?:\.\d+)?/g`. A token passes when (a) after removing `,` it equals a fact `value` written exactly, or rounded to 0, 1 or 2 decimals; or (b) it lies inside a span of the string that equals some fact's `text` or `label` verbatim (request names, error messages like `found 401`, assertion expressions); or (c) it is a percentile rank written as `p<digits>` / `P<digits>` whose rank appears in a `run.p*` fact id.

- [ ] **Step 1: Failing tests:** `passes a display string copied verbatim`; `passes a value rounded to two decimals`; `passes digits inside a request name and inside an error message`; `passes P95 and p99`; `refuses an invented sum` (text "342 failures" with KO facts 172 and 170 → `['342']`); `refuses a converted unit` ("2.38s" with p99 2383 → `['2.38']`); `checks every string in every section`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `Check every number in an analysis against the run's facts`.

### Task 6: Persistence

**Files:**
- Create: `packages/persistence/prisma/migrations/20261102120000_ai_run_analysis/migration.sql`, `packages/persistence/src/repositories/ai-analysis.ts`, `packages/persistence/src/repositories/org-settings.ts`, `packages/persistence/test/ai-analysis.integration.test.ts`
- Modify: `schema.prisma` (`Org.aiEnabled Boolean @default(false) @map("ai_enabled")`; model `RunAiAnalysis` → table `run_ai_analysis`), `src/index.ts`

Table: `run_id uuid PK FK run ON DELETE CASCADE`, `status text CHECK in ('pending','ready','failed')`, `content jsonb NULL`, `provider text NULL`, `model text NULL`, `facts_version int NULL`, `failure_reason text NULL`, `requested_by text NULL` (user id, `ON DELETE SET NULL` FK to `"user"`), `requested_at timestamptz(3) NOT NULL DEFAULT now()`, `generated_at timestamptz(3) NULL`. No backticks in SQL comments.

**Interfaces — Produces** (raw SQL on `pg.Pool`, `VerificationRepository`'s shape):
```ts
export interface AiAnalysisRecord { runId; status: 'pending'|'ready'|'failed'; content: unknown | null; provider: string|null; model: string|null; factsVersion: number|null; failureReason: string|null; requestedAt: Date; generatedAt: Date|null }
export interface AiEligibility { orgId: string; status: string; hasStats: boolean; notExact: boolean; verificationStatus: string | null; ingestedAt: Date|null; recomputedAt: Date|null }
class AiAnalysisRepository {
  find(runId): Promise<AiAnalysisRecord | null>;
  eligibility(runId): Promise<AiEligibility | null>;   // NOT_EXACT_RUN_SQL for notExact
  markPending(runId, userId: string): Promise<void>;   // upsert, clears content/failure, requested_at = now()
  record(runId, r: { content: unknown; provider: string; model: string; factsVersion: number }): Promise<void>; // status ready, generated_at now()
  markFailed(runId, reason: string): Promise<void>;
  readInput(runId): Promise<{ run: FactsInput['run']; figures: StoredFigures; platformAssertions: FactsInput['platformAssertions']; toolAssertions: unknown } | null>;
}
class OrgSettingsRepository { aiEnabled(orgId): Promise<boolean>; setAiEnabled(orgId, enabled: boolean): Promise<void> }
```
`readInput` uses `readStoredFigures`; platform assertion `description` is `describeSlaRule` from contracts over the snapshot, `actualDisplay` via `formatSlaMeasured`.

- [ ] **Step 1: Failing integration tests:** `defaults ai_enabled to false and sets it`; `markPending then record then find round-trips content`; `markPending after failed clears the failure`; `eligibility reports not_exact for an estimated run`; `deletes the analysis with its run`; `readInput returns stored figures and both kinds of assertion`.
- [ ] **Step 2:** FAIL. **Step 3:** Migration, schema, repositories; `prisma migrate deploy` on a scratch database; `infra/test/schema-matches-migrations.sh` logic must still agree (run `prisma migrate diff --exit-code` as that script does).
- [ ] **Step 4:** PASS (scratch DB + Redis index, never `perfportal`).
- [ ] **Step 5:** Commit `Store AI analyses per run and the org's AI switch`.

### Task 7: Worker — providers, service, queue

**Files:**
- Create: `apps/worker/src/ai/prompt.ts`, `apps/worker/src/ai/providers.ts`, `apps/worker/src/ai/ai-analysis.service.ts`, `apps/worker/src/ai/ai-queue.ts`, `apps/worker/test/ai-analysis.integration.test.ts`, `apps/worker/test/ai-providers.test.ts`
- Modify: `apps/worker/src/config.ts` (`ai: AiConfig | null` via `parseAiConfig(process.env)`), `apps/worker/src/main.ts` (start the consumer when `ai !== null`; close on shutdown), `apps/worker/package.json` (`@anthropic-ai/sdk`, `@perfportal/insight`)

**Interfaces — Produces:**
```ts
export interface AnalysisProvider { readonly name: string; readonly model: string; generate(req: { system: string; facts: RunFacts; feedback: string | null }): Promise<unknown> }
export function providerFor(config: AiConfig): AnalysisProvider;
export type AiOutcome = 'ready' | 'failed' | 'skipped';
export class AiAnalysisService { constructor(config: WorkerConfig, pool: pg.Pool, provider: AnalysisProvider | null); generate(runId: string, opts: { lastAttempt: boolean }): Promise<AiOutcome> }
export function startAiAnalysisConsumer(config: WorkerConfig, service: AiAnalysisService): Worker;
```
- Anthropic provider: read the claude-api skill's TypeScript files first; `new Anthropic({ apiKey, timeout: 120_000 })`; `client.messages.parse({ model, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium', format: zodOutputFormat(AiAnalysisContentSchema) }, system, messages })`; enable the server-side refusal fallback for `claude-opus-5-5` / `claude-sonnet-5-5` per that skill (verify the exact binding against the SDK, do not guess); `stop_reason === 'refusal'` → throw `RefusedError`.
- OpenAI-compatible provider: `fetch(`${baseUrl}/chat/completions`)` with `response_format: { type: 'json_schema', json_schema: { name: 'run_analysis', strict: true, schema: z.toJSONSchema(AiAnalysisContentSchema) } }`, 120 s `AbortSignal.timeout`, `Authorization` only when `apiKey`; returns `JSON.parse(choices[0].message.content)`.
- Service flow: re-read org switch and eligibility → if not eligible `markFailed(reason)` and return `skipped`; `buildRunFacts(readInput)`; `generate` → `AiAnalysisContentSchema.safeParse` + `checkNumbers`; on either failure retry ONCE with `feedback` naming the offending numbers or the schema error; second failure → `markFailed('numbers_not_in_facts: …')` / `('invalid_output')`; `RefusedError` → `markFailed('refused')`; transport errors (`Anthropic.APIConnectionError`, 429, ≥500, fetch abort) rethrow unless `lastAttempt`, then `markFailed('provider_error')`.
- Queue: job id = run id, `attempts: 3`, exponential backoff 10 s, `removeOnComplete: true`, concurrency 1; `lastAttempt = job.attemptsMade + 1 >= job.opts.attempts`.
- `prompt.ts`: the system prompt — cite only the given facts, copy each number exactly as its `display` string, never add, subtract, convert or round a number, never infer a cause no fact states, plain sentences, no numbering of items, empty arrays for an Insights sub-section with nothing to say. The user message is the facts as JSON (`id`, `label`, `display`, `text`).

- [ ] **Step 1: Failing tests** — `ai-providers.test.ts` (against a local `node:http` stub on `127.0.0.1`): `openai-compatible sends the schema and returns parsed JSON`; `omits Authorization without a key`; `anthropic provider reaches the stub through baseURL and returns parsed output` (SDK `baseURL` option); `throws RefusedError on a refusal stop reason`. `ai-analysis.integration.test.ts` (fake `AnalysisProvider`): `stores ready content whose numbers trace to facts`; `retries once naming the offending numbers, then stores the corrected content`; `fails with numbers_not_in_facts after a second bad answer`; `skips and records org_disabled when the switch was turned off after queueing`; `records provider_error on the last attempt and rethrows before it`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `Generate AI run analyses in the worker, checked against the facts`.

### Task 8: API, OpenAPI, access, infra

**Files:**
- Create: `apps/api/src/runs/run-ai-analysis.controller.ts`, `apps/api/test/ai-analysis.integration.test.ts`
- Modify: `apps/api/src/config.ts` (`ai: AiConfig | null`), `apps/api/src/runs/runs.module.ts` (controller, `AiAnalysisRepository`, `OrgSettingsRepository`, a BullMQ `Queue(AI_ANALYSIS_QUEUE)` provider closed on shutdown), `apps/api/src/admin/admin.controller.ts` (`GET /v1/admin/settings`, `PUT /v1/admin/settings`, `@Requires('users:manage')`), `apps/api/src/openapi/document.ts` + `schemas.ts` (`AiAnalysisResponse`, `OrgSettings`, `UpdateOrgSettingsRequest` — the last in `REQUEST_BODIES`), `apps/api/test/access-routes.integration.test.ts` (`ACCESS_BY_ROUTE`: `GET /v1/runs/:id/ai-analysis` → `project:read`, `POST …` → `run:analyze`, both admin routes → `users:manage`; matrix probe `{ action: 'run:analyze', role: 'member', route: 'POST /v1/runs/:id/ai-analysis', body: {} }`), `infra/docker-compose.yml`, `infra/.env.example`, `DEPLOYMENT.md`

**Behaviour:**
- Admin settings `GET` answers `aiProviderConfigured`, `aiProvider`, `aiModel` from `config.ai` (never the key) and `aiEnabled` from `OrgSettingsRepository`.
- `GET` (`@Requires('project:read') @Scopes('read')`): resolve the run in the caller's scope (404 otherwise); reason precedence per Global Constraints; else the row → `{ available: true, state, content, failureReason, generatedAt, model, stale }` (`state: 'none'` with no row).
- `POST` (`@Requires('run:analyze') @UseGuards(SessionOnlyGuard)`): unavailable → 409 `AI_ANALYSIS_UNAVAILABLE` naming the reason; `pending` younger than 10 min → 202 the row; `ready` and not stale → 200 the row; otherwise `markPending(runId, tenant.userId)` then `queue.add(…, { jobId: runId })` → 202. Mark before add (the verify queue's ordering reason).

- [ ] **Step 1: Failing integration tests:** `answers not_configured without a provider`; `answers org_disabled until an admin turns it on`; `answers not_terminal for a running run`; `answers estimated for a run labelled estimated`; `answers verification_mismatch`; `POST queues once and answers the pending row twice`; `re-enqueues a pending row older than ten minutes`; `POST on a ready analysis answers it without queueing`; `marks an analysis stale after a recompute and lets a member generate again`; `refuses a viewer's POST with ROLE_REQUIRED and a bearer's with FORBIDDEN`; `hides a stored analysis once the org switch is off`; `GET and PUT /v1/admin/settings report and set the switch`. Plus the existing route-walk, OpenAPI coverage and session-auth cross-org guards go red until registered — that is expected.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; compose + `.env.example` + a `DEPLOYMENT.md` "AI run analysis" section (variables, the two-step opt-in, exactly what is sent, that error messages may carry URL or body fragments, cost note). `node infra/test/env-example-covers-compose.mjs` exit 0; `docker compose -f infra/docker-compose.yml config --quiet` exit 0.
- [ ] **Step 4:** `pnpm typecheck`, `lint`, `test:unit`, `test:integration` (scratch DB, Redis index flushed) exit 0.
- [ ] **Step 5:** Commit `Serve the AI analysis and the org switch`; CLAUDE.md entry with measured floors; PR, CI green (SHA-pinned watch), merge `--merge`.

---

## PR 2 — UI (`feat/ai-run-analysis-ui`, cut from `main` after PR 1 merges)

### Task 9: Admin › Settings

**Files:** Create `apps/web/src/routes/AdminSettings.tsx`, `apps/web/test/AdminSettings.test.tsx`; modify `apps/web/src/api/admin.ts` (`fetchOrgSettings`, `updateOrgSettings`), `apps/web/src/routes/paths.ts` (`ADMIN_SETTINGS_ROUTE = '/admin/settings'`), `AdminShell.tsx` (tab "Settings"), `App.tsx` (route).

Page: one "AI features" switch. When `aiProviderConfigured` is false the switch is not drawn; one sentence says an operator must configure a provider (naming `AI_PROVIDER`). When drawn, its description: "When on, a member can send a run's figures, request names and error messages to <provider/model> to write an analysis." (provider and model from `OrgSettingsSchema.aiProvider` / `aiModel`, Task 1).

- [ ] Tests: `hides the switch when no provider is configured`; `turns AI features on and re-reads the settings`; `shows the API's refusal for a non-admin`. FAIL → implement → PASS → commit `Add Administration › Settings with the org's AI switch`.

### Task 10: The card

**Files:** Create `apps/web/src/api/aiAnalysis.ts`, `apps/web/src/routes/AiAnalysisCard.tsx`, `apps/web/test/AiAnalysisCard.test.tsx`; modify `apps/web/src/routes/RunSummary.tsx` (mount after `SimulationAssertionsBar`, before the "over time" section, finished runs only).

States: unavailable → render nothing; `none` → title + "Analyze with AI" (only when `useProjectAccess(…).can('run:analyze')`; otherwise nothing); `pending` → "Analysing this run…" (`role="status"` mounted only while pending), poll every 3 s; `ready` → three sections, each a `<button aria-expanded>` heading toggle, open on arrival, Insights as a two-column grid at `@container` width; header "Generated on <date>" with an ⓘ naming the model and saying every number was checked against this run's figures; `failed` → one sentence from `failureReason` and "Try again" for a member; `stale` → a line "This run's figures changed after this analysis was written." and "Generate again".

- [ ] Tests: `renders nothing when unavailable`; `offers Analyze with AI to a member and nothing to a viewer`; `polls while pending and renders the sections when ready`; `omits an Insights sub-section that has no bullets`; `collapses a section`; `offers Generate again when stale`; `shows the failure and Try again`. FAIL → implement → PASS → commit `Draw the AI run analysis card on the Summary`.

### Task 11: Browser proof and the real check

**Files:** Create `apps/web/e2e/ai-analysis.spec.ts`, a stub OpenAI-compatible server in `apps/web/e2e/ai-stub.ts`; modify `playwright.config.ts` (webServer env `AI_PROVIDER=openai-compatible`, `AI_MODEL=stub`, `AI_BASE_URL=http://127.0.0.1:<E2E_PORT+1>/v1`), `apps/web/e2e/fixtures.ts` (`enableOrgAi(orgId)`, `processAiAnalysis(runId)` running `AiAnalysisService` in-process from the worker's `dist`, as `parseUploadedRun` runs the pipeline).

The stub answers with content built from the request's own facts (copy two `display` strings), so the check passes for real.

- [ ] Spec: `a member generates an analysis and it survives a reload`; `the card does not appear while the org switch is off` (the default — every other spec stays untouched); `the card sits after the run totals` (its top is below the totals section's bottom; at 375×812 the first total tile is still inside 812). Red-verify by mounting the card before the totals.
- [ ] **Real check** (the user puts `ANTHROPIC_API_KEY` in `infra/.env`; never typed or read by the agent): a fresh `ParitySimulation` run through the on-prem runner, `AI_PROVIDER=anthropic`, org switch on, one generation; read every number in it against that run's Report and record the result and the outcome of the number check in the CLAUDE.md entry.
- [ ] Gates, CLAUDE.md entry with floors, PR, CI green, merge, delete both branches.
