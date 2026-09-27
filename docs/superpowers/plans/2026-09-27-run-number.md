# Run Number Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run of a test carries a stable number (`Run 12`, `#12`), assigned when it joins its test and never renumbered, shown on every surface that names a run within its test.

**Architecture:** A counter on `test` (`next_run_number`) is bumped in the same SQL statement that sets a run's `test_id`, at the only two places that set it (the live fold owner at the log header, and the pipeline at finalize), and stored on `run.run_number` (unique per test). The number rides one new optional contract field, `runNumber`, onto every read path, and one web module spells it.

**Tech Stack:** PostgreSQL 16 + Prisma 6 (migrations are hand-written SQL), node-postgres, NestJS, zod, React + Vite, ECharts, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-run-number-design.md` (committed as 227b16f). Read it before any task; it is the binding authority where this plan is silent.

## Global Constraints

- Branch `feat/run-number`, worktree `/Users/rabindrabiswal/Workspace/perf-dashboard/.claude/worktrees/trusting-lewin-1f9f7d`. Never `cd` to `/Users/rabindrabiswal/Workspace/perf-dashboard` itself. Never bare `git stash`. Never `git add -A` — name paths. Never run `npx prettier` (this repo has no formatter; `eslint` is the only style gate).
- Node 22 (`nvm use` in the worktree). Every command below assumes `source /private/tmp/claude-501/-Users-rabindrabiswal-Workspace-perf-dashboard/73824373-f6b6-44d0-9f6b-bb43d018e7dc/scratchpad/env-runno.sh` first, which sets `DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal_runno`, `REDIS_URL=redis://localhost:6380/7`, the three `S3_*` variables and `PERFPORTAL_E2E_PORT=3200`. NEVER point a suite at the developer database `perfportal` — `test:integration` truncates every table.
- Spellings, exactly: `runName(n)` → `Run ${n}` (a run NAMED: list rows, Compare chips, series, matrix columns, summary tiles, baseline note, tests catalogue, breadcrumb, document title); `runTag(n)` → `#${n}` (the Trends axis and its table). A run with no number keeps EXACTLY today's label.
- Contract field, exactly: `runNumber: RunNumberSchema.nullable().optional()` where `RunNumberSchema = z.number().int().positive()`. Optional because the browser drops a body that fails `safeParse` (rolling-deploy rule).
- Invariant: `run.run_number` is non-null exactly when `run.test_id` is.
- Lock order is RUN row, then TEST row, in every statement and transaction this plan writes.
- No backticks inside any SQL string or SQL comment (a template literal ends at one — CLAUDE.md).
- Named object keys, never a conditional spread `...(x ? {k: v} : {})` (eslint bans it; it also defeats excess-property checking).
- Every new test case must be seen FAILING against the mutation named beside it before it counts. Commit a checkpoint first; mutate; assert the replacement count is exactly 1 BEFORE running (a mutation that matched nothing reports a pass); run; restore with `git checkout HEAD -- <file>`; confirm `git status --short` shows only intended changes. Record each mutation and the failing assertion in the task report.
- A workspace package is consumed through its `dist`. After changing `packages/contracts` or `packages/persistence` source: `find packages/<pkg> -name '*.tsbuildinfo' -delete && pnpm --filter @perfportal/<pkg> build`, then grep the emitted `dist` for the change before believing a test result either way.
- Run each gate by its own exit code: `cmd > /tmp/x.txt 2>&1; echo "exit=$?"`. Never read a gate through a pipe.
- Current floors (main 94b9601): unit 172 / 2217, integration 154 / 1959, e2e 165. Predicted after this plan: unit **174 / 2232**, integration **159 / 1985**, e2e **166** (tally in Task 9).

---

### Task 1: Schema, migration, backfill, and test deletion

**Files:**
- Create: `packages/persistence/prisma/migrations/20260927180000_run_number/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (model `Test` ~line 76; model `Run` ~line 232)
- Modify: `packages/persistence/src/repositories/test.ts` (`remove`, ~line 173)
- Create: `packages/persistence/test/run-number.integration.test.ts`

**Interfaces:**
- Produces: columns `test.next_run_number integer NOT NULL DEFAULT 1`, `run.run_number integer NULL`, unique index `run_test_id_run_number_key`; Prisma fields `Test.nextRunNumber: number`, `Run.runNumber: number | null`.
- Produces: `TestRepository.remove` clears `run_number` on the test's runs in the same transaction.

- [ ] **Step 1: Write the migration**

`packages/persistence/prisma/migrations/20260927180000_run_number/migration.sql`:

```sql
-- A run's number within its test: "Run 12" (backlog #5,
-- docs/superpowers/specs/2026-09-27-run-number-design.md).
--
-- ARRIVAL order, never renumbered. The counter lives on the test and is bumped
-- in the same statement that sets a run's test_id, so a number is taken
-- exactly once, at the moment a run joins its test. See
-- apps/worker/src/pipeline/run-number.ts for the two writers.
--
-- Existing runs are numbered by the SAME rule applied to history: creation
-- order within each test. The two UPDATEs between the BACKFILL markers are
-- read and executed verbatim by run-number.integration.test.ts, so keep the
-- markers and keep each statement ending in a semicolon.

ALTER TABLE "test" ADD COLUMN "next_run_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "run" ADD COLUMN "run_number" INTEGER;

-- BACKFILL: begin
UPDATE run r
   SET run_number = n.num
  FROM (SELECT id,
               row_number() OVER (PARTITION BY test_id ORDER BY created_at, id) AS num
          FROM run
         WHERE test_id IS NOT NULL) n
 WHERE r.id = n.id;

UPDATE test t
   SET next_run_number = COALESCE((SELECT max(r.run_number) FROM run r WHERE r.test_id = t.id), 0) + 1;
-- BACKFILL: end

-- NULLs are distinct in a unique index, so every run without a test coexists.
-- The name is Prisma's own default for @@unique([testId, runNumber]) on "run",
-- which is what keeps infra/test/schema-matches-migrations.sh reading "agree".
CREATE UNIQUE INDEX "run_test_id_run_number_key" ON "run"("test_id", "run_number");
```

- [ ] **Step 2: Describe it in `schema.prisma`**

In `model Test`, after `description     String?`:

```prisma
  /// The number the NEXT run to join this test will take — "Run 12"
  /// (docs/superpowers/specs/2026-09-27-run-number-design.md). Bumped in the
  /// same statement that sets a run's testId (apps/worker/src/pipeline/
  /// run-number.ts), so numbers follow ARRIVAL and are never reused.
  nextRunNumber   Int     @default(1) @map("next_run_number")
```

In `model Run`, directly after the `testId` line (`testId           String?   @map("test_id") @db.Uuid`):

```prisma
  /// This run's number within its test, or null exactly when testId is null.
  /// Assigned when the run JOINS its test and never renumbered; cleared when
  /// the test is deleted (TestRepository.remove), because SET NULL on the
  /// foreign key cannot reach a second column.
  runNumber        Int?      @map("run_number")
```

In `model Run`, beside the other `@@unique`:

```prisma
  @@unique([testId, runNumber])
```

Keep the column alignment of the lines you touch consistent with their neighbours by hand; do NOT run `prisma format` (it realigns unrelated models — CLAUDE.md).

- [ ] **Step 3: Apply to the scratch database and regenerate**

```bash
source /private/tmp/claude-501/-Users-rabindrabiswal-Workspace-perf-dashboard/73824373-f6b6-44d0-9f6b-bb43d018e7dc/scratchpad/env-runno.sh
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
bash infra/test/schema-matches-migrations.sh; echo "schema-guard exit=$?"
```

Expected: the migration applies; the schema guard exits 0 ("agree"). If it exits 2, read its diff — the usual cause is an index name or a column type spelled differently from the SQL.

- [ ] **Step 4: Write the failing tests**

`packages/persistence/test/run-number.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, SCHEMA_TABLES, TestRepository } from '../src/index.js';

/**
 * ═══ A RUN'S NUMBER, AT THE PERSISTENCE LAYER ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Two things live here rather than in the worker's suite: the backfill that
 * numbered history when the column arrived, and the delete that must clear a
 * number the foreign key's SET NULL cannot reach.
 */
const pool = createPool(process.env.DATABASE_URL ?? '');
const prisma = createPrisma(process.env.DATABASE_URL ?? '');

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

const testRow = (slug: string) =>
  prisma.test.create({
    data: { orgId, projectId, slug, name: slug, simulationClass: `example.${slug}` },
  });

/** A run row. `createdAt` and `startedAt` are set independently on purpose:
 *  the backfill orders by CREATION, and a fixture where the two agree cannot
 *  tell that rule from ordering by start. */
const runRow = (opts: {
  testId: string | null;
  createdAt: string;
  startedAt: string;
  runNumber?: number | null;
}) =>
  prisma.run.create({
    data: {
      orgId,
      projectId,
      testId: opts.testId,
      runNumber: opts.runNumber ?? null,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: new Date(opts.createdAt),
      startedAt: new Date(opts.startedAt),
      startedOn: new Date(opts.startedAt.slice(0, 10)),
      engineOptions: {},
    },
  });

/** The migration's own backfill, read out of the file between its markers and
 *  executed verbatim — never a copy of it, which could drift from the SQL
 *  that actually ran on every database. */
function backfillStatements(): string[] {
  const sql = readFileSync(
    fileURLToPath(
      new URL('../prisma/migrations/20260927180000_run_number/migration.sql', import.meta.url),
    ),
    'utf8',
  );
  const block = sql.split('-- BACKFILL: begin')[1]!.split('-- BACKFILL: end')[0]!;
  const statements = block
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Vacuity guard: a marker that moved would leave this with nothing to run,
  // and every assertion below would then be about the fixture's own nulls.
  expect(statements).toHaveLength(2);
  return statements;
}

describe('the backfill that numbered existing runs', () => {
  it('numbers each test’s runs by CREATION order and sets its counter past the last', async () => {
    const a = await testRow('checkout-smoke');
    const b = await testRow('checkout-soak');
    // Created in the order x, y, z — but STARTED in the order z, x, y, so
    // ordering by start would number them differently.
    const x = await runRow({ testId: a.id, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-08-02T10:00:00Z' });
    const y = await runRow({ testId: a.id, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-08-03T10:00:00Z' });
    const z = await runRow({ testId: a.id, createdAt: '2026-09-03T10:00:00Z', startedAt: '2026-08-01T10:00:00Z' });
    const other = await runRow({ testId: b.id, createdAt: '2026-09-04T10:00:00Z', startedAt: '2026-08-04T10:00:00Z' });
    const ungrouped = await runRow({ testId: null, createdAt: '2026-09-05T10:00:00Z', startedAt: '2026-08-05T10:00:00Z' });

    for (const statement of backfillStatements()) await pool.query(statement);

    const numbers = await prisma.run.findMany({ select: { id: true, runNumber: true } });
    const byId = new Map(numbers.map((r) => [r.id, r.runNumber]));
    expect([byId.get(x.id), byId.get(y.id), byId.get(z.id)]).toEqual([1, 2, 3]);
    expect(byId.get(other.id)).toBe(1);
    expect(byId.get(ungrouped.id)).toBeNull();

    const counters = await prisma.test.findMany({ select: { id: true, nextRunNumber: true } });
    const counterOf = new Map(counters.map((t) => [t.id, t.nextRunNumber]));
    expect(counterOf.get(a.id)).toBe(4);
    expect(counterOf.get(b.id)).toBe(2);
  });
});

describe('deleting a test', () => {
  it('leaves its runs ungrouped with no number, and touches no other test’s runs', async () => {
    const doomed = await testRow('checkout-smoke');
    const kept = await testRow('checkout-soak');
    const r1 = await runRow({ testId: doomed.id, runNumber: 1, createdAt: '2026-09-01T10:00:00Z', startedAt: '2026-09-01T10:00:00Z' });
    const r2 = await runRow({ testId: doomed.id, runNumber: 2, createdAt: '2026-09-02T10:00:00Z', startedAt: '2026-09-02T10:00:00Z' });
    const survivor = await runRow({ testId: kept.id, runNumber: 1, createdAt: '2026-09-03T10:00:00Z', startedAt: '2026-09-03T10:00:00Z' });

    const removed = await new TestRepository(prisma).remove({ orgId, projectId }, 'checkout-smoke');
    expect(removed?.slug).toBe('checkout-smoke');

    const rows = await prisma.run.findMany({ select: { id: true, testId: true, runNumber: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The runs survive — deleting a label must not delete a measurement —
    // and carry no number, because there is no test left to count within.
    expect(byId.get(r1.id)).toMatchObject({ testId: null, runNumber: null });
    expect(byId.get(r2.id)).toMatchObject({ testId: null, runNumber: null });
    expect(byId.get(survivor.id)).toMatchObject({ testId: kept.id, runNumber: 1 });
  });
});
```

If `TestRepository` is not exported from `../src/index.js`, import it from `../src/repositories/test.js` instead (check `packages/persistence/src/index.ts`).

- [ ] **Step 5: Run to see the deletion case fail**

```bash
pnpm exec vitest run --config vitest.integration.config.ts packages/persistence/test/run-number.integration.test.ts > /tmp/t1.txt 2>&1; echo "exit=$?"; tail -30 /tmp/t1.txt
```

Expected: the backfill case PASSES (the migration is already written) and the deletion case FAILS with `runNumber: 1` where `null` was expected — `remove` has not changed yet.

- [ ] **Step 6: Clear the numbers in `TestRepository.remove`**

Replace the body of `remove` (keep its docstring, and append the paragraph below to it):

```ts
  async remove(scope: ProjectScope, slug: string): Promise<TestRow | null> {
    const existing = await this.findBySlug(scope, slug);
    if (existing === null) return null;

    const [, { count }] = await this.prisma.$transaction([
      // Numbers first, RUN rows before the TEST row — the lock order every
      // writer of a run number uses, so this cannot deadlock one.
      this.prisma.run.updateMany({
        where: { orgId: scope.orgId, projectId: scope.projectId, testId: existing.id },
        data: { runNumber: null },
      }),
      this.prisma.test.deleteMany({
        where: { orgId: scope.orgId, projectId: scope.projectId, slug },
      }),
      // A run that joined this test between the first statement and the
      // delete took a number the first statement never saw; SET NULL has now
      // ungrouped it, so clear what it is left holding.
      this.prisma.run.updateMany({
        where: {
          orgId: scope.orgId,
          projectId: scope.projectId,
          testId: null,
          runNumber: { not: null },
        },
        data: { runNumber: null },
      }),
    ]);
    return count === 0 ? null : existing;
  }
```

Docstring paragraph to append:

```
   * ═══ AND ITS RUNS LOSE THEIR NUMBERS ═══
   *
   * A run's number counts within its test (spec 2026-09-27-run-number), and
   * `ON DELETE SET NULL` can clear `test_id` but not a second column. So the
   * numbers are cleared here, in the same transaction, and a run never
   * reports a number with no test to count it in. A test later recreated under
   * the same slug is a new row and starts at 1.
```

- [ ] **Step 7: Rebuild persistence, run, see it pass**

```bash
find packages/persistence -name '*.tsbuildinfo' -delete && pnpm --filter @perfportal/persistence build > /tmp/b.txt 2>&1; echo "build exit=$?"
pnpm exec vitest run --config vitest.integration.config.ts packages/persistence/test/run-number.integration.test.ts > /tmp/t1.txt 2>&1; echo "exit=$?"; tail -8 /tmp/t1.txt
```

Expected: 2 passed.

- [ ] **Step 8: Commit the checkpoint**

```bash
git add packages/persistence/prisma/migrations/20260927180000_run_number/migration.sql packages/persistence/prisma/schema.prisma packages/persistence/src/repositories/test.ts packages/persistence/test/run-number.integration.test.ts
git commit -q -F - <<'MSG'
Number a test's runs by arrival: counter on test, run_number on run

Migration 20260927180000_run_number adds test.next_run_number and
run.run_number (unique per test), and numbers existing runs by creation
order within each test. Deleting a test now clears its runs' numbers in
the same transaction, since SET NULL on the foreign key cannot.
MSG
```

- [ ] **Step 9: Red-verify each case, one mutation at a time**

For each, apply the edit (assert it matched once), run the file, record which case failed and its message, restore with `git checkout HEAD -- <file>`:

1. In `migration.sql`, change `ORDER BY created_at, id` to `ORDER BY started_at, id` → the backfill case alone fails (`[2, 3, 1]` against `[1, 2, 3]`).
2. In `migration.sql`, change `, 0) + 1;` to `, 0);` → the backfill case fails on the counter (`3` against `4`).
3. In `test.ts`, delete the first `this.prisma.run.updateMany({ … }),` block AND the third one (the whole number-clearing) → the deletion case alone fails. (Rebuild persistence before running — Global Constraints.)

---

### Task 2: The two numbering statements, as one worker module

**Files:**
- Create: `apps/worker/src/pipeline/run-number.ts`
- Create: `apps/worker/test/run-number.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  - `attachLiveRunToTest(pool: pg.Pool, runId: string, testId: string): Promise<number | null>` — sets `test_id` and assigns a number only if the run has no test yet; returns the number assigned, or null when it assigned nothing.
  - `numberRunForTest(client: pg.PoolClient, runId: string, testId: string | null): Promise<number | null>` — for use INSIDE the pipeline's finalize transaction: sets `test_id` to `testId` and decides the number; returns the run's number afterwards (null when unchanged row or no test).

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/run-number.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createPool, createPrisma, SCHEMA_TABLES } from '@perfportal/persistence';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { attachLiveRunToTest, numberRunForTest } from '../src/pipeline/run-number.js';

/**
 * ═══ A RUN'S NUMBER, AT THE TWO PLACES A RUN JOINS ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * THE REAL STATEMENTS, NOT A MIRROR OF THEIR SQL: both writers call these two
 * functions, and this file calls them too. CLAUDE.md records a test-entity
 * suite that mirrored the resolver's SQL and stopped being valid the day the
 * rule moved out of the schema; this rule lives in code from the start.
 */
const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

const testRow = (slug: string, nextRunNumber = 1) =>
  prisma.test.create({
    data: { orgId, projectId, slug, name: slug, simulationClass: `example.${slug}`, nextRunNumber },
  });

const runRow = (status: 'running' | 'parsing' | 'complete', testId: string | null = null, runNumber: number | null = null) =>
  prisma.run.create({
    data: {
      orgId,
      projectId,
      testId,
      runNumber,
      status,
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      startedAt: new Date('2026-09-27T09:00:00Z'),
      startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });

const numberOf = async (runId: string) =>
  (await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { testId: true, runNumber: true } }));
const counterOf = async (testId: string) =>
  (await prisma.test.findUniqueOrThrow({ where: { id: testId } })).nextRunNumber;

/** One finalize transaction, the way PipelineService opens it. */
async function inFinalize<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('a live run joining its test at the log header', () => {
  it('numbers successive runs 1, 2 and moves the counter past them', async () => {
    const test = await testRow('checkout-smoke');
    const first = await runRow('running');
    const second = await runRow('running');

    expect(await attachLiveRunToTest(pool, first.id, test.id)).toBe(1);
    expect(await attachLiveRunToTest(pool, second.id, test.id)).toBe(2);

    expect(await numberOf(first.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await numberOf(second.id)).toEqual({ testId: test.id, runNumber: 2 });
    expect(await counterOf(test.id)).toBe(3);
  });

  /** A re-claimed fold (crash, rolling deploy) identifies the run again. It
   *  must find the run already in its test and take NOTHING. */
  it('burns no number when the same run is attached a second time', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');

    await attachLiveRunToTest(pool, run.id, test.id);
    expect(await attachLiveRunToTest(pool, run.id, test.id)).toBeNull();

    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });
});

describe('the pipeline deciding the number at finalize', () => {
  it('numbers an upload, which had no test until now', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('parsing');

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await numberOf(run.id)).toEqual({ testId: test.id, runNumber: 1 });
    expect(await counterOf(test.id)).toBe(2);
  });

  it('keeps the number a live run took at its header when the test is the same', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, test.id))).toBe(1);
    expect(await counterOf(test.id)).toBe(2);
  });

  /** B already holds runs, so its next number is 3 — a value the run's OLD
   *  number (1) cannot coincide with, which is what lets this tell "took B's
   *  next" from "kept A's". */
  it('takes the new test’s next number when finalize re-matches it, leaving a gap behind', async () => {
    const a = await testRow('checkout-smoke');
    const b = await testRow('checkout-soak', 3);
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, a.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, b.id))).toBe(3);
    expect(await numberOf(run.id)).toEqual({ testId: b.id, runNumber: 3 });
    expect(await counterOf(b.id)).toBe(4);
    // A's 1 is spent and not given back: numbers are never reused.
    expect(await counterOf(a.id)).toBe(2);
  });

  it('clears the number when the resolver found no test', async () => {
    const test = await testRow('checkout-smoke');
    const run = await runRow('running');
    await attachLiveRunToTest(pool, run.id, test.id);

    expect(await inFinalize((c) => numberRunForTest(c, run.id, null))).toBeNull();
    expect(await numberOf(run.id)).toEqual({ testId: null, runNumber: null });
  });

  /** The terminal UPDATE's own guard: a run already finished must not be
   *  re-numbered by a redelivered job. */
  it('leaves a run that is already terminal exactly as it was', async () => {
    const a = await testRow('checkout-smoke', 2);
    const b = await testRow('checkout-soak');
    const done = await runRow('complete', a.id, 1);

    await inFinalize((c) => numberRunForTest(c, done.id, b.id));

    expect(await numberOf(done.id)).toEqual({ testId: a.id, runNumber: 1 });
    expect(await counterOf(b.id)).toBe(1);
  });

  /** ═══ THE RACE A COUNTER EXISTS FOR ═══
   *  Eight runs of one test finalizing at once, each in its own transaction.
   *  A max-plus-one read would hand several of them the same number (and the
   *  unique index would then refuse all but one). */
  it('gives runs finalizing concurrently distinct numbers', async () => {
    const test = await testRow('checkout-smoke');
    const runs = await Promise.all(Array.from({ length: 8 }, () => runRow('parsing')));

    const numbers = await Promise.all(
      runs.map((run) => inFinalize((c) => numberRunForTest(c, run.id, test.id))),
    );

    expect([...numbers].sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await counterOf(test.id)).toBe(9);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/worker/test/run-number.integration.test.ts > /tmp/t2.txt 2>&1; echo "exit=$?"; tail -15 /tmp/t2.txt
```

Expected: FAIL — the module `../src/pipeline/run-number.js` does not exist.

- [ ] **Step 3: Write the module**

`apps/worker/src/pipeline/run-number.ts`:

```ts
import type pg from 'pg';

/**
 * ═══ A RUN'S NUMBER WITHIN ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * "Run 12": the number a run takes the moment it JOINS its test, kept for
 * ever. Arrival order, deliberately — numbering by when a test ran would
 * renumber every later run whenever an old bundle is uploaded late, and "#12"
 * in last week's thread would name a different run today.
 *
 * A run's test is set in exactly two places, and so is its number, in the
 * SAME statement: `LiveFoldOwner#identify` at the log header
 * (`attachLiveRunToTest`), and `PipelineService` inside its finalize
 * transaction (`numberRunForTest`). The counter is `test.next_run_number`,
 * bumped by an UPDATE whose row lock serialises two runs of one test; a
 * max-plus-one read would hand both the same number.
 *
 * LOCK ORDER IS RUN, THEN TEST, in both statements and in
 * `TestRepository.remove`, so no two of them can deadlock each other.
 *
 * No backticks anywhere in the SQL below: it sits in template literals.
 */

/**
 * The live run's test, at its header — and its number, if and only if the run
 * had no test yet. A re-claimed fold identifies the run again; the EXISTS
 * guard is what stops that burning a second number (the second call blocks on
 * the row lock, re-reads test_id as set, finds "target" empty and allocates
 * nothing). Returns the number assigned, or null when nothing was.
 */
export async function attachLiveRunToTest(
  pool: pg.Pool,
  runId: string,
  testId: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ run_number: number | null }>(
    `WITH target AS (
       SELECT id FROM run WHERE id = $1::uuid AND test_id IS NULL FOR UPDATE
     ), allocated AS (
       UPDATE test SET next_run_number = next_run_number + 1
        WHERE id = $2::uuid AND EXISTS (SELECT 1 FROM target)
       RETURNING next_run_number - 1 AS n
     )
     UPDATE run SET test_id = $2::uuid, run_number = (SELECT n FROM allocated)
      WHERE id = (SELECT id FROM target)
      RETURNING run_number`,
    [runId, testId],
  );
  return rows[0]?.run_number ?? null;
}

/**
 * The number, decided at finalize, INSIDE the pipeline's transaction and
 * immediately before its terminal UPDATE (whose status guard this repeats, so
 * a redelivered job cannot renumber a finished run):
 *
 *   arrives with no test (an upload)      -> the resolved test's next number
 *   arrives in the resolved test          -> the number it already has, kept
 *   arrives in a DIFFERENT test           -> the resolved test's next; the old
 *                                            test keeps a gap, never refilled
 *   the resolver answered null            -> no test, no number
 *
 * Returns the run's number afterwards, or null (no test, or no row updated).
 */
export async function numberRunForTest(
  client: pg.PoolClient,
  runId: string,
  testId: string | null,
): Promise<number | null> {
  const { rows } = await client.query<{ run_number: number | null }>(
    `WITH cur AS (
       SELECT test_id FROM run
        WHERE id = $1::uuid AND status NOT IN ('complete', 'failed') FOR UPDATE
     ), allocated AS (
       UPDATE test SET next_run_number = next_run_number + 1
        WHERE id = $2::uuid
          AND EXISTS (SELECT 1 FROM cur WHERE cur.test_id IS DISTINCT FROM $2::uuid)
       RETURNING next_run_number - 1 AS n
     )
     UPDATE run
        SET test_id = $2::uuid,
            run_number = CASE WHEN run.test_id IS NOT DISTINCT FROM $2::uuid
                              THEN run.run_number
                              ELSE (SELECT n FROM allocated) END
      WHERE id = $1::uuid AND EXISTS (SELECT 1 FROM cur)
      RETURNING run_number`,
    [runId, testId],
  );
  return rows[0]?.run_number ?? null;
}
```

- [ ] **Step 4: Run to see it pass**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/worker/test/run-number.integration.test.ts > /tmp/t2.txt 2>&1; echo "exit=$?"; tail -8 /tmp/t2.txt
```

Expected: 8 passed.

- [ ] **Step 5: Commit the checkpoint**

```bash
git add apps/worker/src/pipeline/run-number.ts apps/worker/test/run-number.integration.test.ts
git commit -q -F - <<'MSG'
Add the two statements that number a run as it joins its test

attachLiveRunToTest (the header) numbers a run only if it has no test
yet, so a re-claimed fold burns nothing; numberRunForTest (finalize)
keeps a same-test number, re-numbers a re-matched run from its new test,
and clears it when the resolver found none. Counter, not max + 1, so
concurrent finalizes of one test take distinct numbers.
MSG
```

- [ ] **Step 6: Red-verify, one mutation at a time (restore after each)**

1. In `attachLiveRunToTest`, delete ` AND EXISTS (SELECT 1 FROM target)` → the "burns no number" case alone fails (counter `3` against `2`).
2. In `numberRunForTest`, replace `THEN run.run_number` with `THEN (SELECT n FROM allocated)` → the "keeps the number" case alone fails (returns `null`: nothing was allocated).
3. In `numberRunForTest`, replace `ELSE (SELECT n FROM allocated) END` with `ELSE run.run_number END` → the "re-matches" case (`1` against `3`), the "upload" case (`null` against `1`) and the "concurrently" case fail; the "clears" case also fails (`1` against `null`). All four assert the same claim — the else-branch allocates — at four inputs; record that rather than calling it blunt.
4. In `numberRunForTest`, delete ` AND status NOT IN ('complete', 'failed')` from the CTE → the "already terminal" case alone fails.
5. In `numberRunForTest`, replace the whole `allocated AS ( … )` CTE body with `SELECT COALESCE(max(run_number), 0) + 1 AS n FROM run WHERE test_id = $2::uuid AND EXISTS (SELECT 1 FROM cur WHERE cur.test_id IS DISTINCT FROM $2::uuid)` → the "concurrently" case fails (a unique-violation error, or duplicate numbers). If it happens to pass once, run it five times and record the rate: a race guard is proven by a mutation that loses it, not by one lucky run.

---

### Task 3: Wire the statements into both writers

**Files:**
- Modify: `apps/worker/src/live/fold-owner.ts` (`#identify`, ~line 1896)
- Modify: `apps/worker/src/pipeline/pipeline.service.ts` (finalize transaction, ~line 366)
- Modify: `apps/worker/test/run-number.integration.test.ts` (one end-to-end case)
- Modify: `apps/worker/test/fold-owner.integration.test.ts` (one case, ~line 2091)

**Interfaces:**
- Consumes: `attachLiveRunToTest`, `numberRunForTest` from Task 2.

- [ ] **Step 1: Write the failing wiring cases**

Append to `apps/worker/test/run-number.integration.test.ts` (add these imports at the top: `execFileSync` from `node:child_process`; `createHash` beside `randomUUID` from `node:crypto`; `mkdtempSync, mkdirSync, readFileSync, copyFileSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path`; `fileURLToPath` from `node:url`; `Readable` from `node:stream`; `BlobStore` from `@perfportal/storage`; `PipelineService` from `../src/pipeline/pipeline.service.js`; and `beforeAll` from `vitest`):

```ts
const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
const blobs = new BlobStore(config.blob);
let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runno-'));
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(FIXTURE_LOG, join(dir, 'run-1', 'simulation.log'));
  execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'run-1']);
  bundle = readFileSync(join(dir, 'bundle.tgz'));
  await blobs.ensureBucket();
});

/** A pending upload of the reference bundle, the shape POST /v1/runs leaves. */
async function pendingUpload(): Promise<string> {
  const key = `runs/${projectId}/${randomUUID()}.tgz`;
  await blobs.putStream(key, Readable.from([bundle]), 100_000_000);
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'pending', tool: 'gatling',
      bundleKey: key,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: BigInt(bundle.length),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('the pipeline, end to end', () => {
  /** THE WIRING, not the statement: two real uploads of one simulation,
   *  processed by the real PipelineService, land in one auto-created test as
   *  Run 1 and Run 2. Removing the call from the pipeline fails this alone. */
  it('numbers two uploads of one simulation 1 then 2', async () => {
    const pipeline = new PipelineService(config, prisma, pool, blobs);
    const first = await pendingUpload();
    await pipeline.process(first);
    const second = await pendingUpload();
    await pipeline.process(second);

    const a = await numberOf(first);
    const b = await numberOf(second);
    expect(a.testId).not.toBeNull();
    expect(b.testId).toBe(a.testId);
    expect([a.runNumber, b.runNumber]).toEqual([1, 2]);
  });
});
```

In `apps/worker/test/fold-owner.integration.test.ts`, inside `describe('a rule scoped to the test the log header names', …)`, directly after the case `'records the test on the run row, so a reader sees it mid-stream'`:

```ts
      /** And NUMBERS it there: a live run shows "Run 1" while it streams, as a
       *  Gatling Enterprise run does from launch — not only once it ends. */
      it('numbers the run at its header, in the same statement that records its test', async () => {
        const test = await seedTest('test.Sim', 'the-sim');
        await owner.tick();

        const row = await prisma.run.findUnique({ where: { id: runId } });
        expect(row?.testId).toBe(test.id);
        expect(row?.runNumber).toBe(1);
        expect((await prisma.test.findUniqueOrThrow({ where: { id: test.id } })).nextRunNumber).toBe(2);
      });
```

- [ ] **Step 2: Run both to see them fail**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/worker/test/run-number.integration.test.ts apps/worker/test/fold-owner.integration.test.ts -t "numbers" > /tmp/t3.txt 2>&1; echo "exit=$?"; grep -E '✓|×|Tests' /tmp/t3.txt | tail -12
```

Expected: `numbers two uploads … 1 then 2` fails (`[null, null]`) and `numbers the run at its header …` fails (`runNumber` null).

- [ ] **Step 3: Wire the fold owner**

In `apps/worker/src/live/fold-owner.ts`, add `import { attachLiveRunToTest } from '../pipeline/run-number.js';` beside the existing `resolveTestId` import, and replace:

```ts
      await this.#pool.query(
        `UPDATE run SET test_id = $2 WHERE id = $1 AND test_id IS NULL`,
        [runId, testId],
      );
```

with:

```ts
      // …and its NUMBER, in the same statement (run-number.ts). A run that
      // already has a test is left alone, number included — so a re-claim
      // mid-stream burns nothing.
      await attachLiveRunToTest(this.#pool, runId, testId);
```

Keep the comment block above it; update its first sentence to say "The run row — its test and its number —".

- [ ] **Step 4: Wire the pipeline**

In `apps/worker/src/pipeline/pipeline.service.ts`, add `import { numberRunForTest } from './run-number.js';` beside the `resolveTestId` import, and insert immediately BEFORE the terminal `await client.query(` whose SQL begins `UPDATE run SET status = CASE WHEN stream_abandoned_at IS NULL`:

```ts
      // ═══ THE RUN'S NUMBER WITHIN ITS TEST ═══
      //
      // In this transaction, and immediately before the terminal UPDATE: it
      // repeats that UPDATE's status guard, which a run that has already gone
      // terminal would no longer pass. The test's row lock it takes is then
      // held for two short statements and the COMMIT, never for the metrics
      // write above. See run-number.ts for the four cases.
      await numberRunForTest(client, run.id, testId);
```

Leave `test_id = $10` in the terminal UPDATE as it is: it writes the same value, and the comment there about `simulation` and `test_id` sharing one statement stays true.

- [ ] **Step 5: Run to see them pass, and the rest of both files stay green**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/worker/test/run-number.integration.test.ts apps/worker/test/fold-owner.integration.test.ts apps/worker/test/pipeline.integration.test.ts apps/worker/test/test-entity.integration.test.ts > /tmp/t3.txt 2>&1; echo "exit=$?"; grep -E 'Test Files|Tests ' /tmp/t3.txt
```

Expected: exit 0, zero failures.

- [ ] **Step 6: Commit the checkpoint**

```bash
git add apps/worker/src/live/fold-owner.ts apps/worker/src/pipeline/pipeline.service.ts apps/worker/test/run-number.integration.test.ts apps/worker/test/fold-owner.integration.test.ts
git commit -q -F - <<'MSG'
Number a run where it joins its test: at its header and at finalize

LiveFoldOwner#identify now records the run's number in the statement that
records its test, so a live run carries "Run 1" while it streams, and the
pipeline decides the number inside its finalize transaction, just before
the terminal UPDATE whose status guard it repeats.
MSG
```

- [ ] **Step 7: Red-verify (restore after each)**

1. In `pipeline.service.ts`, delete the line `await numberRunForTest(client, run.id, testId);` → `numbers two uploads … 1 then 2` fails alone in `run-number.integration.test.ts` (`[null, null]`). `tsc` will also flag the unused import; that is expected under this mutation and is why the run is `vitest`, not `typecheck`.
2. In `fold-owner.ts`, replace `await attachLiveRunToTest(this.#pool, runId, testId);` with ``await this.#pool.query(`UPDATE run SET test_id = $2 WHERE id = $1 AND test_id IS NULL`, [runId, testId]);`` → `numbers the run at its header …` fails alone, while `records the test on the run row …` stays green (the before-state).

---

### Task 4: The contract field

**Files:**
- Create: `packages/contracts/src/run-number.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/run.ts` (`RunIdentitySchema` ~line 232; run-list item `.extend({…})` ~line 449)
- Modify: `packages/contracts/src/metrics.ts` (`TrendRunSchema`, ~line 381)
- Modify: `packages/contracts/src/test.ts` (`TestSummarySchema.latestRun`, ~line 43)
- Create: `packages/contracts/test/run-number.test.ts`

**Interfaces:**
- Produces: `RunNumberSchema` (`z.number().int().positive()`), type `RunNumber`; the field `runNumber?: number | null` on `RunIdentity` (so `RunResponse` and `RunProcessing`), on `RunListResponse['items'][number]`, on `TrendRun`, and on `TestSummary['latestRun']`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/run-number.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  RunIdentitySchema,
  RunListResponseSchema,
  RunNumberSchema,
  TestSummarySchema,
  TrendRunSchema,
} from '../src/index.js';

/**
 * ═══ A RUN'S NUMBER ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Positive and whole — a run is the 1st, 2nd, 12th of its test — or null for a
 * run with no test. And OPTIONAL on every schema that carries it: the browser
 * drops a body that fails safeParse, so a required field would blank the page
 * against an API pod that predates it for a whole rolling deploy.
 */
const MINIMAL_IDENTITY = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-27T09:00:00.000Z',
};

const LIST_ROW = {
  id: MINIMAL_IDENTITY.id,
  project: MINIMAL_IDENTITY.project,
  status: 'complete',
  verdict: null,
  tool: 'gatling',
  startedAt: MINIMAL_IDENTITY.startedAt,
};

const TREND_ROW = {
  id: MINIMAL_IDENTITY.id,
  startedAt: MINIMAL_IDENTITY.startedAt,
  toolStartedAt: null,
  durationMs: null,
  verdict: null,
  count: 1,
  okCount: 1,
  koCount: 0,
  errorRate: 0,
  minMs: 1,
  maxMs: 1,
  meanMs: 1,
  throughputRps: 1,
  percentiles: {},
};

const TEST = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'checkout-smoke',
  name: 'Checkout smoke',
  simulationClass: 'example.CheckoutSimulation',
  description: null,
  createdAt: '2026-09-27T09:00:00.000Z',
  updatedAt: '2026-09-27T09:00:00.000Z',
  runCount: 1,
  latestRun: { id: MINIMAL_IDENTITY.id, status: 'complete', verdict: 'passed' },
};

describe('a run number', () => {
  it('is a positive whole number', () => {
    expect(RunNumberSchema.parse(1)).toBe(1);
    expect(RunNumberSchema.parse(12)).toBe(12);
  });

  it('refuses zero, negatives, fractions and strings', () => {
    for (const bad of [0, -1, 1.5, '12']) {
      expect(RunNumberSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rides a run’s identity, null for a run with no test, and is absent from an older pod', () => {
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, runNumber: 12 }).runNumber).toBe(12);
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, runNumber: null }).runNumber).toBeNull();
    expect(RunIdentitySchema.parse(MINIMAL_IDENTITY).runNumber).toBeUndefined();
    expect(RunIdentitySchema.safeParse({ ...MINIMAL_IDENTITY, runNumber: 0 }).success).toBe(false);
  });

  it('rides a list row, a trend row and a test’s latest run — each still parsing without it', () => {
    const list = RunListResponseSchema.parse({
      items: [{ ...LIST_ROW, runNumber: 3 }, LIST_ROW],
      nextCursor: null,
    });
    expect(list.items.map((i) => i.runNumber)).toEqual([3, undefined]);

    expect(TrendRunSchema.parse({ ...TREND_ROW, runNumber: 3 }).runNumber).toBe(3);
    expect(TrendRunSchema.parse(TREND_ROW).runNumber).toBeUndefined();

    expect(
      TestSummarySchema.parse({ ...TEST, latestRun: { ...TEST.latestRun, runNumber: 3 } }).latestRun
        ?.runNumber,
    ).toBe(3);
    expect(TestSummarySchema.parse(TEST).latestRun?.runNumber).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
pnpm exec vitest run packages/contracts/test/run-number.test.ts > /tmp/t4.txt 2>&1; echo "exit=$?"; tail -12 /tmp/t4.txt
```

Expected: FAIL — `RunNumberSchema` is not exported.

- [ ] **Step 3: Add the schema and the four fields**

`packages/contracts/src/run-number.ts`:

```ts
import { z } from 'zod';

/**
 * ═══ A RUN'S NUMBER WITHIN ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * "Run 12": taken when a run JOINS its test and never renumbered, so it follows
 * arrival rather than start time. Positive and whole. Every schema that
 * carries it does so as `.nullable().optional()` — null for a run with no
 * test, absent from an API pod that predates the field.
 *
 * Its own file, importing only zod, so run.ts, metrics.ts and test.ts can all
 * reach it without an import cycle.
 */
export const RunNumberSchema = z.number().int().positive();
export type RunNumber = z.infer<typeof RunNumberSchema>;
```

`packages/contracts/src/index.ts`: add `export * from './run-number.js';` directly after `export * from './run-note.js';`.

`packages/contracts/src/run.ts`: add `import { RunNumberSchema } from './run-number.js';` after the `RunNoteSchema` import. In `RunIdentitySchema`, directly after the `test: TestRefSchema.nullable().optional(),` entry (find it by its docstring "The test this is a run of, or null."):

```ts
  /**
   * This run's number within `test` — "Run 12" — or null when the run has no
   * test. Taken on JOINING the test and never renumbered (run-number.ts).
   * Optional as well as nullable, for the rolling-deploy reason `test` gives.
   */
  runNumber: RunNumberSchema.nullable().optional(),
```

In the run-list item `.extend({…})`, directly after `test: TestRefSchema.nullable().optional(),`:

```ts
      /** The run's number within its test, or null for none (run-number.ts). */
      runNumber: RunNumberSchema.nullable().optional(),
```

`packages/contracts/src/metrics.ts`: add `import { RunNumberSchema } from './run-number.js';` after the `RunVerdictSchema` import; in `TrendRunSchema`, after `simulation: z.string().nullable().optional(),`:

```ts
  /** The run's number within its test — the Trends axis reads "#12" from it
   *  (run-number.ts). Nullable and optional for the reason the blocks above
   *  give. */
  runNumber: RunNumberSchema.nullable().optional(),
```

`packages/contracts/src/test.ts`: add `import { RunNumberSchema } from './run-number.js';`; in `latestRun`'s `z.object({…})`, after `verdict: RunVerdictSchema.nullable(),`:

```ts
      /** "Run 12" in the catalogue's last-run cell. Optional: an older pod
       *  omits it, and the browser drops a body that fails the schema. */
      runNumber: RunNumberSchema.nullable().optional(),
```

- [ ] **Step 4: Run to see it pass, then rebuild contracts and check the emitted file**

```bash
pnpm exec vitest run packages/contracts/test/run-number.test.ts > /tmp/t4.txt 2>&1; echo "exit=$?"; tail -6 /tmp/t4.txt
find packages/contracts -name '*.tsbuildinfo' -delete && pnpm --filter @perfportal/contracts build > /tmp/b.txt 2>&1; echo "build exit=$?"
grep -c 'runNumber' packages/contracts/dist/src/run.js packages/contracts/dist/src/metrics.js packages/contracts/dist/src/test.js
```

Expected: 4 passed; build exit 0; a non-zero count in each of the three emitted files.

- [ ] **Step 5: Commit the checkpoint**

```bash
git add packages/contracts/src/run-number.ts packages/contracts/src/index.ts packages/contracts/src/run.ts packages/contracts/src/metrics.ts packages/contracts/src/test.ts packages/contracts/test/run-number.test.ts
git commit -q -F - <<'MSG'
Carry a run's number in the contract: identity, list row, trend row, latest run

RunNumberSchema is a positive integer, and every schema carries it as
nullable (a run with no test) and optional (an API pod that predates it,
because the browser drops a body that fails its schema).
MSG
```

- [ ] **Step 6: Red-verify (restore after each; rebuild not needed — the unit test imports `src`)**

1. `run-number.ts`: `.positive()` → `.nonnegative()` → "refuses zero…" fails alone, on `0`.
2. `run.ts`: the identity field's `.nullable().optional()` → `.nullable()` → "rides a run’s identity…" fails alone (the absent case).
3. `metrics.ts`: delete the `runNumber` line from `TrendRunSchema` → "rides a list row…" fails alone (zod strips the key: `undefined` against `3`).

---

### Task 5: Persistence reads and the API

**Files:**
- Modify: `packages/persistence/src/repositories/run.ts` (`RunRecord` ~line 28; `RunRow` ~line 139; `toRecord` ~line 191; list `SELECT` ~line 1003)
- Modify: `packages/persistence/src/repositories/test.ts` (`TestRow.latestRun`; `listForProject`; `findBySlug`)
- Modify: `packages/persistence/src/metrics/trends.ts` (`TRENDS_SQL`, `StoredTrendRun`)
- Modify: `packages/persistence/src/metrics/read.ts` (`trends()` mapping ~line 309)
- Modify: `apps/api/src/runs/runs.service.ts` (`toResponse` ~line 101)
- Modify: `apps/api/src/runs/runs.controller.ts` (`toListItem` ~line 196; the 202 body ~line 283)
- Modify: `apps/api/src/metrics/metrics.controller.ts` (trends mapping ~line 152)
- Modify: `apps/api/src/tests/tests.controller.ts` (`latestRun` ~line 241)
- Create: `apps/api/test/run-number.integration.test.ts`
- Modify (type fixes only, if `tsc` asks): `apps/api/test/verdict.integration.test.ts`, `packages/persistence/test/repositories.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's columns, Task 3's writers (runs get numbers through the real pipeline), Task 4's contract.
- Produces: `RunRecord.runNumber: number | null`; `TestRow.latestRun.runNumber: number | null`; `StoredTrendRun.runNumber: number | null`; `runNumber` on `GET /v1/runs/:id` (both builders), `GET /v1/runs` items, `GET /v1/runs/:id/trends` rows, `GET /v1/projects/:slug/tests` `latestRun`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/run-number.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ A RUN'S NUMBER, ON EVERY READ THAT CARRIES A RUN ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Numbers come from the REAL pipeline here (runPipelineFor), never written by
 * the fixture: a fixture that set run_number itself would prove the reads and
 * nothing about whether a real run ever has one.
 *
 * BOTH identity builders are pinned, separately: a finished run is answered by
 * RunsService.toResponse and a live one by respondWithRun's hand-written 202,
 * and a field reaching only one of them is missing exactly while a reader
 * watches (CLAUDE.md, warmupMs).
 */
const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'runno-api-'));
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(FIXTURE_LOG, join(dir, 'run-1', 'simulation.log'));
  execFileSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'run-1']);
  bundle = readFileSync(join(dir, 'bundle.tgz'));
});

beforeEach(async () => {
  ctx = await createTestApp();
});

afterEach(async () => {
  await ctx?.close();
});

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

/** Upload the reference bundle and process it with the real pipeline. */
async function ingested(): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

/** A RUNNING run in a test with a number — the state LiveFoldOwner leaves at
 *  the header — read through the 202 builder. */
async function runningNumbered(runNumber: number | null): Promise<string> {
  const test =
    runNumber === null
      ? null
      : await ctx.prisma.test.create({
          data: { orgId: ctx.orgId, projectId: ctx.projectId, slug: `live-${randomUUID().slice(0, 8)}`, name: 'Live', simulationClass: 'example.Live', nextRunNumber: runNumber + 1 },
        });
  const run = await ctx.prisma.run.create({
    data: {
      orgId: ctx.orgId, projectId: ctx.projectId, status: 'running', tool: 'gatling',
      testId: test?.id ?? null, runNumber,
      bundleKey: `live/${randomUUID()}/simulation.log`, bundleSha256: 'a'.repeat(64), bundleBytes: 1n,
      startedAt: new Date('2026-09-27T09:00:00Z'), startedOn: new Date('2026-09-27T00:00:00Z'),
      engineOptions: {},
    },
  });
  return run.id;
}

describe('runNumber on the wire', () => {
  it('reports a finished run’s number from the terminal builder', async () => {
    await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${second}`).set(auth());
    expect(res.status).not.toBe(202);
    expect(res.body.runNumber).toBe(2);
  });

  it('reports a live run’s number from the 202 builder', async () => {
    const id = await runningNumbered(7);

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}`).set(auth());
    expect(res.status).toBe(202);
    expect(res.body.runNumber).toBe(7);
  });

  it('reports null for a run with no test', async () => {
    const id = await runningNumbered(null);

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}`).set(auth());
    expect(res.body.runNumber).toBeNull();
  });

  it('carries it on every run-list row', async () => {
    const first = await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get('/v1/runs').set(auth());
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((i: { id: string; runNumber: number }) => [i.id, i.runNumber]));
    expect([byId.get(first), byId.get(second)]).toEqual([1, 2]);
  });

  it('carries it on every trends row', async () => {
    const first = await ingested();
    const second = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${second}/trends`).set(auth());
    expect(res.status).toBe(200);
    const byId = new Map(res.body.runs.map((r: { id: string; runNumber: number }) => [r.id, r.runNumber]));
    expect([byId.get(first), byId.get(second)]).toEqual([1, 2]);
  });

  it('carries it on a test’s latest run in the catalogue', async () => {
    await ingested();
    await ingested();

    const res = await request(ctx.app.getHttpServer()).get('/v1/projects/checkout/tests').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.tests).toHaveLength(1);
    expect(res.body.tests[0].latestRun.runNumber).toBe(2);
  });
});
```

- [ ] **Step 2: Run to see it fail**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/run-number.integration.test.ts > /tmp/t5.txt 2>&1; echo "exit=$?"; grep -E '✓|×|Tests' /tmp/t5.txt | tail -10
```

Expected: all six fail — the field is absent everywhere, and absent reads `undefined`, which fails `toBeNull()` as well as `toBe(n)`.

- [ ] **Step 3: Persistence — the run record and the list**

`packages/persistence/src/repositories/run.ts`:

In `interface RunRecord`, directly after `test: { id: string; slug: string; name: string } | null;`:

```ts
  /** This run's number within `test` ("Run 12"), or null exactly when `test`
   *  is null. Taken on joining the test, never renumbered — see
   *  apps/worker/src/pipeline/run-number.ts. */
  runNumber: number | null;
```

In `interface RunRow`, directly after its `test?: …` line:

```ts
  runNumber: number | null;
```

In `toRecord`, directly after the `test:` entry:

```ts
    runNumber: row.runNumber,
```

In the list query's `SELECT`, directly after the line `t.id AS "testId", t.slug AS "testSlug", t.name AS "testName",`:

```sql
        r.run_number AS "runNumber",
```

- [ ] **Step 4: Persistence — the test catalogue's latest run**

`packages/persistence/src/repositories/test.ts`:

- `TestRow.latestRun`: `{ id: string; status: string; verdict: string | null; runNumber: number | null } | null;`
- `listForProject`: the `findMany` `select` becomes `{ id: true, testId: true, status: true, verdict: true, runNumber: true }`; the map's value type gains `runNumber: number | null`; `latestBy.set(run.testId, { id: run.id, status: run.status, verdict: run.verdict, runNumber: run.runNumber });`.
- `findBySlug`: the `findFirst` `select` becomes `{ id: true, status: true, verdict: true, runNumber: true }`.

- [ ] **Step 5: Persistence — trends**

`packages/persistence/src/metrics/trends.ts`, `TRENDS_SQL`:
- outer `SELECT`: change `t.environment, t.branch, t.commit_sha, t.tool, t.simulation,` to `t.environment, t.branch, t.commit_sha, t.tool, t.simulation, t.run_number,`
- inner `SELECT`: change `r.environment, r.branch, r.commit_sha, r.tool, r.simulation,` to `r.environment, r.branch, r.commit_sha, r.tool, r.simulation, r.run_number,`

`StoredTrendRun`, after `readonly simulation: string | null;`:

```ts
  /** The run's number within its test, or null (run-number.ts). */
  readonly runNumber: number | null;
```

`packages/persistence/src/metrics/read.ts`, in `trends()`'s `rows.map`, after `simulation: r.simulation,`:

```ts
        runNumber: r.run_number,
```

- [ ] **Step 6: The API**

`apps/api/src/runs/runs.service.ts`, in `toResponse`, directly after `test: run.test,`:

```ts
      runNumber: run.runNumber,
```

`apps/api/src/runs/runs.controller.ts`:
- `toListItem`, after `test: r.test,`: `runNumber: r.runNumber,`
- the 202 body, directly after its `test: run.test,` entry:

```ts
        // THE LIVE HALF of the run number: a live run is numbered at its
        // header and read through THIS body while it streams, so a number
        // sent only by toResponse would be missing exactly then.
        runNumber: run.runNumber,
```

`apps/api/src/metrics/metrics.controller.ts`, in the trends `runs.map`, after the `simulation:` entry of each row (keep NAMED, not spread): `runNumber: r.runNumber,`

`apps/api/src/tests/tests.controller.ts`, in `latestRun`'s object, after `verdict: …,`: `runNumber: row.latestRun.runNumber,`

- [ ] **Step 7: Build, typecheck, fix only what `tsc` names**

```bash
find packages/persistence -name '*.tsbuildinfo' -delete && pnpm --filter @perfportal/persistence build > /tmp/b.txt 2>&1; echo "persistence build exit=$?"
grep -c 'run_number\|runNumber' packages/persistence/dist/src/repositories/run.js packages/persistence/dist/src/metrics/trends.js
pnpm typecheck > /tmp/tc.txt 2>&1; echo "typecheck exit=$?"; grep -E 'error TS' /tmp/tc.txt | head -20
```

If `tsc` names a hand-built `RunRecord`, `TestRow` or `StoredTrendRun` in a test (likely `apps/api/test/verdict.integration.test.ts` or `packages/persistence/test/repositories.integration.test.ts`), add `runNumber: null` to that fixture and nothing else.

- [ ] **Step 8: Run to see it pass, plus the files these paths already had**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/run-number.integration.test.ts apps/api/test/read.integration.test.ts apps/api/test/trends.integration.test.ts apps/api/test/tests.integration.test.ts packages/persistence/test/repositories.integration.test.ts > /tmp/t5.txt 2>&1; echo "exit=$?"; grep -E 'Test Files|Tests ' /tmp/t5.txt
```

Expected: exit 0, zero failures; `run-number.integration.test.ts` 6 passed.

- [ ] **Step 9: Commit the checkpoint**

```bash
git add packages/persistence/src/repositories/run.ts packages/persistence/src/repositories/test.ts packages/persistence/src/metrics/trends.ts packages/persistence/src/metrics/read.ts apps/api/src/runs/runs.service.ts apps/api/src/runs/runs.controller.ts apps/api/src/metrics/metrics.controller.ts apps/api/src/tests/tests.controller.ts apps/api/test/run-number.integration.test.ts
# plus any test fixture tsc named in Step 7, by path
git commit -q -F - <<'MSG'
Report a run's number on every read that carries a run

GET /v1/runs/:id from both builders, the run list, trends rows, and a
test's latest run in the catalogue. The API test takes its numbers from
the real pipeline rather than writing them itself.
MSG
```

- [ ] **Step 10: Red-verify (restore after each; rebuild persistence after mutating it)**

1. `runs.service.ts`: delete `runNumber: run.runNumber,` from `toResponse` → the terminal-builder case fails alone.
2. `runs.controller.ts`: delete the 202 body's `runNumber: run.runNumber,` → the 202 case AND the null case fail, and nothing else: both read a RUNNING run, so both go through the 202 builder, and an absent field is `undefined`, not `null`. Record it as one claim (the 202 carries the field) at two values.
3. `run.ts` (persistence): delete `r.run_number AS "runNumber",` from the list SELECT → the list case fails alone.
4. `trends.ts`: remove `, r.run_number` from the inner SELECT → the trends case fails (with a SQL error on the outer `t.run_number`, which is the same claim).
5. `test.ts` (persistence): drop `runNumber: true` from `findBySlug` AND `listForProject` selects → the catalogue case fails alone.

---

### Task 6: One spelling on the web, and the chart labels built from it

**Files:**
- Create: `apps/web/src/runNumber.ts`
- Modify: `apps/web/src/charts/transforms/compare.ts` (add `runLabels` after `compareLabels`)
- Modify: `apps/web/src/charts/transforms/trends.ts` (`axisLabels`, line ~63; import line 2)
- Modify: `apps/web/src/routes/RunCompare.tsx` (`labels`, ~line 184; chip markup ~line 405-433)
- Create: `apps/web/test/runNumber.test.ts`
- Modify: `apps/web/test/transforms.trends.test.ts`
- Modify: `apps/web/test/RunCompare.test.tsx`

**Interfaces:**
- Consumes: `TrendRun.runNumber` (Task 4).
- Produces:
  - `runName(n: number): string` → `Run ${n}`; `runTag(n: number): string` → `#${n}` (in `apps/web/src/runNumber.ts`).
  - `runLabels(runs: readonly { id: string; at: string; runNumber?: number | null }[], form: 'name' | 'tag'): string[]` (in `compare.ts`): numbered runs → `runName`/`runTag`; numberless runs → `compareLabels` over the numberless ones alone.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/runNumber.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runLabels } from '../src/charts/transforms/compare';
import { runMinuteLabel } from '../src/charts/transforms/runLabel';
import { runName, runTag } from '../src/runNumber';

/**
 * ═══ ONE SPELLING OF A RUN'S NUMBER ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * `Run 12` where a run is NAMED, `#12` where it is a compact TAG — the two
 * forms Gatling Enterprise uses, and nowhere else spelled by hand.
 */
describe('a run number, spelled', () => {
  it('names a run "Run 12" and tags it "#12"', () => {
    expect(runName(12)).toBe('Run 12');
    expect(runTag(12)).toBe('#12');
  });

  /** Two runs of one minute, both numbered: a timestamp label would need an
   *  id suffix to tell them apart; the numbers already do. */
  it('labels numbered runs by number, even when their starts share a minute', () => {
    const at = '2026-08-07T11:00:00.000Z';
    expect(
      runLabels(
        [
          { id: 'aaaaaaaa-1', at, runNumber: 4 },
          { id: 'bbbbbbbb-2', at, runNumber: 5 },
        ],
        'name',
      ),
    ).toEqual(['Run 4', 'Run 5']);
    expect(runLabels([{ id: 'aaaaaaaa-1', at, runNumber: 4 }], 'tag')).toEqual(['#4']);
  });

  /** A run with no number keeps EXACTLY today's label — and the collision
   *  suffix is decided among the numberless runs alone, so a numbered run
   *  beside them never forces one. */
  it('keeps today’s minute label for a run with no number, suffixing only real collisions', () => {
    const at = '2026-08-07T11:00:00.000Z';
    const labels = runLabels(
      [
        { id: 'aaaaaaaa-1', at, runNumber: 4 },
        { id: 'cccccccc-3', at, runNumber: null },
        { id: 'dddddddd-4', at },
      ],
      'name',
    );
    expect(labels[0]).toBe('Run 4');
    expect(labels[1]).toBe(`${runMinuteLabel(at)} · cccccc`);
    expect(labels[2]).toBe(`${runMinuteLabel(at)} · dddddd`);

    const alone = runLabels([{ id: 'eeeeeeee-5', at, runNumber: null }, { id: 'ffffffff-6', at, runNumber: 9 }], 'tag');
    expect(alone).toEqual([runMinuteLabel(at), '#9']);
  });
});
```

`apps/web/test/transforms.trends.test.ts` — add inside the file's top-level `describe` that covers the axis (or at the end of the file in a new `describe('run numbers on the axis', …)`):

```ts
describe('run numbers on the axis', () => {
  /** Every run of one test numbered, all started in ONE minute: the axis and
   *  the data table's row headers read the numbers, so a timestamp-built label
   *  cannot pass. */
  it('tags a numbered cohort "#n" on the axis and in the table', () => {
    const at = '2026-08-07T11:00:00.000Z';
    const data = toStatusTrend(
      response([
        run({ id: 'c', startedAt: at, runNumber: 3 }),
        run({ id: 'b', startedAt: at, runNumber: 2 }),
        run({ id: 'a', startedAt: at, runNumber: 1 }),
      ]),
    );
    expect(data.axisLabels).toEqual(['#1', '#2', '#3']);
    expect(data.rows.map((r) => r.label)).toEqual(['#1', '#2', '#3']);
  });
});
```

(`toStatusTrend`, `run` and `response` are already in that file. The cohort is homogeneous, so no comparability spacer appears in `axisLabels`.)

`apps/web/test/RunCompare.test.tsx` — add inside `describe('RunCompare — the picker says which run each candidate is', …)`, following the neighbouring cases' use of `renderCompare`, `cohortRunAt`, `populated`, `OTHER` and `COMPLETE_RUN`:

```ts
  /** A numbered cohort: each chip is NAMED by its number, with the start time
   *  kept as its second line — Gatling Enterprise's picker reads the same. */
  it('names each numbered candidate "Run n", its start time beneath', async () => {
    renderCompare(
      { state: 'ready', run: COMPLETE_RUN },
      populated([
        cohortRunAt({ id: RUN_ID, runNumber: 2 }),
        cohortRunAt({ id: OTHER, runNumber: 1, toolStartedAt: '2026-08-14T09:30:00.000Z', startedAt: '2026-08-14T09:30:00.000Z' }),
      ]),
    );

    const chip = await screen.findByTestId(`compare-run-${OTHER}`);
    expect(chip).toHaveTextContent('Run 1');
    expect(chip).toHaveTextContent(runMinuteLabel('2026-08-14T09:30:00.000Z'));
    expect(chip.getAttribute('aria-label')).toMatch(/^Run 1 · /);
    expect(screen.getByTestId(`compare-run-${RUN_ID}`)).toHaveTextContent('Run 2');
  });
```

Add `import { runMinuteLabel } from '../src/charts/transforms/runLabel';` to that file if absent. If `renderCompare`'s first argument shape differs from `{ state: 'ready', run: COMPLETE_RUN }`, copy the first argument the neighbouring picker cases pass.

- [ ] **Step 2: Run to see them fail**

```bash
pnpm exec vitest run apps/web/test/runNumber.test.ts apps/web/test/transforms.trends.test.ts apps/web/test/RunCompare.test.tsx > /tmp/t6.txt 2>&1; echo "exit=$?"; grep -E '✓|×|Tests|Error' /tmp/t6.txt | tail -12
```

Expected: `runNumber.test.ts` fails to import; the trends and compare cases fail on timestamp labels.

- [ ] **Step 3: The spelling module**

`apps/web/src/runNumber.ts`:

```ts
/**
 * ═══ A RUN'S NUMBER, SPELLED IN ONE PLACE ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * The two forms Gatling Enterprise uses, measured on its own UI:
 *
 *   runName(12) -> "Run 12"   where a run is NAMED — a list row, a picker chip,
 *                             a chart series, a table column, a breadcrumb, a
 *                             document title, the baseline note
 *   runTag(12)  -> "#12"      where it is a compact TAG — the Trends axis
 *
 * GE spells its Compare series "Run #1" and its table column "Run 1"; here both
 * are "Run 12", because both are built from one label field and copying the
 * inconsistency buys nothing.
 *
 * A run with no number (no test, or an API pod that predates the field) keeps
 * EXACTLY the label it had before; see runLabels in charts/transforms/compare.
 */
export function runName(n: number): string {
  return `Run ${n}`;
}

export function runTag(n: number): string {
  return `#${n}`;
}
```

- [ ] **Step 4: `runLabels` in `compare.ts`**

Add `import { runName, runTag } from '../../runNumber';` to `apps/web/src/charts/transforms/compare.ts`, and after `compareLabels` (and its helper), add:

```ts
/**
 * A label per run: its NUMBER where it has one, and exactly `compareLabels`'
 * minute label where it does not.
 *
 * Numbers never collide within a test (a unique index says so), so a numbered
 * run needs no suffix. The numberless runs are passed to `compareLabels` as a
 * group of their own, so its collision suffix is decided among them alone —
 * and a minute label (`08-07 11:00`) can never equal `Run 12` or `#12`, so the
 * two populations cannot collide with each other either.
 */
export function runLabels(
  runs: readonly { id: string; at: string; runNumber?: number | null }[],
  form: 'name' | 'tag',
): string[] {
  const numberless = runs.flatMap((run, index) =>
    run.runNumber === null || run.runNumber === undefined ? [{ id: run.id, at: run.at, index }] : [],
  );
  const fallback = compareLabels(numberless);
  const fallbackAt = new Map(numberless.map((run, k) => [run.index, fallback[k]!]));
  return runs.map((run, index) =>
    run.runNumber === null || run.runNumber === undefined
      ? fallbackAt.get(index)!
      : form === 'name'
        ? runName(run.runNumber)
        : runTag(run.runNumber),
  );
}
```

- [ ] **Step 5: The Trends axis**

`apps/web/src/charts/transforms/trends.ts`: change the import `import { compareLabels } from './compare';` to `import { runLabels } from './compare';`, and replace `axisLabels`' body:

```ts
function axisLabels(runs: readonly TrendRun[]): string[] {
  return runLabels(
    runs.map((run) => ({ id: run.id, at: run.toolStartedAt ?? run.startedAt, runNumber: run.runNumber })),
    'tag',
  );
}
```

Append to `axisLabels`' docstring:

```
 *
 * ═══ AND NOW BY NUMBER ═══ (spec 2026-09-27-run-number)
 *
 * A numbered run is tagged `#12`, the way Gatling Enterprise's own trends axis
 * reads, and needs no suffix; only numberless runs still take the minute
 * label and its collision rule, through `runLabels`.
```

- [ ] **Step 6: Compare's labels and chips**

`apps/web/src/routes/RunCompare.tsx`:
- Add `runLabels` to the existing import from `'../charts/transforms/compare'` (keep `compareLabels` only if still used elsewhere in the file; `lint` will say), and add `import { runMinuteLabel } from '../charts/transforms/runLabel';`.
- Replace the `labels` memo's `compareLabels(…)` call:

```ts
    const computed = runLabels(
      runs.map((run) => ({ id: run.id, at: run.toolStartedAt ?? run.startedAt, runNumber: run.runNumber })),
      'name',
    );
```

- In the chip (`data.runs.map((run) => { … })`), compute beside `mark`/`role`/`conditions`:

```ts
                      // A numbered chip is NAMED by its number; the start time
                      // it used to lead with becomes its second line, as in
                      // Gatling Enterprise's picker. A numberless chip keeps
                      // leading with its time, which IS its label.
                      const startedLine =
                        run.runNumber === null || run.runNumber === undefined
                          ? null
                          : runMinuteLabel(run.toolStartedAt ?? run.startedAt);
```

- `aria-label`: `[labelFor(run.id), startedLine, mark.label, role, conditions]` (the existing `.filter` already drops `null` and `''`).
- Directly after the chip's first `<span className="flex items-center gap-1.5 whitespace-nowrap">…</span>` and before the `conditions` span:

```tsx
                          {startedLine !== null && (
                            <span className="text-[0.6875rem] font-normal tabular-nums">
                              {startedLine}
                            </span>
                          )}
```

- Update the chip's `═══ WHAT A READER IS CHOOSING BETWEEN (review.md 17) ═══` comment: its sentence "The time stays the primary line, because it is what `labelFor` also names the series and the matrix columns by" becomes "The LABEL stays the primary line, because it is what `labelFor` also names the series and the matrix columns by — the run's number once it has one (spec 2026-09-27-run-number), else its time."

- [ ] **Step 7: Run to see them pass**

```bash
pnpm exec vitest run apps/web/test/runNumber.test.ts apps/web/test/transforms.trends.test.ts apps/web/test/transforms.compare.test.ts apps/web/test/RunCompare.test.tsx > /tmp/t6.txt 2>&1; echo "exit=$?"; grep -E 'Test Files|Tests ' /tmp/t6.txt
```

Expected: exit 0, zero failures.

- [ ] **Step 8: Commit the checkpoint**

```bash
git add apps/web/src/runNumber.ts apps/web/src/charts/transforms/compare.ts apps/web/src/charts/transforms/trends.ts apps/web/src/routes/RunCompare.tsx apps/web/test/runNumber.test.ts apps/web/test/transforms.trends.test.ts apps/web/test/RunCompare.test.tsx
git commit -q -F - <<'MSG'
Label runs by number on Compare and the Trends axis

One module spells it (Run 12 / #12); runLabels gives a numbered run its
number and a numberless one exactly today's minute label, with the
collision suffix decided among the numberless alone. Compare chips lead
with the number and keep the start time as a second line.
MSG
```

- [ ] **Step 9: Red-verify (restore after each)**

1. `runNumber.ts`: `` `Run ${n}` `` → `` `Run #${n}` `` → the spelling case fails, and the compare case (on `Run 1`) — both assert the one spelling; record that.
2. `compare.ts` `runLabels`: replace the whole body with `return compareLabels(runs);` → the two runLabels cases fail and the trends and compare cases fail (all assert "numbered runs are labelled by number").
3. `compare.ts` `runLabels`: pass `runs` instead of `numberless` to `compareLabels` (i.e. `const fallback = compareLabels(runs)` and index `fallback[index]`) → the "suffixing only real collisions" case fails alone (the numbered run now forces a suffix on `alone`'s first label).
4. `RunCompare.tsx`: delete the `{startedLine !== null && (…)}` block → the compare case fails alone, on the start time.

---

### Task 7: The identity surfaces

**Files:**
- Modify: `apps/web/src/routes/RunHeader.tsx` (breadcrumb current rung, ~line 367)
- Modify: `apps/web/src/routes/RunShell.tsx` (`useDocumentTitle`, ~line 110)
- Modify: `apps/web/src/routes/RunList.tsx` (`RunRow` identity ~line 1498; `RunCard` `label` ~line 1312)
- Modify: `apps/web/src/routes/RunStats.tsx` (`BaselineNote`, ~line 424)
- Modify: `apps/web/src/routes/ProjectTests.tsx` (last-run cell, ~line 232)
- Modify: `apps/web/test/RunHeader.test.tsx`, `RunShell.test.tsx`, `RunList.test.tsx`, `RunList.compact.test.tsx`, `RunStats.test.tsx`, `ProjectTests.test.tsx` (one case each)

**Interfaces:**
- Consumes: `runName` (Task 6); `runNumber` on `RunIdentity`, run-list items, `TrendRun`, `TestSummary.latestRun` (Task 4).

- [ ] **Step 1: Write the six failing cases**

`RunHeader.test.tsx` (uses `RUN`, `renderHeader`; `RUN` has `test` unset — give it one):

```ts
  /** The breadcrumb's current rung names WHICH run of the test this is — by
   *  its number now, "Run 12", where it used to show an 8-character id. */
  it('ends the breadcrumb at the run’s number when it has one', () => {
    renderHeader({
      ...RUN,
      test: { id: TEST_ID, slug: 'checkout-smoke', name: 'Checkout smoke' },
      runNumber: 12,
    });
    const crumb = screen.getByTestId('run-crumb');
    expect(crumb).toHaveTextContent('Run 12');
    expect(crumb).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('a66548b7')).toBeNull();
  });
```

`RunShell.test.tsx`:

```ts
  /** Two tabs on two runs of one test used to read alike (both the
   *  simulation). A numbered run's tab names the test and the run. */
  it('titles the document with the test and the run’s number', () => {
    renderShellWith({
      identity: { ...RUN, test: { id: '33333333-3333-4333-8333-333333333333', slug: 'checkout-smoke', name: 'Checkout smoke' }, runNumber: 12 },
    });
    expect(document.title).toBe('Checkout smoke · Run 12 · PerfPortal');
  });
```

`RunList.test.tsx` (next to `'identifies a test’s runs by id, keeping the link the row depends on'`):

```ts
  /** A numbered run on its test's list is named by its number; the link's
   *  accessible name still carries the WHOLE id, and the copy button still
   *  copies it. */
  it('names a test’s numbered runs "Run n", keeping the whole id in the link’s name', async () => {
    renderList(
      [{ ...ROWS[0]!, runNumber: 12 }, ROWS[1]!],
      '/projects/checkout/tests/parity',
      { projectSlug: 'checkout', testSlug: 'parity' },
    );
    const numbered = await screen.findByRole('link', {
      name: 'View run 11111111-1111-4111-8111-111111111111',
    });
    expect(numbered).toHaveTextContent(/^Run 12$/);
    // The numberless row keeps today's id prefix.
    expect(
      screen.getByRole('link', { name: 'View run 33333333-3333-4333-8333-333333333333' }),
    ).toHaveTextContent('33333333');
  });
```

`RunList.compact.test.tsx` — first give `renderList` a third parameter and pass it through: change the signature to `function renderList(items = ROWS, initialEntry = '/runs', props: { projectSlug?: string; testSlug?: string } = {})` and `<RunList />` to `<RunList {...props} />`. Then:

```ts
  it('names a test’s numbered run "Run n" on its card too', async () => {
    renderList(
      [{ ...ROWS[0]!, runNumber: 12 }, ROWS[1]!] as unknown as RunListResponse['items'],
      '/projects/checkout/tests/parity',
      { projectSlug: 'checkout', testSlug: 'parity' },
    );
    expect(
      await screen.findByRole('link', { name: 'View run 11111111-1111-4111-8111-111111111111' }),
    ).toHaveTextContent(/^Run 12$/);
  });
```

`RunStats.test.tsx` (uses `renderStats`, `RunStats`, `stats`, `trendRun`):

```ts
  it('names the baseline by its number, with when it started', () => {
    renderStats(
      <RunStats
        stats={stats}
        current={trendRun({ runNumber: 12 })}
        baseline={trendRun({ id: '22222222-2222-4222-8222-222222222222', runNumber: 11 })}
      />,
    );
    const note = screen.getByTestId('baseline-note');
    expect(note).toHaveTextContent(/“vs previous” is Run 11 \(started /);
    expect(screen.getByRole('link', { name: /^Run 11 \(started / })).toHaveAttribute(
      'href',
      '/runs/22222222-2222-4222-8222-222222222222',
    );
  });
```

`ProjectTests.test.tsx` (uses `stubFetch`, `renderPage`, `CHECKOUT_SMOKE`):

```ts
  it('names the latest run by its number beside its badges', async () => {
    stubFetch({
      tests: { tests: [{ ...CHECKOUT_SMOKE, latestRun: { ...CHECKOUT_SMOKE.latestRun!, runNumber: 12 } }] },
    });
    renderPage();
    const link = await screen.findByRole('link', { name: 'View the latest run of Checkout smoke' });
    expect(link).toHaveTextContent('Run 12');
  });
```

(If the tests endpoint body key in `stubFetch` calls elsewhere in the file is not `{ tests: [...] }`, copy the shape those calls use.)

- [ ] **Step 2: Run to see all six fail**

```bash
pnpm exec vitest run apps/web/test/RunHeader.test.tsx apps/web/test/RunShell.test.tsx apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx apps/web/test/RunStats.test.tsx apps/web/test/ProjectTests.test.tsx > /tmp/t7.txt 2>&1; echo "exit=$?"; grep -E '×' /tmp/t7.txt | head
```

Expected: exactly the six new cases fail.

- [ ] **Step 3: The breadcrumb**

`RunHeader.tsx`: `import { runName } from '../runNumber';`. Replace the current-rung `<code aria-current="page" className="text-[0.75rem]">{identity.id.slice(0, 8)}</code>` with:

```tsx
          {identity.runNumber !== null && identity.runNumber !== undefined ? (
            <span data-testid="run-crumb" aria-current="page" className="text-[0.75rem] font-medium">
              {runName(identity.runNumber)}
            </span>
          ) : (
            <code data-testid="run-crumb" aria-current="page" className="text-[0.75rem]">
              {identity.id.slice(0, 8)}
            </code>
          )}
```

Update the comment above it: "THE RUN'S NUMBER, or its short id when it has none — load-bearing rather than decorative: the `<h1>` names the TEST, so two runs of one test are told apart on this page by this rung alone."

- [ ] **Step 4: The document title**

`RunShell.tsx`: `import { runName } from '../runNumber';`. Replace the `useDocumentTitle(…)` call and rewrite the stale comment above it (the heading has named the TEST since review.md 6, not the simulation):

```ts
  // A numbered run's tab names its test and its number — two tabs on two runs
  // of one test used to read alike, both titled with the simulation. A run
  // with no number keeps the title it always had: the simulation, else its
  // short id.
  useDocumentTitle(
    identity.runNumber !== null && identity.runNumber !== undefined && identity.test
      ? `${identity.test.name} · ${runName(identity.runNumber)}`
      : (identity.simulation ?? `Run ${identity.id.slice(0, 8)}`),
  );
```

- [ ] **Step 5: The test's run list — row and card**

`RunList.tsx`: `import { runName } from '../runNumber';`.

`RunRow`: replace the link's child expression with:

```tsx
            {identifyByRunId && run.runNumber !== null && run.runNumber !== undefined ? (
              runName(run.runNumber)
            ) : identifyByRunId || run.simulation === null || run.simulation === undefined ? (
              <code className="text-[0.75rem]">{run.id.slice(0, 8)}</code>
            ) : (
              run.simulation
            )}
```

and extend its comment: "On a test's list a NUMBERED run is named by its number — `Run 12`, spec 2026-09-27-run-number — which is what tells runs of one test apart once they have one."

`RunCard`: replace the `label` expression with:

```ts
  const label =
    identifyByRunId && run.runNumber !== null && run.runNumber !== undefined
      ? runName(run.runNumber)
      : identifyByRunId || run.simulation === null || run.simulation === undefined
        ? run.id.slice(0, 8)
        : run.simulation;
```

- [ ] **Step 6: The baseline note**

`RunStats.tsx`: `import { runName } from '../runNumber';`. Replace the link text expression:

```tsx
          {previous.runNumber !== null && previous.runNumber !== undefined
            ? `${runName(previous.runNumber)} (started ${formatInstant(previous.toolStartedAt ?? previous.startedAt)})`
            : `the run of ${formatInstant(previous.toolStartedAt ?? previous.startedAt)}`}
```

- [ ] **Step 7: The tests catalogue**

`ProjectTests.tsx`: `import { runName } from '../runNumber';`. Inside the latest-run `<Link>`, before the first `<Badge`:

```tsx
            {test.latestRun.runNumber !== null && test.latestRun.runNumber !== undefined && (
              <span className="text-[0.8125rem] font-medium text-accent">
                {runName(test.latestRun.runNumber)}
              </span>
            )}
```

- [ ] **Step 8: Run to see them pass, whole files green**

```bash
pnpm exec vitest run apps/web/test/RunHeader.test.tsx apps/web/test/RunShell.test.tsx apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx apps/web/test/RunStats.test.tsx apps/web/test/ProjectTests.test.tsx > /tmp/t7.txt 2>&1; echo "exit=$?"; grep -E 'Test Files|Tests ' /tmp/t7.txt
```

Expected: exit 0, zero failures.

- [ ] **Step 9: Commit the checkpoint**

```bash
git add apps/web/src/routes/RunHeader.tsx apps/web/src/routes/RunShell.tsx apps/web/src/routes/RunList.tsx apps/web/src/routes/RunStats.tsx apps/web/src/routes/ProjectTests.tsx apps/web/test/RunHeader.test.tsx apps/web/test/RunShell.test.tsx apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx apps/web/test/RunStats.test.tsx apps/web/test/ProjectTests.test.tsx
git commit -q -F - <<'MSG'
Name a run by its number where it is named within its test

The run page's breadcrumb and tab title, a test's run list (row and card),
the baseline note, and the tests catalogue's latest run. A run without a
number keeps exactly the label it had.
MSG
```

- [ ] **Step 10: Red-verify (restore after each)**

1. `RunHeader.tsx`: make the condition `false &&` → the breadcrumb case fails alone.
2. `RunShell.tsx`: make the title condition `false &&` → the title case fails alone.
3. `RunList.tsx` `RunRow`: `identifyByRunId && run.runNumber` → `false && run.runNumber` → the row case fails alone.
4. `RunList.tsx` `RunCard`: same edit on `label` → the card case fails alone.
5. `RunStats.tsx`: condition `false &&` → the baseline case fails alone.
6. `ProjectTests.tsx`: condition `false &&` → the catalogue case fails alone.

---

### Task 8: The browser

**Files:**
- Modify: `apps/web/e2e/fixtures.ts` (`seedTestWithRuns`, ~line 1075)
- Modify: `apps/web/e2e/copy-ids.spec.ts` (~line 52-61)
- Create: `apps/web/e2e/run-number.spec.ts`

**Interfaces:**
- Consumes: everything above; `seedAdmin`, `seedRunWithData` (runs processed by the real in-process pipeline, so they are numbered by the real writer).

- [ ] **Step 1: Make `seedTestWithRuns` describe data the product can hold**

A run with a test and no number is now impossible data (spec: the invariant). In `seedTestWithRuns`, create the test with `nextRunNumber: opts.runs + 1`, and give each run `runNumber: opts.runs - i` — the fixture's runs are newest first (`startedAt = base - i * 60_000`), and arrival numbering gives the OLDEST the lowest number. Add to its docstring: "Numbered as if the runs arrived oldest first, the arrival rule applied to seeded history (spec 2026-09-27-run-number)."

- [ ] **Step 2: Move `copy-ids.spec.ts` with the label**

Replace its comment `// A TEST'S OWN RUN LIST shows an 8-character prefix, which no endpoint` / `// accepts — so this is the list where copying the display would be wrong.` with:

```ts
  // A TEST'S OWN RUN LIST names each run by its number — "Run 2" — which no
  // endpoint accepts, so this is the list where copying the display would be
  // wrong.
```

and replace

```ts
  await expect(runRow.getByRole('link', { name: `View run ${id}`, exact: true })).toHaveText(
    id!.slice(0, 8),
  );
```

with

```ts
  await expect(runRow.getByRole('link', { name: `View run ${id}`, exact: true })).toHaveText(
    /^Run \d+$/,
  );
```

The clipboard assertion below it (`expect.poll(readClipboard).toBe(id)`) is unchanged, and it is what still proves the button copies more than the row shows.

- [ ] **Step 3: Write the new spec**

`apps/web/e2e/run-number.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { projectTestPath, runComparePath, runPath, runTrendsPath } from '../src/routes/paths.js';

/**
 * ═══ A TEST'S RUNS, NAMED BY NUMBER, ON EVERY SURFACE THAT NAMES THEM ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * WHAT ONLY THIS LAYER CAN PROVE. Every unit case hands a component a
 * `runNumber` of its own making. Here the two runs are ingested and PROCESSED
 * by the real pipeline (`seedRunWithData`), so the numbers on screen are the
 * ones the worker assigned — the seam between the writer and five surfaces.
 *
 * The reference bundle names `example.ParitySimulation`, which the worker
 * files under an auto-created test slugged `example-paritysimulation` and
 * NAMED after the class. Both runs start at the same instant (one bundle), so
 * a timestamp label could not tell them apart; the numbers do.
 */
test('two runs of one test read Run 1 and Run 2 on the list, the run page, Compare and Trends', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const first = await seedRunWithData(admin.orgId);
  const second = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // The test's own list: named by number, the link still naming the WHOLE id.
  await page.goto(projectTestPath('checkout', 'example-paritysimulation'));
  await expect(page.getByRole('link', { name: `View run ${first}`, exact: true })).toHaveText('Run 1');
  await expect(page.getByRole('link', { name: `View run ${second}`, exact: true })).toHaveText('Run 2');

  // The run page: the breadcrumb's current rung, and the tab title.
  await page.goto(runPath(second));
  await expect(page.getByTestId('run-crumb')).toHaveText('Run 2');
  await expect(page).toHaveTitle('example.ParitySimulation · Run 2 · PerfPortal');

  // Compare: the picker's chips, and the overlay's two series.
  await page.goto(runComparePath(second));
  await expect(page.getByTestId(`compare-run-${first}`)).toContainText('Run 1');
  await expect(page.getByTestId(`compare-run-${second}`)).toContainText('Run 2');
  const overlay = page.getByTestId('chart-compare-overlay');
  await expect(plot(overlay)).toHaveCount(1);
  const series = overlay.locator('svg text[text-anchor="start"]');
  await expect(series).toHaveCount(2);
  expect((await series.allTextContents()).sort()).toEqual(['Run 1', 'Run 2']);

  // Trends: the axis's own data table, whose row headers are the axis labels.
  await page.goto(runTrendsPath(second));
  const rowHeads = page.getByTestId('chart-data-trend-status').locator('tbody th[scope="row"]');
  await expect(rowHeads).toHaveCount(2);
  expect((await rowHeads.allTextContents()).sort()).toEqual(['#1', '#2']);
});
```

- [ ] **Step 4: Build the web app's dependencies and run the two specs**

```bash
pnpm build > /tmp/b.txt 2>&1; echo "build exit=$?"
pnpm test:e2e apps/web/e2e/run-number.spec.ts apps/web/e2e/copy-ids.spec.ts > /tmp/t8.txt 2>&1; echo "exit=$?"; grep -E 'passed|failed|flaky|Running' /tmp/t8.txt | tail -5
```

Expected: `Running 3 tests`, 3 passed. If a failure's error context shows "PerfPortal is not answering", read `vm_stat` and re-run once before believing it (CLAUDE.md).

- [ ] **Step 5: Commit the checkpoint**

```bash
git add apps/web/e2e/fixtures.ts apps/web/e2e/copy-ids.spec.ts apps/web/e2e/run-number.spec.ts
git commit -q -F - <<'MSG'
Prove in a browser that the worker's numbers reach every surface

Two runs processed by the real pipeline read Run 1 and Run 2 on their
test's list, the run page's breadcrumb and title, Compare's chips and
series, and the Trends axis. seedTestWithRuns now numbers its runs, since
a run with a test and no number is data the product can no longer hold.
MSG
```

- [ ] **Step 6: Red-verify (restore after each; `pnpm build` is NOT needed — the e2e web server builds the app)**

1. `apps/web/src/runNumber.ts`: `runName` returns `` `Run ${n}.` `` → the new spec fails on its FIRST assertion (the list). Record that it fails there, and that `copy-ids.spec.ts` fails too (its `/^Run \d+$/`).
2. `apps/worker/src/pipeline/pipeline.service.ts`: delete the `numberRunForTest` line → the new spec fails on the list (the rows fall back to id prefixes): the seam no unit case can see.

---

### Task 9: Measure, gate, record, publish

This task is the controller's, not an implementer's.

- [ ] **Step 1: Tally the floors from the source before any suite runs**

Unit (vitest unit config; `.ts` and `.tsx`): +2 files (`packages/contracts/test/run-number.test.ts` 4, `apps/web/test/runNumber.test.ts` 3) and +1 case each in `transforms.trends.test.ts`, `RunCompare.test.tsx`, `RunHeader.test.tsx`, `RunShell.test.tsx`, `RunList.test.tsx`, `RunList.compact.test.tsx`, `RunStats.test.tsx`, `ProjectTests.test.tsx` → **174 / 2232**.

Integration (every `.ts` test file; no `.tsx`): the two new unit `.ts` files (4 + 3) and the trends case (1), plus `packages/persistence/test/run-number.integration.test.ts` (2), `apps/worker/test/run-number.integration.test.ts` (8 + 1), `apps/api/test/run-number.integration.test.ts` (6), and 1 case in `fold-owner.integration.test.ts` → +5 files, +26 tests → **159 / 1985**.

e2e: +1 (`run-number.spec.ts`) → **166**.

Recount with `grep -c "^\s*it(" <file>` on each file above; if any differs from this plan, correct the prediction BEFORE running and say why.

- [ ] **Step 2: Geometry, on a real run, before and after**

Measure at 375x812 (the run page's first total vs `mobile.spec.ts`'s 812 fold, and the breadcrumb height) and at 768/1024 (a test's run list's p95/Errors right edges), on `main` and on this branch, with a throwaway spec deleted afterwards. Expected: no movement — `Run 12` is narrower than the prefix it replaces, and the breadcrumb is one line either way. Record the numbers.

- [ ] **Step 3: Real Gatling runs**

Per `verify-with-real-gatling-runs` memory: against the developer database (migrated with this branch's migration first), run a Gradle-plugin live run and an on-prem runner run. Check: the live run shows `Run N` in its breadcrumb WHILE streaming; both end numbered; an existing test's older runs read back in creation order after the migration's backfill (`SELECT run_number, created_at FROM run WHERE test_id = … ORDER BY run_number`).

- [ ] **Step 4: The five gates, in order, by their own exit codes, on the scratch stack**

```bash
pnpm typecheck > /tmp/g-tc.txt 2>&1; echo "typecheck exit=$?"
pnpm lint > /tmp/g-lint.txt 2>&1; echo "lint exit=$?"
pnpm test:unit > /tmp/g-unit.txt 2>&1; echo "unit exit=$?"; grep -E 'Test Files|Tests |Errors' /tmp/g-unit.txt
pnpm test:integration > /tmp/g-int.txt 2>&1; echo "integration exit=$?"; grep -E 'Test Files|Tests ' /tmp/g-int.txt
pnpm test:e2e > /tmp/g-e2e.txt 2>&1; echo "e2e exit=$?"; grep -E 'Running|passed|failed|flaky' /tmp/g-e2e.txt | tail -4
```

Behind the load gate (1-min < 8 and 5-min < 10), with `vm_stat`, swap and `docker ps` checked, and nothing else on the scratch stack. A failure is isolated and re-run before it is believed; a loaded run that passes is a pass.

- [ ] **Step 5: CLAUDE.md entry, PR**

Add the entry at the top of the floor history (above the newest existing entry), update the headline floor sentence to the measured unit numbers, and record: the GE measurement; arrival order and why; the counter and the lock order; each red-verify and what failed; the geometry numbers; the real runs; what was run. Commit with `git commit -F -`, push, open one PR to `main`, bind it with the `ccd_pr` tools, and do NOT merge until the user says so.
