# Run Lifecycle Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the run's journey through PerfPortal — Queued, Load test, Received, Processing, Verdict, as each path has them — on the run page as a strip with a Step times disclosure, grouped under the run header, while the decision band gives up its Execution row.

**Architecture:** Three optional `RunIdentity` fields publish stamps PerfPortal already stores; both identity builders (the terminal `RunsService.toResponse` and the hand-written 202 in `respondWithRun`) send them from one helper. A pure web module (`lifecycle.ts`) turns an identity into ordered steps; `RunLifecycle.tsx` draws them; the verdict word moves into `decision.ts` so the band and the strip share one function.

**Tech Stack:** zod contracts, NestJS + Prisma (API), React + Tailwind v4 (web), vitest (node, jsdom, integration), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md`

## Global Constraints

- **Node from `.nvmrc` (22)**: `source ~/.nvm/nvm.sh && nvm use` before any test. On Node 20 the jsdom project fails to LOAD and still prints a green summary.
- **Floors before this branch (main 77f5807):** unit **166 files / 2135 tests**, integration **149 / 1900**, e2e **156**.
- **Three new identity fields, all `.nullable().optional()`**: `parsingStartedAt`, `streamUpdatedAt`, `queuedAt` (ISO datetimes). NOT `streamAbandonedAt` — see the spec's "Not added".
- **Both identity builders send all three**, NAMED in each object literal (never spread), from one helper, `RunsService.lifecycleOf`.
- **Nothing is derived server-side.** Steps are derived in `apps/web/src/routes/lifecycle.ts`.
- **The strip:** `<section aria-label="Run lifecycle" data-testid="run-lifecycle">`, an `<ol>`, **no heading**; each step's state as words plus a glyph (`Marked`, glyph `aria-hidden`), never colour alone; durations via `formatDuration`; Step times is a `<details>` whose `<summary>` holds no list; times of day via `formatClockTime`, the date and zone once in the table caption.
- **The Verdict step reads `Verdict: <word>`**, the word from the band's own function (`decision.ts`).
- **The decision band drops its Execution row**; its two sentences' tests are re-pointed at the strip, never silently deleted.
- **Compact (below 768 px, `useIsCompact`):** ONE bare line — the furthest step reached, no verdict step, "Step times" beside it — grouped 8 px under the header. Desktop: a card grouped 12 px under the header. Both are chosen by the `compact` prop, never by a Tailwind `md:` variant (CLAUDE.md, review M02: one decision, one breakpoint).
- **Measured fold budget (this branch's base):** 375x812 — first run total at **y=802** against `mobile.spec.ts`'s 812 bound; the Execution row is 18 px plus a 4 px gap. 1440x900 — first total at **y=733** against `run-tables.spec.ts`'s 900. Expected after: ~804 and ~769. Never move a bound to fit.
- **Styling:** type sizes in rem (`text-[0.75rem]`), never `text-[Npx]`; no `[var(--…)]` utilities; status colours through `Marked`'s inline style.
- **No conditional spread of an object literal** (`...(c ? { … } : {})`) — the repo's eslint rule.
- **Zone-pinned tests** set `TZ=Asia/Kolkata` and assert the flip took (`new Date('2026-08-15T00:00:00Z').getHours() === 5`) before anything else; every such file also passes under `TZ=UTC`.
- **Workspace packages resolve through `dist`.** After changing `packages/contracts` or `packages/persistence` source, rebuild it (`find <pkg> -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm --filter <name> exec tsc -b --force`) and grep the emitted `.js` for the change before running anything that imports it.
- **Red-verify every new or re-pointed test.** Commit a checkpoint BEFORE the first mutation. Apply each mutation with a count assertion (`perl -0pi -e '$n = s/…/…/g; die "expected 1, got $n\n" unless $n == 1' <file>`), run, confirm the NAMED case fails for the named reason, restore with `git checkout HEAD -- <file>`, and finish with `git status --short` showing only the three pre-existing untracked paths. A mutation reporting `Tests no tests` stopped the file loading and proves nothing — redo it well-formed. A mutation of package source needs the rebuild above before the run means anything.
- **Git:** branch `feat/run-lifecycle-strip`; never `git add -A` — name every path (`docs/ui-review-2026-09-13/`, `review.md`, `scripts/seed-manual-test.mjs` stay untracked). Commit with `git commit -F - <<'MSG'`.
- **Every task ends with** `pnpm typecheck` and `pnpm lint`, each read by its OWN exit code (`pnpm typecheck > "$SCRATCH/tc.txt" 2>&1; echo "exit=$?"`), never through a pipe. `$SCRATCH` is a directory outside the repo (e.g. the session scratchpad).
- **Integration and e2e run against a scratch database and a scratch Redis index**, never the developer database `perfportal`, which holds nine real Gatling runs.

## File map

| File | Responsibility |
|---|---|
| `packages/contracts/src/run.ts` | the three optional identity fields |
| `packages/contracts/test/run-lifecycle.test.ts` (new) | their parse and back-compat |
| `packages/persistence/src/repositories/run.ts` | `RunRecord` carries `parsingStartedAt` and `streamUpdatedAt` (row mapping, list SQL) |
| `apps/api/src/runs/runs.service.ts` | `lifecycleOf(run)`; `toResponse` names the fields |
| `apps/api/src/runs/runs.controller.ts` | the 202 names them too |
| `apps/api/test/lifecycle.integration.test.ts` (new) | both builders, through the real API |
| `apps/api/test/verdict.integration.test.ts` | its hand-built `RunRecord` gains the two stamps |
| `apps/web/src/routes/decision.ts` (new) | `Decision`, `decisionOf`, `decisionWord`, `releaseWord` — moved out of the band |
| `apps/web/src/routes/lifecycle.ts` (new) | identity → ordered steps (pure) |
| `apps/web/test/lifecycle.test.ts` (new) | the derivation |
| `apps/web/src/routes/RunLifecycle.tsx` (new) | the strip and Step times |
| `apps/web/test/RunLifecycle.test.tsx` (new) | its semantics and the phone variant |
| `apps/web/src/routes/RunDecisionBand.tsx` | uses `decision.ts`; drops the Execution row and `executionText` |
| `apps/web/test/RunDecisionBand.test.tsx` | the two Execution cases become one "no Execution row" case |
| `apps/web/src/routes/RunShell.tsx` | groups the header and the strip, above the band |
| `apps/web/test/RunShell.test.tsx` | mount order; agreement with the Duration chip and the band word |
| `apps/web/e2e/run-lifecycle.spec.ts` (new) | the strip in a browser |
| `apps/web/e2e/run-list.spec.ts`, `apps/web/e2e/mobile.spec.ts` | Execution assertions re-pointed |
| `CLAUDE.md` | floors and the entry |

---

### Task 1: The three identity fields

**Files:**
- Modify: `packages/contracts/src/run.ts` (the end of `RunIdentitySchema`, after `toolStartedAt`)
- Test: `packages/contracts/test/run-lifecycle.test.ts` (new)

**Interfaces:**
- Produces: `RunIdentity['parsingStartedAt' | 'streamUpdatedAt' | 'queuedAt']`, each `string | null | undefined`. `RunResponseSchema` (extends) and `RunProcessingSchema` (the 202, `RunIdentitySchema.partial()`) inherit them.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/run-lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RunIdentitySchema, RunProcessingSchema } from '../src/index.js';

/**
 * ═══ THE RUN'S LIFECYCLE STAMPS ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Stamps PerfPortal already stores, published for the run page's lifecycle
 * strip. OPTIONAL as well as nullable: the browser drops a body that fails
 * the schema, so a required field would blank the run page for every
 * response from an API pod that predates it.
 */
const MINIMAL = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-19T16:39:56.406Z',
};

describe('RunIdentity — the lifecycle stamps', () => {
  it('still parses an identity without them — the rolling-deploy guarantee', () => {
    const parsed = RunIdentitySchema.parse(MINIMAL);
    expect(parsed.parsingStartedAt).toBeUndefined();
    expect(parsed.streamUpdatedAt).toBeUndefined();
    expect(parsed.queuedAt).toBeUndefined();
  });

  it('carries all three, and null for any the row has not stamped', () => {
    const parsed = RunIdentitySchema.parse({
      ...MINIMAL,
      parsingStartedAt: '2026-09-19T16:41:46.000Z',
      streamUpdatedAt: null,
      queuedAt: '2026-09-19T16:39:15.000Z',
    });
    expect(parsed.parsingStartedAt).toBe('2026-09-19T16:41:46.000Z');
    expect(parsed.streamUpdatedAt).toBeNull();
    expect(parsed.queuedAt).toBe('2026-09-19T16:39:15.000Z');
  });

  it('refuses a stamp that is not an instant', () => {
    expect(() => RunIdentitySchema.parse({ ...MINIMAL, queuedAt: 'yesterday' })).toThrow();
  });

  it('reaches the 202 body, which is what a live run is read through', () => {
    const parsed = RunProcessingSchema.parse({
      ...MINIMAL,
      status: 'running',
      statusUrl: `/v1/runs/${MINIMAL.id}`,
      streamUpdatedAt: '2026-09-19T16:40:38.000Z',
    });
    expect(parsed.streamUpdatedAt).toBe('2026-09-19T16:40:38.000Z');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/contracts/test/run-lifecycle.test.ts`
Expected: FAIL — "carries all three" and "reaches the 202" (zod STRIPS unknown keys, so the values come back `undefined`) and "refuses a stamp" (an unknown key is not validated). The first case passes: it is the back-compat guard.

- [ ] **Step 3: Add the fields**

In `packages/contracts/src/run.ts`, replace:

```ts
  toolStartedAt: z.string().datetime().nullable().optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
```

with:

```ts
  toolStartedAt: z.string().datetime().nullable().optional(),
  /*
   * ═══ THE RUN'S LIFECYCLE, AS POSTGRES RECORDED IT ═══
   * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
   *
   * Stamps PerfPortal has always kept and this contract never published. The
   * run page's lifecycle strip derives its steps from them, with `startedAt`
   * (received) and `ingestedAt` (processing ended).
   *
   * OPTIONAL AS WELL AS NULLABLE: the browser drops any body that fails this
   * schema, so a required field would blank the run page for every response
   * from an API pod that predates it — the argument `activityMs` makes.
   */
  /** When processing began: a worker picking up an upload
   *  (`RunRepository.markParsing`), a stream closing (`claimForClose`), or the
   *  sweeper taking over an abandoned stream. */
  parsingStartedAt: z.string().datetime().nullable().optional(),
  /** The last chunk a live stream accepted (`advanceOffset`). Null for an
   *  upload, and for a stream that has accepted nothing yet. */
  streamUpdatedAt: z.string().datetime().nullable().optional(),
  /** When the on-prem runner job that produced this run was queued. Null for
   *  a run the runner did not produce. */
  queuedAt: z.string().datetime().nullable().optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run packages/contracts/test/run-lifecycle.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Rebuild the package and prove the emitted file has the fields**

```bash
find packages/contracts -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
pnpm --filter @perfportal/contracts exec tsc -b --force
grep -c "queuedAt" packages/contracts/dist/src/run.js
```
Expected: a count ≥ 1.

- [ ] **Step 6: Checkpoint, red-verify, typecheck, lint, commit**

Commit a checkpoint (`git add packages/contracts/src/run.ts packages/contracts/test/run-lifecycle.test.ts`), then three mutations, each restored with `git checkout HEAD -- packages/contracts/src/run.ts`:
1. Delete the `queuedAt:` field line → "carries all three" fails (`expected undefined to be '2026-09-19T16:39:15.000Z'`) and "refuses" fails.
2. Drop `.optional()` from `parsingStartedAt` → "still parses an identity without them" fails (`invalid_type`).
3. Replace `queuedAt: z.string().datetime()` with `queuedAt: z.string()` → "refuses a stamp that is not an instant" fails alone.

Rebuild (Step 5) after restoring. Then `pnpm typecheck` and `pnpm lint` by their own exit codes, and amend the checkpoint into:

```bash
git commit --amend -F - <<'MSG'
Publish the run's lifecycle stamps on its identity

Three optional fields PerfPortal has always kept: when processing began, a
stream's last accepted chunk, and when the on-prem runner job was queued.
Optional as well as nullable, so an older API pod's body still parses and
the run page cannot blank mid-deploy.
MSG
```

---

### Task 2: Both identity builders send them

**Files:**
- Modify: `packages/persistence/src/repositories/run.ts` (`RunRecord` ~line 59, `RunRow` ~line 149, `toRecord` ~line 184, the list SQL ~line 932, the `liveState` docstring ~line 597)
- Modify: `apps/api/src/runs/runs.service.ts` (new `lifecycleOf`; `toResponse`)
- Modify: `apps/api/src/runs/runs.controller.ts` (the 202 in `respondWithRun`, ~line 200)
- Modify: `apps/api/test/verdict.integration.test.ts` (the `RunRecord` literal, ~line 227)
- Test: `apps/api/test/lifecycle.integration.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's fields.
- Produces: `RunRecord.parsingStartedAt: Date | null`, `RunRecord.streamUpdatedAt: Date | null`; `RunsService.lifecycleOf(run: RunRecord): Promise<{ parsingStartedAt: string | null; streamUpdatedAt: string | null; queuedAt: string | null }>`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/lifecycle.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ THE LIFECYCLE STAMPS, THROUGH BOTH IDENTITY BUILDERS ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * `GET /v1/runs/{id}` has two builders: `RunsService.toResponse` for a
 * finished run, and the hand-written 202 in `respondWithRun` for a pending,
 * parsing or running one. A field reaching only the first is missing exactly
 * while a run is live — the defect CLAUDE.md records for `warmupMs`. So each
 * stamp is read through the real API on the builder that run's shape gets.
 */
const LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

function read(runId: string) {
  return request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}`)
    .set('Authorization', `Bearer ${ctx.readToken}`);
}

async function openLive(): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs/live')
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .send({ tool: 'gatling' });
  expect(res.status).toBe(201);
  return res.body.runId as string;
}

async function streamFirstChunk(runId: string): Promise<void> {
  const res = await request(ctx.app.getHttpServer())
    .post(`/v1/runs/${runId}/stream`)
    .set('Authorization', `Bearer ${ctx.streamToken}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Stream-Offset', '0')
    .send(readFileSync(LOG).subarray(0, 64 * 1024));
  expect(res.status).toBe(202);
}

describe('the lifecycle stamps, on both identity builders', () => {
  it('a streaming run carries its last chunk on the 202, and nothing about processing yet', async () => {
    ctx = await createTestApp();
    const runId = await openLive();

    const before = await read(runId);
    expect(before.status).toBe(202);
    expect(before.body.streamUpdatedAt).toBeNull();

    await streamFirstChunk(runId);
    const after = await read(runId);
    expect(after.status).toBe(202);
    expect(after.body.streamUpdatedAt).toMatch(ISO);
    expect(after.body.parsingStartedAt).toBeNull();
    expect(after.body.queuedAt).toBeNull();
  });

  it('a stream being closed carries when processing began, still on the 202', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    await streamFirstChunk(runId);
    expect(await new RunRepository(ctx.prisma).claimForClose(runId)).toBe(true);

    const res = await read(runId);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('parsing');
    expect(res.body.parsingStartedAt).toMatch(ISO);
  });

  it('a finished upload carries its processing span, and no stream', async () => {
    ctx = await createTestApp();
    const posted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', bundle, 'bundle.tgz');
    expect(posted.status).toBe(202);
    const runId = posted.body.id as string;
    await runPipelineFor(ctx, runId);

    const res = await read(runId);
    expect(res.status).toBe(200);
    expect(res.body.parsingStartedAt).toMatch(ISO);
    expect(res.body.ingestedAt).toMatch(ISO);
    expect(Date.parse(res.body.parsingStartedAt)).toBeLessThanOrEqual(Date.parse(res.body.ingestedAt));
    expect(res.body.streamUpdatedAt).toBeNull();
    expect(res.body.queuedAt).toBeNull();
  });

  it('an incomplete stream keeps its last chunk on the finished body', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    await streamFirstChunk(runId);
    await ctx.prisma.run.update({
      where: { id: runId },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });

    const res = await read(runId);
    expect(res.status).toBe(200);
    expect(res.body.streamUpdatedAt).toMatch(ISO);
    expect(res.body.parsingStartedAt).toBeNull();
  });

  it('a runner’s run carries when its job was queued, live and once finished', async () => {
    ctx = await createTestApp();
    const runId = await openLive();
    const artifact = await ctx.prisma.runnerArtifact.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        name: 'lifecycle',
        filename: 'bundle.tgz',
        kind: 'gatling_bundle',
        simulationClass: 'example.ParitySimulation',
        sha256: '0'.repeat(64),
        bytes: BigInt(1),
        storagePath: 'lifecycle/none',
      },
    });
    const queuedAt = new Date(Date.now() - 41_000);
    await ctx.prisma.runnerJob.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        artifactId: artifact.id,
        runId,
        status: 'running',
        requestedBy: 'lifecycle-test',
        createdAt: queuedAt,
      },
    });

    const live = await read(runId);
    expect(live.status).toBe(202);
    expect(live.body.queuedAt).toBe(queuedAt.toISOString());

    await ctx.prisma.run.update({
      where: { id: runId },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });
    const done = await read(runId);
    expect(done.status).toBe(200);
    expect(done.body.queuedAt).toBe(queuedAt.toISOString());
  });
});
```

- [ ] **Step 2: Bring up the scratch stack and run it to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use
docker exec infra-postgres-1 psql -U perfportal -d perfportal -c 'DROP DATABASE IF EXISTS perfportal_lifecycle' -c 'CREATE DATABASE perfportal_lifecycle'
docker exec infra-redis-1 redis-cli -n 10 FLUSHDB
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal_lifecycle
export REDIS_URL=redis://localhost:6380/10
export S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
pnpm --filter @perfportal/persistence run migrate:deploy
pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/lifecycle.integration.test.ts
```
Expected: FAIL — every stamp assertion reads `undefined` (neither builder sends them yet).

- [ ] **Step 3: Carry the two run-row stamps on `RunRecord`**

In `packages/persistence/src/repositories/run.ts`:

In `export interface RunRecord`, after `  ingestedAt: Date | null;` add:

```ts
  /** When processing began: `markParsing` for an upload, `claimForClose` for
   *  a stream, or the sweeper taking over an abandoned one. */
  parsingStartedAt: Date | null;
  /** The last chunk a stream accepted (`advanceOffset`). Null for an upload. */
  streamUpdatedAt: Date | null;
```

In `interface RunRow`, after `  ingestedAt: Date | null;` add:

```ts
  parsingStartedAt: Date | null;
  streamUpdatedAt: Date | null;
```

(Prisma's `findById`/`findByIdUnscoped` rows already carry every scalar column, so those reads need no change.)

In `toRecord`, after `    ingestedAt: row.ingestedAt,` add:

```ts
    parsingStartedAt: row.parsingStartedAt,
    streamUpdatedAt: row.streamUpdatedAt,
```

In the list SQL, replace

```ts
        r.ingested_at AS "ingestedAt", r.engine_options AS "engineOptions", r.error,
```

with

```ts
        r.ingested_at AS "ingestedAt", r.engine_options AS "engineOptions", r.error,
        r.parsing_started_at AS "parsingStartedAt", r.stream_updated_at AS "streamUpdatedAt",
```

(The list does not publish them; `fromSqlRow` builds a real `RunRecord`, and one carrying `undefined` where the type promises `Date | null` would be a lie about the row. No backticks in that template literal — CLAUDE.md.)

In the `liveState` docstring, replace `not part of RunRecord (no existing reader needs stream_offset, so it was never added to that shape; see toRecord()/RunRow above)` with `stream_offset is not part of RunRecord (no reader outside this pair needs it; stream_updated_at is, for the run page's lifecycle strip)`.

Rebuild and prove it:

```bash
find packages/persistence -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
pnpm --filter @perfportal/persistence exec tsc -b --force
grep -c "streamUpdatedAt" packages/persistence/dist/src/repositories/run.js
```
Expected: a count ≥ 2.

- [ ] **Step 4: One helper, and the finished body names the fields**

In `apps/api/src/runs/runs.service.ts`, add to `RunsService`, directly after `statusFor`:

```ts
  /**
   * The run's lifecycle stamps, for BOTH identity builders — `toResponse`
   * below and the 202 in `respondWithRun` — so the two cannot send different
   * sets. Two come off the RunRecord; `queuedAt` is one indexed lookup
   * (`runner_job_run_id_idx`) for the runner job that produced the run, if
   * any. A run has at most one: a retry makes a new job AND a new run.
   */
  async lifecycleOf(run: RunRecord): Promise<{
    parsingStartedAt: string | null;
    streamUpdatedAt: string | null;
    queuedAt: string | null;
  }> {
    const job = await this.prisma.runnerJob.findFirst({
      where: { runId: run.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());
    return {
      parsingStartedAt: iso(run.parsingStartedAt),
      streamUpdatedAt: iso(run.streamUpdatedAt),
      queuedAt: iso(job?.createdAt ?? null),
    };
  }
```

In `toResponse`, directly after the `assertions` query (`}) as RunAssertionRow[];`) add:

```ts
    const lifecycle = await this.lifecycleOf(run);
```

and after `      ingestedAt: run.ingestedAt ? run.ingestedAt.toISOString() : null,` add — NAMED, never spread (a spread hides a mistyped key from the excess-property check, CLAUDE.md):

```ts
      parsingStartedAt: lifecycle.parsingStartedAt,
      streamUpdatedAt: lifecycle.streamUpdatedAt,
      queuedAt: lifecycle.queuedAt,
```

- [ ] **Step 5: The 202 sends them too**

In `apps/api/src/runs/runs.controller.ts`, in `respondWithRun`, replace:

```ts
  if (status === 202) {
    // IDENTITY, NOT MEASUREMENTS. Every field here is already on the
    // RunRecord this function was handed — `project` is joined (see
    // RunRecord's own comment on why the worker pays that indexed join), so
    // the wider body costs no additional query. That is the whole reason this
    // is a widened 202 rather than a full `toResponse` at every status:
    // toResponse runs runAssertion.findMany and the isWindowable EXISTS, which
    // a poller would pay for every five seconds, per watcher, per live run.
    res
```

with:

```ts
  if (status === 202) {
    // IDENTITY, NOT MEASUREMENTS. Every field here is on the RunRecord this
    // function was handed — `project` is joined (see RunRecord's own comment
    // on why the worker pays that indexed join) — except `queuedAt`, which is
    // ONE indexed runner-job lookup (`lifecycleOf`). That is the whole reason
    // this is a widened 202 rather than a full `toResponse` at every status:
    // toResponse runs runAssertion.findMany and the isWindowable EXISTS, which
    // a poller would pay for every five seconds, per watcher, per live run.
    const lifecycle = await runs.lifecycleOf(run);
    res
```

and after `        toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,` (inside that same `.json({ … })`) add:

```ts
        // THE LIVE HALF of the lifecycle strip: a streaming run is read
        // through THIS body, so a stamp sent only by `toResponse` would be
        // missing exactly while a reader watches the run (CLAUDE.md, warmupMs).
        parsingStartedAt: lifecycle.parsingStartedAt,
        streamUpdatedAt: lifecycle.streamUpdatedAt,
        queuedAt: lifecycle.queuedAt,
```

- [ ] **Step 6: Fix the hand-built record typecheck names**

Run `pnpm typecheck > "$SCRATCH/tc.txt" 2>&1; echo "exit=$?"`. Expected: an error for `apps/api/test/verdict.integration.test.ts`'s `const run: RunRecord = {` (missing `parsingStartedAt`, `streamUpdatedAt`). In that literal replace `ingestedAt: new Date(), engineOptions: {}, toolAssertions: null,` with `ingestedAt: new Date(), engineOptions: {}, toolAssertions: null, parsingStartedAt: null, streamUpdatedAt: null,`. Fix any other literal the same way; re-run until exit 0.

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/lifecycle.integration.test.ts apps/api/test/verdict.integration.test.ts apps/api/test/read.integration.test.ts apps/api/test/openapi.integration.test.ts`
Expected: PASS. (`openapi.integration.test.ts` re-validates documented responses, which now carry the fields; `read.integration.test.ts` exercises the list SQL.)

- [ ] **Step 8: Checkpoint, red-verify, lint, commit**

Commit a checkpoint naming every changed path, then three mutations, each restored from HEAD (all in `apps/api/src`, which the suite compiles directly — no rebuild needed):
1. Delete the three lifecycle lines from the 202 builder → the streaming, closing and runner-live assertions fail; the upload and incomplete cases pass.
2. Delete the three lines from `toResponse` → the upload, incomplete and runner-finished assertions fail; the streaming and closing cases pass.
3. Make `lifecycleOf` return `queuedAt: null` → only the runner case fails.

Then `pnpm typecheck` and `pnpm lint` by their own exit codes, and amend the checkpoint into:

```bash
git commit --amend -F - <<'MSG'
Send the lifecycle stamps from both identity builders

GET /v1/runs/{id} builds a finished run in RunsService.toResponse and a
pending, parsing or running one in the hand-written 202; both now name the
three stamps from one helper, lifecycleOf, so a live run is never missing
them. RunRecord carries the two run-row stamps (the list SQL selects them so
a listed record is not a lie); queuedAt is one indexed runner-job lookup.
MSG
```

---

### Task 3: The verdict word in one place, and the steps as a pure function

**Files:**
- Create: `apps/web/src/routes/decision.ts`
- Modify: `apps/web/src/routes/RunDecisionBand.tsx` (`type Decision` ~line 27, `decisionWord` ~line 454, the `const decision` line ~line 108, the contracts import line 3)
- Create: `apps/web/src/routes/lifecycle.ts`
- Test: `apps/web/test/lifecycle.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's fields on `RunIdentity` (rebuilt `dist`).
- Produces:
  - `decision.ts`: `type Decision = RunVerdict | 'none' | 'unevaluated'`; `decisionOf(verdict: RunVerdict | null | undefined): Decision`; `decisionWord(decision: Decision, counts: AssertionCounts, unconfigured: boolean): string`; `releaseWord(verdict: RunVerdict | null | undefined, assertions: readonly Assertion[] | undefined): string`.
  - `lifecycle.ts`: `type StepName = 'queued' | 'load-test' | 'received' | 'processing' | 'verdict'`; `type StepState = 'done' | 'active' | 'pending' | 'stopped' | 'failed'`; `STEP_LABEL: Record<StepName, string>`; `interface LifecycleStep { name: StepName; text: string; state: StepState; startMs: number | null; endMs: number | null; durationMs: number | null; note: string | null; verdict?: RunVerdict | null }`; `interface LifecycleInput { identity: Partial<RunIdentity>; status: RunResponse['status']; verdict: RunResponse['verdict'] | undefined; assertions: readonly Assertion[] | undefined }`; `lifecycleSteps(input: LifecycleInput): LifecycleStep[]`.

- [ ] **Step 1: Move the verdict word out of the band**

Create `apps/web/src/routes/decision.ts`:

```ts
import type { Assertion, RunVerdict } from '@perfportal/contracts';
import { countAssertions, type AssertionCounts } from './assertions';

/**
 * ═══ THE RELEASE VERDICT'S WORD, IN ONE PLACE ═══
 *
 * Moved out of `RunDecisionBand` when the run lifecycle strip gained a Verdict
 * step (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md): the
 * strip and the band now say one verdict with one function, so they cannot
 * describe it in two vocabularies — the "one page, two vocabularies" defect
 * this repo has fixed repeatedly.
 *
 * `unevaluated` is `undefined`: the verdict has not been reported yet. `none`
 * is `null`: the run finished with no verdict at all. Different facts.
 */
export type Decision = RunVerdict | 'none' | 'unevaluated';

export function decisionOf(verdict: RunVerdict | null | undefined): Decision {
  return verdict === undefined ? 'unevaluated' : (verdict ?? 'none');
}
```

MOVE the band's `decisionWord` — its docstring and body verbatim — from `RunDecisionBand.tsx` to the end of this file, changing only `function decisionWord(` to `export function decisionWord(`. Then append:

```ts
/**
 * The word for a run, from what the band itself reads. `unconfigured` is keyed
 * on the ARRAY, not on "judged": an absent list is a run whose assertions have
 * not been reported, and "Not configured" would be a claim about a project we
 * have not heard from (the band's own reasoning, moved with it).
 */
export function releaseWord(
  verdict: RunVerdict | null | undefined,
  assertions: readonly Assertion[] | undefined,
): string {
  const unconfigured = assertions !== undefined && assertions.length === 0;
  return decisionWord(decisionOf(verdict), countAssertions(assertions ?? []), unconfigured);
}
```

In `RunDecisionBand.tsx`:
- delete `type Decision = RunVerdict | 'none' | 'unevaluated';` and the moved `decisionWord`;
- add `import { decisionOf, decisionWord, type Decision } from './decision';` after the `./assertions` import;
- change line 3 to `import type { Assertion, RunIdentity, RunResponse } from '@perfportal/contracts';` (`RunVerdict` was only used by the moved type);
- replace `  const decision: Decision = verdict === undefined ? 'unevaluated' : (verdict ?? 'none');` with `  const decision: Decision = decisionOf(verdict);`.

Run: `pnpm exec vitest run apps/web/test/RunDecisionBand.test.tsx` — expected PASS, unchanged (a pure move).

- [ ] **Step 2: Write the failing derivation tests**

Create `apps/web/test/lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '@perfportal/contracts';
import { lifecycleSteps, type LifecycleInput, type StepName } from '../src/routes/lifecycle';
import { releaseWord } from '../src/routes/decision';
import { formatDuration } from '../src/routes/format';

/**
 * ═══ THE RUN'S JOURNEY, DERIVED ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Times follow a real run (b01d731e, 108.5 s) where a real one fits; the
 * states are the ones each path can reach. Cases that print a time of day pin
 * Asia/Kolkata and assert the pin took — this machine's own zone IS
 * Asia/Kolkata, so a pin that silently failed would still pass here.
 */
const T = Date.parse('2026-09-19T16:39:56.406Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function input(
  identity: Partial<RunIdentity>,
  status: LifecycleInput['status'],
  verdict: LifecycleInput['verdict'] = null,
  assertions: LifecycleInput['assertions'] = [],
): LifecycleInput {
  return { identity, status, verdict, assertions };
}
const names = (i: LifecycleInput): StepName[] => lifecycleSteps(i).map((s) => s.name);
const step = (i: LifecycleInput, name: StepName) => lifecycleSteps(i).find((s) => s.name === name)!;

async function inKolkata(body: () => void): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

const FINISHED_RUNNER = input(
  {
    queuedAt: iso(T - 41_000),
    startedAt: iso(T),
    toolStartedAt: iso(T + 1_000),
    activityMs: 107_701,
    durationMs: 108_532,
    streamUpdatedAt: iso(T + 109_000),
    parsingStartedAt: iso(T + 110_000),
    ingestedAt: iso(T + 112_000),
  },
  'complete',
  'failed',
);

describe('lifecycleSteps — the steps a path has', () => {
  it('walks a runner run from its queue', () => {
    expect(names(FINISHED_RUNNER)).toEqual(['queued', 'load-test', 'processing', 'verdict']);
    expect(step(FINISHED_RUNNER, 'queued')).toMatchObject({ state: 'done', text: 'Queued · 41s', durationMs: 41_000 });
  });

  it('starts a live stream at its load test', () => {
    const live = input({ startedAt: iso(T), streamUpdatedAt: iso(T + 60_000) }, 'complete', 'passed');
    expect(names(live)).toEqual(['load-test', 'processing', 'verdict']);
  });

  it('puts an upload’s arrival after its load test', () => {
    const upload = input({ startedAt: iso(T + 600_000), toolStartedAt: iso(T), activityMs: 62_136 }, 'complete');
    expect(names(upload)).toEqual(['load-test', 'received', 'processing', 'verdict']);
  });

  /** Only a stream can end incomplete, so the status decides a row with no
   *  stamps — the e2e suite's seeded incomplete run is exactly that. */
  it('treats an incomplete run as streamed even when no stamp says so', () => {
    expect(names(input({ startedAt: iso(T) }, 'incomplete', 'not_evaluated'))).toEqual([
      'load-test',
      'processing',
      'verdict',
    ]);
  });
});

describe('lifecycleSteps — each state says what it is', () => {
  it('counts a streaming load test to its last chunk, and leaves the rest pending', () => {
    const streaming = input({ startedAt: iso(T), streamUpdatedAt: iso(T + 42_000) }, 'running', undefined, undefined);
    expect(step(streaming, 'load-test')).toMatchObject({
      state: 'active',
      text: 'Load test · streaming · 42s',
      endMs: null,
    });
    expect(step(streaming, 'processing').state).toBe('pending');
    expect(step(streaming, 'verdict')).toMatchObject({ state: 'pending', text: 'Verdict' });
  });

  /** The load test stopped at the producer's last sign of life. The sweeper
   *  gave up five minutes later; counting that silence as load would be a
   *  claim nobody measured. */
  it('ends an unprocessed incomplete stream at its last chunk, with nothing retained', () => {
    const quiet = input(
      { startedAt: iso(T), streamUpdatedAt: iso(T + 30_000), ingestedAt: iso(T + 330_500) },
      'incomplete',
      'not_evaluated',
    );
    expect(step(quiet, 'load-test')).toMatchObject({
      state: 'stopped',
      endMs: T + 30_000,
      durationMs: 30_000,
      text: 'Load test stopped early · 30s',
    });
    expect(step(quiet, 'processing')).toMatchObject({ state: 'stopped', text: 'Nothing retained' });
  });

  it('ends a processed incomplete stream where its own log says the test ended', () => {
    const processed = input(
      {
        startedAt: iso(T),
        toolStartedAt: iso(T + 1_000),
        activityMs: 36_028,
        durationMs: 36_500,
        streamUpdatedAt: iso(T + 37_500),
        parsingStartedAt: iso(T + 337_500),
        ingestedAt: iso(T + 339_500),
      },
      'incomplete',
      'not_evaluated',
    );
    expect(step(processed, 'load-test')).toMatchObject({
      state: 'stopped',
      endMs: T + 1_000 + 36_028,
      durationMs: 36_028,
      text: 'Load test stopped early · 36s',
    });
    expect(step(processed, 'processing')).toMatchObject({ state: 'done', text: 'Processed · 2s' });
  });

  /** The sweeper began processing, and its assembly found nothing decodable:
   *  the run was finalized with no statistics, so no span was ever measured. */
  it('says nothing was retained when processing began and measured nothing', () => {
    const empty = input(
      {
        startedAt: iso(T),
        streamUpdatedAt: iso(T + 30_000),
        parsingStartedAt: iso(T + 330_000),
        ingestedAt: iso(T + 331_000),
      },
      'incomplete',
      'not_evaluated',
    );
    expect(step(empty, 'processing')).toMatchObject({ state: 'stopped', text: 'Nothing retained' });
  });

  it('says an upload nobody has picked up is waiting for a worker, since it arrived', async () => {
    await inKolkata(() => {
      const waiting = input({ startedAt: '2026-08-14T10:43:49.546Z' }, 'pending', undefined, undefined);
      expect(step(waiting, 'processing')).toMatchObject({
        state: 'active',
        text: 'Waiting for a worker since 16:13:49',
      });
      expect(step(waiting, 'load-test')).toMatchObject({ state: 'pending', text: 'Load test · known once processed' });
      expect(step(waiting, 'received').state).toBe('done');
    });
  });

  it('says since when a run has been processing', async () => {
    await inKolkata(() => {
      const parsing = input(
        { startedAt: '2026-08-14T10:43:49.546Z', parsingStartedAt: '2026-08-14T10:43:50.000Z' },
        'parsing',
        undefined,
        undefined,
      );
      expect(step(parsing, 'processing')).toMatchObject({ state: 'active', text: 'Processing since 16:13:50' });
    });
  });

  it('notes how long after the test an upload arrived', () => {
    const upload = input(
      {
        startedAt: '2026-08-14T10:43:49.546Z',
        toolStartedAt: '2026-08-07T05:30:02.171Z',
        activityMs: 62_136,
      },
      'complete',
    );
    const gap = Date.parse('2026-08-14T10:43:49.546Z') - (Date.parse('2026-08-07T05:30:02.171Z') + 62_136);
    expect(step(upload, 'received')).toMatchObject({
      text: 'Received',
      note: `${formatDuration(gap)} after the test ended`,
    });
  });

  it('shows no duration for a skewed pair rather than a negative one', () => {
    const skewed = input(
      { startedAt: iso(T), parsingStartedAt: iso(T + 5_000), ingestedAt: iso(T + 4_000) },
      'complete',
    );
    expect(step(skewed, 'processing')).toMatchObject({ durationMs: null, text: 'Processed' });
  });

  /** Unreachable on the page today — the API answers a failed run with the
   *  ingest problem instead of an identity — and kept so the day it is
   *  reachable it says the right thing rather than "stopped early". */
  it('defensively reads a failed run as processing failed', () => {
    const failed = input({ startedAt: iso(T) }, 'failed', null, undefined);
    expect(step(failed, 'processing')).toMatchObject({ state: 'failed', text: 'Processing failed' });
    expect(step(failed, 'load-test').text).not.toMatch(/stopped early/);
  });
});

describe('lifecycleSteps — agreement with the rest of the page', () => {
  it('reads the band’s own word for every verdict', () => {
    for (const [verdict, assertions] of [
      ['passed', []],
      ['failed', []],
      ['not_evaluated', []],
      ['not_evaluated', undefined],
      [null, []],
    ] as const) {
      const judged = input({ startedAt: iso(T), streamUpdatedAt: iso(T + 1_000) }, 'complete', verdict, assertions);
      expect(step(judged, 'verdict')).toMatchObject({
        state: 'done',
        text: `Verdict: ${releaseWord(verdict, assertions)}`,
        verdict,
      });
    }
  });

  it('carries the run’s own span, the Duration chip’s `activityMs ?? durationMs`', () => {
    const both = input({ startedAt: iso(T), toolStartedAt: iso(T), activityMs: 62_136, durationMs: 63_161 }, 'complete');
    expect(step(both, 'load-test').durationMs).toBe(62_136);
    const legacy = input({ startedAt: iso(T), toolStartedAt: iso(T), durationMs: 63_161 }, 'complete');
    expect(step(legacy, 'load-test').durationMs).toBe(63_161);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run apps/web/test/lifecycle.test.ts`
Expected: FAIL — `Failed to resolve import "../src/routes/lifecycle"`.

- [ ] **Step 4: Write the derivation**

Create `apps/web/src/routes/lifecycle.ts`:

```ts
import type { Assertion, RunIdentity, RunResponse, RunVerdict } from '@perfportal/contracts';
import { releaseWord } from './decision';
import { formatClockTime, formatDuration } from './format';

/**
 * ═══ THE RUN'S JOURNEY, DERIVED FROM ITS OWN STAMPS ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Pure: an identity in, ordered steps out, the way `window.ts` holds the time
 * window's math. Every time comes from a stamp PerfPortal recorded; nothing is
 * estimated, and nothing reads a client clock — a live run's Load test
 * advances with each identity refresh, from its own last chunk.
 *
 * WHICH STEPS: a runner run is Queued ❯ Load test ❯ Processing ❯ Verdict; a
 * live stream starts at its Load test; an upload's test ran before PerfPortal
 * saw anything, so its Received step comes after the Load test.
 */

export type StepName = 'queued' | 'load-test' | 'received' | 'processing' | 'verdict';
export type StepState = 'done' | 'active' | 'pending' | 'stopped' | 'failed';

export const STEP_LABEL: Record<StepName, string> = {
  queued: 'Queued',
  'load-test': 'Load test',
  received: 'Received',
  processing: 'Processing',
  verdict: 'Verdict',
};

export interface LifecycleStep {
  readonly name: StepName;
  /** What the strip says for this step. */
  readonly text: string;
  readonly state: StepState;
  /** Epoch milliseconds, or null where nothing was stamped. */
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** How long it took, or null when a stamp is missing or the pair is skewed. */
  readonly durationMs: number | null;
  /** A second fact for the step's Step times row. */
  readonly note: string | null;
  /** The Verdict step only: which verdict its mark shows. */
  readonly verdict?: RunVerdict | null;
}

export interface LifecycleInput {
  readonly identity: Partial<RunIdentity>;
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly assertions: readonly Assertion[] | undefined;
}

function at(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** End minus start, or null — a pair out of order is two clocks disagreeing,
 *  and a negative duration would be a claim nobody measured. */
function between(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? end - start : null;
}

function withDuration(text: string, durationMs: number | null): string {
  return durationMs === null ? text : `${text} · ${formatDuration(durationMs)}`;
}

export function lifecycleSteps(input: LifecycleInput): LifecycleStep[] {
  const { identity, status, verdict, assertions } = input;
  const received = at(identity.startedAt);
  const toolStart = at(identity.toolStartedAt);
  // THE RUN'S OWN SPAN, the Duration chip's expression: one number under one word.
  const testSpan = identity.activityMs ?? identity.durationMs ?? null;
  const testEnd = toolStart !== null && testSpan !== null ? toolStart + testSpan : null;
  const parsing = at(identity.parsingStartedAt);
  const ingested = at(identity.ingestedAt);
  const lastChunk = at(identity.streamUpdatedAt);
  const queued = at(identity.queuedAt);

  const fromRunner = queued !== null;
  // ONLY A STREAM CAN END INCOMPLETE (the sweeper's `running` arm, or a close
  // with no bytes), so the status decides a row that carries no stamps.
  const streamed = fromRunner || status === 'running' || status === 'incomplete' || lastChunk !== null;

  const steps: LifecycleStep[] = [];

  if (fromRunner) {
    const durationMs = between(queued, received);
    steps.push({
      name: 'queued',
      text: withDuration('Queued', durationMs),
      state: 'done',
      startMs: queued,
      endMs: received,
      durationMs,
      note: null,
    });
  }

  if (streamed) {
    const startMs = toolStart ?? received;
    if (status === 'running') {
      const durationMs = between(received, lastChunk);
      steps.push({
        name: 'load-test',
        text: withDuration('Load test · streaming', durationMs),
        state: 'active',
        startMs,
        endMs: null,
        durationMs,
        note: null,
      });
    } else {
      // WHERE THE TEST ENDED: the processed log's own span when there is one,
      // else the last accepted chunk — the producer's last sign of life. Never
      // the sweeper's give-up, which would count the silence before it as load.
      const endMs = testEnd ?? lastChunk;
      const durationMs = testSpan ?? between(startMs, endMs);
      const stopped = status === 'incomplete';
      steps.push({
        name: 'load-test',
        text: withDuration(stopped ? 'Load test stopped early' : 'Load test', durationMs),
        state: stopped ? 'stopped' : 'done',
        startMs,
        endMs,
        durationMs,
        note: null,
      });
    }
  } else {
    steps.push(
      toolStart === null
        ? {
            name: 'load-test',
            text: 'Load test · known once processed',
            state: 'pending',
            startMs: null,
            endMs: null,
            durationMs: null,
            note: null,
          }
        : {
            name: 'load-test',
            text: withDuration('Load test', testSpan),
            state: 'done',
            startMs: toolStart,
            endMs: testEnd,
            durationMs: testSpan,
            note: null,
          },
    );
    const gap = between(testEnd, received);
    steps.push({
      name: 'received',
      text: 'Received',
      state: 'done',
      startMs: received,
      endMs: received,
      durationMs: null,
      note: gap === null ? null : `${formatDuration(gap)} after the test ended`,
    });
  }

  steps.push(processingStep(status, received, parsing, ingested, testSpan !== null));

  const judged = status === 'complete' || status === 'incomplete';
  steps.push(
    judged
      ? {
          name: 'verdict',
          text: `Verdict: ${releaseWord(verdict, assertions)}`,
          state: 'done',
          startMs: ingested,
          endMs: ingested,
          durationMs: null,
          note: null,
          verdict: verdict ?? null,
        }
      : {
          name: 'verdict',
          text: 'Verdict',
          state: 'pending',
          startMs: null,
          endMs: null,
          durationMs: null,
          note: null,
        },
  );

  return steps;
}

function processingStep(
  status: RunResponse['status'],
  received: number | null,
  parsing: number | null,
  ingested: number | null,
  /** Whether processing measured a span, i.e. the log became statistics. */
  measured: boolean,
): LifecycleStep {
  const base = { name: 'processing' as const, note: null };
  if (status === 'failed') {
    // UNREACHABLE ON THE PAGE TODAY: `GET /v1/runs/{id}` answers a failed run
    // with the ingest problem, which the page shows instead of the run shell.
    // Kept so that, if an identity ever arrives for one, it says "failed"
    // rather than claiming the stream stopped early.
    return {
      ...base,
      text: 'Processing failed',
      state: 'failed',
      startMs: parsing,
      endMs: ingested,
      durationMs: between(parsing, ingested),
    };
  }
  if (status === 'pending') {
    return {
      ...base,
      text: received === null ? 'Waiting for a worker' : `Waiting for a worker since ${formatClockTime(received)}`,
      state: 'active',
      startMs: received,
      endMs: null,
      durationMs: null,
    };
  }
  if (status === 'parsing') {
    return {
      ...base,
      text: parsing === null ? 'Processing' : `Processing since ${formatClockTime(parsing)}`,
      state: 'active',
      startMs: parsing,
      endMs: null,
      durationMs: null,
    };
  }
  if (status === 'running') {
    return { ...base, text: 'Processing', state: 'pending', startMs: null, endMs: null, durationMs: null };
  }
  if (status === 'incomplete' && (parsing === null || !measured)) {
    // NOTHING BECAME STATISTICS: nothing arrived to process (the sweeper
    // finalized the run in place, or a close carried no bytes), or the
    // sweeper's assembly found nothing decodable. The statistics table's own
    // words for it.
    return { ...base, text: 'Nothing retained', state: 'stopped', startMs: parsing, endMs: ingested, durationMs: null };
  }
  const durationMs = between(parsing, ingested);
  return {
    ...base,
    text: withDuration('Processed', durationMs),
    state: 'done',
    startMs: parsing,
    endMs: ingested,
    durationMs,
  };
}
```

(`...base` spreads a typed `const`, not a conditional object literal, so the eslint rule is not involved, and the literal keys beside it are still checked.)

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm exec vitest run apps/web/test/lifecycle.test.ts`, then `TZ=UTC pnpm exec vitest run apps/web/test/lifecycle.test.ts`
Expected: PASS both, 15 tests.

- [ ] **Step 6: Checkpoint, red-verify, typecheck, lint, commit**

Commit a checkpoint (name the four paths), then mutations, each restored from HEAD:
1. Drop `status === 'incomplete' || ` from `streamed` → only "treats an incomplete run as streamed" fails.
2. `const endMs = lastChunk ?? testEnd;` → "ends a processed incomplete stream where its own log says" fails (`endMs` T+37500 against T+37028).
3. `between` without `&& end >= start` → "shows no duration for a skewed pair" fails.
4. The Verdict step's text as `` `Verdict: ${verdict}` `` → "reads the band's own word for every verdict" fails.
5. `const testSpan = identity.durationMs ?? identity.activityMs ?? null;` → "carries the run's own span" fails.
6. In `processingStep`'s `pending` branch, `formatClockTime(Date.now())` for `formatClockTime(received)` → "waiting for a worker, since it arrived" fails.
7. `(parsing === null || !measured)` → `parsing === null` → only "says nothing was retained when processing began and measured nothing" fails.

Then `pnpm typecheck` and `pnpm lint` by their own exit codes, and amend the checkpoint into:

```bash
git commit --amend -F - <<'MSG'
Derive the run's lifecycle steps, and share the verdict word

lifecycle.ts turns a run identity into its ordered steps from PerfPortal's
own stamps: Queued for a runner run, the Load test (streaming, stopped early
at the producer's last sign of life, or known once processed), Received for
an upload, Processing, and the Verdict. The band's decisionWord moves to
decision.ts so the strip reads the same word.
MSG
```

---

### Task 4: The strip on the run page

**Files:**
- Create: `apps/web/src/routes/RunLifecycle.tsx`
- Test: `apps/web/test/RunLifecycle.test.tsx` (new)
- Modify: `apps/web/src/routes/RunShell.tsx` (imports; the `<RunHeader … />` block, ~lines 162-173)
- Modify: `apps/web/src/routes/RunDecisionBand.tsx` (the `<dl>` comment and Execution `Outcome` ~lines 312-316; `executionText` ~lines 492-497)
- Modify: `apps/web/test/RunDecisionBand.test.tsx` (the two Execution cases, ~lines 124-159)
- Modify: `apps/web/test/RunShell.test.tsx` (two cases added to `describe('RunShell'`)

**Interfaces:**
- Consumes: `lifecycleSteps`, `STEP_LABEL`, `LifecycleStep`, `StepState` (Task 3); `Marked`, `VERDICT`, `Mark` (`marks.tsx`: `Mark = { glyph; label; colour }`, `VERDICT: Record<RunVerdict | 'none', Mark>`); `formatClockTime`, `formatDuration`, `formatZoneOffset` (`format.ts`).
- Produces: `RunLifecycle({ steps: readonly LifecycleStep[]; compact: boolean })` (default export); test ids `run-lifecycle`, `lifecycle-<step name>`, `lifecycle-times`, `lifecycle-times-<step name>`.

- [ ] **Step 1: Write the failing component tests**

Create `apps/web/test/RunLifecycle.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RunLifecycle from '../src/routes/RunLifecycle';
import { lifecycleSteps } from '../src/routes/lifecycle';

afterEach(cleanup);

/**
 * ═══ THE LIFECYCLE STRIP ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * The derivation is `lifecycle.test.ts`'s; these pin how the strip SAYS it:
 * a named region, an ordered list, no heading (the Overview's outline is
 * asserted as an exact list, and shell chrome must not add to it), words and
 * a hidden glyph rather than colour alone, Step times outside the summary,
 * and the phone's one line.
 */
const UPLOAD = lifecycleSteps({
  identity: {
    startedAt: '2026-08-14T10:43:49.546Z',
    toolStartedAt: '2026-08-07T05:30:02.171Z',
    activityMs: 62_136,
    durationMs: 63_161,
    parsingStartedAt: '2026-08-14T10:43:50.000Z',
    ingestedAt: '2026-08-14T10:43:52.000Z',
  },
  status: 'complete',
  verdict: 'failed',
  assertions: [],
});

const STREAMING = lifecycleSteps({
  identity: { startedAt: '2026-09-19T16:39:56.406Z', streamUpdatedAt: '2026-09-19T16:40:38.406Z' },
  status: 'running',
  verdict: undefined,
  assertions: undefined,
});

function region() {
  return screen.getByRole('region', { name: 'Run lifecycle' });
}

function items() {
  return within(within(region()).getByRole('list')).getAllByRole('listitem');
}

async function inKolkata(body: () => void): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('RunLifecycle', () => {
  it('is a named region holding an ordered list, with no heading', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    expect(within(region()).getByRole('list').tagName).toBe('OL');
    expect(items()).toHaveLength(4);
    expect(within(region()).queryAllByRole('heading')).toHaveLength(0);
  });

  it('says each step in words, with its glyph hidden from a screen reader', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    expect(items().map((li) => li.textContent)).toEqual([
      expect.stringContaining('Load test · 62s'),
      expect.stringContaining('Received'),
      expect.stringContaining('Processed · 2s'),
      expect.stringContaining('Verdict: Failed'),
    ]);
    for (const li of items()) {
      expect(li.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('keeps the list outside the Step times disclosure', () => {
    render(<RunLifecycle steps={UPLOAD} compact={false} />);
    const list = within(region()).getByRole('list');
    const details = screen.getByTestId('lifecycle-times');
    expect(details.tagName).toBe('DETAILS');
    expect(details.contains(list)).toBe(false);
  });

  it('times every step to the second, with the zone once in the caption', async () => {
    await inKolkata(() => {
      render(<RunLifecycle steps={UPLOAD} compact={false} />);
      const details = screen.getByTestId('lifecycle-times');
      expect(details.querySelector('caption')?.textContent).toMatch(/GMT\+5:30/);
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('16:13:50');
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('16:13:52');
      expect(screen.getByTestId('lifecycle-times-received')).toHaveTextContent(/after the test ended/);
      // The load test ran a week before the bundle arrived: its row is on the
      // caption's day and carries no date; every later row carries its own.
      expect(screen.getByTestId('lifecycle-times-load-test')).not.toHaveTextContent('2026');
      expect(screen.getByTestId('lifecycle-times-processing')).toHaveTextContent('2026');
    });
  });

  /** One line on a phone, and not the verdict: the decision band's 36 px word
   *  sits directly below it, and review M02 removed exactly that kind of
   *  restatement from the phone. The fold had 10 px to spare. */
  it('shows only the furthest step reached on a phone', () => {
    render(<RunLifecycle steps={UPLOAD} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Processed · 2s');
    expect(within(region()).getByRole('list')).not.toHaveTextContent('Verdict:');
    expect(screen.getByTestId('lifecycle-times')).toBeInTheDocument();
  });

  it('shows a streaming load test on a phone while the run is live', () => {
    render(<RunLifecycle steps={STREAMING} compact />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveTextContent('Load test · streaming · 42s');
  });

  /** Was the decision band's Execution sentence; the strip says it now. */
  it('says an incomplete run’s load test stopped early, not that processing failed', () => {
    const steps = lifecycleSteps({
      identity: { startedAt: '2026-09-19T16:39:56.406Z' },
      status: 'incomplete',
      verdict: 'not_evaluated',
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact={false} />);
    expect(region()).toHaveTextContent(/stopped early/i);
    expect(region()).not.toHaveTextContent(/processing failed/i);
  });

  /** The other half of that pair, kept from the band: a failed run never
   *  says "stopped early". Defensive — see `lifecycle.ts`. */
  it('says a failed run’s processing failed, never that it stopped early', () => {
    const steps = lifecycleSteps({
      identity: { startedAt: '2026-09-19T16:39:56.406Z' },
      status: 'failed',
      verdict: null,
      assertions: undefined,
    });
    render(<RunLifecycle steps={steps} compact={false} />);
    expect(region()).toHaveTextContent(/processing failed/i);
    expect(region()).not.toHaveTextContent(/stopped early/i);
  });
});
```

(`items()` scopes to the `<ol>`: jsdom keeps a closed `<details>`'s table in the accessibility tree, and the verdict-absence check reads the list for the same reason — the Step times table legitimately names every step, the Verdict one included.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/web/test/RunLifecycle.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/routes/RunLifecycle"`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/routes/RunLifecycle.tsx`:

```tsx
import { formatClockTime, formatDuration, formatZoneOffset } from './format';
import { STEP_LABEL, type LifecycleStep, type StepState } from './lifecycle';
import { Marked, VERDICT, type Mark } from './marks';

/**
 * ═══ THE RUN'S JOURNEY, UNDER ITS NAME ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Gatling Enterprise opens a run with `Build successful ❯ Deployed · 14s ❯
 * Assertions failed · 2m 00s`; this is that shape with PerfPortal's own steps.
 *
 * NO HEADING. `RunShell` renders above the tab outlet, so anything here is on
 * every tab, and the Overview tab's heading outline is asserted as an exact
 * list. Named by `aria-label`, like `LiveStatusStrip` and the decision band.
 *
 * STEP TIMES SIT BESIDE THE LIST, NEVER INSIDE A `<summary>`: a summary's
 * contents are presentational to a screen reader, so a list there would lose
 * its list-ness. Times are absolute; the Offset/Datetime axis mode does not
 * touch them.
 *
 * ONE DECISION, ONE BREAKPOINT. `compact` (`useIsCompact`, below 768 px)
 * chooses both WHAT the strip says and HOW it is drawn, rather than a Tailwind
 * `md:` variant answering the second half on its own — review M02's rule that
 * a JS breakpoint and a CSS breakpoint describing one decision must be one
 * number. On a phone it is ONE bare line: the fold had 10 px to spare, and a
 * carded row would have pushed the run's own numbers off the first screen.
 */

/** A state's glyph and colour — the run list's own shapes (`marks.tsx`). */
const STATE_MARK: Record<StepState, Omit<Mark, 'label'>> = {
  done: { glyph: '●', colour: 'var(--color-status-passed)' },
  active: { glyph: '◐', colour: 'var(--color-status-pending)' },
  pending: { glyph: '○', colour: 'var(--color-status-not-applicable)' },
  stopped: { glyph: '◌', colour: 'var(--color-status-not-applicable)' },
  failed: { glyph: '✕', colour: 'var(--color-status-failed)' },
};

const FRAME =
  'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 rounded-xl border border-default bg-surface px-4 py-3 text-[0.8125rem]';
const COMPACT_FRAME = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[0.75rem] leading-4';

function markFor(step: LifecycleStep): Mark {
  // The Verdict step wears the verdict's own mark, as the run list does.
  if (step.name === 'verdict' && step.state !== 'pending') {
    const verdict = VERDICT[step.verdict ?? 'none'];
    return { glyph: verdict.glyph, colour: verdict.colour, label: step.text };
  }
  return { ...STATE_MARK[step.state], label: step.text };
}

/** On a phone, the furthest step reached — never the verdict, which is the
 *  decision band's 36 px word directly below. */
function furthestReached(steps: readonly LifecycleStep[]): LifecycleStep[] {
  const reached = steps.filter((s) => s.name !== 'verdict' && s.state !== 'pending');
  const furthest = reached[reached.length - 1] ?? steps[0];
  return furthest === undefined ? [] : [furthest];
}

/** A calendar day in the reader's zone. Built per call: a module-scope
 *  `Intl.DateTimeFormat` freezes the zone at import (CLAUDE.md). */
function formatDay(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(epochMs);
}

/** A time of day, dated only when its day differs from the caption's. */
function timeCell(epochMs: number | null, anchorMs: number | null): string {
  if (epochMs === null) return '—';
  const time = formatClockTime(epochMs);
  return anchorMs !== null && formatDay(epochMs) !== formatDay(anchorMs) ? `${formatDay(epochMs)} ${time}` : time;
}

export default function RunLifecycle({
  steps,
  compact,
}: {
  readonly steps: readonly LifecycleStep[];
  readonly compact: boolean;
}) {
  const shown = compact ? furthestReached(steps) : steps;
  const anchorMs = steps.find((s) => s.startMs !== null)?.startMs ?? null;

  return (
    <section aria-label="Run lifecycle" data-testid="run-lifecycle" className={compact ? COMPACT_FRAME : FRAME}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {shown.map((step, i) => (
          <li
            key={step.name}
            data-testid={`lifecycle-${step.name}`}
            data-state={step.state}
            className="flex min-w-0 items-center gap-2"
          >
            {i > 0 ? (
              <span aria-hidden="true" className="text-muted">
                ❯
              </span>
            ) : null}
            <Marked mark={markFor(step)} />
          </li>
        ))}
      </ol>

      <details data-testid="lifecycle-times" className="min-w-0 text-[0.75rem]">
        {/* The disclosure affordance every other `<summary>` in this app wears
            (`TableFrame`, `RunStats`, `StatisticsTable`): accent, underline on
            hover, no marker. */}
        <summary className="w-fit cursor-pointer list-none font-medium text-accent hover:underline hover:underline-offset-2">
          Step times
        </summary>
        <table className="mt-2 border-collapse text-left">
          <caption className="pb-1 text-left text-muted">
            {anchorMs === null
              ? 'No times recorded yet'
              : `Times on ${formatDay(anchorMs)}, ${formatZoneOffset(anchorMs)}`}
          </caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="pr-4 font-medium">Step</th>
              <th scope="col" className="pr-4 font-medium">Started</th>
              <th scope="col" className="pr-4 font-medium">Ended</th>
              <th scope="col" className="font-medium">Took</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {steps.map((step) => (
              <tr key={step.name} data-testid={`lifecycle-times-${step.name}`}>
                <th scope="row" className="pr-4 font-sans font-normal">{STEP_LABEL[step.name]}</th>
                <td className="pr-4">{timeCell(step.startMs, anchorMs)}</td>
                <td className="pr-4">{timeCell(step.endMs, anchorMs)}</td>
                <td>{step.durationMs !== null ? formatDuration(step.durationMs) : (step.note ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run apps/web/test/RunLifecycle.test.tsx`, then `TZ=UTC pnpm exec vitest run apps/web/test/RunLifecycle.test.tsx`
Expected: PASS both, 8 tests.

- [ ] **Step 5: Group it under the header, and take the Execution row out of the band**

In `apps/web/src/routes/RunShell.tsx`, after `import RunDecisionBand from './RunDecisionBand';` add:

```ts
import RunLifecycle from './RunLifecycle';
import { lifecycleSteps } from './lifecycle';
```

and replace:

```tsx
    <div className="flex flex-col gap-6">
      <RunHeader
        identity={identity}
        status={status}
        verdict={verdict}
        peakUsers={users.data ? peakConcurrentUsers(users.data) : null}
        /* THE SAME `compact` THE BRUSH BELOW READS, spent a second time —
           review M02 folds the header's secondary metadata behind a
           disclosure on a phone, and a `<details>`'s open state is the one
           thing a media query cannot set. See `RunHeader`'s own note. */
        compact={compact}
      />
```

with:

```tsx
    <div className="flex flex-col gap-6">
      {/* THE RUN'S JOURNEY, UNDER ITS NAME, the way Gatling Enterprise sets its
          strip directly under a run's title: the band below keeps the release
          decision and its evidence, the strip says how the run got there
          (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md).
          Grouped with the header rather than given the shell's 24 px gap:
          MEASURED at 375x812 the run's first total sat at y=802 of 812, and a
          carded row in that gap would have cost ~70 px. */}
      <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
        <RunHeader
          identity={identity}
          status={status}
          verdict={verdict}
          peakUsers={users.data ? peakConcurrentUsers(users.data) : null}
          /* THE SAME `compact` THE BRUSH BELOW READS, spent a second time —
             review M02 folds the header's secondary metadata behind a
             disclosure on a phone, and a `<details>`'s open state is the one
             thing a media query cannot set. See `RunHeader`'s own note. */
          compact={compact}
        />
        <RunLifecycle steps={lifecycleSteps({ identity, status, verdict, assertions })} compact={compact} />
      </div>
```

In `apps/web/src/routes/RunDecisionBand.tsx`, replace:

```tsx
          {/* THREE OUTCOMES, NAMED. Each row says which system answered, so no
              reader has to infer that "0 failed" meant one system's rules and
              not the test's own checks. */}
          <dl data-testid="run-outcomes" className="flex flex-col gap-1 text-[0.75rem]">
            <Outcome testId="outcome-execution" label="Execution" value={executionText(status)} />
```

with:

```tsx
          {/* TWO OUTCOMES, NAMED. Each row says which system answered, so no
              reader has to infer that "0 failed" meant one system's rules and
              not the test's own checks. What the RUN itself did was a third
              row here, "Execution"; the lifecycle strip above now says it,
              with timings. */}
          <dl data-testid="run-outcomes" className="flex flex-col gap-1 text-[0.75rem]">
```

and delete the `executionText` function with its one-line docstring (`/** What the RUN did, as distinct from what any gate concluded about it. */`). `status` stays a prop: `runSummaryJson` still reads it.

- [ ] **Step 6: Re-point the band's Execution cases, and pin the shell**

In `apps/web/test/RunDecisionBand.test.tsx`, replace everything from the docstring that opens `═══ \`incomplete\` IS NOT \`failed\`, AND THE BAND IS WHERE THAT IS SAID ═══` through the end of the case `it('still says a failed run could not be processed', …);` with:

```tsx
  /**
   * ═══ THE EXECUTION ROW MOVED TO THE LIFECYCLE STRIP ═══
   *
   * This band used to say what the RUN did in a row of its own — "incomplete —
   * the stream stopped early" against "could not be processed", an exclusive
   * pair because the two send a reader to different work. The run lifecycle
   * strip above the band says it now, with timings, and
   * `RunLifecycle.test.tsx` carries both halves of that pair. What stays here
   * is that the band no longer says it at all: two places stating one fact is
   * how they come to disagree.
   */
  it('has no Execution row: the lifecycle strip above it says what the run did', () => {
    renderBand({ status: 'incomplete', verdict: null, assertions: undefined });
    expect(screen.queryByTestId('outcome-execution')).toBeNull();
    expect(screen.queryByText(/stream stopped early|could not be processed/i)).toBeNull();
  });
```

In `apps/web/test/RunShell.test.tsx`, add `import { formatDuration } from '../src/routes/format';` to the imports, and add inside `describe('RunShell', () => {`:

```tsx
  it('mounts the lifecycle strip between the header and the release decision', () => {
    renderShell();
    const heading = screen.getByRole('heading', { level: 1 });
    const strip = screen.getByRole('region', { name: 'Run lifecycle' });
    const band = screen.getByRole('region', { name: 'Release decision' });
    expect(heading.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** One number under one word, one verdict in one vocabulary: the strip must
   *  agree with the header's Duration chip and the band's big word. The two
   *  spans differ here, so an expression reading the wrong one shows a
   *  different number. */
  it('says the Duration chip’s number and the band’s word', () => {
    expect(formatDuration(62_136)).not.toBe(formatDuration(RUN.durationMs));
    renderShellWith({ identity: { ...RUN, activityMs: 62_136 }, verdict: 'failed', assertions: [] });
    expect(screen.getByTestId('run-duration')).toHaveTextContent(formatDuration(62_136));
    expect(screen.getByTestId('lifecycle-load-test')).toHaveTextContent(formatDuration(62_136));
    const word = screen.getByTestId('decision-word').textContent ?? '';
    expect(word).not.toBe('');
    expect(screen.getByTestId('lifecycle-verdict')).toHaveTextContent(`Verdict: ${word}`);
  });
```

- [ ] **Step 7: Run the web unit files, and look for anything else pinning the row**

Run: `pnpm exec vitest run apps/web/test/RunLifecycle.test.tsx apps/web/test/RunDecisionBand.test.tsx apps/web/test/RunShell.test.tsx apps/web/test/lifecycle.test.ts apps/web/test/RunDetail.live.test.tsx apps/web/test/RunDetail.polling.test.tsx`
Expected: PASS (the two RunDetail files render the whole shell, so they prove the strip adds no colliding text). Then `grep -rn "outcome-execution\|executionText" apps/web/src apps/web/test` — expected: only the new "has no Execution row" case.

- [ ] **Step 8: Checkpoint, red-verify, typecheck, lint, commit**

Commit a checkpoint naming every changed path, then mutations, each restored from HEAD:
1. Move the `<ol>…</ol>` inside the `<summary>` → "keeps the list outside the Step times disclosure" fails.
2. Add `<h2 className="sr-only">Lifecycle</h2>` as the section's first child → "is a named region … with no heading" fails.
3. `const shown = steps;` (the phone gets every step) → both phone cases fail.
4. In `RunShell.tsx`, move `<RunLifecycle … />` out of the header group and below `<RunDecisionBand … />` → "mounts … between the header and the release decision" fails.
5. In `lifecycle.ts`, the Verdict text as `` `Verdict: ${verdict}` `` → the RunShell agreement case fails (`Verdict: failed` against the band's `Failed`).
6. Restore the band's Execution `<Outcome … />` line and `executionText` → "has no Execution row" fails.
7. `timeCell` returning `time` alone (never dated) → "times every step to the second" fails on the processing row's missing date.

Then `pnpm typecheck` and `pnpm lint` by their own exit codes, and amend the checkpoint into:

```bash
git commit --amend -F - <<'MSG'
Put the run's lifecycle strip under its header

The run page now walks the run's journey under its name: each step's
outcome and duration, and a Step times disclosure with each step's start and
end to the second, dated once. The decision band gives up its Execution row,
whose sentences the strip now says with timings. On a phone the strip is one
bare line, the furthest step reached, because the fold had 10 px to spare
and the band's own word states the verdict directly below.
MSG
```

---

### Task 5: The strip in a browser

**Files:**
- Create: `apps/web/e2e/run-lifecycle.spec.ts`
- Modify: `apps/web/e2e/run-list.spec.ts` (~line 500), `apps/web/e2e/mobile.spec.ts` (the M02 docstring ~line 170 and the assertion ~line 206)

**Interfaces:**
- Consumes: Task 4's test ids and region name; `seedAdmin`, `seedRunWithData`, `seedIncompleteRun` (`apps/web/e2e/fixtures.ts`); `signIn(page, admin)` (`apps/web/e2e/helpers.ts`); `runPath` (`apps/web/src/routes/paths.ts`).

- [ ] **Step 1: The scratch stack (as in Task 2 Step 2), plus a free port**

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN   # if anything holds it, export PERFPORTAL_E2E_PORT=3100
```

- [ ] **Step 2: Write the spec**

Create `apps/web/e2e/run-lifecycle.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { seedAdmin, seedIncompleteRun, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ THE RUN'S JOURNEY, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * The unit layer hands the strip its steps; these prove the seams: a real
 * upload's stamps reaching the page through the real API, the band without
 * its Execution row, and a seeded incomplete run — which carries no stream
 * stamps at all — still saying its load test stopped early.
 */
test('an uploaded run walks Load test, Received, Processing and Verdict, with its times', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  const strip = page.getByRole('region', { name: 'Run lifecycle' });
  await expect(strip.getByRole('list').getByRole('listitem')).toHaveText([
    /Load test/,
    /Received/,
    /Processed/,
    /Verdict:/,
  ]);

  await strip.getByText('Step times').click();
  await expect(strip.getByTestId('lifecycle-times-processing')).toContainText(/\d{2}:\d{2}:\d{2}/);

  const band = page.getByRole('region', { name: 'Release decision' });
  await expect(band).toBeVisible();
  await expect(band.getByTestId('outcome-execution')).toHaveCount(0);
});

test('an incomplete run says its load test stopped early', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedIncompleteRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));

  await expect(page.getByRole('region', { name: 'Run lifecycle' })).toContainText(/stopped early/i);
});
```

- [ ] **Step 3: Re-point the two assertions on the retired row**

In `apps/web/e2e/run-list.spec.ts` (~line 500), replace

```ts
  await expect(page.getByText(/the stream stopped early/i)).toBeVisible();
```

with

```ts
  // The decision band's Execution sentence moved into the lifecycle strip.
  await expect(page.getByRole('region', { name: 'Run lifecycle' })).toContainText(/stopped early/i);
```

In `apps/web/e2e/mobile.spec.ts`, in the M02 docstring replace ` * The band states three outcomes as labelled rows (Execution, Platform gates,\n * Simulation checks) and then restates them in a sentence:` with ` * The band stated its outcomes as labelled rows (then Execution, Platform\n * gates and Simulation checks — the lifecycle strip has since taken\n * Execution) and then restated them in a sentence:`, and replace

```ts
  await expect(band).toContainText('Platform gates');
  await expect(band).toContainText('Execution');
```

with

```ts
  await expect(band).toContainText('Platform gates');
  await expect(band).toContainText('Simulation assertions');
  // What the run itself did is the lifecycle strip's now, one line on a phone.
  await expect(page.getByRole('region', { name: 'Run lifecycle' })).toBeVisible();
```

- [ ] **Step 4: Run the new and every spec whose bound or assertion the strip can reach**

Run: `pnpm exec playwright test apps/web/e2e/run-lifecycle.spec.ts apps/web/e2e/run-list.spec.ts apps/web/e2e/mobile.spec.ts apps/web/e2e/run-tables.spec.ts apps/web/e2e/run-detail.spec.ts --workers=2`
Expected: PASS. `mobile.spec.ts` holds the 375x812 fold (802 before, ~804 expected, bound 812); `run-tables.spec.ts` the 1440x900 one (733 before, ~769 expected, bound 900); `run-detail.spec.ts` has a pending-run case asserting the page draws NO table (`getByRole('table')).toHaveCount(0)`), which must still pass with the strip's Step times table inside its closed `<details>`. If a bound fails, STOP and report the measured positions — never move a bound.

- [ ] **Step 5: Red-verify, typecheck, lint, commit**

Commit a checkpoint, then, each restored from HEAD:
1. In `RunShell.tsx`, delete the `<RunLifecycle … />` line → both new cases and the two re-pointed assertions fail.
2. In `lifecycle.ts`, drop `status === 'incomplete' || ` from `streamed` → "an incomplete run says its load test stopped early" fails (the seeded row carries no stream stamps, so it reads as an upload: "Load test · known once processed"). `apps/web` needs no rebuild step: the webServer builds it on every run.

Then `pnpm typecheck` and `pnpm lint` by their own exit codes, and amend the checkpoint into:

```bash
git commit --amend -F - <<'MSG'
Prove the lifecycle strip in a browser, and re-point the retired Execution row

A real upload's stamps reach the strip and its Step times through the real
API; the band has no Execution row; a seeded incomplete run, which carries no
stream stamps at all, still says its load test stopped early. The run-list and
mobile assertions on the band's Execution sentence now read the strip.
MSG
```

---

### Task 6: Gates, floors and CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Confirm nothing else is using the stack**

```bash
ps -axo args | grep -E '[v]itest|[v]ite build|[p]laywright test|perf-dashboard.*[d]ist/main\.js' | grep -v 'playwright-mcp'
docker exec infra-redis-1 redis-cli -n 10 LLEN bull:ingest:wait
uptime; vm_stat | head -2; sysctl vm.swapusage
```
Expected: no suite and no stray API or worker; queue depth 0; 1-minute load below 8 and 5-minute below 10. If not met, WAIT; never start behind an expired wait.

- [ ] **Step 2: Predict, then run the five gates**

Recreate `perfportal_lifecycle`, flush db 10, migrate. PREDICTED from the cases above — recount before running if any task added or removed one: unit **169 / 2163** (166 + 3 files; 2135 + 4 + 15 + 8 + 2 − 1); integration **152 / 1924** (149 + the two new `.ts` unit files + `lifecycle.integration.test.ts`; 1900 + 4 + 15 + 5); e2e **158** (156 + 2). Then:

```bash
pnpm typecheck > "$SCRATCH/g-tc.txt" 2>&1; echo "typecheck exit=$?"
pnpm lint > "$SCRATCH/g-lint.txt" 2>&1; echo "lint exit=$?"
pnpm test:unit > "$SCRATCH/g-unit.txt" 2>&1; echo "unit exit=$?"; tail -6 "$SCRATCH/g-unit.txt"
TZ=UTC pnpm test:unit > "$SCRATCH/g-unit-utc.txt" 2>&1; echo "unit-utc exit=$?"; tail -6 "$SCRATCH/g-unit-utc.txt"
pnpm test:integration > "$SCRATCH/g-int.txt" 2>&1; echo "integration exit=$?"; tail -6 "$SCRATCH/g-int.txt"
pnpm test:e2e > "$SCRATCH/g-e2e.txt" 2>&1; echo "e2e exit=$?"; tail -4 "$SCRATCH/g-e2e.txt"
```
Expected: exit 0 each, every total equal to its prediction, no `Errors` line in either unit output. Chase any difference in either direction. A failure on a loaded machine is isolated and re-run once before it is believed.

- [ ] **Step 3: Write the CLAUDE.md entry**

Insert a new entry directly after the paragraph beginning `**AND ITS e2e IS THE FIRST THAT RUNS ON THREE ENGINES.**`, and replace the headline floor (`fewer than **166 files / 2135 tests**`) with the measured unit floor. The entry states, in this file's voice: the floors (from → to, all three); that the phone fold decided the compact variant, with the measurements (802 of 812, the 22 px the Execution row gave back, a carded row costing ~70); that a failed run never reaches the strip because `GET /v1/runs/{id}` answers it with the ingest problem (so the band's "could not be processed" had been unreachable too); that "stopped early" keys on the incomplete status because the e2e suite's seeded incomplete run carries no stream stamps, and a derivation keyed on stamps alone would have called it an upload; that an abandoned stream's load test ends at its last chunk rather than the sweeper's give-up, which is why `stream_abandoned_at` stayed off the contract; that both identity builders send the stamps from one helper and a mutation dropping them from each builder was red-verified; that the verdict word moved to `decision.ts`; and anything the gates themselves taught. Then `WHAT WAS RUN` with every exit code and total, the scratch database and Redis index.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -F - <<'MSG'
Record the lifecycle strip's floors and what building it taught
MSG
git log --oneline origin/main..HEAD
```

Pushing, the PR and the merge (one PR to main, `--merge`) follow in the finishing step.

- [ ] **Step 5: Real runs (controller)**

Against the developer database's real Gatling runs, read-only, with the API at the origin it trusts: the strip on a live-streamed run (`gatling-demo`) and an uploaded one (`web-demo`), Step times opened, and a phone-width view; then one real on-prem runner run (the recipe in the memory `verify-with-real-gatling-runs`) to see Queued with its real wait.
