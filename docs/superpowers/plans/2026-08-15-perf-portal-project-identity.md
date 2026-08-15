# Project Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every run a visible project, give the org a list of its projects with each one's latest verdict, and stop discarding the `environment`/`branch`/`commitSha` the ingest contract already validates.

**Architecture:** `RunRecord` grows a joined `project`, so both run response shapes carry identity from one place. A new `GET /v1/projects` answers with one `LEFT JOIN LATERAL` query rather than one query per project. `?project=<slug>` fills the optional `projectId` that `RunRepository.list` already accepts. Three nullable columns land on `run`, written at accept time and never by the worker.

**Tech Stack:** TypeScript, NestJS 11, Prisma + PostgreSQL, Zod, React 19 + React Router 7, TanStack Query 5, Vitest, Playwright, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-15-perf-portal-project-identity-design.md`

## Global Constraints

- **`project` on `RunResponse` is REQUIRED, not `.optional()`.** `run.project_id` is `NOT NULL`; an optional field would model a state the database cannot hold.
- **The lateral's inner `ORDER BY` is `COALESCE(tool_started_at, started_at) DESC, id DESC`** — character-for-character what `RunRepository.list` orders by. If they drift, the sidebar's "latest run" and the run list's top row name different runs and nothing looks broken.
- **404 for a slug outside the caller's org.** Never 403, never an empty 200. A 403 confirms the project exists; an empty 200 describes a project that exists and is idle.
- **400 `PROJECT_MISMATCH`** when a bearer token names a project other than its own.
- **Three nullable columns, no default, no backfill, no index.** Nothing to backfill from; nothing filters on them.
- **Chips render only when non-null.** A run carrying none looks exactly as it does today. Never `—`, never `''`.
- **The commit chip links nowhere** and shows 7 characters with the full SHA in the group's accessible name.
- **`<RunList key={slug} …>` is required**, not stylistic. Without it, `/projects/a` → `/projects/b` reuses the component and its cursor.
- **Expectations are computed from the payload, never written down.** A test that hard-codes a value a fixture supplies breaks on the next re-capture for a reason that is not a defect.
- **Accessible-name assertions go in Playwright, never jsdom.** `dom-accessibility-api` does not consult a descendant's `aria-hidden` the way Chromium's accessibility tree does.
- **Full verification before claiming completion:**
  `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
  `test:integration` and `test:e2e` need the local stack (`infra/docker-compose.yml`) and the env vars in `CLAUDE.md`.
- **Never run `pnpm test:integration` while `scripts/capture-chart-fixture.mjs` is capturing** — that suite truncates every table on setup.
- Branch is `feat/project-identity`, already created from `main`. One PR back to `main`, merged with `--merge`, never squash.

**Seed data both test suites already provide:** org with one project, `slug: 'checkout'`, `name: 'Checkout'` — `apps/api/test/support/app.ts:61` and `apps/web/e2e/fixtures.ts:67`.

---

### Task 1: Project identity on `RunRecord` and both run responses

**Files:**
- Modify: `packages/contracts/src/run.ts`
- Modify: `packages/persistence/src/repositories/run.ts`
- Modify: `apps/api/src/runs/runs.service.ts:34-46`
- Modify: `apps/api/src/runs/runs.controller.ts:69-78`
- Modify: `apps/api/test/verdict.integration.test.ts:226` (a `RunRecord` literal that will stop compiling)
- Modify: `apps/web/test/RunHeader.test.tsx`, `apps/web/test/RunShell.test.tsx` (`RunResponse` literals, same reason)
- Test: `packages/contracts/test/contracts.test.ts`, `apps/api/test/read.integration.test.ts`

**Interfaces:**
- Produces: `ProjectRefSchema` / `ProjectRef` (`{ id: string; slug: string; name: string }`) from `@perfportal/contracts`; `RunRecord.project: { id: string; slug: string; name: string }` from `@perfportal/persistence`; `RunResponse.project` and `RunListResponse['items'][number].project` / `.simulation`.

- [ ] **Step 1: Write the failing contract test**

Append to `packages/contracts/test/contracts.test.ts`:

```ts
describe('RunResponseSchema project identity', () => {
  const base = {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    assertions: [],
  };

  it('rejects a run with no project — run.project_id is NOT NULL', () => {
    expect(() => RunResponseSchema.parse(base)).toThrow();
  });

  it('carries the project through', () => {
    const ok = RunResponseSchema.parse({
      ...base,
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    });
    expect(ok.project.slug).toBe('checkout');
    expect(ok.project.name).toBe('Checkout');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @perfportal/contracts exec vitest run test/contracts.test.ts`
Expected: the second test FAILS — `Unrecognized key(s)` is not thrown, so `ok.project` is `undefined` and `.slug` throws `TypeError`. The first test also fails, because a schema with no `project` key accepts `base` happily.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/run.ts`, above `RunResponseSchema`:

```ts
/**
 * A run's owning project, as every run response carries it. Its own schema
 * rather than an inline object so RunResponse and RunListResponse cannot
 * describe the same thing two ways.
 */
export const ProjectRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
```

In `RunResponseSchema`, directly after `id`:

```ts
  /**
   * The project this run belongs to. REQUIRED, not optional: run.project_id
   * is NOT NULL, so an optional field would model a state the database
   * cannot hold — and apps/web parses with RunResponseSchema.parse, so a
   * server that forgets it must fail loudly rather than render a blank
   * where a project name belongs.
   */
  project: ProjectRefSchema,
```

In `RunListResponseSchema`'s `.pick({...})`, add two keys:

```ts
      project: true,
      simulation: true,
```

- [ ] **Step 4: Run the contract test and watch it pass**

Run: `pnpm --filter @perfportal/contracts exec vitest run test/contracts.test.ts`
Expected: PASS. The three pre-existing `RunResponseSchema.parse` calls in this file (around lines 22, 34, 47) now fail — add `project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' }` to each object under test. They are asserting other fields; the project is scaffolding for them.

- [ ] **Step 5: Put `project` on `RunRecord`**

In `packages/persistence/src/repositories/run.ts`, add to `RunRecord` after `projectId`:

```ts
  /**
   * Joined from `project`. REQUIRED: run.project_id is NOT NULL, so every
   * read path can supply it and no consumer should have to check. The
   * worker's findByIdUnscoped pays one indexed foreign-key join it does not
   * read — cheaper than a second RunRecord shape, and far cheaper than an
   * optional-but-always-present field.
   */
  project: { id: string; slug: string; name: string };
```

Change `RunRow`'s shape to match — replace nothing, add:

```ts
  project: { id: string; slug: string; name: string };
```

And in `toRecord`, after `projectId: row.projectId,`:

```ts
    project: { id: row.project.id, slug: row.project.slug, name: row.project.name },
```

Picking the three fields explicitly, rather than spreading `row.project`, is what stops Prisma's full `Project` row (with `settings`, `createdAt`, `orgId`) from leaking into `RunRecord`.

- [ ] **Step 6: Include the project on the three Prisma read paths**

In the same file, add `include: { project: true }` to `create`, `findById` and `findByIdUnscoped`:

```ts
    const row = await this.prisma.run.create({
      data: { /* unchanged */ },
      include: { project: true },
    });
```

```ts
    const row = await this.prisma.run.findFirst({
      where: { /* unchanged */ },
      include: { project: true },
    });
```

```ts
    const row = await this.prisma.run.findUnique({
      where: { id },
      include: { project: true },
    });
```

- [ ] **Step 7: Join the project in the raw-SQL list**

Still in `run.ts`, add beneath `RunRow`:

```ts
/**
 * The raw-SQL list's row shape. Flat project columns rather than RunRow's
 * nested object, because a SQL result set has no nesting — fromSqlRow below
 * is the one place that difference is reconciled.
 */
interface RunSqlRow extends Omit<RunRow, 'project'> {
  projectSlug: string;
  projectName: string;
}

function fromSqlRow(row: RunSqlRow): RunRecord {
  const { projectSlug, projectName, ...rest } = row;
  return toRecord({ ...rest, project: { id: row.projectId, slug: projectSlug, name: projectName } });
}
```

Replace the query in `list()` with the aliased-and-joined form. **Every run column now needs an `r.` prefix**: `project` also has an `id`, and an unqualified `id` in the `ORDER BY` or the cursor tuple is an ambiguous-column error at runtime, not compile time.

```ts
    const rows = await this.prisma.$queryRaw<RunSqlRow[]>`
      SELECT
        r.id, r.org_id AS "orgId", r.project_id AS "projectId", r.status, r.verdict, r.tool,
        r.tool_version AS "toolVersion", r.simulation, r.description,
        r.duration_ms AS "durationMs", r.bundle_key AS "bundleKey",
        r.bundle_sha256 AS "bundleSha256", r.bundle_bytes AS "bundleBytes",
        r.idempotency_key AS "idempotencyKey", r.started_at AS "startedAt",
        r.started_on AS "startedOn", r.tool_started_at AS "toolStartedAt",
        r.ingested_at AS "ingestedAt", r.engine_options AS "engineOptions", r.error,
        p.slug AS "projectSlug", p.name AS "projectName"
      FROM run r
      JOIN project p ON p.id = r.project_id
      WHERE r.org_id = ${scope.orgId}::uuid
      ${scope.projectId ? Prisma.sql`AND r.project_id = ${scope.projectId}::uuid` : Prisma.empty}
      ${
        cursorKey
          ? Prisma.sql`AND (COALESCE(r.tool_started_at, r.started_at), r.id) < (${cursorKey.effective}::timestamp(3), ${cursorKey.id}::uuid)`
          : Prisma.empty
      }
      ORDER BY COALESCE(r.tool_started_at, r.started_at) DESC, r.id DESC
      LIMIT ${opts.limit + 1}
    `;
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(fromSqlRow), nextCursor: next };
```

`JOIN`, not `LEFT JOIN`: `run.project_id` is `NOT NULL` with a foreign key, so a run without a project cannot exist. A `LEFT JOIN` would make `projectSlug` nullable for a state the schema forbids.

- [ ] **Step 8: Map it into both responses**

`apps/api/src/runs/runs.service.ts`, in `toResponse`'s returned object after `id: run.id,`:

```ts
      project: run.project,
```

`apps/api/src/runs/runs.controller.ts`, in `toListItem` after `id: r.id,`:

```ts
    project: r.project,
    simulation: r.simulation,
```

- [ ] **Step 9: Fix the three literals the compiler now rejects**

`pnpm typecheck` will name them. Each gets the same project object:

- `apps/api/test/verdict.integration.test.ts:226` — the `RunRecord` literal gains
  `project: { id: ctx.projectId, slug: 'checkout', name: 'Checkout' },`
- `apps/web/test/RunHeader.test.tsx` and `apps/web/test/RunShell.test.tsx` — the `RunResponse` literals gain
  `project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },`

This is the compiler enumerating every construction site. It is not a defect.

- [ ] **Step 10: Write the failing integration test**

Append to `apps/api/test/read.integration.test.ts`:

This file already has `ingested()` (posts the reference bundle and runs the
pipeline, returning the run id) and `auth()` (the read-token header). Use
both; do not write a new ingest path.

```ts
describe('project identity', () => {
  it('names the run\'s project on both the detail and the list', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const detail = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.project).toEqual({
      id: ctx.projectId,
      slug: 'checkout',
      name: 'Checkout',
    });

    const list = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(list.status).toBe(200);
    const row = list.body.items.find((i: { id: string }) => i.id === runId);
    // Derived from the detail response, not written down a second time: the
    // two shapes must agree, and hard-coding both proves only that this test
    // is self-consistent.
    expect(row.project).toEqual(detail.body.project);
    expect(row.simulation).toBe(detail.body.simulation);
  });
});
```

- [ ] **Step 11: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
```

Expected: all green. If `packages/persistence/test/repositories.integration.test.ts` asserts on a whole `RunRecord` with `toEqual`, it needs `project` added — same reason as Step 9.

- [ ] **Step 12: Commit**

```bash
git add -A && git commit -m "feat(api): every run response names its project"
```

---

### Task 2: The three ingest columns — migration, writer, contract

**Files:**
- Create: `packages/persistence/prisma/migrations/20260815000000_run_ingest_provenance/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (model `Run`)
- Modify: `packages/persistence/src/repositories/run.ts` (`RunRecord`, `RunRow`, `RunSqlRow` via `Omit`, `CreateRunInput`, `create`, `toRecord`, the raw SQL `SELECT`)
- Modify: `packages/contracts/src/run.ts` (`RunResponseSchema`)
- Modify: `apps/api/src/runs/runs.service.ts` (`toResponse`)
- Modify: `apps/api/src/ingest/ingest.service.ts:95-105`
- Test: `apps/api/test/read.integration.test.ts` (round-trip and null), `apps/api/test/ingest.integration.test.ts` (idempotent no-op)

**Interfaces:**
- Consumes: `RunRecord` and `CreateRunInput` from Task 1.
- Produces: `RunRecord.environment`, `.branch`, `.commitSha`, all `string | null`; `CreateRunInput.environment?`, `.branch?`, `.commitSha?`; the same three on `RunResponse` as `string | null | undefined`.

- [ ] **Step 1a: Let `read.integration.test.ts`'s helper carry extra metadata**

**A GET on a freshly-posted run answers 202 with a `RunProcessing` body —
`{ id, status, statusUrl }` — which has no `environment` on it at all.** A
round-trip test that skips the pipeline asserts against the wrong shape and
would pass or fail for reasons unrelated to storage. `ingested()` in
`read.integration.test.ts` already runs the pipeline; widen it rather than
writing a second ingest path:

```ts
async function ingested(extra: Record<string, unknown> = {}): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...extra }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}
```

The default `{}` keeps every existing call site unchanged.

- [ ] **Step 1b: Write the failing round-trip tests**

Append to `apps/api/test/read.integration.test.ts`:

```ts
describe('ingest provenance', () => {
  it('stores environment, branch and commitSha from ingest metadata', async () => {
    ctx = await createTestApp();
    const runId = await ingested({
      environment: 'staging',
      branch: 'release/24.8',
      commitSha: 'abc1234def5678',
    });

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('staging');
    expect(res.body.branch).toBe('release/24.8');
    expect(res.body.commitSha).toBe('abc1234def5678');
  });

  it('reads null, not empty string, for a run that carried none of them', async () => {
    ctx = await createTestApp();
    const runId = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${runId}`).set(auth());
    // null, never '': an empty string would claim the caller sent an empty
    // branch, which is a different fact from having sent nothing.
    expect(res.body.environment).toBeNull();
    expect(res.body.branch).toBeNull();
    expect(res.body.commitSha).toBeNull();
  });
});
```

- [ ] **Step 1c: Write the failing idempotency test**

Append to `apps/api/test/ingest.integration.test.ts`. This one asserts
against the **row**, not a response: §6.4 is a claim about what got written,
and both posts answer 202 with a body that carries no branch either way.

```ts
it('does not update provenance on an idempotent re-post', async () => {
  await drainQueue();
  ctx = await createTestApp();

  const first = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42', branch: 'main' }))
    .attach('bundle', bundle, 'bundle.tgz');

  const second = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42', branch: 'corrected' }))
    .attach('bundle', bundle, 'bundle.tgz');
  expect(second.body.id).toBe(first.body.id);   // one run, by idempotency

  const row = await ctx.prisma.run.findUnique({ where: { id: first.body.id } });
  // accept() returns the existing run BEFORE writing anything, so the second
  // post is a no-op. Pinned because the first person to fix a typo in a
  // pipeline and re-run it will expect otherwise.
  expect(row?.branch).toBe('main');
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts
pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/ingest.integration.test.ts
```

Expected: the round-trip test FAILS with `expected undefined to be 'staging'` — the field is not on the response at all. The null test FAILS on `toBeNull` for the same reason (`undefined` is not `null`). The idempotency test FAILS with `expected undefined to be 'main'` — vitest transpiles without typechecking, so `row?.branch` is simply absent from the row rather than a compile error. `pnpm typecheck` is where the missing Prisma field shows up as a type error.

- [ ] **Step 3: Write the migration**

Create `packages/persistence/prisma/migrations/20260815000000_run_ingest_provenance/migration.sql`:

```sql
-- Ingest metadata the API has validated since M0 and discarded ever since.
-- Nullable with no default and no backfill: the values were never stored
-- anywhere, so there is nothing to backfill FROM. Every existing run reads
-- null forever, which is the honest state — '' would claim the caller sent
-- an empty branch.
--
-- No index on any of them. Nothing filters on these yet, and an index on a
-- column that is null for 100% of existing rows earns nothing.
ALTER TABLE "run" ADD COLUMN "environment" TEXT;
ALTER TABLE "run" ADD COLUMN "branch" TEXT;
ALTER TABLE "run" ADD COLUMN "commit_sha" TEXT;
```

- [ ] **Step 4: Declare them in the Prisma schema**

In `packages/persistence/prisma/schema.prisma`, model `Run`, after `toolVersion`:

```prisma
  /// Ingest metadata, frozen at accept time exactly like engineOptions and
  /// for the same reason: they describe the run that was submitted, and a
  /// later edit must not rewrite what was true when it ran. Never written by
  /// the worker. Null for every run created before migration
  /// 20260815000000_run_ingest_provenance, and for any run whose caller
  /// sent none of them.
  environment String?
  branch      String?
  commitSha   String? @map("commit_sha")
```

Then regenerate the client:

```bash
pnpm --filter @perfportal/persistence exec prisma generate
```

- [ ] **Step 5: Apply the migration to the local stack**

```bash
pnpm --filter @perfportal/persistence exec prisma migrate deploy
```

Expected: `20260815000000_run_ingest_provenance` applied. If the local database is behind, `migrate deploy` applies the earlier ones first — that is fine and expected.

- [ ] **Step 6: Carry them through the repository**

In `packages/persistence/src/repositories/run.ts`:

`RunRecord` gains, after `toolVersion`:

```ts
  /** Ingest metadata, frozen at accept time. Null when the caller sent none. */
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
```

`RunRow` gains the same three. `RunSqlRow` inherits them through its `Omit<RunRow, 'project'>`, so it needs no edit.

`CreateRunInput` gains, after `tool`:

```ts
  environment?: string;
  branch?: string;
  commitSha?: string;
```

`toRecord` gains, after `toolVersion: row.toolVersion,`:

```ts
    environment: row.environment,
    branch: row.branch,
    commitSha: row.commitSha,
```

`create`'s `data` gains, after `tool: input.tool,`:

```ts
        environment: input.environment ?? null,
        branch: input.branch ?? null,
        commitSha: input.commitSha ?? null,
```

The raw-SQL `SELECT` in `list()` gains three columns, beside the other `r.`-prefixed ones:

```sql
        r.environment, r.branch, r.commit_sha AS "commitSha",
```

- [ ] **Step 7: Put them on the contract and the response**

`packages/contracts/src/run.ts`, in `RunResponseSchema` after `toolVersion`:

```ts
  /**
   * From ingest metadata, frozen at accept time. Null for every run created
   * before migration 20260815000000_run_ingest_provenance, and for any run
   * whose caller did not send them.
   */
  environment: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
```

`apps/api/src/runs/runs.service.ts`, in `toResponse` after `toolVersion: run.toolVersion,`:

```ts
      environment: run.environment,
      branch: run.branch,
      commitSha: run.commitSha,
```

- [ ] **Step 8: Write them at ingest**

`apps/api/src/ingest/ingest.service.ts`, inside the `this.runs.create({...})` call, after `tool: metadata.tool,`:

```ts
        ...(metadata.environment ? { environment: metadata.environment } : {}),
        ...(metadata.branch ? { branch: metadata.branch } : {}),
        ...(metadata.commitSha ? { commitSha: metadata.commitSha } : {}),
```

The same conditional-spread form the line below already uses for `idempotencyKey`. No worker change — these arrive at accept time and are frozen there.

- [ ] **Step 9: Run the tests and watch them pass**

```bash
pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts
pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/ingest.integration.test.ts
```

Expected: all three PASS.

- [ ] **Step 10: Full gate, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add -A && git commit -m "feat(api): store the ingest metadata the API was validating and discarding"
```

---

### Task 3: `GET /v1/projects`

**Files:**
- Create: `packages/contracts/src/project.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/persistence/src/repositories/project.ts`
- Create: `apps/api/src/projects/projects.controller.ts`
- Create: `apps/api/src/projects/projects.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/openapi/schemas.ts`, `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/projects.integration.test.ts` (create), `apps/api/test/openapi.integration.test.ts`

**Interfaces:**
- Consumes: `RunStatusSchema`, `RunVerdictSchema` from `packages/contracts/src/run.ts`.
- Produces: `ProjectListResponseSchema` / `ProjectListResponse` from `@perfportal/contracts`; `ProjectRepository.listForOrg(orgId: string, projectId?: string): Promise<ProjectListRow[]>` and the exported `ProjectListRow` interface, both from `@perfportal/persistence`. `ProjectListRow` types `status`/`verdict` as `string` because they come off raw SQL; the controller narrows them and the Zod schema is what actually validates.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/projects.integration.test.ts`. This suite's tests each
build their own app — `let ctx: TestContext;` at module scope, an
`afterEach(async () => { await ctx?.close(); })`, and `ctx = await
createTestApp();` as the first line of every `it`. That is the shape
`read.integration.test.ts` uses; a shared `beforeEach` is not it.

```ts
describe('GET /v1/projects', () => {
  it('lists a project with no runs, carrying latestRun: null', async () => {
    ctx = await createTestApp();
    // ctx's org has exactly one project ('checkout') and no runs yet.
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      id: ctx.projectId,
      slug: 'checkout',
      name: 'Checkout',
      latestRun: null,
    });
  });

  it('reports the same run GET /v1/runs puts first, not the most recently ingested', async () => {
    ctx = await createTestApp();
    // Two runs whose ingest order and TOOL order disagree, so a query
    // ordering by the wrong column picks the wrong run. Ordering by
    // COALESCE(tool_started_at, started_at) must choose `later`; ordering by
    // started_at alone would choose `earlier`.
    const base = Date.UTC(2026, 7, 15, 12, 0, 0);
    const earlier = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'passed',
        tool: 'gatling', bundleKey: 'k1', bundleSha256: 's1', bundleBytes: BigInt(1),
        startedAt: new Date(base + 10 * 60_000),        // ingested LAST
        startedOn: new Date(Date.UTC(2026, 7, 15)),
        toolStartedAt: new Date(base - 10 * 60_000),    // but ran FIRST
        engineOptions: {},
      },
    });
    const later = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, status: 'complete', verdict: 'failed',
        tool: 'gatling', bundleKey: 'k2', bundleSha256: 's2', bundleBytes: BigInt(1),
        startedAt: new Date(base),                      // ingested FIRST
        startedOn: new Date(Date.UTC(2026, 7, 15)),
        toolStartedAt: new Date(base + 20 * 60_000),    // but ran LAST
        engineOptions: {},
      },
    });

    const runs = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    const projects = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);

    // Derived from the run list, not written down: these two must agree, and
    // asserting a literal id would prove only that this test is self-consistent.
    expect(projects.body.items[0].latestRun.id).toBe(runs.body.items[0].id);
    expect(projects.body.items[0].latestRun.id).toBe(later.id);
    expect(projects.body.items[0].latestRun.id).not.toBe(earlier.id);
    expect(projects.body.items[0].latestRun.status).toBe('complete');
    expect(projects.body.items[0].latestRun.verdict).toBe('failed');
  });

  it('shows a bearer token only the project it was minted against', async () => {
    ctx = await createTestApp();
    const other = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.body.items.map((p: { slug: string }) => p.slug)).toEqual(['checkout']);
    expect(res.body.items.map((p: { id: string }) => p.id)).not.toContain(other.id);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/projects.integration.test.ts`
Expected: FAIL with 404 on every request — the route does not exist.

- [ ] **Step 3: Write the contract**

Create `packages/contracts/src/project.ts`:

```ts
import { z } from 'zod';
import { RunStatusSchema, RunVerdictSchema } from './run.js';

/**
 * Every project a credential can see. A session sees its whole org's; a
 * bearer token sees the one project it was minted against. One rule, not
 * two — "the projects this credential can see".
 *
 * No `nextCursor`: an org has a handful of projects, not a page of them. If
 * one ever has enough to need paging, this schema needs a cursor and the
 * sidebar needs a scroll region — one change, and this sentence is where it
 * starts.
 */
export const ProjectListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      /**
       * The project's most recent run, by the same ordering GET /v1/runs
       * uses. Null for a project nothing has ever been ingested into.
       *
       * `status` rides along with `verdict` deliberately: a pending run has
       * `verdict: null`, and a badge reading that as "not evaluated" would
       * state a fact about a run nobody has measured yet. Read `status`
       * first; fall through to `verdict` only for a `complete` run.
       */
      latestRun: z
        .object({
          id: z.string().uuid(),
          status: RunStatusSchema,
          verdict: RunVerdictSchema.nullable(),
        })
        .nullable(),
    }),
  ),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
```

Add to `packages/contracts/src/index.ts`, after the `run.js` line:

```ts
export * from './project.js';
```

- [ ] **Step 4: Write the repository query**

In `packages/persistence/src/repositories/project.ts`, add the import and the method:

```ts
import { Prisma, type PrismaClient } from '@prisma/client';
```

```ts
  /**
   * Every project in an org, each with its most recent run.
   *
   * LEFT JOIN LATERAL, not DISTINCT ON (project_id) over `run`: a project
   * with zero runs must still appear — an org's newest project is exactly
   * the one with nothing in it — and DISTINCT ON over the run table would
   * silently omit it.
   *
   * The inner ORDER BY is spelled character-for-character like
   * RunRepository.list's. If those two expressions ever disagree, a
   * project's "latest run" and the run list's top row name different runs,
   * and nothing on screen looks wrong.
   *
   * `projectId` narrows to a single project for a bearer token, which is
   * scoped to exactly one. Absent for a session, which sees the whole org.
   */
  async listForOrg(orgId: string, projectId?: string): Promise<ProjectListRow[]> {
    const rows = await this.prisma.$queryRaw<RawProjectRow[]>`
      SELECT p.id, p.slug, p.name,
             r.id AS "latestRunId", r.status AS "latestRunStatus",
             r.verdict AS "latestRunVerdict"
      FROM project p
      LEFT JOIN LATERAL (
        SELECT id, status, verdict
        FROM run
        WHERE project_id = p.id
        ORDER BY COALESCE(tool_started_at, started_at) DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE p.org_id = ${orgId}::uuid
      ${projectId ? Prisma.sql`AND p.id = ${projectId}::uuid` : Prisma.empty}
      ORDER BY p.name ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      latestRun:
        row.latestRunId === null
          ? null
          : { id: row.latestRunId, status: row.latestRunStatus!, verdict: row.latestRunVerdict },
    }));
  }
```

And above the class:

```ts
interface RawProjectRow {
  id: string;
  slug: string;
  name: string;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunVerdict: string | null;
}

export interface ProjectListRow {
  id: string;
  slug: string;
  name: string;
  latestRun: { id: string; status: string; verdict: string | null } | null;
}
```

`ORDER BY p.name ASC` because the sidebar is a list a human scans; it sorts the way a human expects, not by creation time.

- [ ] **Step 5: Write the controller and module**

Create `apps/api/src/projects/projects.controller.ts`:

```ts
import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ProjectListResponse } from '@perfportal/contracts';
import { ProjectRepository } from '@perfportal/persistence';
import { Scopes } from '../auth/scopes.decorator.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default. @Scopes('read') is still required
// per-route.
@Controller('/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectRepository) {}

  /**
   * The projects this credential can see — one rule, not two. A session
   * names no project and sees its whole org's; a bearer token is minted
   * against exactly one and sees that one, as a one-element list. Not a 400
   * for the token: asking what it can see is a reasonable question with a
   * correct answer, and a CI job resolving its own slug is the caller.
   */
  @Get()
  @Scopes('read')
  async list(@Req() req: Request): Promise<ProjectListResponse> {
    const tenant = req.tenant!;
    const rows = await this.projects.listForOrg(tenant.orgId, tenant.projectId);
    return {
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        // The repository reads status and verdict off raw SQL, so they
        // arrive as `string`. Narrowed here rather than in the repository,
        // which has no business importing the contract's enums — and the
        // Zod schema is what actually validates the value on the way out.
        latestRun:
          r.latestRun === null
            ? null
            : {
                id: r.latestRun.id,
                status: r.latestRun.status as RunStatus,
                verdict: r.latestRun.verdict as RunVerdict | null,
              },
      })),
    };
  }
}
```

Its imports:

```ts
import type { ProjectListResponse, RunStatus, RunVerdict } from '@perfportal/contracts';
```

Create `apps/api/src/projects/projects.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsController } from './projects.controller.js';

// ProjectRepository is provided and exported by AuthModule (see its
// `exports` array), so importing that module is what supplies it here.
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
})
export class ProjectsModule {}
```

In `apps/api/src/app.module.ts`, add the import and put `ProjectsModule` in `imports`.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/projects.integration.test.ts`
Expected: all three PASS. If the second fails with the two ids equal, the lateral is ordering by `started_at` rather than the `COALESCE` — re-read Step 4.

- [ ] **Step 7: Declare it in OpenAPI**

`apps/api/src/openapi/schemas.ts` — add `ProjectListResponseSchema` to the import list from `@perfportal/contracts` and one entry to `SOURCE`:

```ts
  ProjectListResponse: ProjectListResponseSchema,
```

`apps/api/src/openapi/document.ts` — add a path entry beside `'/v1/projects/{slug}/runs'`:

```ts
  '/v1/projects': {
    get: {
      operationId: 'listProjects',
      summary: 'Projects this credential can see',
      tags: ['projects'],
      description:
        'Requires the "read" scope. A session names no project and sees every project in its ' +
        'org; a bearer token is minted against exactly one and sees that one, as a ' +
        'one-element list. Each project carries its most recent run by the same ordering ' +
        'GET /v1/runs uses, or null for a project nothing has been ingested into. Not ' +
        'paginated: an org has a handful of projects, not a page of them.',
      responses: {
        '200': {
          description: 'Every project this credential can see, ordered by name.',
          content: json(schemaRef('ProjectListResponse')),
        },
        ...authFailureResponses,
      },
    },
  },
```

- [ ] **Step 8: Assert the document declares it**

Append to `apps/api/test/openapi.integration.test.ts`:

```ts
it('declares GET /v1/projects and its response schema', async () => {
  const doc = await fetchDoc();
  expect(doc.paths?.['/v1/projects']?.['get']).toBeTruthy();
  expect(doc.components?.schemas?.['ProjectListResponse']).toBeTruthy();
});
```

"The document validates" never catches an omission — a document missing a field is still a valid document. The previous sub-project shipped a fix for exactly this, `run_series_bucket.family` being absent.

- [ ] **Step 9: Full gate, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add -A && git commit -m "feat(api): GET /v1/projects, each project with its latest run"
```

---

### Task 4: `?project=<slug>` on `GET /v1/runs`

**Files:**
- Modify: `packages/persistence/src/repositories/project.ts`
- Modify: `apps/api/src/runs/runs.controller.ts:31-45`
- Modify: `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/read.integration.test.ts`, `apps/api/test/openapi.integration.test.ts`

**Interfaces:**
- Consumes: `ProjectRepository` from Task 3; `badRequest(code, message, remediation)` from `apps/api/src/common/validation.ts`.
- Produces: `ProjectRepository.findBySlugInOrg(orgId: string, slug: string): Promise<ProjectRecord | null>`; the `project` query parameter on `GET /v1/runs`.

- [ ] **Step 1: Write the failing tests — all six rows of the spec's table**

Append to `apps/api/test/read.integration.test.ts`:

```ts
describe('GET /v1/runs?project=', () => {
  it('filters to the named project', async () => {
    ctx = await createTestApp();
    const runId = await ingested();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=checkout').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(runId);
  });

  it('404s for a slug that does not exist in this org', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs?project=no-such-project')
      .set(auth());
    // 404, never an empty 200: an empty 200 would describe a project that
    // exists and happens to be idle, and a caller cannot tell those apart.
    expect(res.status).toBe(404);
  });

  it('404s — not 403 — for a project belonging to another org', async () => {
    ctx = await createTestApp();
    const otherOrg = await ctx.prisma.org.create({
      data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' },
    });
    await ctx.prisma.project.create({
      data: { orgId: otherOrg.id, slug: 'secret', name: 'Secret', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=secret').set(auth());
    // 403 would confirm the project exists. The status code must not
    // distinguish "no such project" from "not yours".
    expect(res.status).toBe(404);
  });

  it('is identical to omitting the parameter when a token names its own project', async () => {
    ctx = await createTestApp();
    await ingested();
    const withParam = await request(ctx.app.getHttpServer())
      .get('/v1/runs?project=checkout')
      .set(auth());
    const without = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(withParam.body).toEqual(without.body);
  });

  it('400s with PROJECT_MISMATCH when a token names another project', async () => {
    ctx = await createTestApp();
    await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs?project=search').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_MISMATCH');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts`
Expected: the 404 and 400 tests FAIL with 200 — the parameter is ignored today, so every one of these returns the unfiltered list.

- [ ] **Step 3: Add the lookup**

In `packages/persistence/src/repositories/project.ts`:

```ts
  /**
   * A project by slug WITHIN an org id.
   *
   * Separate from findBySlug, which takes an org SLUG. `req.tenant` carries
   * an org id, and bending one method into accepting either would make
   * every call site read ambiguously.
   */
  async findBySlugInOrg(orgId: string, slug: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { orgId, slug } });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    };
  }
```

- [ ] **Step 4: Handle the parameter in the controller**

`apps/api/src/runs/runs.controller.ts` — `RunsController` gains `ProjectRepository` (it is already imported in this file for `ProjectRunsController`):

```ts
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
  ) {}
```

And `list` becomes:

```ts
  @Get()
  @Scopes('read')
  async list(
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: string,
    @Query('project') project?: string,
  ): Promise<RunListResponse> {
    const tenant = req.tenant!;
    let projectId = tenant.projectId;

    if (project !== undefined) {
      const named = await this.projects.findBySlugInOrg(tenant.orgId, project);
      // 404, never 403 and never an empty 200: a 403 confirms the project
      // exists, and an empty 200 describes a project that exists and happens
      // to be idle. The status code must not distinguish "no such project"
      // from "not yours".
      if (!named) throw new NotFoundException(`No project "${project}" in this organisation.`);
      // A bearer token is minted against exactly one project. Naming another
      // is a caller mistake, not a permission question — and answering with
      // that token's own runs under someone else's slug would be a silent
      // wrong answer.
      if (tenant.projectId && tenant.projectId !== named.id) {
        throw badRequest(
          'PROJECT_MISMATCH',
          `This token belongs to a different project than "${project}".`,
          'Omit "project", or use a session, which can read every project in the org.',
        );
      }
      projectId = named.id;
    }

    const parsedCursor = parseCursor(cursor);
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, ...(projectId ? { projectId } : {}) },
      { limit: parseLimit(limit), ...(parsedCursor ? { cursor: parsedCursor } : {}) },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }
```

Update this method's docstring: it currently says the spread "is the only production caller of `RunRepository.list`'s org-only branch", which stops being true the moment `?project=` can fill `projectId`. Say instead that the org-only branch is taken by a session that names no project.

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts`
Expected: all five PASS.

- [ ] **Step 6: Declare the parameter, and assert it is declared**

`apps/api/src/openapi/document.ts` — add to the `parameters` record:

```ts
  ProjectFilter: {
    name: 'project',
    in: 'query',
    description:
      'Restrict to one project, by slug. Validated: a slug not in the caller\'s org is a 404, ' +
      'never an empty result, so a caller can tell "no such project" from "that project is ' +
      'idle". A bearer token naming a project other than its own gets a 400 PROJECT_MISMATCH.',
    schema: { type: 'string' },
  },
```

And add it to `listRuns`'s parameter list:

```ts
      parameters: [parameters['Limit']!, parameters['Cursor']!, parameters['ProjectFilter']!],
```

`listRuns`'s `responses` gains `'404': ref('NotFound')`.

Append to `apps/api/test/openapi.integration.test.ts`:

```ts
it('declares the project filter on GET /v1/runs', async () => {
  const doc = await fetchDoc();
  const get = doc.paths?.['/v1/runs']?.['get'] as
    | { parameters?: { name?: string }[] }
    | undefined;
  expect(get?.parameters?.map((p) => p.name)).toContain('project');
});
```

- [ ] **Step 7: Full gate, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
git add -A && git commit -m "feat(api): GET /v1/runs?project= filters by slug within the caller's org"
```

---

### Task 5: The run list's columns

**Files:**
- Modify: `apps/web/src/routes/RunList.tsx`
- Test: `apps/web/test/RunList.test.tsx` (create), `apps/web/e2e/run-list.spec.ts`

**Interfaces:**
- Consumes: `RunListResponse['items'][number]` with `project` and `simulation`, from Task 1.
- Produces: nothing later tasks import. Task 6 adds props to this component.

- [ ] **Step 1: Write the failing unit test**

Create `apps/web/test/RunList.test.tsx`. The harness mirrors
`RunShell.test.tsx`'s — a `QueryClientProvider` with retries off, a
`MemoryRouter` because the rows contain `<Link>`s, and `vi.stubGlobal` on
`fetch` rather than mocking the module, so the real `fetchRuns` and the real
`RunListResponseSchema.parse` both run.

```tsx
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import RunList from '../src/routes/RunList';

afterEach(cleanup);

function renderList(items: RunListResponse['items']) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ROWS: RunListResponse['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'complete',
    verdict: 'passed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    toolStartedAt: '2026-08-15T09:00:00.000Z',
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: 'example.ParitySimulation',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    verdict: null,
    tool: 'gatling',
    startedAt: '2026-08-15T11:00:00.000Z',
    toolStartedAt: null,
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: null,          // the worker has not parsed it
  },
];

describe('RunList columns', () => {
  it('names each row by its project and simulation', async () => {
    renderList(ROWS);
    expect(await screen.findByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.getAllByText('Checkout')).toHaveLength(2);
    expect(screen.getByText('example.ParitySimulation')).toBeInTheDocument();
  });

  it('has no Tool column — TOOL_IDS has one member, so it read "gatling" on every row', async () => {
    renderList(ROWS);
    await screen.findByRole('columnheader', { name: 'Project' });
    expect(screen.queryByRole('columnheader', { name: 'Tool' })).toBeNull();
  });

  it('falls back to the short id when the run has no simulation yet', async () => {
    renderList(ROWS);
    // Derived from the row, not written down: re-slicing the id here the way
    // the component does would just restate the implementation. Assert
    // instead that the accessible name carries the WHOLE id while the visible
    // text is a strict prefix of it.
    const link = await screen.findByRole('link', { name: `View run ${ROWS[1]!.id}` });
    expect(ROWS[1]!.id.startsWith(link.textContent!)).toBe(true);
    expect(link.textContent).not.toBe(ROWS[1]!.id);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @perfportal/web exec vitest run test/RunList.test.tsx`
Expected: FAIL — no `Project` columnheader exists, and the `Tool` one does.

- [ ] **Step 3: Change the columns**

In `apps/web/src/routes/RunList.tsx`, replace the `<thead>` row with:

```tsx
          <thead>
            <tr className="border-b border-default">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Started
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Project
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Simulation
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Status
              </th>
              <th scope="col" className="py-2 font-semibold">
                Verdict
              </th>
            </tr>
          </thead>
```

Replace `RunRow`'s cells after the `Started` one with:

```tsx
      <td className="py-2 pr-4">{run.project.name}</td>
      <td data-testid="run-simulation" className="py-2 pr-4">
        {/* The simulation is what a reader is looking for, so it is the
            link. Falls back to the short id for a run the worker has not
            parsed (or never will), which is what this column showed before
            the simulation was available at all. The accessible name carries
            the WHOLE id either way, because "View" repeated down a column
            names nothing. */}
        <Link to={runPath(run.id)} aria-label={`View run ${run.id}`} className="underline">
          {run.simulation ?? <code>{run.id.slice(0, 8)}</code>}
        </Link>
      </td>
      <td className="py-2 pr-4">
        <Badge mark={STATUS[run.status]} />
      </td>
      <td className="py-2">
        <Badge mark={VERDICT[run.verdict ?? 'none']} />
      </td>
```

Import `runPath` from `./paths` — it already exists there and spells the same URL `RunTabs` links to.

Update the `<caption>` to mention the project:

```tsx
          <caption className="pb-3 text-left text-sm text-muted">
            Every run in your organisation, newest first, with the project it belongs to.
            “Started” is the load test’s own start time; rows marked <em>ingest time</em> have not
            been parsed yet, so they fall back to when PerfPortal received the run.
          </caption>
```

Add a comment above the `<thead>` recording why Tool is gone:

```tsx
          {/* No Tool column. TOOL_IDS has exactly one member, so it read
              "gatling" on every row this platform can produce. It returns
              the day a second tool ships, at which point it carries
              information; the field stays in the contract meanwhile. */}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm --filter @perfportal/web exec vitest run test/RunList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update the e2e spec**

`apps/web/e2e/run-list.spec.ts` — any assertion naming the `Tool` or `Run` column headers, or selecting the last cell for the link, needs to move. `data-testid="run-row"` and `data-run-id` are unchanged, so `helpers.ts`'s `firstRowId` needs nothing.

Add one spec that a jsdom test cannot make:

```ts
test('a row link is named by the whole run id, not by its visible text', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);       // this suite's existing seed
  await signIn(page, admin);
  await page.goto('/runs');
  // Chromium's real accessibility tree — a <code> inside the link must not
  // pollute or replace the name the aria-label supplies.
  await expect(page.getByRole('link', { name: `View run ${runId}` })).toBeVisible();
});
```

- [ ] **Step 6: Run the e2e suite for this spec, then commit**

```bash
pnpm test:e2e -- run-list.spec.ts
git add -A && git commit -m "feat(web): the run list names each row by its project and simulation"
```

---

### Task 6: `/projects/:slug`

**Files:**
- Create: `apps/web/src/api/projects.ts`
- Create: `apps/web/src/routes/ProjectRuns.tsx`
- Modify: `apps/web/src/api/runs.ts`
- Modify: `apps/web/src/routes/RunList.tsx`
- Modify: `apps/web/src/routes/paths.ts`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/e2e/run-list.spec.ts` (or a new `project-runs.spec.ts`)

**Interfaces:**
- Consumes: `ProjectListResponseSchema` from Task 3; `GET /v1/runs?project=` from Task 4.
- Produces: `fetchProjects(): Promise<ProjectListResponse>` and `projectsQueryKey` from `apps/web/src/api/projects.ts`; `projectPath(slug: string): string` from `./paths`; `RunList`'s `projectSlug` and `heading` props.

- [ ] **Step 1: Write the failing e2e test**

This is falsification checkpoint 5. It needs *page forward, then switch* — no click-through finds it.

```ts
test('switching projects after paging forward shows the second project\'s first page', async ({ page }) => {
  const admin = await seedAdmin();
  // PAGE_SIZE is 25, so 26 runs in the first project guarantee a Next.
  const alpha = await seedProjectWithRuns(admin.orgId, 'alpha', 'Alpha', 26);
  await seedProjectWithRuns(admin.orgId, 'beta', 'Beta', 3);

  await signIn(page, admin);
  await page.goto(`/projects/${alpha.slug}`);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('run-row')).toHaveCount(1);   // 26 = 25 + 1

  await page.goto('/projects/beta');
  // Without key={slug} the cursor survives the param change, resolves
  // against no row under the new scope, and this list comes back EMPTY —
  // a screen that looks merely idle rather than broken.
  await expect(page.getByTestId('run-row')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Beta' })).toBeVisible();
});
```

Add to `apps/web/e2e/fixtures.ts`, modelled on `seedRunsAt` — one
`createMany` for the whole batch, because seeding a full page plus one at a
round trip per row would make a test about a button click cost twenty-six of
them:

```ts
/**
 * A project of its own inside orgId, with `count` complete runs.
 *
 * Its OWN project rather than the org's shared 'checkout' (via projectFor),
 * because the test this exists for is about moving BETWEEN projects — two
 * seeds landing in one project would make the assertion vacuous.
 *
 * `startedAt` walks backwards a minute per row so the list's order is
 * deterministic, and `startedOn` mirrors its date because that column is the
 * ingest-date partition key (see schema.prisma).
 */
export async function seedProjectWithRuns(
  orgId: string,
  slug: string,
  name: string,
  count: number,
): Promise<{ projectId: string; slug: string }> {
  const project = await prisma.project.create({ data: { orgId, slug, name, settings: {} } });
  const base = Date.UTC(2026, 7, 15, 12, 0, 0);
  await prisma.run.createMany({
    data: Array.from({ length: count }, (_, i) => {
      const startedAt = new Date(base - i * 60_000);
      return {
        orgId,
        projectId: project.id,
        status: 'complete',
        verdict: 'passed',
        tool: 'gatling',
        bundleKey: `e2e-fixture/${randomUUID()}`,
        bundleSha256: '0'.repeat(64),
        bundleBytes: BigInt(1),
        startedAt,
        startedOn: startedAt,
        toolStartedAt: null,
        engineOptions: {},
      };
    }),
  });
  return { projectId: project.id, slug };
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:e2e -- project-runs.spec.ts`
Expected: FAIL at the first `page.goto` — `/projects/alpha` matches the catch-all and redirects to `/runs`.

- [ ] **Step 3: Add the web projects reader**

Create `apps/web/src/api/projects.ts`:

```ts
import { ProjectListResponseSchema, type ProjectListResponse } from '@perfportal/contracts';
import { apiFetch } from './fetch';

/**
 * ONE query key for the project list, exported beside its fetcher exactly as
 * `runsQueryKey` is beside `fetchRuns`. Not a function: this endpoint takes
 * no parameters — an org's projects are not paginated (see
 * ProjectListResponseSchema).
 */
export const projectsQueryKey = ['projects'] as const;

/**
 * `GET /v1/projects`, org-scoped by the session cookie.
 *
 * No `staleTime`: each project carries its LATEST RUN, which changes as
 * runs are ingested and as the worker moves one from pending to complete.
 * Caching this indefinitely — the way the metric queries are cached, since
 * a completed run's numbers are immutable — would freeze a verdict badge on
 * a value that has moved.
 */
export function fetchProjects(): Promise<ProjectListResponse> {
  return apiFetch(ProjectListResponseSchema, '/v1/projects');
}
```

- [ ] **Step 4: Thread the slug through the runs reader**

In `apps/web/src/api/runs.ts`:

```ts
export const runsQueryKey = (cursor: string | null = null, projectSlug: string | null = null) =>
  ['runs', cursor, projectSlug] as const;
```

```ts
export function fetchRuns(
  cursor: string | null = null,
  projectSlug: string | null = null,
): Promise<RunListResponse> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('cursor', cursor);
  if (projectSlug !== null) query.set('project', projectSlug);
  return apiFetch(RunListResponseSchema, `/v1/runs?${query.toString()}`);
}
```

Add to `runsQueryKey`'s docstring: the slug is part of the key because a filtered and an unfiltered list are different data under the same cursor, and sharing a key would serve one as the other. `runsQueryKey()` with no arguments is now `['runs', null, null]` — still the exact key `AuthGate`'s membership probe uses, so the first paint still renders from the bootstrap's cached result.

- [ ] **Step 5: Give `RunList` its two props**

In `apps/web/src/routes/RunList.tsx`:

```tsx
export default function RunList({
  projectSlug = null,
  heading = 'Runs',
}: {
  /** Narrows the list to one project. Null is the org-wide list. */
  readonly projectSlug?: string | null;
  readonly heading?: string;
} = {}) {
```

The query becomes:

```tsx
  const runs = useQuery({
    queryKey: runsQueryKey(cursor, projectSlug),
    queryFn: () => fetchRuns(cursor, projectSlug),
    placeholderData: keepPreviousData,
  });
```

`<h1>` renders `{heading}`. The `<caption>`'s "Every run in your organisation" becomes conditional:

```tsx
            {projectSlug === null ? 'Every run in your organisation' : 'Every run in this project'},
            newest first, with the project it belongs to.
```

- [ ] **Step 6: Add the route and the page**

`apps/web/src/routes/paths.ts`:

```ts
/** One project's runs. Spelled once because App.tsx declares it, RunHeader
 *  links to it and the e2e suite navigates to it. */
export function projectPath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}
```

Create `apps/web/src/routes/ProjectRuns.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import RunList from './RunList';

/**
 * One project's runs.
 *
 * `key={slug}` IS THE POINT, not styling. `RunList` holds its cursor in
 * `useState`. Moving from `/runs` to `/projects/a` swaps one route element
 * for another and remounts — but `/projects/a` to `/projects/b` matches the
 * SAME route, so React reuses the component instance and the cursor
 * survives into a scope where it no longer resolves. `RunRepository.list`
 * answers an unresolvable cursor with an empty page, deliberately, so the
 * reader would get a blank list for no visible reason. A different project
 * is a different component.
 *
 * The name comes from `GET /v1/projects` rather than from the first run's
 * `project.name`, because a project with no runs has no first run and still
 * has a name. Until it resolves the heading is the slug, which is a real
 * name for the project rather than a placeholder.
 */
export default function ProjectRuns() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;

  return <RunList key={slug} projectSlug={slug} heading={project?.name ?? slug} />;
}
```

`apps/web/src/App.tsx` — import `ProjectRuns` and add the route inside `<AppShell />`, before the catch-all:

```tsx
          <Route path="/projects/:slug" element={<ProjectRuns />} />
```

- [ ] **Step 7: Run the e2e test and watch it pass**

Run: `pnpm test:e2e -- project-runs.spec.ts`
Expected: PASS. To prove the `key` is load-bearing rather than decorative, delete it, re-run, and confirm the second assertion fails with 0 rows; then put it back.

- [ ] **Step 8: Full gate, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e
git add -A && git commit -m "feat(web): /projects/:slug lists one project's runs"
```

---

### Task 7: The run header's project name and provenance chips

**Files:**
- Modify: `apps/web/src/routes/RunHeader.tsx`
- Test: `apps/web/test/RunHeader.test.tsx`, `apps/web/e2e/run-detail.spec.ts`

**Interfaces:**
- Consumes: `RunResponse.project`, `.environment`, `.branch`, `.commitSha` from Tasks 1 and 2; `projectPath` from Task 6.

- [ ] **Step 1: Write the failing unit tests**

`apps/web/test/RunHeader.test.tsx` — this file's existing render helper needs a `MemoryRouter` wrapper now, because the header contains a `<Link>`. Add it there once.

```tsx
it('names the project, linking to its run list', () => {
  renderHeader({ ...RUN, project: { id: PROJECT_ID, slug: 'checkout', name: 'Checkout' } });
  const link = screen.getByRole('link', { name: 'Checkout' });
  expect(link).toHaveAttribute('href', '/projects/checkout');
});

it('shows no provenance chips for a run that carried none', () => {
  renderHeader({ ...RUN, environment: null, branch: null, commitSha: null });
  // Absent, not blank: a dash would claim we asked and got nothing back.
  expect(screen.queryByTestId('run-environment')).toBeNull();
  expect(screen.queryByTestId('run-branch')).toBeNull();
  expect(screen.queryByTestId('run-commit')).toBeNull();
});

it('shows each chip that has a value, and truncates the commit', () => {
  const commitSha = 'abc1234def5678';
  renderHeader({ ...RUN, environment: 'staging', branch: 'release/24.8', commitSha });
  expect(screen.getByTestId('run-environment')).toHaveTextContent('staging');
  expect(screen.getByTestId('run-branch')).toHaveTextContent('release/24.8');
  // Derived from the value, not written down: assert the visible text is a
  // strict prefix of the full sha rather than restating the slice length.
  const visible = screen.getByTestId('run-commit').textContent!;
  expect(commitSha.startsWith(visible)).toBe(true);
  expect(visible).not.toBe(commitSha);
});

it('does not make the commit a link — the platform does not know the repo host', () => {
  renderHeader({ ...RUN, commitSha: 'abc1234def5678' });
  expect(screen.getByTestId('run-commit').querySelector('a')).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @perfportal/web exec vitest run test/RunHeader.test.tsx`
Expected: FAIL — no link named `Checkout`, and no `run-environment` testid.

- [ ] **Step 3: Render the project name and the chips**

In `apps/web/src/routes/RunHeader.tsx`, add the imports:

```tsx
import { Link } from 'react-router-dom';
import { projectPath } from './paths';
```

Above the `<h1>`:

```tsx
      {/* The project above the simulation, not beside it: it is the run's
          address, and the simulation is its identity. A link because the
          reader who wants "this project's other runs" is one click from
          them. */}
      <p className="text-sm text-muted">
        <Link to={projectPath(run.project.slug)} className="underline">
          {run.project.name}
        </Link>
      </p>
```

Inside the chip row, after the tool chip:

```tsx
        {/* Provenance from ingest metadata. Each renders only when the run
            carries it: a run submitted without them looks exactly as it did
            before this existed, rather than growing three dashes. The
            spec's §2 promise, now that the platform actually stores them.

            role="group" + aria-label for the same reason every other chip
            here has them: a bare <span>'s implicit role is "generic", which
            is Name-from-PROHIBITED, so aria-label alone does nothing. */}
        {run.environment != null && run.environment !== '' && (
          <span role="group" aria-label={`Environment: ${run.environment}`} data-testid="run-environment">
            {run.environment}
          </span>
        )}
        {run.branch != null && run.branch !== '' && (
          <span role="group" aria-label={`Branch: ${run.branch}`} data-testid="run-branch">
            {run.branch}
          </span>
        )}
        {run.commitSha != null && run.commitSha !== '' && (
          // Seven characters visible, the WHOLE sha in the accessible name —
          // the same short-versus-full treatment the run list gives a run id.
          // NOT a link: the platform does not know the repository host, and a
          // chip that looks like a link but is not is worse than plain text.
          <span role="group" aria-label={`Commit: ${run.commitSha}`} data-testid="run-commit">
            <code>{run.commitSha.slice(0, 7)}</code>
          </span>
        )}
```

Replace this component's docstring paragraph that reads *"There is no environment and no branch: `IngestMetadataSchema` accepts both and nothing stores them"* — that stopped being true in Task 2. Say instead that the chips render only when the run carries them, and that a run predating the migration carries none.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm --filter @perfportal/web exec vitest run test/RunHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Assert the accessible names in Chromium**

Append to `apps/web/e2e/run-detail.spec.ts`:

```ts
test('the commit chip is named by the whole sha, not the seven visible characters', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithProvenance(admin.orgId, {
    environment: 'staging',
    branch: 'release/24.8',
    commitSha: 'abc1234def5678',
  });
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);
  // jsdom cannot answer this: dom-accessibility-api does not compute a
  // <code> descendant's contribution the way Chromium's tree does, so
  // whether the truncated text pollutes or replaces the aria-label is only
  // observable in a real browser.
  await expect(page.getByTestId('run-commit')).toHaveAccessibleName('Commit: abc1234def5678');
  await expect(page.getByTestId('run-environment')).toHaveAccessibleName('Environment: staging');
});
```

Add to `apps/web/e2e/fixtures.ts`:

```ts
/**
 * A complete run carrying ingest provenance, in orgId's own project.
 *
 * Written directly rather than posted through the ingest endpoint: the
 * chips' accessible names are what this seeds for, and running the whole
 * parse pipeline to set three text columns would make a header test depend
 * on the worker.
 */
export async function seedRunWithProvenance(
  orgId: string,
  provenance: { environment?: string; branch?: string; commitSha?: string },
): Promise<string> {
  const projectId = await projectFor(orgId);
  const startedAt = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
  const run = await prisma.run.create({
    data: {
      orgId,
      projectId,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      simulation: 'example.ParitySimulation',
      durationMs: 63161,
      bundleKey: `e2e-fixture/${randomUUID()}`,
      bundleSha256: '0'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt,
      startedOn: startedAt,
      toolStartedAt: startedAt,
      engineOptions: {},
      environment: provenance.environment ?? null,
      branch: provenance.branch ?? null,
      commitSha: provenance.commitSha ?? null,
    },
  });
  return run.id;
}
```

- [ ] **Step 6: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all five green. This is the gate `CLAUDE.md` requires before the sub-project can be called complete — `pnpm test:unit` excludes `*.integration.test.ts` and `*.e2e.test.ts`, so it alone proves nothing about the API.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): the run header names its project and shows what CI told us about the run"
```

---

## Verification

The sub-project is complete when, on a clean tree:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

is green, and every success criterion in spec §11 holds:

- `GET /v1/runs` with no `?project=` returns what it returns today, plus `project` and `simulation`
- Every run response names its project; none invents one
- A run posted with `environment`, `branch` and `commitSha` reads them back; one posted without reads null and shows no chips
- `/projects/:slug` lists that project's runs and nothing else, and switching projects after paging forward shows page one of the second, not an empty list
- The OpenAPI document declares `ProjectListResponse`, `GET /v1/projects`, and the `project` query parameter
