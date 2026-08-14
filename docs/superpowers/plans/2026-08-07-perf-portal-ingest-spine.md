# Ingest Spine Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gatling results bundle posted over HTTP is parsed, aggregated, evaluated against SLA rules, persisted, and readable — with an adaptive verdict returned to the caller.

**Architecture:** Two NestJS deployables (`apps/api`, `apps/worker`) over one pnpm workspace, consuming the three already-shipped pure packages unchanged. The API streams the bundle to object storage, commits a `run` row, enqueues a BullMQ job, and waits on Redis pub/sub for a bounded window. The worker parses via a plugin, runs the statistics engine, persists, evaluates SLA rules, and publishes.

**Tech Stack:** Node 22 · pnpm 9 · TypeScript 5.6 (ESM) · NestJS 11 · Prisma 6 · PostgreSQL 16 · Redis 7 + BullMQ · MinIO (S3) · Zod · Vitest

**Spec:** [`docs/superpowers/specs/2026-08-07-perf-portal-ingest-spine-service-design.md`](../specs/2026-08-07-perf-portal-ingest-spine-service-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node `>=22`.** CI pins 22; the machine default is v20.20.2. Use `nvm use` (`.nvmrc` lands in Task 1). Node 20 and 22 differ in exactly the ESM behavior this design depends on.
- **ESM everywhere.** `"type": "module"` in every package and app. Relative imports in `packages/*` carry an explicit `.js` extension.
- **Packages** compile with `moduleResolution: bundler` (existing `tsconfig.base.json`). **Apps** compile with `module`/`moduleResolution: NodeNext`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`. With `emitDecoratorMetadata: false`, NestJS reports a *successful boot* and injects `undefined` — verified in the spike. Never trust a clean startup log.
- **`noUncheckedIndexedAccess: true`** is on. Indexing an array yields `T | undefined`.
- **Purity rule (ESLint, enforced):** `packages/{core,plugin-gatling,statistics}` must not import `node:fs`, `node:http`, `node:https`, `node:net`, `pg`, `prisma`, `@prisma/*`, or `@nestjs/*`. Do not widen this glob.
- **`IngestError.remediation` is required at compile time.** An error that cannot state a fix does not compile.
- **DDSketch relative accuracy is 1%, and 1.000% is reachable.** Every accuracy assertion uses `<=`, never `<`.
- **Percentile keys are `p${number}`** — `p50`, `p95`, `p99.9`. `Sketch.quantile()` takes a fraction (`0.95`), `RollupBuilder.finish()` takes whole numbers (`95`).
- **Tenancy is a parameter, not a convention.** Every repository method takes `{ orgId, projectId }` and cannot omit it.
- **Every `run_series_bucket` read passes `run_started_on` alongside `run_id`.** It is the partition key; filtering on `run_id` alone scans every partition.
- **Never assert dependency injection with `instanceof`.** `new PrismaClient() instanceof PrismaClient` is `false` under Prisma 6 — the client is a Proxy. Assert by API shape.
- **Falsify every test before trusting it.** Break the implementation, watch the test fail for the stated reason, restore. A test never observed failing is not evidence.
- **A dependency change is only validated from a clean install.** `rm -rf node_modules && pnpm install --frozen-lockfile`. The one CI failure in this project's history was a removal verified against a stale `node_modules`.

### Fixture ground truth

`fixtures/gatling-3.15.1.2/reference-report/simulation.log` — asserted end-to-end in Task 15, and independently proven by the existing package tests:

| Quantity | Value |
|---|---|
| Total requests | 895 |
| OK / KO | 871 / 24 |
| Indicator bands (`<800` / `800–1200` / `≥1200`) | 848 / 0 / 23 |
| Max · mean · stddev | 2503 · 228 · 370 |
| Error messages | 15 × `…500…`, 9 × `…503…` |
| User events · group records | 490 (245/245) · 405 |

### Three departures from the spec, recorded

**1. Metric writes use batched `INSERT`, not `COPY`** (spec §9.4). At ~30k bucket rows per run, 500 rows per statement is ~60 statements, and it avoids hand-rolled `COPY` text escaping — a defect farm, in service of a throughput requirement explicitly out of scope for this slice (spec §1.2, §5.2). `COPY` becomes a measured optimization when the benchmark demands it, not a guess made now.

**2. The verdict wait uses Postgres `LISTEN/NOTIFY`, not Redis pub/sub** (spec §6.1 step 7). The notification must never announce a state that rolled back. `pg_notify` issued after `COMMIT` returns gives that ordering for free; a Redis publish is a second system that can fire on a transaction that then fails. It also keeps Redis off the API's read path. Redis remains the queue. Detail in Task 13.

**3. OpenAPI is 3.0, not 3.1** (spec §10). `@nestjs/swagger` emits 3.0. Nothing in this slice needs a 3.1-only feature, and hand-maintaining a 3.1 document beside generated decorators would guarantee drift between the two. Revisit if a consumer requires 3.1.

---

## File Structure

| Path | Responsibility |
|---|---|
| `.nvmrc` | Pins the Node version to match CI |
| `packages/core/src/plugin.ts` | `PerfPlugin`, `BundleIndex`, `BundleSource`, `DetectResult` |
| `packages/statistics/src/engine-async.ts` | `runEngineAsync` over an `AsyncIterable` |
| `packages/plugin-gatling/src/plugin.ts` | `GatlingPlugin` — detect allowlist + parse adapter |
| `packages/contracts/src/*.ts` | Zod schemas and DTO types shared by api, worker, and tests |
| `packages/persistence/prisma/schema.prisma` | The 9 tables |
| `packages/persistence/src/client.ts` | Prisma client + `pg` pool construction |
| `packages/persistence/src/repositories/*.ts` | Tenancy-scoped CRUD |
| `packages/persistence/src/metrics/*.ts` | Raw-SQL writers and readers for stats, series, errors |
| `packages/storage/src/blobs.ts` | S3 client, streaming upload with inline SHA-256 and the size cap |
| `packages/storage/src/bundle.ts` | `BundleSource` over a gzipped tar |
| `packages/sla/src/evaluate.ts` | Pure rule evaluation → assertions + verdict |
| `apps/api/src/**` | HTTP: auth, ingest, verdict wait, read endpoints |
| `apps/worker/src/**` | BullMQ consumer, ingest pipeline, sweeper |
| `infra/docker-compose.yml` | Postgres 16 · Redis 7 · MinIO |

---

## Task 1: Make the shipped packages importable at runtime

The blocker found by the pre-flight spike (spec §3 F-1). All three packages declare `"exports": { ".": "./src/index.ts" }` — raw TypeScript. Node strips the types off `index.ts`, then fails to resolve its relative `./sketch.js`, which does not exist unless the package is built. Nothing has ever caught this because only vitest and `tsc -b` have loaded these packages, and both read source.

**Files:**
- Create: `.nvmrc`
- Create: `packages/statistics/test/runtime-import.test.ts`
- Modify: `packages/core/package.json`, `packages/statistics/package.json`, `packages/plugin-gatling/package.json`
- Modify: `pnpm-workspace.yaml`, `vitest.config.ts`, `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: every later task can `import { … } from '@perfportal/statistics'` from a running Node process. Apps must run `pnpm -w build` before starting.

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/runtime-import.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Vitest reads package SOURCE, so it cannot catch a package that is unimportable
 * by Node itself. Shell out to a real node process — that is the only way this
 * failure mode is observable, and it is how apps/api and apps/worker will load it.
 */
describe('runtime importability', () => {
  it('loads @perfportal/statistics in a plain node process', () => {
    const script = `
      const { Sketch } = await import('@perfportal/statistics');
      const s = new Sketch();
      for (let i = 1; i <= 1000; i++) s.accept(i);
      if (!(Math.abs(s.quantile(0.95) - 950) / 950 <= 0.01)) throw new Error('p95 out of tolerance');
      console.log('ok');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });

  it('loads @perfportal/plugin-gatling in a plain node process', () => {
    const script = `
      const m = await import('@perfportal/plugin-gatling');
      if (typeof m.parseSimulationLog !== 'function') throw new Error('missing parseSimulationLog');
      console.log('ok');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/runtime-import.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND: Cannot find module '…/packages/statistics/src/sketch.js' imported from …/packages/statistics/src/index.ts`.

That exact message is the point of the task. If you see a different failure, stop and diagnose before continuing.

- [ ] **Step 3: Add the conditional exports map to all three packages**

In each of `packages/core/package.json`, `packages/statistics/package.json`, `packages/plugin-gatling/package.json`: **delete the `"main"` field** and add:

```json
  "exports": {
    ".": {
      "perfportal-source": "./src/index.ts",
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    }
  },
  "files": ["dist"]
```

The `perfportal-source` condition keeps vitest and `tsc` on source so the test suite needs no build; `default` sends Node to the compiled output. Order matters — conditions are matched top to bottom.

- [ ] **Step 4: Point vitest at the source condition**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Keep the suite reading TypeScript source: no build step, no stale dist.
    conditions: ['perfportal-source'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Anything needing live Postgres, Redis, or MinIO is named
    // *.integration.test.ts and runs only under vitest.integration.config.ts,
    // so `pnpm test` stays runnable with no Docker.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
```

**Naming rule, enforced from here on:** a test that needs live infrastructure is named `*.integration.test.ts`. A test that does not is named `*.test.ts`. Getting this wrong makes `pnpm test` fail on a machine with no Docker, which trains people to ignore a red suite.

- [ ] **Step 5: Add the workspace glob, the build script, and the Node pin**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`.nvmrc`:

```
22.19.0
```

Root `package.json` — add `build` and make `test` depend on it, since the runtime-import test needs `dist`:

```json
  "scripts": {
    "build": "tsc -b",
    "test": "pnpm build && vitest run",
    "test:unit": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc -b"
  }
```

- [ ] **Step 6: Build and verify the test passes**

```bash
pnpm build && pnpm vitest run packages/statistics/test/runtime-import.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Falsify — prove the test detects a regression**

```bash
node -e "const f='packages/statistics/package.json';const fs=require('fs');const j=JSON.parse(fs.readFileSync(f));j.exports['.'].default='./src/index.ts';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
pnpm vitest run packages/statistics/test/runtime-import.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`. Then restore:

```bash
git checkout packages/statistics/package.json
```

- [ ] **Step 8: Verify the whole suite from a clean install**

```bash
rm -rf node_modules packages/*/node_modules && pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
```

Expected: lint clean, typecheck clean, **50 tests passing** (the existing 48 plus the 2 added here).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix: make the shipped packages importable by node at runtime

They exported ./src/index.ts — raw TypeScript. Node strips the types off
index.ts and then cannot resolve its relative ./sketch.js, because nothing
is built. Invisible until now because only vitest and tsc -b have ever
loaded these packages, and both read source; no running process ever has.
apps/api and apps/worker would have hit it on first boot.

Conditional exports send vitest and tsc to source via a perfportal-source
condition and Node to dist, so the suite still needs no build while the
packages become importable. Adds a runtime-import test that shells out to a
real node process, since vitest by construction cannot observe this failure."
```

---

## Task 2: `@perfportal/contracts` — wire schemas

Zod schemas and inferred types shared by the API, the worker, and the integration tests. Defining them once is what keeps the `POST` response and the `GET` status response provably identical (spec §7).

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/{index,ingest,run,metrics,problem}.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Modify: `tsconfig.json` (add the project reference)

**Interfaces:**
- Consumes: nothing.
- Produces: `IngestMetadataSchema`, `IngestMetadata`, `RunResponseSchema`, `RunResponse`, `RunStatus`, `RunVerdict`, `AssertionOutcome`, `ProblemDetailsSchema`, `ProblemDetails`, `StatRowSchema`, `StatsResponse`, `SeriesResponse`, `ErrorsResponse`, `RunListResponse`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IngestMetadataSchema, ProblemDetailsSchema, RunResponseSchema } from '../src/index.js';

describe('IngestMetadataSchema', () => {
  it('accepts a minimal payload', () => {
    const parsed = IngestMetadataSchema.parse({ tool: 'gatling' });
    expect(parsed.tool).toBe('gatling');
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown tool', () => {
    expect(() => IngestMetadataSchema.parse({ tool: 'notatool' })).toThrow();
  });

  it('rejects an idempotency key that is too long to index safely', () => {
    expect(() => IngestMetadataSchema.parse({ tool: 'gatling', idempotencyKey: 'x'.repeat(256) })).toThrow();
  });
});

describe('RunResponseSchema', () => {
  it('requires a verdict on a complete run', () => {
    const ok = RunResponseSchema.parse({
      id: '018f0000-0000-7000-8000-000000000000',
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      startedAt: '2026-08-07T00:00:00.000Z',
      assertions: [],
    });
    expect(ok.verdict).toBe('passed');
  });

  it('rejects a verdict outside the enum', () => {
    expect(() =>
      RunResponseSchema.parse({
        id: '018f0000-0000-7000-8000-000000000000',
        status: 'complete',
        verdict: 'maybe',
        tool: 'gatling',
        startedAt: '2026-08-07T00:00:00.000Z',
        assertions: [],
      }),
    ).toThrow();
  });
});

describe('ProblemDetailsSchema', () => {
  it('requires remediation — an error that cannot state a fix is not a valid response', () => {
    expect(() =>
      ProblemDetailsSchema.parse({
        type: 'https://perfportal.dev/errors/BUNDLE_TOO_LARGE',
        title: 'Bundle too large',
        status: 400,
        code: 'BUNDLE_TOO_LARGE',
        detail: 'exceeded',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/contracts/test/contracts.test.ts
```

Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Create the package manifest and tsconfig**

`packages/contracts/package.json`:

```json
{
  "name": "@perfportal/contracts",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "perfportal-source": "./src/index.ts",
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "zod": "^3.23.8"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

Add to root `tsconfig.json` references: `{ "path": "packages/contracts" }`.

- [ ] **Step 4: Write the schemas**

`packages/contracts/src/problem.ts`:

```ts
import { z } from 'zod';

/** RFC 9457 problem+json, with the two fields this product adds: code and remediation. */
export const ProblemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string().min(1),
  status: z.number().int(),
  code: z.string().min(1),
  detail: z.string().min(1),
  /** Required, mirroring IngestError.remediation. */
  remediation: z.string().min(1),
  traceId: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
```

`packages/contracts/src/ingest.ts`:

```ts
import { z } from 'zod';

export const TOOL_IDS = ['gatling'] as const;

export const IngestMetadataSchema = z.object({
  tool: z.enum(TOOL_IDS),
  /** Scopes idempotency to the project. Bounded so the unique index stays sane. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(200).optional(),
  commitSha: z.string().min(7).max(64).optional(),
  /** Milliseconds the caller is willing to wait for a synchronous verdict. */
  waitMs: z.number().int().min(0).max(120_000).optional(),
});
export type IngestMetadata = z.infer<typeof IngestMetadataSchema>;
```

`packages/contracts/src/run.ts`:

```ts
import { z } from 'zod';

export const RunStatusSchema = z.enum(['pending', 'parsing', 'complete', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunVerdictSchema = z.enum(['passed', 'failed', 'not_evaluated']);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const AssertionOutcomeSchema = z.enum(['passed', 'failed', 'not_applicable']);
export type AssertionOutcome = z.infer<typeof AssertionOutcomeSchema>;

export const AssertionSchema = z.object({
  ruleId: z.string().uuid(),
  outcome: AssertionOutcomeSchema,
  /** Null when the outcome is not_applicable — there was nothing to measure. */
  actualValue: z.number().nullable(),
  message: z.string(),
  rule: z.object({
    scope: z.enum(['run', 'scenario', 'group', 'request']),
    targetName: z.string().nullable(),
    family: z.enum(['response_time', 'latency', 'group_cumulated', 'group_duration']),
    metric: z.string(),
    comparator: z.enum(['lte', 'gte']),
    threshold: z.number(),
  }),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const RunResponseSchema = z.object({
  id: z.string().uuid(),
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  tool: z.string(),
  toolVersion: z.string().nullable().optional(),
  startedAt: z.string().datetime(),
  ingestedAt: z.string().datetime().nullable().optional(),
  assertions: z.array(AssertionSchema),
  error: z
    .object({ code: z.string(), message: z.string(), remediation: z.string() })
    .nullable()
    .optional(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const RunListResponseSchema = z.object({
  items: z.array(
    RunResponseSchema.pick({ id: true, status: true, verdict: true, tool: true, startedAt: true }),
  ),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
```

`packages/contracts/src/metrics.ts`:

```ts
import { z } from 'zod';

export const MetricScopeSchema = z.enum(['run', 'scenario', 'group', 'request']);
export const MetricFamilySchema = z.enum([
  'response_time',
  'latency',
  'group_cumulated',
  'group_duration',
]);

export const StatRowSchema = z.object({
  scope: MetricScopeSchema,
  name: z.string(),
  family: MetricFamilySchema,
  count: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  errorRate: z.number(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  stddevMs: z.number(),
  throughputRps: z.number(),
  /** Keys are p<number>: p50, p95, p99.9. */
  percentiles: z.record(z.number()),
});
export type StatRow = z.infer<typeof StatRowSchema>;

export const StatsResponseSchema = z.object({
  runId: z.string().uuid(),
  stats: z.array(StatRowSchema),
  indicators: z.object({
    under: z.number().int(),
    between: z.number().int(),
    over: z.number().int(),
    failed: z.number().int(),
  }),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const SeriesBucketSchema = z.object({
  startOffsetMs: z.number().int(),
  startedCount: z.number().int(),
  endedCount: z.number().int(),
  okCount: z.number().int(),
  koCount: z.number().int(),
  minMs: z.number(),
  maxMs: z.number(),
  meanMs: z.number(),
  percentiles: z.record(z.number()),
});

export const SeriesResponseSchema = z.object({
  runId: z.string().uuid(),
  scope: MetricScopeSchema,
  name: z.string(),
  buckets: z.array(SeriesBucketSchema),
});
export type SeriesResponse = z.infer<typeof SeriesResponseSchema>;

export const ErrorsResponseSchema = z.object({
  runId: z.string().uuid(),
  errors: z.array(z.object({ message: z.string(), count: z.number().int() })),
});
export type ErrorsResponse = z.infer<typeof ErrorsResponseSchema>;
```

`packages/contracts/src/index.ts`:

```ts
export * from './problem.js';
export * from './ingest.js';
export * from './run.js';
export * from './metrics.js';
```

- [ ] **Step 5: Install and run the tests**

```bash
pnpm install
pnpm vitest run packages/contracts/test/contracts.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Falsify**

Make `remediation` optional in `problem.ts` (`z.string().min(1).optional()`), re-run.

Expected: FAIL on "requires remediation". Restore it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(contracts): wire schemas shared by api, worker, and tests

Defining the run response once is what makes POST /v1/runs and
GET /v1/runs/{id} provably return the same shape for the same state —
the property the verdict contract rests on.

ProblemDetails requires remediation, mirroring IngestError: an error that
cannot state a fix is not a valid response."
```

---

## Task 3: The plugin contract, and an async engine entry point

Additive to `@perfportal/core` and `@perfportal/statistics`. No existing exported type changes, and no existing test is perturbed — the parity suite keeps using the synchronous `runEngine`.

**Files:**
- Create: `packages/core/src/plugin.ts`
- Create: `packages/statistics/src/engine-async.ts`
- Create: `packages/statistics/test/engine-async.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/statistics/src/index.ts`

**Interfaces:**
- Consumes: `CanonicalEvent`, `CapabilityDescriptor`, `ToolId` from `@perfportal/core`; `EngineOptions`, `EngineResult`, `runEngine` from `@perfportal/statistics`.
- Produces:
  - `interface BundleIndex { files: readonly string[]; head(path: string, bytes: number): Promise<Uint8Array> }`
  - `interface BundleSource { index: BundleIndex; read(path: string): Promise<Uint8Array> }`
  - `interface DetectResult { matched: boolean; toolVersion?: string; reason?: string }`
  - `interface PerfPlugin { id: ToolId; detect(index: BundleIndex): Promise<DetectResult>; parse(source: BundleSource): AsyncIterable<CanonicalEvent>; capabilities(): CapabilityDescriptor }`
  - `runEngineAsync(events: AsyncIterable<CanonicalEvent>, opts?: EngineOptions): Promise<EngineResult>`

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/engine-async.test.ts`:

```ts
import type { CanonicalEvent } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { runEngineAsync } from '../src/engine-async.js';

function events(): CanonicalEvent[] {
  const base = 1_700_000_000_000;
  const out: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
  ];
  for (let i = 0; i < 50; i++) {
    out.push({
      type: 'request',
      name: i % 2 === 0 ? 'GET /a' : 'GET /b',
      groups: [],
      userId: String(i),
      startMs: base + i * 10,
      endMs: base + i * 10 + (i % 7) * 100,
      ok: i % 11 !== 0,
      message: i % 11 === 0 ? 'boom' : undefined,
    });
  }
  return out;
}

async function* toAsync(items: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of items) yield e;
}

describe('runEngineAsync', () => {
  it('produces results identical to runEngine on the same events', async () => {
    const sync = runEngine(events());
    const async_ = await runEngineAsync(toAsync(events()));

    // Compare everything except the sketches, which are objects.
    const strip = (r: typeof sync) =>
      r.stats
        .map(({ sketch: _sketch, ...rest }) => rest)
        .sort((a, b) => `${a.scope}${a.name}${a.family}`.localeCompare(`${b.scope}${b.name}${b.family}`));

    expect(strip(async_)).toEqual(strip(sync));
    expect(async_.indicators).toEqual(sync.indicators);
    expect(async_.errors).toEqual(sync.errors);
    expect(async_.endpointCount).toEqual(sync.endpointCount);
    expect([...async_.series.keys()].sort()).toEqual([...sync.series.keys()].sort());
  });

  it('propagates an IngestError thrown mid-stream instead of swallowing it', async () => {
    async function* boom(): AsyncIterable<CanonicalEvent> {
      yield { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 1 };
      throw new Error('source exploded');
    }
    await expect(runEngineAsync(boom())).rejects.toThrow('source exploded');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/engine-async.test.ts
```

Expected: FAIL — `Cannot find module '../src/engine-async.js'`.

- [ ] **Step 3: Write the plugin contract**

`packages/core/src/plugin.ts`:

```ts
import type { CapabilityDescriptor } from './capabilities.js';
import type { CanonicalEvent, ToolId } from './events.js';

/**
 * A read-only view of an opened bundle. The WORKER implements this; a plugin
 * never opens a file or reaches object storage itself. That is what lets the
 * plugin declare an async contract while staying inside the purity rule
 * (no node:fs, no I/O) that ESLint enforces on this package.
 */
export interface BundleIndex {
  /** Bundle-relative paths with POSIX separators. */
  readonly files: readonly string[];
  /** First `bytes` bytes of a file, for signature sniffing. Never the whole file. */
  head(path: string, bytes: number): Promise<Uint8Array>;
}

export interface BundleSource {
  readonly index: BundleIndex;
  read(path: string): Promise<Uint8Array>;
}

export interface DetectResult {
  matched: boolean;
  /** Tool version as reported by the bundle, when the format carries one. */
  toolVersion?: string;
  /** Populated when matched is false, to explain what was expected. */
  reason?: string;
}

export interface PerfPlugin {
  readonly id: ToolId;
  detect(index: BundleIndex): Promise<DetectResult>;
  /**
   * Async by contract even where an implementation is synchronous underneath.
   * This is the seam at which a streaming reader can later be substituted
   * without changing the engine or any consumer (spec §5.1).
   */
  parse(source: BundleSource): AsyncIterable<CanonicalEvent>;
  capabilities(): CapabilityDescriptor;
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from './plugin.js';
```

- [ ] **Step 4: Write the async engine**

`packages/statistics/src/engine-async.ts`:

```ts
import type { CanonicalEvent } from '@perfportal/core';
import { runEngine, type EngineOptions, type EngineResult } from './engine.js';

/**
 * Drains an AsyncIterable into the synchronous engine.
 *
 * This deliberately materializes the event array. Spec §5.1: at the 5M-event
 * target the whole Gatling log is ~150-250 MB and engine state is ~91 MB, well
 * inside an 8 GiB worker, so the cost of a true streaming rewrite of the
 * parity-verified decoder is not yet justified. The async signature is the seam
 * that makes that rewrite invisible to callers when measurement demands it.
 */
export async function runEngineAsync(
  events: AsyncIterable<CanonicalEvent>,
  opts: EngineOptions = {},
): Promise<EngineResult> {
  const collected: CanonicalEvent[] = [];
  for await (const e of events) collected.push(e);
  return runEngine(collected, opts);
}
```

Add to `packages/statistics/src/index.ts`:

```ts
export * from './engine-async.js';
```

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run packages/statistics/test/engine-async.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Falsify**

In `engine-async.ts`, wrap the loop in `try { … } catch { /* ignore */ }`. Re-run.

Expected: FAIL on "propagates an IngestError thrown mid-stream". Restore.

- [ ] **Step 7: Verify the purity rule still holds and nothing regressed**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: clean; **52 tests passing**.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core,statistics): add the plugin contract and an async engine entry

BundleSource is implemented by the worker, never by a plugin, so a plugin can
declare an async contract without acquiring an I/O dependency — the purity
rule ESLint enforces on these packages stays intact.

runEngineAsync materializes the stream today. Per spec §5.1 the memory this
would save does not exist at the 5M-event target (~150-250 MB of log against
~91 MB of engine state, on an 8 GiB worker), and the alternative is rewriting
the least-safe-to-touch component in the codebase. The async signature is the
seam that makes that rewrite internal if measurement ever contradicts the
extrapolation. runEngine is untouched, so the parity suite is unperturbed."
```

---

## Task 4: The Gatling plugin

Wraps the parity-verified `parseSimulationLog` in the `PerfPlugin` contract, and adds the version allowlist. The binary format carries **no compatibility guarantee** (PRD §28 R-3), so an unrecognized major is a structured rejection, never a best-effort parse that silently produces wrong numbers.

**Files:**
- Create: `packages/plugin-gatling/src/plugin.ts`
- Create: `packages/plugin-gatling/test/plugin.test.ts`
- Modify: `packages/plugin-gatling/src/index.ts`, `packages/plugin-gatling/package.json`

**Interfaces:**
- Consumes: `PerfPlugin`, `BundleIndex`, `BundleSource`, `DetectResult`, `ingestError` from `@perfportal/core`; `parseSimulationLog`, `readRunHeader`, `BinaryReader` from this package.
- Produces: `class GatlingPlugin implements PerfPlugin`, `const SUPPORTED_GATLING_MAJORS: readonly string[]`, `const SIMULATION_LOG = 'simulation.log'`.

- [ ] **Step 1: Write the failing test**

`packages/plugin-gatling/test/plugin.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BundleIndex, BundleSource } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { GatlingPlugin } from '../src/plugin.js';

const LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

function sourceFrom(files: Record<string, Uint8Array>): BundleSource {
  const index: BundleIndex = {
    files: Object.keys(files),
    head: async (path, bytes) => {
      const f = files[path];
      if (!f) throw new Error(`no such file ${path}`);
      return f.subarray(0, bytes);
    },
  };
  return {
    index,
    read: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`no such file ${path}`);
      return f;
    },
  };
}

const realLog = new Uint8Array(readFileSync(LOG));

describe('GatlingPlugin.detect', () => {
  it('matches the reference bundle and reports its version', async () => {
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': realLog }).index);
    expect(r.matched).toBe(true);
    expect(r.toolVersion).toBe('3.15.1');
  });

  it('finds simulation.log in a nested directory', async () => {
    const r = await new GatlingPlugin().detect(
      sourceFrom({ 'paritysimulation-20260807/simulation.log': realLog }).index,
    );
    expect(r.matched).toBe(true);
  });

  it('does not match a bundle with no simulation.log, and says what it wanted', async () => {
    const r = await new GatlingPlugin().detect(sourceFrom({ 'index.html': new Uint8Array([1]) }).index);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('simulation.log');
  });

  it('does not match when the first byte is not a Run record', async () => {
    const notGatling = new Uint8Array(realLog);
    notGatling[0] = 9;
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': notGatling }).index);
    expect(r.matched).toBe(false);
  });

  it('rejects an unsupported major rather than guessing at the layout', async () => {
    // Rewrite the length-prefixed version string "3.15.1" as "9.99.9" in place.
    const other = new Uint8Array(realLog);
    const buf = Buffer.from(other.buffer, other.byteOffset, other.byteLength);
    buf.write('9.99.9', 5, 'latin1');
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': other }).index);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('9.99.9');
  });
});

describe('GatlingPlugin.parse', () => {
  it('yields the fixture record counts through the async contract', async () => {
    const plugin = new GatlingPlugin();
    let requests = 0;
    let users = 0;
    let groups = 0;
    let meta = 0;
    for await (const e of plugin.parse(sourceFrom({ 'simulation.log': realLog }))) {
      if (e.type === 'request') requests++;
      else if (e.type === 'user') users++;
      else if (e.type === 'group') groups++;
      else meta++;
    }
    expect({ meta, requests, users, groups }).toEqual({ meta: 1, requests: 895, users: 490, groups: 405 });
  });

  it('raises a structured, remediable error when simulation.log is absent', async () => {
    const plugin = new GatlingPlugin();
    const iterate = async () => {
      for await (const _ of plugin.parse(sourceFrom({ 'index.html': new Uint8Array([1]) }))) {
        /* drain */
      }
    };
    await expect(iterate()).rejects.toMatchObject({
      code: 'LOG_NOT_FOUND',
      remediation: expect.stringMatching(/.+/),
    });
  });
});

describe('GatlingPlugin.capabilities', () => {
  it('declares what the binary log actually carries', () => {
    expect(new GatlingPlugin().capabilities()).toEqual({
      latency: false,
      groups: true,
      scenarios: true,
      sessionEvents: true,
      nativeAssertions: true,
      errorMessages: true,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/plugin-gatling/test/plugin.test.ts
```

Expected: FAIL — `Cannot find module '../src/plugin.js'`.

- [ ] **Step 3: Implement the plugin**

`packages/plugin-gatling/src/plugin.ts`:

```ts
import {
  ingestError,
  type BundleIndex,
  type BundleSource,
  type CanonicalEvent,
  type CapabilityDescriptor,
  type DetectResult,
  type PerfPlugin,
  type ToolId,
} from '@perfportal/core';
import { RECORD, readRunHeader } from './header.js';
import { BinaryReader } from './reader.js';
import { parseSimulationLog } from './records.js';

export const SIMULATION_LOG = 'simulation.log';

/**
 * The binary log format carries no compatibility guarantee across Gatling
 * majors (PRD §28 R-3). An unknown major is rejected, never parsed on a guess:
 * a wrong record layout does not fail loudly, it produces plausible wrong
 * numbers, which is the worst outcome this product can have.
 */
export const SUPPORTED_GATLING_MAJORS: readonly string[] = ['3'];

/** Enough for the record byte plus the length-prefixed version string. */
const HEAD_BYTES = 64;

function findLog(index: BundleIndex): string | undefined {
  return index.files.find((f) => f === SIMULATION_LOG || f.endsWith(`/${SIMULATION_LOG}`));
}

export class GatlingPlugin implements PerfPlugin {
  readonly id: ToolId = 'gatling';

  async detect(index: BundleIndex): Promise<DetectResult> {
    const path = findLog(index);
    if (!path) {
      return { matched: false, reason: `no ${SIMULATION_LOG} found in the bundle` };
    }

    const head = await index.head(path, HEAD_BYTES);
    const buf = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    if (buf.length < 5 || buf.readInt8(0) !== RECORD.RUN) {
      return {
        matched: false,
        reason: `${path} does not begin with a Gatling Run record (0x00)`,
      };
    }

    const len = buf.readInt32BE(1);
    if (len <= 0 || 5 + len > buf.length) {
      return { matched: false, reason: `${path} has an unreadable version header` };
    }
    const version = buf.subarray(5, 5 + len).toString('latin1');
    const major = version.split('.')[0] ?? '';
    if (!SUPPORTED_GATLING_MAJORS.includes(major)) {
      return {
        matched: false,
        reason: `Gatling ${version} is not a supported major (supported: ${SUPPORTED_GATLING_MAJORS.join(', ')})`,
      };
    }
    return { matched: true, toolVersion: version };
  }

  async *parse(source: BundleSource): AsyncIterable<CanonicalEvent> {
    const path = findLog(source.index);
    if (!path) {
      throw ingestError('LOG_NOT_FOUND', {
        message: `The bundle contains no ${SIMULATION_LOG}.`,
        remediation: `Upload the whole Gatling results directory, which contains ${SIMULATION_LOG}. Uploading only the HTML report is not enough — the report is rendered output, not data.`,
        detail: { files: source.index.files.slice(0, 20) },
      });
    }

    const bytes = await source.read(path);
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Re-read the header for a precise version error before streaming records.
    const version = readRunHeader(new BinaryReader(buf)).gatlingVersion;
    const major = version.split('.')[0] ?? '';
    if (!SUPPORTED_GATLING_MAJORS.includes(major)) {
      throw ingestError('LOG_BINARY_FORMAT', {
        message: `Gatling ${version} writes a simulation.log layout this build does not support.`,
        remediation: `Re-run with a supported Gatling major (${SUPPORTED_GATLING_MAJORS.join(', ')}), or upgrade the platform to a build that lists this version as supported.`,
        detail: { version },
      });
    }

    try {
      yield* parseSimulationLog(buf);
    } catch (err) {
      if (err instanceof Error && err.name === 'IngestError') throw err;
      throw ingestError('LOG_MALFORMED', {
        message: `simulation.log could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
        remediation:
          'The file appears truncated or corrupt. Confirm the Gatling run finished and that the whole results directory was archived without modification.',
        detail: { path },
      });
    }
  }

  capabilities(): CapabilityDescriptor {
    return {
      latency: false,          // the binary log records start/end only, not first-byte
      groups: true,
      scenarios: true,
      sessionEvents: true,
      nativeAssertions: true,  // present as opaque protobuf; decoded in M3
      errorMessages: true,
    };
  }
}
```

Add to `packages/plugin-gatling/src/index.ts`:

```ts
export * from './plugin.js';
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run packages/plugin-gatling/test/plugin.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Falsify the allowlist**

Change `SUPPORTED_GATLING_MAJORS` to `['3', '9']` and re-run.

Expected: FAIL on "rejects an unsupported major rather than guessing at the layout". Restore.

- [ ] **Step 6: Verify no regression**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: clean; **61 tests passing**.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(plugin-gatling): implement the PerfPlugin contract

detect sniffs only the head of simulation.log — the record byte and the
length-prefixed version — and matches on an explicit major allowlist. An
unknown major is rejected with remediation rather than parsed on a guess,
because a wrong record layout does not fail loudly: it produces plausible
wrong numbers, which is the worst failure this product can have.

parse wraps the parity-verified generator and converts decode failures into
structured IngestErrors. The sync generator underneath is untouched."
```

---

## Task 5: `@perfportal/persistence` — schema and migrations

Nine tables, all carrying `org_id` and `project_id`. Two things land now that are cheap now and expensive later: **tenancy columns** and **range partitioning** on the time-series table.

**Files:**
- Create: `packages/persistence/package.json`, `packages/persistence/tsconfig.json`
- Create: `packages/persistence/prisma/schema.prisma`
- Create: `packages/persistence/prisma/migrations/0001_init/migration.sql`
- Create: `packages/persistence/src/{index,client}.ts`
- Create: `packages/persistence/test/migrations.integration.test.ts`
- Create: `infra/docker-compose.yml`
- Create: `vitest.integration.config.ts`
- Modify: root `tsconfig.json`, root `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `createPrisma(url: string): PrismaClient`, `createPool(url: string): Pool`, `SCHEMA_TABLES: readonly string[]`, and the generated Prisma types.

> **Prisma and partitioning.** Prisma cannot express `PARTITION BY RANGE`, so this migration is generated with `prisma migrate dev --create-only` and then hand-edited. Prisma's introspection ignores partitioning, so the model in `schema.prisma` and the partitioned table do not register as drift. `run_series_bucket` stays in `schema.prisma` for exactly that reason — omitting it would make `prisma migrate dev` try to drop it.

- [ ] **Step 1: Start the infrastructure**

`infra/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: perfportal
      POSTGRES_PASSWORD: perfportal
      POSTGRES_DB: perfportal
    ports: ['5433:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U perfportal']
      interval: 2s
      timeout: 3s
      retries: 30

  redis:
    image: redis:7-alpine
    ports: ['6380:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 2s
      timeout: 3s
      retries: 30

  minio:
    image: minio/minio:RELEASE.2024-09-13T20-26-02Z
    command: server /data
    environment:
      MINIO_ROOT_USER: perfportal
      MINIO_ROOT_PASSWORD: perfportal123
    ports: ['9000:9000']
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 2s
      timeout: 3s
      retries: 30
```

Ports are offset (5433, 6380) so a developer's existing local Postgres or Redis is never shadowed.

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

Expected: three services, all `healthy`.

- [ ] **Step 2: Write the failing test**

`packages/persistence/test/migrations.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPool, SCHEMA_TABLES } from '../src/index.js';

const URL_ = process.env.DATABASE_URL;
if (!URL_) throw new Error('DATABASE_URL is required for integration tests. See infra/docker-compose.yml.');

describe('migrations', () => {
  it('creates every expected table', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...SCHEMA_TABLES]],
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual([...SCHEMA_TABLES].sort());
    } finally {
      await pool.end();
    }
  });

  it('partitions run_series_bucket by range, so retention is a partition drop', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ partstrat: string }>(
        `SELECT p.partstrat FROM pg_partitioned_table p
         JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = 'run_series_bucket'`,
      );
      expect(rows[0]?.partstrat).toBe('r');
    } finally {
      await pool.end();
    }
  });

  it('has at least one partition ready to accept writes', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhparent WHERE c.relname = 'run_series_bucket'`,
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it('scopes every run to an org and a project', async () => {
    const pool = createPool(URL_);
    try {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'run' AND column_name IN ('org_id','project_id')`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/migrations.integration.test.ts
```

Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 4: Create the package**

`packages/persistence/package.json`:

```json
{
  "name": "@perfportal/persistence",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "perfportal-source": "./src/index.ts",
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "prisma:generate": "prisma generate --schema prisma/schema.prisma",
    "migrate:deploy": "prisma migrate deploy --schema prisma/schema.prisma"
  },
  "dependencies": {
    "@perfportal/core": "workspace:*",
    "@perfportal/statistics": "workspace:*",
    "@prisma/client": "^6.19.3",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10",
    "prisma": "^6.19.3"
  }
}
```

`packages/persistence/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

Add `{ "path": "packages/persistence" }` to root `tsconfig.json` references.

`vitest.integration.config.ts` at the repo root:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['perfportal-source'] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Integration tests share one Postgres; running files in parallel would
    // let one file's truncate wipe another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

Root `package.json` scripts — add:

```json
    "test:integration": "pnpm build && vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 5: Write the Prisma schema**

`packages/persistence/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Org {
  id        String    @id @default(uuid()) @db.Uuid
  slug      String    @unique
  name      String
  createdAt DateTime  @default(now()) @map("created_at")
  projects  Project[]

  @@map("org")
}

model Project {
  id        String   @id @default(uuid()) @db.Uuid
  orgId     String   @map("org_id") @db.Uuid
  slug      String
  name      String
  settings  Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")

  org       Org        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  tokens    ApiToken[]
  runs      Run[]
  slaRules  SlaRule[]

  @@unique([orgId, slug])
  @@map("project")
}

model ApiToken {
  id         String    @id @default(uuid()) @db.Uuid
  orgId      String    @map("org_id") @db.Uuid
  projectId  String    @map("project_id") @db.Uuid
  name       String
  /// Indexed lookup key, so verification is one row read plus one hash.
  prefix     String    @unique
  tokenHash  String    @map("token_hash")
  scopes     String[]
  createdAt  DateTime  @default(now()) @map("created_at")
  lastUsedAt DateTime? @map("last_used_at")
  revokedAt  DateTime? @map("revoked_at")

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@map("api_token")
}

model Run {
  id             String    @id @default(uuid()) @db.Uuid
  orgId          String    @map("org_id") @db.Uuid
  projectId      String    @map("project_id") @db.Uuid
  status         String
  verdict        String?
  tool           String
  toolVersion    String?   @map("tool_version")
  bundleKey      String    @map("bundle_key")
  bundleSha256   String    @map("bundle_sha256")
  bundleBytes    BigInt    @map("bundle_bytes")
  idempotencyKey String?   @map("idempotency_key")
  startedAt      DateTime  @map("started_at")
  startedOn      DateTime  @map("started_on") @db.Date
  ingestedAt     DateTime? @map("ingested_at")
  /// Frozen at accept time. Statistics are meaningless without the options
  /// that produced them, and a project changing its warm-up must not
  /// silently reinterpret its own history.
  engineOptions  Json      @map("engine_options")
  error          Json?

  project    Project        @relation(fields: [projectId], references: [id], onDelete: Cascade)
  assertions RunAssertion[]

  @@unique([projectId, idempotencyKey])
  @@index([projectId, startedAt(sort: Desc)])
  @@index([status, startedAt])
  @@map("run")
}

model RunStat {
  id           String  @id @default(uuid()) @db.Uuid
  runId        String  @map("run_id") @db.Uuid
  orgId        String  @map("org_id") @db.Uuid
  projectId    String  @map("project_id") @db.Uuid
  scope        String
  name         String
  family       String
  count        Int
  okCount      Int     @map("ok_count")
  koCount      Int     @map("ko_count")
  errorRate    Float   @map("error_rate")
  minMs        Float   @map("min_ms")
  maxMs        Float   @map("max_ms")
  meanMs       Float   @map("mean_ms")
  stddevMs     Float   @map("stddev_ms")
  throughputRps Float  @map("throughput_rps")
  percentiles  Json
  sketch       Bytes
  sketchKind   String  @map("sketch_kind")

  @@unique([runId, scope, name, family])
  @@index([runId])
  @@map("run_stat")
}

/// Partitioned by range on run_started_on — see migration 0001, hand-edited.
model RunSeriesBucket {
  runStartedOn  DateTime @map("run_started_on") @db.Date
  runId         String   @map("run_id") @db.Uuid
  orgId         String   @map("org_id") @db.Uuid
  projectId     String   @map("project_id") @db.Uuid
  scope         String
  name          String
  startOffsetMs Int      @map("start_offset_ms")
  startedCount  Int      @map("started_count")
  endedCount    Int      @map("ended_count")
  okCount       Int      @map("ok_count")
  koCount       Int      @map("ko_count")
  minMs         Float    @map("min_ms")
  maxMs         Float    @map("max_ms")
  meanMs        Float    @map("mean_ms")
  percentiles   Json

  @@id([runStartedOn, runId, scope, name, startOffsetMs])
  @@map("run_series_bucket")
}

model RunError {
  id        String @id @default(uuid()) @db.Uuid
  runId     String @map("run_id") @db.Uuid
  orgId     String @map("org_id") @db.Uuid
  projectId String @map("project_id") @db.Uuid
  message   String
  count     Int

  @@index([runId])
  @@map("run_error")
}

model SlaRule {
  id         String  @id @default(uuid()) @db.Uuid
  orgId      String  @map("org_id") @db.Uuid
  projectId  String  @map("project_id") @db.Uuid
  scope      String
  targetName String? @map("target_name")
  family     String
  metric     String
  comparator String
  threshold  Float
  enabled    Boolean @default(true)

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, enabled])
  @@map("sla_rule")
}

model RunAssertion {
  id           String  @id @default(uuid()) @db.Uuid
  runId        String  @map("run_id") @db.Uuid
  orgId        String  @map("org_id") @db.Uuid
  projectId    String  @map("project_id") @db.Uuid
  ruleId       String  @map("rule_id") @db.Uuid
  /// The rule as it read at evaluation time. Editing a threshold must never
  /// rewrite the history of what passed.
  ruleSnapshot Json    @map("rule_snapshot")
  outcome      String
  actualValue  Float?  @map("actual_value")
  message      String

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId])
  @@map("run_assertion")
}
```

- [ ] **Step 6: Generate the migration, then hand-edit it for partitioning**

```bash
cd packages/persistence
pnpm install
pnpm exec prisma migrate dev --create-only --name init --schema prisma/schema.prisma
```

Rename the generated directory to `0001_init` if Prisma timestamped it, then edit `prisma/migrations/0001_init/migration.sql`. Find the generated `CREATE TABLE "run_series_bucket" (...)` statement and replace it, plus append the partitions, so the file ends with:

```sql
-- Prisma cannot express partitioning; this statement replaces the generated one.
-- Partitioning by run start date is what makes retention a partition drop
-- rather than a delete storm (NFR-SC-7).
CREATE TABLE "run_series_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "started_count" INTEGER NOT NULL,
    "ended_count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "ko_count" INTEGER NOT NULL,
    "min_ms" DOUBLE PRECISION NOT NULL,
    "max_ms" DOUBLE PRECISION NOT NULL,
    "mean_ms" DOUBLE PRECISION NOT NULL,
    "percentiles" JSONB NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_series_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "scope", "name", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

CREATE INDEX "run_series_bucket_run_idx"
  ON "run_series_bucket" ("run_started_on", "run_id", "scope", "name");

-- Twelve months from 2026-01. Automatic rollover is a later milestone; until
-- then a write past the last partition fails loudly rather than silently
-- landing somewhere wrong.
CREATE TABLE "run_series_bucket_2026_01" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_series_bucket_2026_02" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_series_bucket_2026_03" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_series_bucket_2026_04" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_series_bucket_2026_05" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_series_bucket_2026_06" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_series_bucket_2026_07" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_series_bucket_2026_08" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_series_bucket_2026_09" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_series_bucket_2026_10" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_series_bucket_2026_11" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_series_bucket_2026_12" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
```

Delete any generated `CREATE UNIQUE INDEX "run_series_bucket_pkey"` or plain `CREATE TABLE "run_series_bucket"` left behind by Prisma, so the statement above is the only definition.

- [ ] **Step 7: Write the client module**

`packages/persistence/src/client.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

/**
 * Prisma owns schema, migrations, and CRUD. The metric tables are written and
 * read with raw parameterized SQL through this pool: Prisma is weak at bytea
 * payloads, batched inserts of tens of thousands of rows, and analytical
 * aggregation, and that is where query performance would quietly rot.
 */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export const SCHEMA_TABLES = [
  'org',
  'project',
  'api_token',
  'run',
  'run_stat',
  'run_series_bucket',
  'run_error',
  'sla_rule',
  'run_assertion',
] as const;
```

`packages/persistence/src/index.ts`:

```ts
export * from './client.js';
```

- [ ] **Step 8: Apply the migration and run the tests**

```bash
cd packages/persistence
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
cd ../..
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/migrations.integration.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Falsify the partition assertion**

Prove the test would catch an unpartitioned table:

```bash
psql "$DATABASE_URL" -c 'ALTER TABLE run_series_bucket RENAME TO run_series_bucket_tmp;'
psql "$DATABASE_URL" -c 'CREATE TABLE run_series_bucket (run_started_on DATE NOT NULL);'
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/migrations.integration.test.ts
```

Expected: FAIL on "partitions run_series_bucket by range". Then restore:

```bash
psql "$DATABASE_URL" -c 'DROP TABLE run_series_bucket; ALTER TABLE run_series_bucket_tmp RENAME TO run_series_bucket;'
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/migrations.integration.test.ts
```

Expected: PASS again.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(persistence): schema and migrations for the ingest spine

Nine tables, every one scoped by org_id and project_id. Neither tenancy nor
partitioning is needed by this slice; both are migrations you plan an outage
around if deferred, so they land in the first one.

run_series_bucket is partitioned by range on run_started_on, which is what
makes retention a partition drop rather than a delete storm (NFR-SC-7). A
primary key on a partitioned table must contain the partition key, which is
why run_started_on leads it — and why every read must pass it. Prisma cannot
express partitioning, so migration 0001 is hand-edited; Prisma's
introspection ignores partitioning, so this does not register as drift.

Twelve months of partitions are pre-created. Automatic rollover is a later
milestone; until then a write past the last partition fails loudly rather
than landing somewhere wrong."
```

---

## Task 6: Tenancy-scoped repositories

Prisma CRUD for the six relational tables. Every method takes a `TenantScope` it cannot omit — tenancy is enforced by the type system, not by remembering to add a `WHERE`.

**Files:**
- Create: `packages/persistence/test/support/db.ts`
- Create: `packages/persistence/src/repositories/{tenant,project,token,run,rule}.ts`
- Create: `packages/persistence/test/repositories.integration.test.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Consumes: `createPrisma`, `createPool`.
- Produces:
  - `interface TenantScope { orgId: string; projectId: string }`
  - `class ProjectRepository { findBySlug(orgSlug, projectSlug): Promise<ProjectRecord | null>; settings(scope): Promise<ProjectSettings> }`
  - `class TokenRepository { findByPrefix(prefix): Promise<TokenRecord | null>; touch(id): Promise<void> }`
  - `class RunRepository { create(input): Promise<RunRecord>; findById(scope, id): Promise<RunRecord | null>; findByIdempotencyKey(scope, key): Promise<RunRecord | null>; markParsing(id): Promise<void>; complete(id, verdict, toolVersion): Promise<void>; fail(id, error): Promise<void>; list(scope, opts): Promise<{ items: RunRecord[]; nextCursor: string | null }>; claimStale(olderThanMs): Promise<string[]> }`
  - `class RuleRepository { listEnabled(scope): Promise<SlaRuleRecord[]> }`
  - `resetDatabase(pool): Promise<void>`, `seedTenant(prisma): Promise<{ orgId, projectId, tokenPrefix, tokenSecret }>`

- [ ] **Step 1: Write the test-support helper**

`packages/persistence/test/support/db.ts`:

```ts
import type pg from 'pg';
import { SCHEMA_TABLES } from '../../src/index.js';

/** TRUNCATE, not DROP: the schema is migrated once per run, the data per test. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for integration tests. Run: docker compose -f infra/docker-compose.yml up -d',
    );
  }
  return url;
}
```

- [ ] **Step 2: Write the failing test**

`packages/persistence/test/repositories.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  ProjectRepository,
  RunRepository,
  TokenRepository,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

async function seed() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const p1 = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const p2 = await prisma.project.create({
    data: { orgId: org.id, slug: 'search', name: 'Search', settings: {} },
  });
  return { orgId: org.id, a: p1.id, b: p2.id };
}

function runInput(orgId: string, projectId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    orgId,
    projectId,
    tool: 'gatling',
    bundleKey: 'bundles/x.tgz',
    bundleSha256: 'a'.repeat(64),
    bundleBytes: 1234,
    startedAt: new Date('2026-08-07T10:00:00Z'),
    engineOptions: { warmupMs: 0, percentiles: [50, 95] },
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('RunRepository tenancy', () => {
  it('will not return a run belonging to another project', async () => {
    const { orgId, a, b } = await seed();
    const run = await new RunRepository(prisma).create(runInput(orgId, a));

    const repo = new RunRepository(prisma);
    expect(await repo.findById({ orgId, projectId: a }, run.id)).not.toBeNull();
    expect(await repo.findById({ orgId, projectId: b }, run.id)).toBeNull();
  });

  it('derives startedOn from startedAt so the partition key is never wrong', async () => {
    const { orgId, a } = await seed();
    const run = await new RunRepository(prisma).create(
      runInput(orgId, a, { startedAt: new Date('2026-03-14T23:59:59Z') }),
    );
    expect(run.startedOn.toISOString().slice(0, 10)).toBe('2026-03-14');
  });
});

describe('RunRepository idempotency', () => {
  it('returns the original run for a repeated key instead of creating a second', async () => {
    const { orgId, a } = await seed();
    const repo = new RunRepository(prisma);
    const first = await repo.create(runInput(orgId, a, { idempotencyKey: 'build-42' }));

    const found = await repo.findByIdempotencyKey({ orgId, projectId: a }, 'build-42');
    expect(found?.id).toBe(first.id);
  });

  it('scopes idempotency to the project — the same key in another project is a new run', async () => {
    const { orgId, a, b } = await seed();
    const repo = new RunRepository(prisma);
    await repo.create(runInput(orgId, a, { idempotencyKey: 'build-42' }));
    const other = await repo.create(runInput(orgId, b, { idempotencyKey: 'build-42' }));
    expect(other.id).toBeTruthy();
    expect(await repo.findByIdempotencyKey({ orgId, projectId: b }, 'build-42')).not.toBeNull();
  });
});

describe('RunRepository.claimStale', () => {
  it('returns pending runs older than the window and ignores fresh ones', async () => {
    const { orgId, a } = await seed();
    const repo = new RunRepository(prisma);
    const stale = await repo.create(
      runInput(orgId, a, { startedAt: new Date('2026-08-07T10:00:00Z') }),
    );
    const fresh = await repo.create(runInput(orgId, a));

    // Age the first run's ingest clock past the window.
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      stale.id,
    ]);

    const claimed = await repo.claimStale(60_000);
    expect(claimed).toContain(stale.id);
    expect(claimed).not.toContain(fresh.id);
  });
});

describe('ProjectRepository', () => {
  it('resolves a project by org and project slug', async () => {
    await seed();
    const found = await new ProjectRepository(prisma).findBySlug('acme', 'checkout');
    expect(found?.slug).toBe('checkout');
  });

  it('returns null for a project in an org that does not own it', async () => {
    await seed();
    expect(await new ProjectRepository(prisma).findBySlug('nope', 'checkout')).toBeNull();
  });
});

describe('TokenRepository', () => {
  it('finds an active token by prefix and reports a revoked one as revoked', async () => {
    const { orgId, a } = await seed();
    await prisma.apiToken.create({
      data: {
        orgId,
        projectId: a,
        name: 'ci',
        prefix: 'pp_live_abc',
        tokenHash: 'hash',
        scopes: ['ingest'],
      },
    });
    const repo = new TokenRepository(prisma);
    const t = await repo.findByPrefix('pp_live_abc');
    expect(t?.scopes).toEqual(['ingest']);
    expect(t?.revokedAt).toBeNull();
    expect(await repo.findByPrefix('pp_live_missing')).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/repositories.integration.test.ts
```

Expected: FAIL — `RunRepository` is not exported.

- [ ] **Step 4: Add the `created_at` column the sweeper needs**

`claimStale` must age off **when the run row was created**, not when the load test started — a CI job can post a three-hour-old run. Add to the `Run` model in `schema.prisma`:

```prisma
  createdAt      DateTime  @default(now()) @map("created_at")
```

and change the sweeper index to:

```prisma
  @@index([status, createdAt])
```

Then generate and apply a second migration:

```bash
cd packages/persistence
pnpm exec prisma migrate dev --name run_created_at --schema prisma/schema.prisma
cd ../..
```

- [ ] **Step 5: Write the repositories**

`packages/persistence/src/repositories/tenant.ts`:

```ts
/**
 * Every repository method takes this. Tenancy is a required parameter, not a
 * convention someone remembers — a query that forgets it will not compile.
 */
export interface TenantScope {
  readonly orgId: string;
  readonly projectId: string;
}
```

`packages/persistence/src/repositories/project.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface ProjectRecord {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  settings: ProjectSettings;
}

/** The EngineOptions the shipped statistics engine already accepts. */
export interface ProjectSettings {
  warmupMs?: number;
  lowerMs?: number;
  higherMs?: number;
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
  waitMs?: number;
  maxBundleBytes?: number;
}

export class ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findBySlug(orgSlug: string, projectSlug: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({
      where: { slug: projectSlug, org: { slug: orgSlug } },
    });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      settings: (row.settings ?? {}) as ProjectSettings,
    };
  }

  async settings(scope: TenantScope): Promise<ProjectSettings> {
    const row = await this.prisma.project.findFirst({
      where: { id: scope.projectId, orgId: scope.orgId },
    });
    return (row?.settings ?? {}) as ProjectSettings;
  }
}
```

`packages/persistence/src/repositories/token.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

export interface TokenRecord {
  id: string;
  orgId: string;
  projectId: string;
  prefix: string;
  tokenHash: string;
  scopes: string[];
  revokedAt: Date | null;
}

export class TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** One indexed row read; the caller then performs exactly one hash verification. */
  async findByPrefix(prefix: string): Promise<TokenRecord | null> {
    const row = await this.prisma.apiToken.findUnique({ where: { prefix } });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      prefix: row.prefix,
      tokenHash: row.tokenHash,
      scopes: row.scopes,
      revokedAt: row.revokedAt,
    };
  }

  async touch(id: string): Promise<void> {
    await this.prisma.apiToken.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
```

`packages/persistence/src/repositories/run.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface RunRecord {
  id: string;
  orgId: string;
  projectId: string;
  status: string;
  verdict: string | null;
  tool: string;
  toolVersion: string | null;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  idempotencyKey: string | null;
  startedAt: Date;
  startedOn: Date;
  ingestedAt: Date | null;
  engineOptions: Record<string, unknown>;
  error: { code: string; message: string; remediation: string } | null;
}

export interface CreateRunInput {
  orgId: string;
  projectId: string;
  tool: string;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  idempotencyKey?: string;
  startedAt: Date;
  engineOptions: Record<string, unknown>;
}

function toRecord(row: {
  id: string; orgId: string; projectId: string; status: string; verdict: string | null;
  tool: string; toolVersion: string | null; bundleKey: string; bundleSha256: string;
  bundleBytes: bigint; idempotencyKey: string | null; startedAt: Date; startedOn: Date;
  ingestedAt: Date | null; engineOptions: unknown; error: unknown;
}): RunRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    status: row.status,
    verdict: row.verdict,
    tool: row.tool,
    toolVersion: row.toolVersion,
    bundleKey: row.bundleKey,
    bundleSha256: row.bundleSha256,
    bundleBytes: Number(row.bundleBytes),
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt,
    startedOn: row.startedOn,
    ingestedAt: row.ingestedAt,
    engineOptions: (row.engineOptions ?? {}) as Record<string, unknown>,
    error: (row.error ?? null) as RunRecord['error'],
  };
}

/** UTC date of the run start — the partition key. Derived, never supplied. */
function startedOnFrom(startedAt: Date): Date {
  return new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()));
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const row = await this.prisma.run.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        status: 'pending',
        verdict: null,
        tool: input.tool,
        bundleKey: input.bundleKey,
        bundleSha256: input.bundleSha256,
        bundleBytes: BigInt(input.bundleBytes),
        idempotencyKey: input.idempotencyKey ?? null,
        startedAt: input.startedAt,
        startedOn: startedOnFrom(input.startedAt),
        engineOptions: input.engineOptions as object,
      },
    });
    return toRecord(row);
  }

  async findById(scope: TenantScope, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
    });
    return row ? toRecord(row) : null;
  }

  /** Unscoped by design: the worker holds a job, not a caller's credential. */
  async findByIdUnscoped(id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(scope: TenantScope, key: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { orgId: scope.orgId, projectId: scope.projectId, idempotencyKey: key },
    });
    return row ? toRecord(row) : null;
  }

  async markParsing(id: string): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { status: 'parsing' } });
  }

  async complete(id: string, verdict: string, toolVersion: string | null): Promise<void> {
    await this.prisma.run.update({
      where: { id },
      data: { status: 'complete', verdict, toolVersion, ingestedAt: new Date() },
    });
  }

  async fail(id: string, error: { code: string; message: string; remediation: string }): Promise<void> {
    await this.prisma.run.update({
      where: { id },
      data: { status: 'failed', error, ingestedAt: new Date() },
    });
  }

  async list(
    scope: TenantScope,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: RunRecord[]; nextCursor: string | null }> {
    const rows = await this.prisma.run.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(toRecord), nextCursor: next };
  }

  /**
   * Orphan recovery: a run committed but whose queue enqueue never landed.
   * Ages off created_at, not startedAt — a CI job can post a three-hour-old run.
   */
  async claimStale(olderThanMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.run.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    return rows.map((r) => r.id);
  }
}
```

`packages/persistence/src/repositories/rule.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface SlaRuleRecord {
  id: string;
  scope: 'run' | 'scenario' | 'group' | 'request';
  targetName: string | null;
  family: 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
}

export class RuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listEnabled(scope: TenantScope): Promise<SlaRuleRecord[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId, enabled: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as SlaRuleRecord['scope'],
      targetName: r.targetName,
      family: r.family as SlaRuleRecord['family'],
      metric: r.metric,
      comparator: r.comparator as SlaRuleRecord['comparator'],
      threshold: r.threshold,
    }));
  }
}
```

Add to `packages/persistence/src/index.ts`:

```ts
export * from './repositories/tenant.js';
export * from './repositories/project.js';
export * from './repositories/token.js';
export * from './repositories/run.js';
export * from './repositories/rule.js';
```

- [ ] **Step 6: Run the tests**

```bash
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/repositories.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Falsify the tenancy guard**

In `RunRepository.findById`, drop `projectId` from the `where` clause. Re-run.

Expected: FAIL on "will not return a run belonging to another project". Restore.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(persistence): tenancy-scoped repositories

Every method takes a TenantScope it cannot omit, so a cross-tenant read is a
compile error rather than a forgotten WHERE clause. Falsified: removing
projectId from findById makes the cross-project test fail.

startedOn is derived from startedAt inside create(), never supplied by a
caller — it is the partition key, and a wrong value would file a run's
buckets under the wrong month or fail the write outright.

claimStale ages off created_at rather than startedAt: a CI job can post a
run that started hours earlier, and aging off the load test's own clock
would sweep it the moment it arrived."
```

---

## Task 7: Metric writers and readers

Raw parameterized SQL. The sketch round-trip through `bytea` and the partition-pruning predicate are the two things that silently break.

**Files:**
- Create: `packages/persistence/src/metrics/{write,read}.ts`
- Create: `packages/persistence/test/metrics.integration.test.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Consumes: `pg.Pool`; `EngineResult`, `StatRollup`, `Sketch`, `SKETCH_KIND` from `@perfportal/statistics`.
- Produces:
  - `class MetricWriter { persist(client: pg.PoolClient, ctx: MetricContext, result: EngineResult): Promise<void> }`
  - `interface MetricContext { runId: string; orgId: string; projectId: string; runStartedOn: Date }`
  - `class MetricReader { stats(scope, runId): Promise<StoredStat[]>; sketch(scope, runId, key): Promise<Sketch | null>; series(scope, runId, runStartedOn, sel): Promise<StoredBucket[]>; errors(scope, runId): Promise<{message,count}[]> }`

- [ ] **Step 1: Write the failing test**

`packages/persistence/test/metrics.integration.test.ts`:

```ts
import { runEngine } from '@perfportal/statistics';
import type { CanonicalEvent } from '@perfportal/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, MetricReader, MetricWriter } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');

function events(): CanonicalEvent[] {
  const base = STARTED_AT.getTime();
  const out: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
  ];
  for (let i = 0; i < 400; i++) {
    out.push({
      type: 'request',
      name: i % 2 === 0 ? 'GET /a' : 'GET /b',
      groups: [],
      userId: String(i),
      startMs: base + i * 25,
      endMs: base + i * 25 + (i % 13) * 40 + 5,
      ok: i % 17 !== 0,
      message: i % 17 === 0 ? 'status 500' : undefined,
    });
  }
  return out;
}

async function seedRun() {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const run = await prisma.run.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      status: 'parsing',
      tool: 'gatling',
      bundleKey: 'k',
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id };
}

async function persist(ctx: { orgId: string; projectId: string; runId: string }) {
  const result = runEngine(events(), { percentiles: [50, 95, 99] });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await new MetricWriter().persist(client, { ...ctx, runStartedOn: STARTED_ON }, result);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return result;
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('MetricWriter / MetricReader', () => {
  it('round-trips stats with the values the engine produced', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);

    const stored = await new MetricReader(pool).stats({ orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId);
    const engineRun = result.stats.find((s) => s.scope === 'run');
    const storedRun = stored.find((s) => s.scope === 'run');

    expect(storedRun).toBeDefined();
    expect(storedRun?.count).toBe(engineRun?.count);
    expect(storedRun?.koCount).toBe(engineRun?.koCount);
    expect(storedRun?.maxMs).toBeCloseTo(engineRun?.maxMs ?? -1, 6);
    expect(storedRun?.stddevMs).toBeCloseTo(engineRun?.stddevMs ?? -1, 6);
    expect(storedRun?.percentiles['p95']).toBeCloseTo(engineRun?.percentiles['p95'] ?? -1, 6);
  });

  it('round-trips the sketch through bytea so percentiles are answerable after reload', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);

    const reloaded = await new MetricReader(pool).sketch(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
      { scope: 'run', name: '', family: 'response_time' },
    );
    const original = result.stats.find((s) => s.scope === 'run')?.sketch;

    expect(reloaded).not.toBeNull();
    expect(reloaded!.count).toBe(original!.count);
    for (const q of [0.5, 0.95, 0.99]) {
      expect(reloaded!.quantile(q)).toBeCloseTo(original!.quantile(q), 6);
    }
  });

  it('answers a percentile that was never stored in the JSONB — the point of keeping the sketch', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    const stored = await new MetricReader(pool).stats({ orgId: ctx.orgId, projectId: ctx.projectId }, ctx.runId);
    expect(Object.keys(stored[0]!.percentiles)).not.toContain('p99.9');

    const sketch = await new MetricReader(pool).sketch(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
      { scope: 'run', name: '', family: 'response_time' },
    );
    expect(Number.isFinite(sketch!.quantile(0.999))).toBe(true);
  });

  it('round-trips series buckets and error rows', async () => {
    const ctx = await seedRun();
    const result = await persist(ctx);
    const reader = new MetricReader(pool);
    const tenant = { orgId: ctx.orgId, projectId: ctx.projectId };

    const buckets = await reader.series(tenant, ctx.runId, STARTED_ON, { scope: 'run', name: '' });
    const expected = result.series.get('run ')?.buckets ?? [];
    expect(buckets).toHaveLength(expected.length);
    expect(buckets.reduce((a, b) => a + b.startedCount, 0)).toBe(
      expected.reduce((a, b) => a + b.startedCount, 0),
    );

    const errors = await reader.errors(tenant, ctx.runId);
    expect(errors.reduce((a, e) => a + e.count, 0)).toBe(
      result.errors.reduce((a, e) => a + e.count, 0),
    );
  });

  it('will not read another project\'s metrics', async () => {
    const ctx = await seedRun();
    await persist(ctx);
    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: '00000000-0000-0000-0000-000000000000' },
      ctx.runId,
    );
    expect(stats).toEqual([]);
  });

  it('prunes partitions — the series query plan touches one partition, not twelve', async () => {
    const ctx = await seedRun();
    await persist(ctx);

    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT * FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2 AND scope = $3 AND name = $4`,
      [STARTED_ON, ctx.runId, 'run', ''],
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const scanned = (plan.match(/run_series_bucket_2026_\d\d/g) ?? []).length;
    expect(scanned).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts
```

Expected: FAIL — `MetricWriter` is not exported.

- [ ] **Step 3: Write the writer**

`packages/persistence/src/metrics/write.ts`:

```ts
import type { EngineResult } from '@perfportal/statistics';
import { SKETCH_KIND } from '@perfportal/statistics';
import type pg from 'pg';

export interface MetricContext {
  runId: string;
  orgId: string;
  projectId: string;
  /** The partition key. Must match run.started_on exactly. */
  runStartedOn: Date;
}

/** Rows per INSERT statement. Postgres caps a statement at 65535 parameters. */
const BATCH = 500;

async function insertBatched(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')}`, params);
  }
}

export class MetricWriter {
  /**
   * Writes stats, series buckets, and errors. The caller owns the transaction:
   * statistics, assertions, and the run's terminal status commit together, so a
   * run is never observable with stats but no verdict.
   *
   * Batched parameterized INSERT rather than COPY — at ~30k bucket rows that is
   * ~60 statements, and it avoids hand-rolled COPY text escaping for a
   * throughput requirement that is out of scope for this slice.
   */
  async persist(client: pg.PoolClient, ctx: MetricContext, result: EngineResult): Promise<void> {
    await insertBatched(
      client,
      'run_stat',
      [
        'id', 'run_id', 'org_id', 'project_id', 'scope', 'name', 'family',
        'count', 'ok_count', 'ko_count', 'error_rate',
        'min_ms', 'max_ms', 'mean_ms', 'stddev_ms', 'throughput_rps',
        'percentiles', 'sketch', 'sketch_kind',
      ],
      result.stats.map((s) => [
        crypto.randomUUID(),
        ctx.runId, ctx.orgId, ctx.projectId,
        s.scope, s.name, s.family,
        s.count, s.okCount, s.koCount, s.errorRate,
        s.minMs, s.maxMs, s.meanMs, s.stddevMs, s.throughputRps,
        JSON.stringify(s.percentiles),
        Buffer.from(s.sketch.serialize()),
        SKETCH_KIND,
      ]),
    );

    const bucketRows: unknown[][] = [];
    for (const entry of result.series.values()) {
      for (const b of entry.buckets) {
        bucketRows.push([
          ctx.runStartedOn, ctx.runId, ctx.orgId, ctx.projectId,
          entry.scope, entry.name, b.startOffsetMs,
          b.startedCount, b.endedCount, b.okCount, b.koCount,
          b.sketch.count === 0 ? 0 : b.sketch.min,
          b.sketch.count === 0 ? 0 : b.sketch.max,
          b.sketch.count === 0 ? 0 : b.sketch.sum / b.sketch.count,
          // Only the configured percentiles are stored per bucket; per spec §9.1
          // bucket sketches are deliberately not persisted.
          JSON.stringify(percentilesOf(b.sketch, result)),
        ]);
      }
    }
    await insertBatched(
      client,
      'run_series_bucket',
      [
        'run_started_on', 'run_id', 'org_id', 'project_id',
        'scope', 'name', 'start_offset_ms',
        'started_count', 'ended_count', 'ok_count', 'ko_count',
        'min_ms', 'max_ms', 'mean_ms', 'percentiles',
      ],
      bucketRows,
    );

    await insertBatched(
      client,
      'run_error',
      ['id', 'run_id', 'org_id', 'project_id', 'message', 'count'],
      result.errors.map((e) => [
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId, e.message, e.count,
      ]),
    );
  }
}

/** Percentile set is taken from any run-scope rollup, which carries the configured keys. */
function percentilesOf(
  sketch: { count: number; quantile(q: number): number },
  result: EngineResult,
): Record<string, number> {
  const keys = Object.keys(result.stats[0]?.percentiles ?? { p50: 0, p95: 0, p99: 0 });
  const out: Record<string, number> = {};
  if (sketch.count === 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  for (const k of keys) {
    const p = Number(k.slice(1));
    out[k] = sketch.quantile(p / 100);
  }
  return out;
}
```

- [ ] **Step 4: Write the reader**

`packages/persistence/src/metrics/read.ts`:

```ts
import { Sketch } from '@perfportal/statistics';
import type pg from 'pg';
import type { TenantScope } from '../repositories/tenant.js';

export interface StoredStat {
  scope: string;
  name: string;
  family: string;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  percentiles: Record<string, number>;
}

export interface StoredBucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  percentiles: Record<string, number>;
}

export interface StatKey {
  scope: string;
  name: string;
  family: string;
}

export class MetricReader {
  constructor(private readonly pool: pg.Pool) {}

  async stats(scope: TenantScope, runId: string): Promise<StoredStat[]> {
    const { rows } = await this.pool.query(
      `SELECT scope, name, family, count, ok_count, ko_count, error_rate,
              min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles
         FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
        ORDER BY scope, name, family`,
      [runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({
      scope: r.scope,
      name: r.name,
      family: r.family,
      count: r.count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      errorRate: r.error_rate,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      stddevMs: r.stddev_ms,
      throughputRps: r.throughput_rps,
      percentiles: r.percentiles as Record<string, number>,
    }));
  }

  /**
   * The stored summary sketch. This is what lets an SLA rule ask for p99.9 when
   * the project's stored percentile set is [50, 75, 95, 99] (spec §8.2).
   */
  async sketch(scope: TenantScope, runId: string, key: StatKey): Promise<Sketch | null> {
    const { rows } = await this.pool.query<{ sketch: Buffer }>(
      `SELECT sketch FROM run_stat
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
          AND scope = $4 AND name = $5 AND family = $6`,
      [runId, scope.orgId, scope.projectId, key.scope, key.name, key.family],
    );
    const buf = rows[0]?.sketch;
    return buf ? Sketch.deserialize(new Uint8Array(buf)) : null;
  }

  /**
   * runStartedOn is REQUIRED, not optional. It is the partition key: a query
   * filtering on run_id alone cannot prune and scans every partition. The
   * signature is what enforces that, and a test asserts the plan.
   */
  async series(
    scope: TenantScope,
    runId: string,
    runStartedOn: Date,
    sel: { scope: string; name: string },
  ): Promise<StoredBucket[]> {
    const { rows } = await this.pool.query(
      `SELECT start_offset_ms, started_count, ended_count, ok_count, ko_count,
              min_ms, max_ms, mean_ms, percentiles
         FROM run_series_bucket
        WHERE run_started_on = $1 AND run_id = $2
          AND org_id = $3 AND project_id = $4
          AND scope = $5 AND name = $6
        ORDER BY start_offset_ms`,
      [runStartedOn, runId, scope.orgId, scope.projectId, sel.scope, sel.name],
    );
    return rows.map((r) => ({
      startOffsetMs: r.start_offset_ms,
      startedCount: r.started_count,
      endedCount: r.ended_count,
      okCount: r.ok_count,
      koCount: r.ko_count,
      minMs: r.min_ms,
      maxMs: r.max_ms,
      meanMs: r.mean_ms,
      percentiles: r.percentiles as Record<string, number>,
    }));
  }

  async errors(scope: TenantScope, runId: string): Promise<{ message: string; count: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT message, count FROM run_error
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3
        ORDER BY count DESC, message ASC`,
      [runId, scope.orgId, scope.projectId],
    );
    return rows.map((r) => ({ message: r.message, count: r.count }));
  }
}
```

Add to `packages/persistence/src/index.ts`:

```ts
export * from './metrics/write.js';
export * from './metrics/read.js';
```

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/metrics.integration.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Falsify the partition-pruning assertion**

In `MetricReader.series`, remove `run_started_on = $1 AND` from the `WHERE` clause and shift the parameter indices down. Re-run.

Expected: FAIL on "prunes partitions" — the plan will list all twelve partitions. Restore.

- [ ] **Step 7: Falsify the sketch round-trip**

In `MetricWriter.persist`, replace `Buffer.from(s.sketch.serialize())` with `Buffer.alloc(0)`. Re-run.

Expected: FAIL on the sketch round-trip test. Restore.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(persistence): raw-SQL metric writers and readers

Prisma owns CRUD; these three tables are raw SQL, because Prisma is weak at
bytea payloads, batched inserts of tens of thousands of rows, and analytical
aggregation — the boundary where query performance would quietly rot.

MetricReader.series takes runStartedOn as a REQUIRED parameter. It is the
partition key, and a query filtering on run_id alone cannot prune and scans
every partition; the signature is what enforces it, and an EXPLAIN test
asserts exactly one partition is touched. Falsified by dropping the
predicate: the plan then lists all twelve.

Summary sketches persist as bytea and reload answering percentiles that were
never stored in the JSONB — which is what lets an SLA rule ask for p99.9
against a project configured for [50, 75, 95, 99]."
```

---

## Task 8: Object storage and the bundle source

The API streams the upload to S3 while hashing it inline; the worker fetches it back and presents it to a plugin as a `BundleSource`. The size cap lives here, and it is what makes the in-memory parse decision (spec §5.1) safe.

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/tsconfig.json`
- Create: `packages/storage/src/{index,blobs,bundle}.ts`
- Create: `packages/storage/test/{blobs,bundle}.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `ingestError` from `@perfportal/core`.
- Produces:
  - `class BlobStore { constructor(cfg: BlobConfig); putStream(key, body: Readable, maxBytes): Promise<{ sha256: string; bytes: number }>; get(key): Promise<Buffer>; ensureBucket(): Promise<void> }`
  - `interface BlobConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean }`
  - `openTarGzBundle(archive: Buffer): Promise<BundleSource>`

- [ ] **Step 1: Write the failing tests**

`packages/storage/test/bundle.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openTarGzBundle } from '../src/index.js';

function makeArchive(files: Record<string, Buffer | string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const root = join(dir, 'results');
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'results']);
  return readFileSync(out);
}

describe('openTarGzBundle', () => {
  it('lists entries with POSIX-relative paths', async () => {
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': 'x', 'index.html': 'y' }));
    expect([...src.index.files].sort()).toEqual(['results/index.html', 'results/simulation.log']);
  });

  it('reads a whole file back byte-for-byte', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': payload }));
    expect(Buffer.from(await src.read('results/simulation.log'))).toEqual(payload);
  });

  it('head returns only the requested prefix, never the whole file', async () => {
    const payload = Buffer.alloc(4096, 7);
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': payload }));
    const head = await src.index.head('results/simulation.log', 16);
    expect(head).toHaveLength(16);
  });

  it('rejects a bundle that is not a gzip archive, with remediation', async () => {
    await expect(openTarGzBundle(Buffer.from('this is not a tarball'))).rejects.toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('rejects an archive containing no files', async () => {
    await expect(openTarGzBundle(makeArchive({}))).rejects.toMatchObject({ code: 'BUNDLE_EMPTY' });
  });

  it('refuses a path traversal entry rather than writing outside the bundle', async () => {
    // tar entries named ../x must never be honoured; the reader is in-memory,
    // but a consumer resolving these against a temp dir would escape it.
    const dir = mkdtempSync(join(tmpdir(), 'evil-'));
    writeFileSync(join(dir, 'payload'), 'x');
    const out = join(dir, 'evil.tgz');
    execFileSync('tar', ['-czf', out, '-C', dir, '--transform', 's|payload|../escape|', 'payload']);
    await expect(openTarGzBundle(readFileSync(out))).rejects.toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
    });
  });
});
```

`packages/storage/test/blobs.integration.test.ts`:

```ts
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/index.js';

const cfg = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  bucket: `test-${randomUUID()}`,
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'perfportal',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'perfportal123',
  forcePathStyle: true,
};

const store = new BlobStore(cfg);

afterAll(async () => {
  /* the bucket is per-run and disposable */
});

describe('BlobStore', () => {
  it('stores a stream and reports the sha256 computed inline', async () => {
    await store.ensureBucket();
    const payload = Buffer.from('hello bundle');
    const expected = createHash('sha256').update(payload).digest('hex');

    const res = await store.putStream('runs/a.tgz', Readable.from([payload]), 1_000_000);
    expect(res.sha256).toBe(expected);
    expect(res.bytes).toBe(payload.length);
    expect(await store.get('runs/a.tgz')).toEqual(payload);
  });

  it('aborts past the size cap instead of buffering an unbounded body', async () => {
    await store.ensureBucket();
    const big = Readable.from([Buffer.alloc(2048, 1), Buffer.alloc(2048, 2)]);
    await expect(store.putStream('runs/big.tgz', big, 1024)).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
      remediation: expect.stringMatching(/.+/),
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm vitest run --config vitest.integration.config.ts packages/storage/test/
```

Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Create the package**

`packages/storage/package.json`:

```json
{
  "name": "@perfportal/storage",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "perfportal-source": "./src/index.ts",
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "@aws-sdk/client-s3": "^3.658.0",
    "@perfportal/core": "workspace:*",
    "tar-stream": "^3.1.7"
  },
  "devDependencies": {
    "@types/tar-stream": "^3.1.3"
  }
}
```

`packages/storage/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

Add `{ "path": "packages/storage" }` to root `tsconfig.json` references.

- [ ] **Step 4: Write the blob store**

`packages/storage/src/blobs.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ingestError } from '@perfportal/core';

export interface BlobConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class BlobStore {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(cfg: BlobConfig) {
    this.#bucket = cfg.bucket;
    this.#s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle ?? true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#s3.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch {
      await this.#s3.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  /**
   * Streams the body to object storage, hashing and counting inline. The cap is
   * enforced DURING the stream, so an oversized upload is aborted rather than
   * buffered — this is what makes the in-memory parse of spec §5.1 safe.
   *
   * The bundle is durable before any row references it (spec §6.1 step order).
   */
  async putStream(
    key: string,
    body: Readable,
    maxBytes: number,
  ): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    const chunks: Buffer[] = [];

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          cb(
            ingestError('BUNDLE_TOO_LARGE', {
              message: `Bundle exceeds the ${maxBytes}-byte limit for this project.`,
              remediation:
                'Archive only the Gatling results directory, without the bundled js/ and style/ vendor assets, or raise the limit in project settings.',
              detail: { maxBytes },
            }),
          );
          return;
        }
        hash.update(chunk);
        chunks.push(chunk);
        cb(null, chunk);
      },
    });

    await pipeline(body, meter);

    await this.#s3.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: Buffer.concat(chunks) }),
    );
    return { sha256: hash.digest('hex'), bytes };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`empty body for ${key}`);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }
}
```

- [ ] **Step 5: Write the bundle reader**

`packages/storage/src/bundle.ts`:

```ts
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { ingestError, type BundleIndex, type BundleSource } from '@perfportal/core';
import { extract } from 'tar-stream';

/** Rejects absolute paths and any traversal segment. */
function safePath(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw ingestError('BUNDLE_NOT_ARCHIVE', {
      message: `The archive contains an unsafe entry path: ${name}`,
      remediation:
        'Re-create the archive from inside the results directory, without absolute or parent-relative paths.',
      detail: { entry: name },
    });
  }
  return normalized;
}

/**
 * Reads a gzipped tar into memory and presents it as a BundleSource.
 *
 * In memory by design (spec §5.1): the size cap in BlobStore.putStream bounds
 * this, and the worker is the only caller.
 */
export async function openTarGzBundle(archive: Buffer): Promise<BundleSource> {
  const files = new Map<string, Buffer>();

  await new Promise<void>((resolve, reject) => {
    const ex = extract();
    ex.on('entry', (header, stream, next) => {
      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }
      let path: string;
      try {
        path = safePath(header.name);
      } catch (err) {
        reject(err);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        files.set(path, Buffer.concat(chunks));
        next();
      });
      stream.on('error', reject);
    });
    ex.on('finish', resolve);
    ex.on('error', reject);

    Readable.from(archive)
      .pipe(createGunzip())
      .on('error', () =>
        reject(
          ingestError('BUNDLE_NOT_ARCHIVE', {
            message: 'The upload is not a gzipped tar archive.',
            remediation:
              'Upload the Gatling results directory as a .tar.gz, for example: tar -czf results.tgz -C target/gatling <run-directory>',
          }),
        ),
      )
      .pipe(ex);
  });

  if (files.size === 0) {
    throw ingestError('BUNDLE_EMPTY', {
      message: 'The archive contains no files.',
      remediation: 'Archive the Gatling results directory itself, not an empty parent directory.',
    });
  }

  const index: BundleIndex = {
    files: [...files.keys()],
    head: async (path, bytes) => {
      const f = files.get(path);
      if (!f) throw new Error(`no such entry: ${path}`);
      return new Uint8Array(f.subarray(0, bytes));
    },
  };

  return {
    index,
    read: async (path) => {
      const f = files.get(path);
      if (!f) throw new Error(`no such entry: ${path}`);
      return new Uint8Array(f);
    },
  };
}
```

`packages/storage/src/index.ts`:

```ts
export * from './blobs.js';
export * from './bundle.js';
```

- [ ] **Step 6: Run the tests**

```bash
pnpm install
pnpm vitest run --config vitest.integration.config.ts packages/storage/test/
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Falsify the size cap**

In `putStream`, change `if (bytes > maxBytes)` to `if (false)`. Re-run.

Expected: FAIL on "aborts past the size cap". Restore.

- [ ] **Step 8: Falsify the traversal guard**

In `safePath`, `return normalized` unconditionally. Re-run.

Expected: FAIL on "refuses a path traversal entry". Restore.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(storage): S3 blob store and tar.gz bundle source

putStream enforces the size cap DURING the stream, hashing and counting
inline, so an oversized upload is aborted rather than buffered. That cap is
what makes the in-memory parse decision of spec §5.1 safe: without it, one
pathological bundle exhausts a worker.

openTarGzBundle implements the BundleSource the worker hands to a plugin, so
plugins never touch the filesystem and the purity rule holds. Path traversal
entries are refused — falsified by removing the guard."
```

---

## Task 9: SLA evaluation

A pure function: rules plus stored stats plus sketches in, assertions and a verdict out. No database, no HTTP. This is where `not_applicable` earns its keep.

**Files:**
- Create: `packages/sla/package.json`, `packages/sla/tsconfig.json`
- Create: `packages/sla/src/{index,evaluate,metrics}.ts`
- Create: `packages/sla/test/evaluate.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `Sketch` from `@perfportal/statistics`; `StoredStat` shape from `@perfportal/persistence` (structurally, not imported — keeps this package pure).
- Produces:
  - `interface EvaluableStat { scope; name; family; count; okCount; koCount; errorRate; minMs; maxMs; meanMs; stddevMs; throughputRps; percentiles: Record<string, number>; sketch?: Sketch }`
  - `interface EvaluableRule { id; scope; targetName: string | null; family; metric: string; comparator: 'lte' | 'gte'; threshold: number }`
  - `interface EvaluatedAssertion { ruleId; outcome: 'passed' | 'failed' | 'not_applicable'; actualValue: number | null; message: string; ruleSnapshot: EvaluableRule }`
  - `evaluateRules(rules, stats): { assertions: EvaluatedAssertion[]; verdict: 'passed' | 'failed' | 'not_evaluated' }`
  - `resolveMetric(stat: EvaluableStat, metric: string): number | null`

- [ ] **Step 1: Write the failing test**

`packages/sla/test/evaluate.test.ts`:

```ts
import { Sketch } from '@perfportal/statistics';
import { describe, expect, it } from 'vitest';
import { evaluateRules, resolveMetric, type EvaluableRule, type EvaluableStat } from '../src/index.js';

function sketchOf(values: number[]): Sketch {
  const s = new Sketch();
  for (const v of values) s.accept(v);
  return s;
}

function stat(over: Partial<EvaluableStat> = {}): EvaluableStat {
  return {
    scope: 'run',
    name: '',
    family: 'response_time',
    count: 1000,
    okCount: 990,
    koCount: 10,
    errorRate: 0.01,
    minMs: 1,
    maxMs: 2000,
    meanMs: 220,
    stddevMs: 300,
    throughputRps: 50,
    percentiles: { p50: 100, p95: 700, p99: 1800 },
    sketch: sketchOf(Array.from({ length: 1000 }, (_, i) => i + 1)),
    ...over,
  };
}

function rule(over: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'p95',
    comparator: 'lte',
    threshold: 800,
    ...over,
  };
}

describe('resolveMetric', () => {
  it('reads a stored percentile from the JSONB', () => {
    expect(resolveMetric(stat(), 'p95')).toBe(700);
  });

  it('answers a percentile that was never stored, from the sketch', () => {
    const v = resolveMetric(stat(), 'p99.9');
    expect(v).not.toBeNull();
    expect(Math.abs(v! - 999) / 999).toBeLessThanOrEqual(0.01);
  });

  it('resolves the scalar metrics', () => {
    expect(resolveMetric(stat(), 'mean')).toBe(220);
    expect(resolveMetric(stat(), 'max')).toBe(2000);
    expect(resolveMetric(stat(), 'error_rate')).toBe(0.01);
    expect(resolveMetric(stat(), 'throughput_rps')).toBe(50);
    expect(resolveMetric(stat(), 'count')).toBe(1000);
  });

  it('returns null for an unknown metric rather than guessing', () => {
    expect(resolveMetric(stat(), 'p95th')).toBeNull();
  });

  it('returns null for a percentile when there is no sketch to fall back to', () => {
    expect(resolveMetric(stat({ sketch: undefined }), 'p99.9')).toBeNull();
  });
});

describe('evaluateRules', () => {
  it('passes when the value is within an lte threshold', () => {
    const r = evaluateRules([rule({ threshold: 800 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('passed');
    expect(r.assertions[0]?.actualValue).toBe(700);
    expect(r.verdict).toBe('passed');
  });

  it('fails when the value exceeds an lte threshold', () => {
    const r = evaluateRules([rule({ threshold: 500 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('failed');
    expect(r.verdict).toBe('failed');
  });

  it('treats the boundary as passing — lte means less than or equal', () => {
    const r = evaluateRules([rule({ threshold: 700 })], [stat()]);
    expect(r.assertions[0]?.outcome).toBe('passed');
  });

  it('handles gte in the same way', () => {
    const pass = evaluateRules([rule({ metric: 'throughput_rps', comparator: 'gte', threshold: 40 })], [stat()]);
    expect(pass.assertions[0]?.outcome).toBe('passed');
    const fail = evaluateRules([rule({ metric: 'throughput_rps', comparator: 'gte', threshold: 60 })], [stat()]);
    expect(fail.assertions[0]?.outcome).toBe('failed');
  });

  it('records not_applicable when the target is absent — never a silent pass', () => {
    const r = evaluateRules(
      [rule({ scope: 'request', targetName: 'GET /missing' })],
      [stat()],
    );
    expect(r.assertions[0]?.outcome).toBe('not_applicable');
    expect(r.assertions[0]?.actualValue).toBeNull();
    expect(r.assertions[0]?.message).toContain('GET /missing');
  });

  it('reports not_evaluated when every rule is not_applicable', () => {
    const r = evaluateRules([rule({ scope: 'request', targetName: 'GET /missing' })], [stat()]);
    expect(r.verdict).toBe('not_evaluated');
  });

  it('reports not_evaluated when there are no rules — a project without rules is not failing', () => {
    expect(evaluateRules([], [stat()]).verdict).toBe('not_evaluated');
  });

  it('fails the run if any rule fails, even when others pass', () => {
    const r = evaluateRules(
      [
        rule({ id: 'a', threshold: 800 }),
        rule({ id: 'b', threshold: 100 }),
        rule({ id: 'c', scope: 'request', targetName: 'GET /gone' }),
      ],
      [stat()],
    );
    expect(r.verdict).toBe('failed');
    expect(r.assertions.map((a) => a.outcome)).toEqual(['passed', 'failed', 'not_applicable']);
  });

  it('snapshots the rule as it read at evaluation time', () => {
    const original = rule({ threshold: 800 });
    const r = evaluateRules([original], [stat()]);
    original.threshold = 1;
    expect(r.assertions[0]?.ruleSnapshot.threshold).toBe(800);
  });

  it('matches a rule to the right family, not merely the right name', () => {
    const stats = [
      stat({ scope: 'group', name: 'Cart', family: 'group_duration', percentiles: { p95: 100 } }),
      stat({ scope: 'group', name: 'Cart', family: 'group_cumulated', percentiles: { p95: 900 } }),
    ];
    const r = evaluateRules(
      [rule({ scope: 'group', targetName: 'Cart', family: 'group_cumulated', threshold: 500 })],
      stats,
    );
    expect(r.assertions[0]?.actualValue).toBe(900);
    expect(r.assertions[0]?.outcome).toBe('failed');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/sla/test/evaluate.test.ts
```

Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Create the package**

`packages/sla/package.json`:

```json
{
  "name": "@perfportal/sla",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "perfportal-source": "./src/index.ts",
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "@perfportal/core": "workspace:*",
    "@perfportal/statistics": "workspace:*"
  }
}
```

`packages/sla/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src", "test"]
}
```

Add `{ "path": "packages/sla" }` to root `tsconfig.json` references.

Extend the ESLint purity glob to cover this package too — it must stay free of I/O. In `eslint.config.js`:

```js
    files: ['packages/{core,plugin-gatling,statistics,sla}/src/**/*.ts'],
```

- [ ] **Step 4: Write the metric resolver**

`packages/sla/src/metrics.ts`:

```ts
import type { Sketch } from '@perfportal/statistics';

export interface EvaluableStat {
  scope: string;
  name: string;
  family: string;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  throughputRps: number;
  percentiles: Record<string, number>;
  /** The persisted summary sketch, when loaded. */
  sketch?: Sketch;
}

const SCALARS: Record<string, (s: EvaluableStat) => number> = {
  count: (s) => s.count,
  mean: (s) => s.meanMs,
  min: (s) => s.minMs,
  max: (s) => s.maxMs,
  stddev: (s) => s.stddevMs,
  error_rate: (s) => s.errorRate,
  throughput_rps: (s) => s.throughputRps,
};

/** p50, p95, p99.9 — a percentile is p followed by a number in (0, 100). */
const PERCENTILE = /^p(\d+(?:\.\d+)?)$/;

/**
 * Percentiles come from the stored JSONB when present, and otherwise from the
 * summary sketch. That fallback is why summary sketches are persisted at all
 * (spec §9.1): a rule may ask for p99.9 while the project stores only
 * [50, 75, 95, 99], and the alternative would be freezing the answerable
 * percentile set at ingest time forever.
 */
export function resolveMetric(stat: EvaluableStat, metric: string): number | null {
  const scalar = SCALARS[metric];
  if (scalar) return scalar(stat);

  const m = PERCENTILE.exec(metric);
  if (!m) return null;

  const stored = stat.percentiles[metric];
  if (stored !== undefined) return stored;

  const p = Number(m[1]);
  if (!(p > 0 && p < 100)) return null;
  if (!stat.sketch || stat.sketch.count === 0) return null;
  return stat.sketch.quantile(p / 100);
}
```

- [ ] **Step 5: Write the evaluator**

`packages/sla/src/evaluate.ts`:

```ts
import { resolveMetric, type EvaluableStat } from './metrics.js';

export interface EvaluableRule {
  id: string;
  scope: string;
  /** null for run scope; the request or group name otherwise. */
  targetName: string | null;
  family: string;
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
}

export type AssertionOutcome = 'passed' | 'failed' | 'not_applicable';
export type Verdict = 'passed' | 'failed' | 'not_evaluated';

export interface EvaluatedAssertion {
  ruleId: string;
  outcome: AssertionOutcome;
  /** null when not_applicable — there was nothing to measure. */
  actualValue: number | null;
  message: string;
  /** The rule as it read at evaluation time. Editing a threshold later must
   *  never rewrite the history of what passed. */
  ruleSnapshot: EvaluableRule;
}

function describe(rule: EvaluableRule): string {
  const target = rule.targetName ?? 'the run';
  return `${rule.metric} of ${target} (${rule.family}) ${rule.comparator === 'lte' ? '≤' : '≥'} ${rule.threshold}`;
}

export function evaluateRules(
  rules: readonly EvaluableRule[],
  stats: readonly EvaluableStat[],
): { assertions: EvaluatedAssertion[]; verdict: Verdict } {
  const assertions: EvaluatedAssertion[] = [];

  for (const rule of rules) {
    const snapshot: EvaluableRule = { ...rule };
    const stat = stats.find(
      (s) =>
        s.scope === rule.scope &&
        s.name === (rule.targetName ?? '') &&
        s.family === rule.family,
    );

    if (!stat) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message: `No ${rule.family} statistics for ${rule.targetName ?? 'the run'} in this run, so ${describe(rule)} was not checked.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }

    const actual = resolveMetric(stat, rule.metric);
    if (actual === null || Number.isNaN(actual)) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message: `Metric "${rule.metric}" could not be resolved for ${rule.targetName ?? 'the run'}, so ${describe(rule)} was not checked.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }

    const passed = rule.comparator === 'lte' ? actual <= rule.threshold : actual >= rule.threshold;
    assertions.push({
      ruleId: rule.id,
      outcome: passed ? 'passed' : 'failed',
      actualValue: actual,
      message: `${describe(rule)} — actual ${actual}`,
      ruleSnapshot: snapshot,
    });
  }

  // A rule that could not be checked is never a pass. "We checked and it was
  // fine" and "we did not check" are different facts, and collapsing them is
  // the difference between a gate and a decoration.
  if (assertions.some((a) => a.outcome === 'failed')) return { assertions, verdict: 'failed' };
  if (assertions.some((a) => a.outcome === 'passed')) return { assertions, verdict: 'passed' };
  return { assertions, verdict: 'not_evaluated' };
}
```

`packages/sla/src/index.ts`:

```ts
export * from './metrics.js';
export * from './evaluate.js';
```

- [ ] **Step 6: Run the tests**

```bash
pnpm install
pnpm vitest run packages/sla/test/evaluate.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 7: Falsify the `not_applicable` rule**

In `evaluateRules`, change the missing-stat branch to push `outcome: 'passed'`. Re-run.

Expected: FAIL on "records not_applicable when the target is absent" **and** on "reports not_evaluated when every rule is not_applicable". Restore.

- [ ] **Step 8: Falsify the snapshot**

Change `const snapshot: EvaluableRule = { ...rule }` to `= rule`. Re-run.

Expected: FAIL on "snapshots the rule as it read at evaluation time". Restore.

- [ ] **Step 9: Verify everything**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: clean; **77 unit tests passing**.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(sla): absolute rule evaluation

Pure: rules and stats in, assertions and a verdict out. No database, no HTTP,
and the ESLint purity glob now covers this package so it stays that way.

A rule whose target is absent from the run records not_applicable, never a
silent pass, and a run of only not_applicable assertions is not_evaluated
rather than passed. 'We checked and it was fine' and 'we did not check' are
different facts; collapsing them turns a gate into a decoration. Falsified by
making the missing-target branch pass — two tests fail.

Percentiles fall back to the summary sketch when the requested one is not in
the stored JSONB, so a rule can ask for p99.9 against a project configured
for [50, 75, 95, 99]. Rules are snapshotted by value at evaluation time —
falsified by aliasing instead of copying."
```

---

## Task 10: The API application — configuration, auth, and problem+json

The NestJS app boots, verifies a bearer token in one indexed row read plus one hash, enforces scopes, and renders every error as RFC 9457.

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/api/src/{main,app.module,config}.ts`
- Create: `apps/api/src/auth/{tokens,auth.guard,scopes.decorator,auth.module}.ts`
- Create: `apps/api/src/common/{problem.filter,problem}.ts`
- Create: `apps/api/src/health.controller.ts`
- Create: `apps/api/test/{tokens.test.ts,auth.integration.test.ts}`
- Create: `apps/api/test/support/app.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `TokenRepository`, `ProjectRepository`, `createPrisma`, `createPool` from `@perfportal/persistence`; `ProblemDetails` from `@perfportal/contracts`.
- Produces:
  - `mintToken(): { token: string; prefix: string }`, `hashToken(secret): Promise<string>`, `verifyToken(hash, secret): Promise<boolean>`, `splitToken(token): { prefix: string; secret: string } | null`
  - `class AuthGuard implements CanActivate` — attaches `request.tenant: { orgId, projectId, tokenId, scopes }`
  - `@Scopes('ingest' | 'read')` decorator
  - `class ProblemFilter implements ExceptionFilter`
  - `loadConfig(env): AppConfig`
  - `createTestApp(): Promise<{ app, http, prisma, pool, seed }>` (test support)

- [ ] **Step 1: Write the failing unit test**

`apps/api/test/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashToken, mintToken, splitToken, verifyToken } from '../src/auth/tokens.js';

describe('token minting', () => {
  it('produces a token whose prefix is recoverable without the secret', () => {
    const { token, prefix } = mintToken();
    expect(token.startsWith(`${prefix}_`)).toBe(true);
    expect(splitToken(token)?.prefix).toBe(prefix);
  });

  it('produces a distinct token each time', () => {
    expect(mintToken().token).not.toBe(mintToken().token);
  });

  it('rejects a malformed token instead of throwing', () => {
    expect(splitToken('nonsense')).toBeNull();
    expect(splitToken('pp_only_two')).toBeNull();
    expect(splitToken('')).toBeNull();
  });
});

describe('token verification', () => {
  it('verifies the correct secret and rejects a wrong one', async () => {
    const { token } = mintToken();
    const parts = splitToken(token)!;
    const hash = await hashToken(parts.secret);

    expect(await verifyToken(hash, parts.secret)).toBe(true);
    expect(await verifyToken(hash, `${parts.secret}x`)).toBe(false);
  });

  it('does not store the secret in the hash', async () => {
    const { token } = mintToken();
    const parts = splitToken(token)!;
    const hash = await hashToken(parts.secret);
    expect(hash).not.toContain(parts.secret);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyToken('not-a-real-argon2-hash', 'whatever')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/api/test/tokens.test.ts
```

Expected: FAIL — `Cannot find module '../src/auth/tokens.js'`.

- [ ] **Step 3: Create the app package**

`apps/api/package.json`:

```json
{
  "name": "@perfportal/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.6",
    "@nestjs/core": "^11.1.6",
    "@nestjs/platform-express": "^11.1.6",
    "@nestjs/swagger": "^8.1.0",
    "@node-rs/argon2": "^2.0.2",
    "@perfportal/contracts": "workspace:*",
    "@perfportal/core": "workspace:*",
    "@perfportal/persistence": "workspace:*",
    "@perfportal/sla": "workspace:*",
    "@perfportal/statistics": "workspace:*",
    "@perfportal/storage": "workspace:*",
    "bullmq": "^5.34.0",
    "busboy": "^1.6.0",
    "ioredis": "^5.4.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/busboy": "^1.5.4",
    "@types/express": "^5.0.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2"
  }
}
```

`apps/api/tsconfig.json` — note the four settings the pre-flight spike proved are required:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`@node-rs/argon2` ships prebuilt binaries, so no native toolchain is needed on a developer machine or in CI.

**Vitest cannot run NestJS dependency injection without an SWC transform.** Verified before this plan was executed: `tsc` emits `__metadata(...)` for a decorated class with constructor parameters; **esbuild — which is vitest's transformer — does not**, because emitting `design:paramtypes` needs full type information that esbuild deliberately does not compute. Without it, every `Test.createTestingModule` boot fails with "Nest can't resolve dependencies". The pre-flight spike did not catch this because it ran `tsc`-built output, not vitest.

Add the transform to **both** vitest configs. Install first:

```bash
pnpm add -Dw unplugin-swc @swc/core
```

`vitest.config.ts` and `vitest.integration.config.ts` each gain:

```ts
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      // Only apps use decorators; packages stay on the faster esbuild path.
      include: /apps\/.*\.ts$/,
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  // ...existing resolve and test blocks unchanged
});
```

`decoratorMetadata: true` is the setting that matters. `legacyDecorator: true` matches `experimentalDecorators` in the app tsconfigs — the two must agree, or the same class compiles to different shapes under test and at runtime.

- [ ] **Step 4: Write the token module**

`apps/api/src/auth/tokens.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const PREFIX_BYTES = 6;   // 12 hex chars — the indexed lookup key
const SECRET_BYTES = 24;  // 48 hex chars

/**
 * Token layout: pp_<prefix-hex>_<secret-hex>
 *
 * The prefix is stored in an indexed unique column so verification is exactly
 * one row read plus one Argon2 verification, rather than hashing against every
 * token in the table.
 */
export function mintToken(): { token: string; prefix: string } {
  const prefix = `pp_${randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  return { token: `${prefix}_${secret}`, prefix };
}

export function splitToken(token: string): { prefix: string; secret: string } | null {
  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const [scheme, prefixBody, secret] = parts;
  if (scheme !== 'pp' || !prefixBody || !secret) return null;
  return { prefix: `pp_${prefixBody}`, secret };
}

export function hashToken(secret: string): Promise<string> {
  return hash(secret);
}

/** Never throws: a corrupt stored hash is a verification failure, not a 500. */
export async function verifyToken(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the unit test**

```bash
pnpm install
pnpm vitest run apps/api/test/tokens.test.ts
```

Expected: PASS, 6 tests.

No config change is needed: Task 1 already set `include` to cover `apps/*/test/**/*.test.ts` and to exclude `*.integration.test.ts`. This file is `tokens.test.ts` — pure, no infrastructure — so it belongs in the unit suite and runs here.

- [ ] **Step 6: Write config, problem+json, and the guard**

`apps/api/src/config.ts`:

```ts
export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  blob: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  defaultWaitMs: number;
  maxBundleBytes: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6380',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: env.S3_ACCESS_KEY ?? 'perfportal',
      secretAccessKey: env.S3_SECRET_KEY ?? 'perfportal123',
    },
    defaultWaitMs: Number(env.INGEST_WAIT_MS ?? 25_000),
    maxBundleBytes: Number(env.MAX_BUNDLE_BYTES ?? 512 * 1024 * 1024),
  };
}
```

`apps/api/src/common/problem.ts`:

```ts
import { IngestError } from '@perfportal/core';
import type { ProblemDetails } from '@perfportal/contracts';

const BASE = 'https://perfportal.dev/errors';

/** Deterministic status for each ingest failure mode. */
const STATUS: Record<string, number> = {
  BUNDLE_TOO_LARGE: 413,
  BUNDLE_NOT_ARCHIVE: 400,
  BUNDLE_EMPTY: 400,
  TOOL_AMBIGUOUS: 400,
  TOOL_UNKNOWN: 400,
  LOG_NOT_FOUND: 400,
  LOG_BINARY_FORMAT: 400,
  LOG_MALFORMED: 400,
  ENDPOINT_CARDINALITY_EXCEEDED: 400,
  NO_REQUESTS: 400,
  PROJECT_MISMATCH: 403,
  TOKEN_REVOKED: 401,
  PLUGIN_TIMEOUT: 400,
  PLUGIN_MEMORY_EXCEEDED: 400,
};

export function statusForCode(code: string): number {
  return STATUS[code] ?? 400;
}

export function problemFromIngestError(err: IngestError, traceId?: string): ProblemDetails {
  return {
    type: `${BASE}/${err.code}`,
    title: err.message.split('\n')[0] ?? err.code,
    status: statusForCode(err.code),
    code: err.code,
    detail: err.message,
    remediation: err.remediation,
    ...(traceId ? { traceId } : {}),
    ...(err.detail ? { meta: err.detail } : {}),
  };
}

export function problem(
  code: string,
  status: number,
  detail: string,
  remediation: string,
  traceId?: string,
): ProblemDetails {
  return {
    type: `${BASE}/${code}`,
    title: code.replaceAll('_', ' ').toLowerCase(),
    status,
    code,
    detail,
    remediation,
    ...(traceId ? { traceId } : {}),
  };
}

export function isIngestError(e: unknown): e is IngestError {
  return e instanceof IngestError || (e instanceof Error && e.name === 'IngestError');
}
```

`apps/api/src/common/problem.filter.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { isIngestError, problem, problemFromIngestError } from './problem.js';

/** Every error leaves as application/problem+json. Stack traces never do. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = randomUUID();

    if (isIngestError(exception)) {
      const body = problemFromIngestError(exception, traceId);
      res.status(body.status).type('application/problem+json').send(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const detail =
        typeof raw === 'string' ? raw : ((raw as { message?: string }).message ?? exception.message);
      const body = problem(
        (exception as { code?: string }).code ?? httpCode(status),
        status,
        detail,
        (exception as { remediation?: string }).remediation ??
          'Check the request against the OpenAPI description at /v1/openapi.json.',
        traceId,
      );
      res.status(status).type('application/problem+json').send(body);
      return;
    }

    // eslint-disable-next-line no-console
    console.error('unhandled', traceId, exception);
    const body = problem(
      'INTERNAL',
      500,
      'The request could not be completed.',
      `Retry the request. If it keeps failing, report trace ${traceId}.`,
      traceId,
    );
    res.status(500).type('application/problem+json').send(body);
  }
}

function httpCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'BUNDLE_TOO_LARGE';
  if (status === 422) return 'SLA_FAILED';
  return 'BAD_REQUEST';
}
```

`apps/api/src/auth/scopes.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export type TokenScope = 'ingest' | 'read';
export const SCOPES_KEY = 'perfportal:scopes';
export const Scopes = (...scopes: TokenScope[]) => SetMetadata(SCOPES_KEY, scopes);
```

`apps/api/src/auth/auth.guard.ts`:

```ts
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import { SCOPES_KEY, type TokenScope } from './scopes.decorator.js';
import { splitToken, verifyToken } from './tokens.js';

export interface Tenant {
  orgId: string;
  projectId: string;
  tokenId: string;
  scopes: string[];
}

declare module 'express' {
  interface Request {
    tenant?: Tenant;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();

    const header = req.headers.authorization ?? '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const parts = raw ? splitToken(raw) : null;
    if (!parts) throw new UnauthorizedException('A bearer API token is required.');

    const record = await this.tokens.findByPrefix(parts.prefix);
    if (!record) throw new UnauthorizedException('Unknown API token.');
    if (record.revokedAt) throw new UnauthorizedException('This API token has been revoked.');
    if (!(await verifyToken(record.tokenHash, parts.secret))) {
      throw new UnauthorizedException('Invalid API token.');
    }

    const required = this.reflector.getAllAndOverride<TokenScope[]>(SCOPES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) ?? [];
    for (const scope of required) {
      if (!record.scopes.includes(scope)) {
        throw new ForbiddenException(
          `This token lacks the "${scope}" scope. A CI credential is not automatically a read credential.`,
        );
      }
    }

    req.tenant = {
      orgId: record.orgId,
      projectId: record.projectId,
      tokenId: record.id,
      scopes: record.scopes,
    };
    return true;
  }
}
```

`apps/api/src/auth/auth.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createPool,
  createPrisma,
  ProjectRepository,
  RunRepository,
  RuleRepository,
  TokenRepository,
} from '@perfportal/persistence';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { AuthGuard } from './auth.guard.js';

export const CONFIG = Symbol('CONFIG');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: PrismaClient, useFactory: () => createPrisma(loadConfig().databaseUrl) },
    { provide: pg.Pool, useFactory: () => createPool(loadConfig().databaseUrl) },
    { provide: TokenRepository, useFactory: (p: PrismaClient) => new TokenRepository(p), inject: [PrismaClient] },
    { provide: ProjectRepository, useFactory: (p: PrismaClient) => new ProjectRepository(p), inject: [PrismaClient] },
    { provide: RunRepository, useFactory: (p: PrismaClient) => new RunRepository(p), inject: [PrismaClient] },
    { provide: RuleRepository, useFactory: (p: PrismaClient) => new RuleRepository(p), inject: [PrismaClient] },
    AuthGuard,
  ],
  exports: [CONFIG, PrismaClient, pg.Pool, TokenRepository, ProjectRepository, RunRepository, RuleRepository, AuthGuard],
})
export class AuthModule {}
```

- [ ] **Step 7: Write the health controller, app module, and entry point**

`apps/api/src/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import pg from 'pg';

@Controller()
export class HealthController {
  constructor(private readonly pool: pg.Pool) {}

  @Get('/healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness means dependencies answer, not merely that the process is up. */
  @Get('/readyz')
  async ready(): Promise<{ status: string }> {
    await this.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/main.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';

const app = await NestFactory.create(AppModule);
app.useGlobalFilters(new ProblemFilter());
await app.listen(loadConfig().port);
```

- [ ] **Step 8: Write the boot assertion the spike's F-2 finding demands**

With `emitDecoratorMetadata: false`, Nest reports a successful boot and injects `undefined`; the failure surfaces arbitrarily far away. A clean startup log is not evidence.

`apps/api/test/support/app.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AppModule } from '../../src/app.module.js';
import { ProblemFilter } from '../../src/common/problem.filter.js';
import { hashToken, mintToken } from '../../src/auth/tokens.js';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  pool: pg.Pool;
  orgId: string;
  projectId: string;
  ingestToken: string;
  readToken: string;
  close(): Promise<void>;
}

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
];

export async function createTestApp(
  settings: Record<string, unknown> = {},
): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.init();

  const prisma = app.get(PrismaClient);
  const pool = app.get(pg.Pool);

  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);

  const org = await prisma.org.create({ data: { slug: `org-${randomUUID().slice(0, 8)}`, name: 'Test' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: settings as object },
  });

  const ing = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'ci',
      prefix: ing.prefix, tokenHash: await hashToken(splitSecret(ing.token)),
      scopes: ['ingest', 'read'],
    },
  });

  const rd = mintToken();
  await prisma.apiToken.create({
    data: {
      orgId: org.id, projectId: project.id, name: 'reader',
      prefix: rd.prefix, tokenHash: await hashToken(splitSecret(rd.token)),
      scopes: ['read'],
    },
  });

  return {
    app,
    prisma,
    pool,
    orgId: org.id,
    projectId: project.id,
    ingestToken: ing.token,
    readToken: rd.token,
    async close() {
      await app.close();
    },
  };
}

function splitSecret(token: string): string {
  const parts = token.split('_');
  return parts[2] ?? '';
}
```

`apps/api/test/auth.integration.test.ts`:

```ts
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { createTestApp, type TestContext } from './support/app.js';
import { mintToken } from '../src/auth/tokens.js';

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe('boot integrity', () => {
  it('injects every dependency — a clean startup log is not evidence', async () => {
    ctx = await createTestApp();
    const guard = ctx.app.get(AuthGuard);

    // Assert by API shape, never instanceof: Prisma 6 returns a Proxy, so
    // `new PrismaClient() instanceof PrismaClient` is false even with no Nest.
    const injected = guard as unknown as { tokens?: { findByPrefix?: unknown } };
    expect(typeof injected.tokens?.findByPrefix).toBe('function');
  });
});

describe('AuthGuard', () => {
  it('rejects a request with no token', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.remediation).toBeTruthy();
  });

  it('rejects an unknown token', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${mintToken().token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    ctx = await createTestApp();
    await ctx.prisma.apiToken.updateMany({ data: { revokedAt: new Date() } });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('revoked');
  });

  it('never returns a stack trace', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/runs/not-a-uuid');
    expect(JSON.stringify(res.body)).not.toContain('at Object.');
  });
});

describe('health', () => {
  it('reports readiness only when the database answers', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

> These reference `GET /v1/runs/{id}`, which Task 13 adds. Until then the guard runs and returns 401 before routing, which is exactly what these tests assert. The readiness test passes from this task onward.

- [ ] **Step 9: Run the integration tests**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/auth.integration.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 10: Falsify the boot assertion — the F-2 finding**

Under vitest the binding setting is the **SWC plugin's** `decoratorMetadata`, not the app tsconfig's `emitDecoratorMetadata` — vitest never reads the app tsconfig for this. Flip the plugin setting in `vitest.integration.config.ts`:

```bash
sed -i.bak 's/decoratorMetadata: true/decoratorMetadata: false/' vitest.integration.config.ts
pnpm vitest run --config vitest.integration.config.ts apps/api/test/auth.integration.test.ts
```

Expected: FAIL on "injects every dependency", or a Nest "can't resolve dependencies" error at boot. Either proves the assertion is live. Then restore:

```bash
mv vitest.integration.config.ts.bak vitest.integration.config.ts
```

Both settings must stay true: the tsconfig one governs the built output that actually runs in production, the plugin one governs what the tests exercise. Verify the tsconfig side separately:

```bash
pnpm build && grep -c "__metadata" apps/api/dist/auth/auth.guard.js
```

Expected: a non-zero count. If it is zero, the shipped app cannot inject anything, however green the tests are.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(api): app scaffold, token auth, and problem+json

Token layout is pp_<prefix>_<secret>, with the prefix stored in a unique
indexed column, so verification is one row read plus one Argon2 verification
rather than hashing against every token in the table. @node-rs/argon2 ships
prebuilt binaries, so no native toolchain is needed anywhere.

Scopes split ingest from read. That is not RBAC and does not pretend to be;
it is the smallest mechanism that stops a CI credential from also being a
read credential.

A boot-integrity test asserts injected dependencies are actually present,
because the pre-flight spike showed a wrong emitDecoratorMetadata makes Nest
report a SUCCESSFUL boot while injecting undefined. Falsified by flipping
that flag. The assertion checks API shape, not instanceof — Prisma 6 returns
a Proxy, so instanceof is false even with no Nest involved.

Errors leave as RFC 9457 with a required remediation field. Stack traces
never do."
```

---

## Task 11: `POST /v1/runs` — accept, store, enqueue

The accept path only. This task returns `202` with a status URL for every accepted bundle; Task 13 adds the bounded wait that upgrades that to `200`/`422`. Splitting them keeps each independently testable and keeps the step-ordering guarantee under its own test.

**Files:**
- Create: `apps/api/src/ingest/{ingest.controller,ingest.service,multipart,queue}.ts`
- Create: `apps/api/src/ingest/ingest.module.ts`
- Create: `apps/api/test/ingest.integration.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `RunRepository`, `ProjectRepository` from `@perfportal/persistence`; `BlobStore` from `@perfportal/storage`; `IngestMetadataSchema` from `@perfportal/contracts`; `AuthGuard`, `Scopes`.
- Produces:
  - `readMultipart(req): Promise<{ metadata: unknown; bundle: Readable; filename: string }>`
  - `class IngestQueue { add(runId: string): Promise<void>; close(): Promise<void> }` — BullMQ queue named `ingest`
  - `class IngestService { accept(tenant, metadata, bundle): Promise<RunRecord> }`
  - `POST /v1/runs` → `202 { id, status, statusUrl }`

- [ ] **Step 1: Write the failing test**

`apps/api/test/ingest.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  const results = join(dir, 'paritysimulation-20260807');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'paritysimulation-20260807']);
  bundle = readFileSync(out);
});

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

async function drainQueue(): Promise<void> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
}

describe('POST /v1/runs', () => {
  it('accepts a bundle and returns a status URL', async () => {
    await drainQueue();
    ctx = await createTestApp();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.statusUrl).toBe(`/v1/runs/${res.body.id}`);
  });

  it('commits the run row before enqueuing, so the only reachable gap is a run with no job', async () => {
    await drainQueue();
    ctx = await createTestApp();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    expect(row?.status).toBe('pending');
    expect(row?.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row?.bundleBytes)).toBe(bundle.length);

    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data.runId)).toContain(res.body.id);
    await q.close();
  });

  it('freezes the engine options onto the run', async () => {
    await drainQueue();
    ctx = await createTestApp({ warmupMs: 5000, percentiles: [50, 90, 99] });

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    const row = await ctx.prisma.run.findUnique({ where: { id: res.body.id } });
    expect(row?.engineOptions).toMatchObject({ warmupMs: 5000, percentiles: [50, 90, 99] });
  });

  it('is idempotent — the same key returns the original run and creates no second row', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', idempotencyKey: 'build-42' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const first = await post();
    const second = await post();

    expect(second.body.id).toBe(first.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });

  it('rejects a token without the ingest scope', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('ingest');
  });

  it('rejects invalid metadata with a remediable problem document', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'notatool' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
    expect(await ctx.prisma.run.count()).toBe(0);
  });

  it('rejects a bundle past the size cap without creating a run', async () => {
    await drainQueue();
    ctx = await createTestApp({ maxBundleBytes: 1024 });
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BUNDLE_TOO_LARGE');
    expect(await ctx.prisma.run.count()).toBe(0);
  });

  it('rejects a request with no bundle part', async () => {
    await drainQueue();
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling' }));

    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
export REDIS_URL='redis://localhost:6380'
pnpm build && pnpm vitest run --config vitest.integration.config.ts apps/api/test/ingest.integration.test.ts
```

Expected: FAIL — all POSTs return 404, no route.

- [ ] **Step 3: Write the multipart reader**

`apps/api/src/ingest/multipart.ts`:

```ts
import type { Readable } from 'node:stream';
import { ingestError } from '@perfportal/core';
import busboy from 'busboy';
import type { Request } from 'express';

export interface MultipartUpload {
  metadataRaw: string;
  bundle: Readable;
  filename: string;
}

/**
 * Streams the request. The bundle part is handed on as a stream and is never
 * buffered in this process — the API must not hold a multi-hundred-megabyte
 * body in memory while the worker is the component sized for that.
 *
 * Resolves as soon as the bundle part arrives, so the caller can pipe it
 * onward while the request is still being received. `metadata` must therefore
 * be sent BEFORE `bundle`, which is what supertest's .field().attach() order
 * produces and what the OpenAPI description states.
 */
export function readMultipart(req: Request): Promise<MultipartUpload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fields: 10 } });
    } catch {
      reject(
        ingestError('BUNDLE_NOT_ARCHIVE', {
          message: 'The request is not a multipart/form-data upload.',
          remediation:
            'POST multipart/form-data with a JSON "metadata" field followed by a "bundle" file part.',
        }),
      );
      return;
    }

    let metadataRaw = '';
    let settled = false;

    bb.on('field', (name, value) => {
      if (name === 'metadata') metadataRaw = value;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'bundle') {
        stream.resume();
        return;
      }
      settled = true;
      resolve({ metadataRaw, bundle: stream, filename: info.filename });
    });

    bb.on('close', () => {
      if (!settled) {
        reject(
          ingestError('BUNDLE_EMPTY', {
            message: 'The request contained no "bundle" file part.',
            remediation:
              'Attach the gzipped Gatling results directory as a file part named "bundle", after the "metadata" field.',
          }),
        );
      }
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}
```

- [ ] **Step 4: Write the queue and the service**

`apps/api/src/ingest/queue.ts`:

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

export const INGEST_QUEUE = 'ingest';

export interface IngestJobData {
  runId: string;
}

@Injectable()
export class IngestQueue implements OnModuleDestroy {
  readonly #queue: Queue<IngestJobData>;

  constructor(redisUrl: string) {
    this.#queue = new Queue<IngestJobData>(INGEST_QUEUE, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        // Deterministic failures are not retried; the worker decides by
        // rethrowing an UnrecoverableError. Transient ones get three tries.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }

  async add(runId: string): Promise<void> {
    await this.#queue.add('ingest', { runId }, { jobId: runId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#queue.close();
  }
}
```

`apps/api/src/ingest/ingest.service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { ingestError } from '@perfportal/core';
import {
  ProjectRepository,
  RunRepository,
  type ProjectSettings,
  type RunRecord,
} from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { IngestMetadataSchema, type IngestMetadata } from '@perfportal/contracts';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import type { Tenant } from '../auth/auth.guard.js';
import { IngestQueue } from './queue.js';

const ENGINE_KEYS = [
  'warmupMs', 'lowerMs', 'higherMs', 'percentiles',
  'maxEndpoints', 'maxBucketsRun', 'maxBucketsEndpoint',
] as const;

@Injectable()
export class IngestService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly runs: RunRepository,
    private readonly blobs: BlobStore,
    private readonly queue: IngestQueue,
  ) {}

  parseMetadata(raw: string): IngestMetadata {
    let json: unknown;
    try {
      json = JSON.parse(raw || '{}');
    } catch {
      throw ingestError('TOOL_UNKNOWN', {
        message: 'The "metadata" field is not valid JSON.',
        remediation: 'Send metadata as a JSON object, for example {"tool":"gatling"}.',
      });
    }
    const parsed = IngestMetadataSchema.safeParse(json);
    if (!parsed.success) {
      throw ingestError('TOOL_UNKNOWN', {
        message: `Invalid metadata: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        remediation:
          'Send {"tool":"gatling"} plus any optional fields. See /v1/openapi.json for the full schema.',
        detail: { issues: parsed.error.issues },
      });
    }
    return parsed.data;
  }

  /**
   * Step order is load-bearing (spec §6.1). The bundle is durable before any
   * row references it, and the run row commits before the job is enqueued.
   * The DB insert and the queue add span two systems and cannot share a
   * transaction, so exactly one inconsistency is reachable — a run with no
   * job — which the sweeper recovers. The reverse order yields a job pointing
   * at a nonexistent run, which is not recoverable.
   */
  async accept(tenant: Tenant, metadata: IngestMetadata, bundle: Readable): Promise<RunRecord> {
    const scope = { orgId: tenant.orgId, projectId: tenant.projectId };

    if (metadata.idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(scope, metadata.idempotencyKey);
      if (existing) {
        bundle.resume();       // drain, or the connection stalls
        return existing;
      }
    }

    const settings = await this.projects.settings(scope);
    const maxBytes = settings.maxBundleBytes ?? this.config.maxBundleBytes;

    const key = `runs/${tenant.projectId}/${randomUUID()}.tgz`;
    const { sha256, bytes } = await this.blobs.putStream(key, bundle, maxBytes);

    const run = await this.runs.create({
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      tool: metadata.tool,
      bundleKey: key,
      bundleSha256: sha256,
      bundleBytes: bytes,
      ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
      startedAt: new Date(),
      engineOptions: engineOptionsFrom(settings),
    });

    await this.queue.add(run.id);
    return run;
  }
}

/**
 * Frozen onto the run, not read at parse time. Statistics are meaningful only
 * relative to the warm-up window and percentile set that produced them, and a
 * project changing its warm-up must not silently reinterpret its own history.
 */
export function engineOptionsFrom(settings: ProjectSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENGINE_KEYS) {
    const v = settings[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 5: Write the controller and module**

`apps/api/src/ingest/ingest.controller.ts`:

```ts
import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { IngestService } from './ingest.service.js';
import { readMultipart } from './multipart.js';

@Controller('/v1/runs')
@UseGuards(AuthGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  @Scopes('ingest')
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = await readMultipart(req);
    const metadata = this.ingest.parseMetadata(upload.metadataRaw);
    const run = await this.ingest.accept(req.tenant!, metadata, upload.bundle);

    res.status(202).json({
      id: run.id,
      status: run.status,
      statusUrl: `/v1/runs/${run.id}`,
    });
  }
}
```

`apps/api/src/ingest/ingest.module.ts`:

```ts
import { Inject, Module } from '@nestjs/common';
import { BlobStore } from '@perfportal/storage';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestQueue } from './queue.js';

@Module({
  controllers: [IngestController],
  providers: [
    IngestService,
    {
      provide: BlobStore,
      useFactory: async (config: AppConfig) => {
        const store = new BlobStore({ ...config.blob });
        await store.ensureBucket();
        return store;
      },
      inject: [CONFIG],
    },
    {
      provide: IngestQueue,
      useFactory: (config: AppConfig) => new IngestQueue(config.redisUrl),
      inject: [CONFIG],
    },
  ],
  exports: [BlobStore, IngestQueue],
})
export class IngestModule {}
```

Register it in `apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { IngestModule } from './ingest/ingest.module.js';

@Module({
  imports: [AuthModule, IngestModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 6: Run the tests**

```bash
pnpm install && pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/ingest.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Falsify the step ordering**

In `IngestService.accept`, move `await this.queue.add(run.id)` above `await this.runs.create(...)` — the enqueue then references a run id that does not yet exist, so `run.id` is unavailable and the code will not compile. That compile failure is the point: **the ordering is enforced by data dependency, not discipline.** Note this in the commit and restore.

- [ ] **Step 8: Falsify the size cap path**

In `IngestService.accept`, replace `maxBytes` with `Number.MAX_SAFE_INTEGER`. Re-run.

Expected: FAIL on "rejects a bundle past the size cap". Restore.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): POST /v1/runs — accept, store, enqueue

The bundle streams to object storage and is durable before any row references
it; the run row commits before the job is enqueued. Those two systems cannot
share a transaction, so the order is chosen to make exactly one inconsistency
reachable — a run with no job — which the sweeper recovers. The reverse order
produces a job pointing at a nonexistent run, which is not recoverable. The
ordering is enforced by data dependency: the enqueue needs run.id, so writing
it the wrong way round does not compile.

engineOptions is frozen onto the run at accept time rather than read at parse
time, so a project changing its warm-up cannot silently reinterpret history.

Returns 202 with a status URL for every accepted bundle. Task 13 adds the
bounded wait that upgrades this to 200/422."
```

---

## Task 12: The worker — the ingest pipeline

Claim, fetch, detect, parse, aggregate, persist, evaluate, publish. Statistics, assertions, and the run's terminal status commit in one transaction, so a run is never observable with stats but no verdict.

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`
- Create: `apps/worker/src/{main,worker.module,config}.ts`
- Create: `apps/worker/src/pipeline/{pipeline.service,plugins,retry}.ts`
- Create: `apps/worker/src/{consumer,sweeper}.ts`
- Create: `apps/worker/test/{retry.test.ts,pipeline.integration.test.ts}`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `GatlingPlugin`; `openTarGzBundle`, `BlobStore`; `runEngineAsync`; `MetricWriter`, `RunRepository`, `RuleRepository`, `MetricReader`; `evaluateRules`.
- Produces:
  - `class PipelineService { process(runId: string): Promise<void> }`
  - `isTransient(err: unknown): boolean`
  - `class Sweeper { sweep(): Promise<number> }`
  - Publishes `run:{id}` on Redis on every terminal state.

- [ ] **Step 1: Write the failing unit test for retry classification**

`apps/worker/test/retry.test.ts`:

```ts
import { ingestError } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { isTransient } from '../src/pipeline/retry.js';

describe('isTransient', () => {
  it('treats a lost database connection as transient', () => {
    const e = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats object storage being unreachable as transient', () => {
    const e = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats every IngestError as deterministic — retrying reaches the same conclusion', () => {
    for (const code of ['LOG_MALFORMED', 'BUNDLE_EMPTY', 'ENDPOINT_CARDINALITY_EXCEEDED'] as const) {
      expect(isTransient(ingestError(code, { message: 'm', remediation: 'r' }))).toBe(false);
    }
  });

  it('treats an unknown error as deterministic, so a bug does not burn three worker slots', () => {
    expect(isTransient(new TypeError('x is not a function'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/worker/test/retry.test.ts
```

Expected: FAIL — `Cannot find module '../src/pipeline/retry.js'`.

- [ ] **Step 3: Create the worker package**

`apps/worker/package.json`:

```json
{
  "name": "@perfportal/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.6",
    "@nestjs/core": "^11.1.6",
    "@perfportal/contracts": "workspace:*",
    "@perfportal/core": "workspace:*",
    "@perfportal/persistence": "workspace:*",
    "@perfportal/plugin-gatling": "workspace:*",
    "@perfportal/sla": "workspace:*",
    "@perfportal/statistics": "workspace:*",
    "@perfportal/storage": "workspace:*",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.1",
    "pg": "^8.13.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  }
}
```

`apps/worker/tsconfig.json` — identical compiler settings to `apps/api`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Add `{ "path": "apps/api" }` and `{ "path": "apps/worker" }` are **not** added to the root `tsconfig.json` references — apps build with their own `tsc -p`, since `composite` and `NodeNext` do not mix with the packages' `bundler` resolution. Instead extend the root `build` script:

```json
    "build": "tsc -b && pnpm --filter @perfportal/api build && pnpm --filter @perfportal/worker build"
```

- [ ] **Step 4: Write retry classification**

`apps/worker/src/pipeline/retry.ts`:

```ts
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'NetworkingError', 'TimeoutError', 'RequestTimeout', 'SlowDown',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

/**
 * Only transient failures are retried. A parse failure, an unsupported bundle,
 * or a cardinality violation is deterministic: retrying burns a worker slot to
 * reach the identical conclusion. An unknown error is treated as deterministic
 * for the same reason — a bug retried three times is a bug three times.
 */
export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as Error).name === 'IngestError') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}
```

- [ ] **Step 5: Run the unit test**

```bash
pnpm install
pnpm vitest run apps/worker/test/retry.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing pipeline integration test**

`apps/worker/test/pipeline.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createPool, createPrisma, MetricReader } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PipelineService } from '../src/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../src/config.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const config = loadWorkerConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
});
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const blobs = new BlobStore(config.blob);

let bundle: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
  await blobs.ensureBucket();
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_stat',
  'run', 'sla_rule', 'api_token', 'project', 'org',
];

async function seedRun(bundleBody: Buffer, engineOptions: Record<string, unknown> = {}) {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const key = `runs/test/${Date.now()}.tgz`;
  await blobs.putStream(key, Readable.from([bundleBody]), 100_000_000);
  const startedAt = new Date('2026-08-07T10:00:00Z');
  const run = await prisma.run.create({
    data: {
      orgId: org.id, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: key, bundleSha256: 'x'.repeat(64), bundleBytes: BigInt(bundleBody.length),
      startedAt, startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: engineOptions as object,
    },
  });
  return { orgId: org.id, projectId: project.id, runId: run.id, startedOn: new Date('2026-08-07T00:00:00Z') };
}

function pipeline(): PipelineService {
  return new PipelineService(config, prisma, pool, blobs);
}

describe('PipelineService', () => {
  it('reproduces the fixture statistics end to end', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('complete');
    expect(run?.toolVersion).toBe('3.15.1');

    const stats = await new MetricReader(pool).stats(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    const runStat = stats.find((s) => s.scope === 'run' && s.family === 'response_time');

    expect(runStat?.count).toBe(895);
    expect(runStat?.okCount).toBe(871);
    expect(runStat?.koCount).toBe(24);
    expect(Math.round(runStat!.maxMs)).toBe(2503);
    expect(Math.round(runStat!.meanMs)).toBe(228);
    expect(Math.round(runStat!.stddevMs)).toBe(370);
  });

  it('persists the error table with the fixture counts', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const errors = await new MetricReader(pool).errors(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
    );
    expect(errors.reduce((a, e) => a + e.count, 0)).toBe(24);
    expect(errors.map((e) => e.count).sort((a, b) => b - a)).toEqual([15, 9]);
  });

  it('persists series buckets readable through the partition key', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);

    const buckets = await new MetricReader(pool).series(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      ctx.runId,
      ctx.startedOn,
      { scope: 'run', name: '' },
    );
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.reduce((a, b) => a + b.startedCount, 0)).toBe(895);
  });

  it('evaluates SLA rules and records the verdict', async () => {
    const ctx = await seedRun(bundle);
    await prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('failed');

    const assertions = await prisma.runAssertion.findMany({ where: { runId: ctx.runId } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.outcome).toBe('failed');
    expect(assertions[0]?.ruleSnapshot).toMatchObject({ threshold: 1, metric: 'p95' });
  });

  it('reports not_evaluated when a project has no rules', async () => {
    const ctx = await seedRun(bundle);
    await pipeline().process(ctx.runId);
    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.verdict).toBe('not_evaluated');
  });

  it('records a structured failure with remediation for a corrupt bundle', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    await pipeline().process(ctx.runId);

    const run = await prisma.run.findUnique({ where: { id: ctx.runId } });
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('writes nothing at all when the run fails — no half-persisted statistics', async () => {
    const ctx = await seedRun(Buffer.from('not a tarball at all'));
    await pipeline().process(ctx.runId);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM run_stat WHERE run_id = $1', [
      ctx.runId,
    ]);
    expect(rows[0]?.n).toBe(0);
  });
});
```

- [ ] **Step 7: Write the worker config and plugin registry**

`apps/worker/src/config.ts`:

```ts
export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  blob: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  concurrency: number;
  sweepIntervalMs: number;
  staleAfterMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing required environment variable DATABASE_URL');
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6380',
    blob: {
      endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'perfportal',
      accessKeyId: env.S3_ACCESS_KEY ?? 'perfportal',
      secretAccessKey: env.S3_SECRET_KEY ?? 'perfportal123',
    },
    concurrency: Number(env.WORKER_CONCURRENCY ?? 2),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 30_000),
    staleAfterMs: Number(env.STALE_AFTER_MS ?? 60_000),
  };
}
```

`apps/worker/src/pipeline/plugins.ts`:

```ts
import { ingestError, type BundleIndex, type PerfPlugin } from '@perfportal/core';
import { GatlingPlugin } from '@perfportal/plugin-gatling';

export const PLUGINS: readonly PerfPlugin[] = [new GatlingPlugin()];

/**
 * Exactly one plugin must claim a bundle. Zero is an unsupported bundle; more
 * than one is ambiguous, and guessing which is right would silently pick an
 * interpretation of the data.
 */
export async function selectPlugin(
  index: BundleIndex,
): Promise<{ plugin: PerfPlugin; toolVersion: string | null }> {
  const matches: { plugin: PerfPlugin; toolVersion: string | null }[] = [];
  const reasons: string[] = [];

  for (const plugin of PLUGINS) {
    const result = await plugin.detect(index);
    if (result.matched) matches.push({ plugin, toolVersion: result.toolVersion ?? null });
    else if (result.reason) reasons.push(`${plugin.id}: ${result.reason}`);
  }

  const first = matches[0];
  if (!first) {
    throw ingestError('TOOL_UNKNOWN', {
      message: 'No installed plugin recognises this bundle.',
      remediation:
        'Upload the whole results directory produced by a supported tool. Supported today: Gatling 3.x.',
      detail: { reasons, files: index.files.slice(0, 20) },
    });
  }
  if (matches.length > 1) {
    throw ingestError('TOOL_AMBIGUOUS', {
      message: `More than one plugin claimed this bundle: ${matches.map((m) => m.plugin.id).join(', ')}.`,
      remediation:
        'Upload the results of a single tool run. A bundle containing output from two tools cannot be interpreted unambiguously.',
    });
  }
  return first;
}
```

- [ ] **Step 8: Write the pipeline**

`apps/worker/src/pipeline/pipeline.service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IngestError } from '@perfportal/core';
import {
  MetricWriter,
  RunRepository,
  RuleRepository,
  type RunRecord,
} from '@perfportal/persistence';
import { evaluateRules, type EvaluableRule, type EvaluableStat } from '@perfportal/sla';
import { runEngineAsync, type EngineOptions } from '@perfportal/statistics';
import { BlobStore, openTarGzBundle } from '@perfportal/storage';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { selectPlugin } from './plugins.js';

@Injectable()
export class PipelineService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  async process(runId: string): Promise<void> {
    const runs = new RunRepository(this.prisma);
    const run = await runs.findByIdUnscoped(runId);
    if (!run) return;                                   // swept away or deleted
    if (run.status === 'complete' || run.status === 'failed') return;   // already terminal

    await runs.markParsing(runId);

    try {
      await this.#ingest(run);
    } catch (err) {
      const structured =
        err instanceof IngestError || (err instanceof Error && err.name === 'IngestError')
          ? (err as IngestError)
          : null;
      await runs.fail(runId, {
        code: structured?.code ?? 'INTERNAL',
        message: structured?.message ?? 'The run could not be ingested.',
        remediation:
          structured?.remediation ??
          'Retry the upload. If it keeps failing, the bundle may be incomplete.',
      });
      await this.#publish(runId);
      throw err;                                        // let the consumer classify it
    }

    await this.#publish(runId);
  }

  async #ingest(run: RunRecord): Promise<void> {
    const archive = await this.blobs.get(run.bundleKey);
    const source = await openTarGzBundle(archive);
    const { plugin, toolVersion } = await selectPlugin(source.index);

    const result = await runEngineAsync(plugin.parse(source), run.engineOptions as EngineOptions);

    const rules = await new RuleRepository(this.prisma).listEnabled({
      orgId: run.orgId,
      projectId: run.projectId,
    });

    const evaluable: EvaluableStat[] = result.stats.map((s) => ({
      scope: s.scope,
      name: s.name,
      family: s.family,
      count: s.count,
      okCount: s.okCount,
      koCount: s.koCount,
      errorRate: s.errorRate,
      minMs: s.minMs,
      maxMs: s.maxMs,
      meanMs: s.meanMs,
      stddevMs: s.stddevMs,
      throughputRps: s.throughputRps,
      percentiles: s.percentiles,
      sketch: s.sketch,
    }));

    const evaluableRules: EvaluableRule[] = rules.map((r) => ({
      id: r.id,
      scope: r.scope,
      targetName: r.targetName,
      family: r.family,
      metric: r.metric,
      comparator: r.comparator,
      threshold: r.threshold,
    }));

    const { assertions, verdict } = evaluateRules(evaluableRules, evaluable);

    // Statistics, assertions, and the terminal status commit together. A run is
    // never observable with statistics but no verdict, or the reverse.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await new MetricWriter().persist(
        client,
        {
          runId: run.id,
          orgId: run.orgId,
          projectId: run.projectId,
          runStartedOn: run.startedOn,
        },
        result,
      );

      for (const a of assertions) {
        await client.query(
          `INSERT INTO run_assertion
             (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(), run.id, run.orgId, run.projectId, a.ruleId,
            JSON.stringify(a.ruleSnapshot), a.outcome, a.actualValue, a.message,
          ],
        );
      }

      await client.query(
        `UPDATE run SET status = 'complete', verdict = $2, tool_version = $3, ingested_at = now()
          WHERE id = $1`,
        [run.id, verdict, toolVersion],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async #publish(runId: string): Promise<void> {
    await this.pool.query(`SELECT pg_notify('run_terminal', $1)`, [runId]);
  }
}
```

> **Why `pg_notify` and not Redis pub/sub here.** The publish must happen only if the transaction that made the run terminal actually committed. `pg_notify` outside the transaction is issued after `COMMIT` returns, so it cannot announce a state that was rolled back. Task 13 layers the Redis fan-out on top for the API's bounded wait, subscribing to this notification.

- [ ] **Step 9: Run the pipeline tests**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
export REDIS_URL='redis://localhost:6380'
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/worker/test/pipeline.integration.test.ts
```

Expected: PASS, 7 tests. The first asserts the fixture's exact figures — 895 / 871 / 24 / 2503 / 228 / 370 — through the database.

- [ ] **Step 10: Falsify the transaction boundary**

In `#ingest`, move the `UPDATE run SET status = 'complete'` above the `MetricWriter().persist(...)` call and add `throw new Error('boom')` immediately after the update. Re-run.

Expected: FAIL on "writes nothing at all when the run fails" **or** a run marked `complete` with zero stats — either proves the assertion is live. Restore.

- [ ] **Step 11: Write the consumer and sweeper**

`apps/worker/src/consumer.ts`:

```ts
import { UnrecoverableError, Worker } from 'bullmq';
import type { WorkerConfig } from './config.js';
import { isTransient } from './pipeline/retry.js';
import type { PipelineService } from './pipeline/pipeline.service.js';

export function startConsumer(config: WorkerConfig, pipeline: PipelineService): Worker {
  return new Worker(
    'ingest',
    async (job) => {
      const runId = job.data.runId as string;
      try {
        await pipeline.process(runId);
      } catch (err) {
        // A deterministic failure is already recorded on the run. Retrying it
        // burns a worker slot to reach the identical conclusion.
        if (!isTransient(err)) {
          throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    { connection: { url: config.redisUrl }, concurrency: config.concurrency },
  );
}
```

`apps/worker/src/sweeper.ts`:

```ts
import { Queue } from 'bullmq';
import type pg from 'pg';
import type { WorkerConfig } from './config.js';

/**
 * Recovers the one inconsistency the accept path can produce: a run committed
 * whose queue enqueue never landed (spec §6.1). FOR UPDATE SKIP LOCKED makes
 * this safe with any number of worker replicas and needs no leader election,
 * which is why this slice has no separate scheduler deployable.
 */
export class Sweeper {
  readonly #queue: Queue;

  constructor(
    private readonly config: WorkerConfig,
    private readonly pool: pg.Pool,
  ) {
    this.#queue = new Queue('ingest', { connection: { url: config.redisUrl } });
  }

  async sweep(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM run
          WHERE status = 'pending'
            AND created_at < now() - ($1::int * interval '1 millisecond')
          ORDER BY created_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED`,
        [this.config.staleAfterMs],
      );
      for (const row of rows) {
        await this.#queue.add('ingest', { runId: row.id }, { jobId: `sweep-${row.id}-${rows.length}` });
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
```

`apps/worker/src/main.ts`:

```ts
import 'reflect-metadata';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { loadWorkerConfig } from './config.js';
import { startConsumer } from './consumer.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { Sweeper } from './sweeper.js';

const config = loadWorkerConfig();
const prisma = createPrisma(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const blobs = new BlobStore(config.blob);
await blobs.ensureBucket();

const pipeline = new PipelineService(config, prisma, pool, blobs);
const worker = startConsumer(config, pipeline);
const sweeper = new Sweeper(config, pool);

const timer = setInterval(() => {
  void sweeper.sweep().catch((err) => console.error('sweep failed', err));
}, config.sweepIntervalMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await worker.close();
  await sweeper.close();
  await pool.end();
  await prisma.$disconnect();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

- [ ] **Step 12: Add a sweeper test**

Append to `apps/worker/test/pipeline.integration.test.ts`:

```ts
describe('Sweeper', () => {
  it('re-enqueues a run whose job never landed, and leaves fresh ones alone', async () => {
    const { Sweeper } = await import('../src/sweeper.js');
    const ctx = await seedRun(bundle);
    await pool.query(`UPDATE run SET created_at = now() - interval '10 minutes' WHERE id = $1`, [
      ctx.runId,
    ]);
    const fresh = await seedRunKeepingExisting();

    const sweeper = new Sweeper({ ...config, staleAfterMs: 60_000 }, pool);
    try {
      const swept = await sweeper.sweep();
      expect(swept).toBe(1);
    } finally {
      await sweeper.close();
    }
    expect(fresh).toBeDefined();
  });
});

/** A second pending run created without truncating, so the sweep has both. */
async function seedRunKeepingExisting() {
  const project = await prisma.project.findFirstOrThrow();
  return prisma.run.create({
    data: {
      orgId: project.orgId, projectId: project.id, status: 'pending', tool: 'gatling',
      bundleKey: 'runs/none.tgz', bundleSha256: 'y'.repeat(64), bundleBytes: BigInt(1),
      startedAt: new Date('2026-08-07T10:00:00Z'),
      startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {},
    },
  });
}
```

- [ ] **Step 13: Run everything**

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/worker/test/
pnpm lint && pnpm typecheck
```

Expected: PASS, 12 tests; lint and typecheck clean.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(worker): the ingest pipeline

Statistics, assertions, and the run's terminal status commit in ONE
transaction, so a run is never observable with stats but no verdict, or with
a verdict but no stats. Falsified by moving the status update ahead of
persistence and throwing between them.

Only transient failures retry. A parse failure, an unsupported bundle, or a
cardinality violation is deterministic — retrying burns a worker slot to
reach the identical conclusion — and an unknown error is treated the same
way, because a bug retried three times is a bug three times.

The terminal notification is issued by pg_notify AFTER commit rather than
from inside the transaction, so it can never announce a state that rolled
back. Task 13 fans this out to Redis for the API's bounded wait.

The sweeper recovers the single inconsistency the accept path can produce —
a committed run whose enqueue never landed — using FOR UPDATE SKIP LOCKED,
which is safe across replicas and needs no leader election. That is why this
slice has no separate scheduler deployable.

Asserts the fixture's exact figures through the database: 895 requests,
871/24 OK/KO, max 2503, mean 228, stddev 370, and 15x500 / 9x503 errors."
```

---

## Task 13: The adaptive verdict

`POST` waits a bounded window for a terminal state, then answers `200`, `422`, or `400`. If the window expires it answers `202` with a status URL — and `GET /v1/runs/{id}` returns **the same code for the same state**. That identity is the contract.

> **Second departure from the spec, recorded.** Spec §6.1 step 7 says the API waits on **Redis pub/sub**. This plan waits on **Postgres `LISTEN/NOTIFY`** instead. The notification must never announce a state that rolled back; `pg_notify` issued after `COMMIT` returns gives that ordering for free, whereas a Redis publish is a second system that can fire on a transaction that then fails. It also removes Redis from the API's read path entirely. Redis remains the queue. If live streaming (M7) later needs Redis fan-out, it layers on top without changing this contract.

**Files:**
- Create: `apps/api/src/runs/{runs.controller,runs.service,terminal-waiter}.ts`
- Create: `apps/api/src/runs/runs.module.ts`
- Create: `apps/api/test/verdict.integration.test.ts`
- Modify: `apps/api/src/ingest/ingest.controller.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `RunRepository`, `createPool`; `RunResponse`, `AssertionSchema` from `@perfportal/contracts`.
- Produces:
  - `class TerminalWaiter { waitFor(runId: string, timeoutMs: number): Promise<boolean> }`
  - `class RunsService { toResponse(run): Promise<RunResponse>; statusFor(run): number }`
  - `GET /v1/runs/:id`
  - `POST /v1/runs` now returns `200` / `422` / `202`

- [ ] **Step 1: Write the failing test**

`apps/api/test/verdict.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunResponseSchema } from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

async function clearQueue() {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();
}

function post(waitMs?: number) {
  const metadata: Record<string, unknown> = { tool: 'gatling' };
  if (waitMs !== undefined) metadata.waitMs = waitMs;
  return request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify(metadata))
    .attach('bundle', bundle, 'bundle.tgz');
}

describe('the adaptive verdict', () => {
  it('answers 202 with a status URL when the wait window is zero', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const res = await post(0);

    expect(res.status).toBe(202);
    expect(res.body.statusUrl).toBe(`/v1/runs/${res.body.id}`);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('answers 200 with verdict not_evaluated when there are no rules', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('not_evaluated');
    expect(() => RunResponseSchema.parse(res.body)).not.toThrow();
  });

  it('answers 422 when a rule fails, listing the failing assertion', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(422);
    expect(res.body.verdict).toBe('failed');
    expect(res.body.assertions[0].outcome).toBe('failed');
  });

  it('answers 200 when a rule passes', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 100_000,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('passed');
  });

  it('answers 200 with not_evaluated when every rule is not_applicable', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'request', targetName: 'GET /nonexistent',
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 10,
      },
    });
    const accepted = await post(0);
    await runPipelineFor(ctx, accepted.body.id);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('not_evaluated');
    expect(res.body.assertions[0].outcome).toBe('not_applicable');
    expect(res.body.assertions[0].actualValue).toBeNull();
  });

  it('answers 400 with the structured ingest error when the bundle was rejected', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
      .attach('bundle', Buffer.from('not a tarball'), 'bundle.tgz');
    await runPipelineFor(ctx, accepted.body.id).catch(() => undefined);

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUNDLE_NOT_ARCHIVE');
    expect(res.body.remediation).toBeTruthy();
  });

  it('returns 404 for a run belonging to another project', async () => {
    await clearQueue();
    ctx = await createTestApp();
    const accepted = await post(0);

    const other = await ctx.prisma.org.create({ data: { slug: 'other', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'p', name: 'P', settings: {} },
    });
    const { mintToken, hashToken } = await import('../src/auth/tokens.js');
    const t = mintToken();
    await ctx.prisma.apiToken.create({
      data: {
        orgId: other.id, projectId: otherProject.id, name: 'x',
        prefix: t.prefix, tokenHash: await hashToken(t.token.split('_')[2]!), scopes: ['read'],
      },
    });

    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted.body.id}`)
      .set('Authorization', `Bearer ${t.token}`);

    expect(res.status).toBe(404);
  });

  it('POST and GET return the identical code for the identical state', async () => {
    await clearQueue();
    ctx = await createTestApp();
    await ctx.prisma.slaRule.create({
      data: {
        orgId: ctx.orgId, projectId: ctx.projectId, scope: 'run', targetName: null,
        family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 1,
      },
    });

    // Long window; the pipeline runs concurrently and the waiter is woken by
    // the post-commit notification.
    const posted = post(20_000);
    const accepted = await new Promise<string>((resolve) => {
      const poll = setInterval(async () => {
        const row = await ctx.prisma.run.findFirst({ orderBy: { createdAt: 'desc' } });
        if (row) {
          clearInterval(poll);
          resolve(row.id);
        }
      }, 50);
    });
    await runPipelineFor(ctx, accepted);
    const postRes = await posted;

    const getRes = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${accepted}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    expect(postRes.status).toBe(422);
    expect(getRes.status).toBe(postRes.status);
    expect(getRes.body.verdict).toBe(postRes.body.verdict);
  });
});
```

`apps/api/test/support/pipeline.ts` — runs the worker's pipeline in-process, so the API tests do not need a separate worker deployable running:

```ts
import { BlobStore } from '@perfportal/storage';
import { PipelineService } from '../../../worker/src/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../../../worker/src/config.js';
import type { TestContext } from './app.js';

export async function runPipelineFor(ctx: TestContext, runId: string): Promise<void> {
  const config = loadWorkerConfig();
  const blobs = new BlobStore(config.blob);
  const pipeline = new PipelineService(config, ctx.prisma, ctx.pool, blobs);
  await pipeline.process(runId).catch(() => undefined);   // failures are recorded on the run
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/verdict.integration.test.ts
```

Expected: FAIL — `GET /v1/runs/:id` returns 404 (no route).

- [ ] **Step 3: Write the terminal waiter**

`apps/api/src/runs/terminal-waiter.ts`:

```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';

/**
 * Waits for a run to reach a terminal state.
 *
 * Listens on a DEDICATED connection: a pooled one would be handed to another
 * query mid-wait and the LISTEN registration would be lost. The worker issues
 * pg_notify only after its transaction commits, so a wake-up can never
 * announce a state that rolled back.
 */
@Injectable()
export class TerminalWaiter implements OnModuleInit, OnModuleDestroy {
  #client: pg.Client | null = null;
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(private readonly databaseUrl: string) {}

  async onModuleInit(): Promise<void> {
    this.#client = new pg.Client({ connectionString: this.databaseUrl });
    await this.#client.connect();
    this.#client.on('notification', (msg) => {
      if (msg.channel !== 'run_terminal' || !msg.payload) return;
      const set = this.#waiters.get(msg.payload);
      if (!set) return;
      for (const resolve of set) resolve();
    });
    await this.#client.query('LISTEN run_terminal');
  }

  /** Resolves true if the run went terminal within the window, false on timeout. */
  waitFor(runId: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (woken: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters.get(runId)?.delete(onNotify);
        resolve(woken);
      };
      const onNotify = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);

      let set = this.#waiters.get(runId);
      if (!set) {
        set = new Set();
        this.#waiters.set(runId, set);
      }
      set.add(onNotify);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client?.end();
    this.#client = null;
  }
}
```

- [ ] **Step 4: Write the runs service and controller**

`apps/api/src/runs/runs.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { RunResponse } from '@perfportal/contracts';
import { RunRepository, type RunRecord } from '@perfportal/persistence';
import type { PrismaClient } from '@prisma/client';

@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One status per state, used by BOTH the POST response and the GET response.
   * The identity of those two codes is the contract: a CI script handles the
   * fast and slow paths with one branch instead of two.
   *
   *   200  ingested, verdict passed or not_evaluated
   *   422  ingested, verdict failed
   *   400+ bundle rejected (the ingest error's own status)
   *   202  still processing
   */
  statusFor(run: RunRecord): number {
    if (run.status === 'failed') return 400;
    if (run.status !== 'complete') return 202;
    return run.verdict === 'failed' ? 422 : 200;
  }

  async toResponse(run: RunRecord): Promise<RunResponse> {
    const assertions = await this.prisma.runAssertion.findMany({
      where: { runId: run.id },
      orderBy: { outcome: 'asc' },   // 'failed' sorts before 'not_applicable' and 'passed'
    });

    return {
      id: run.id,
      status: run.status as RunResponse['status'],
      verdict: (run.verdict ?? null) as RunResponse['verdict'],
      tool: run.tool,
      toolVersion: run.toolVersion,
      startedAt: run.startedAt.toISOString(),
      ingestedAt: run.ingestedAt ? run.ingestedAt.toISOString() : null,
      error: run.error,
      assertions: assertions.map((a) => {
        const snap = a.ruleSnapshot as {
          scope: string; targetName: string | null; family: string;
          metric: string; comparator: string; threshold: number;
        };
        return {
          ruleId: a.ruleId,
          outcome: a.outcome as 'passed' | 'failed' | 'not_applicable',
          actualValue: a.actualValue,
          message: a.message,
          rule: {
            scope: snap.scope as 'run' | 'scenario' | 'group' | 'request',
            targetName: snap.targetName,
            family: snap.family as 'response_time' | 'latency' | 'group_cumulated' | 'group_duration',
            metric: snap.metric,
            comparator: snap.comparator as 'lte' | 'gte',
            threshold: snap.threshold,
          },
        };
      }),
    };
  }

  runs(): RunRepository {
    return new RunRepository(this.prisma);
  }
}
```

`apps/api/src/runs/runs.controller.ts`:

```ts
import { Controller, Get, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemFromIngestError } from '../common/problem.js';
import { IngestError, type IngestErrorCode } from '@perfportal/core';
import type { RunRecord } from '@perfportal/persistence';
import { AuthGuard } from '../auth/auth.guard.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { RunsService } from './runs.service.js';

@Controller('/v1/runs')
@UseGuards(AuthGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get(':id')
  @Scopes('read')
  async get(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const tenant = req.tenant!;
    const run = await this.runs
      .runs()
      .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);

    await respondWithRun(this.runs, run, res);
  }
}

/**
 * Shared by GET and POST so the two cannot drift. This function IS the
 * "same code for the same state" guarantee.
 */
export async function respondWithRun(
  runs: RunsService,
  run: RunRecord,
  res: Response,
  retryAfterSeconds = 5,
): Promise<void> {
  const status = runs.statusFor(run);

  if (status === 202) {
    res
      .status(202)
      .set('Retry-After', String(retryAfterSeconds))
      .json({ id: run.id, status: run.status, statusUrl: `/v1/runs/${run.id}` });
    return;
  }

  if (run.status === 'failed') {
    const err = run.error ?? {
      code: 'INTERNAL',
      message: 'The run could not be ingested.',
      remediation: 'Retry the upload.',
    };
    const body = problemFromIngestError(
      new IngestError(err.code as IngestErrorCode, {
        message: err.message,
        remediation: err.remediation,
      }),
    );
    res.status(body.status).type('application/problem+json').json(body);
    return;
  }

  res.status(status).json(await runs.toResponse(run));
}
```

`apps/api/src/runs/runs.module.ts`:

```ts
import { Inject, Module } from '@nestjs/common';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { TerminalWaiter } from './terminal-waiter.js';

@Module({
  controllers: [RunsController],
  providers: [
    RunsService,
    {
      provide: TerminalWaiter,
      useFactory: (config: AppConfig) => new TerminalWaiter(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [RunsService, TerminalWaiter],
})
export class RunsModule {}
```

- [ ] **Step 5: Wire the wait into `POST`**

Replace the body of `apps/api/src/ingest/ingest.controller.ts`:

```ts
import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { respondWithRun } from '../runs/runs.controller.js';
import { RunsService } from '../runs/runs.service.js';
import { TerminalWaiter } from '../runs/terminal-waiter.js';
import { IngestService } from './ingest.service.js';
import { readMultipart } from './multipart.js';

@Controller('/v1/runs')
@UseGuards(AuthGuard)
export class IngestController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly ingest: IngestService,
    private readonly runs: RunsService,
    private readonly waiter: TerminalWaiter,
  ) {}

  @Post()
  @Scopes('ingest')
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upload = await readMultipart(req);
    const metadata = this.ingest.parseMetadata(upload.metadataRaw);
    const accepted = await this.ingest.accept(req.tenant!, metadata, upload.bundle);

    const waitMs = metadata.waitMs ?? this.config.defaultWaitMs;
    await this.waiter.waitFor(accepted.id, waitMs);

    // Re-read: the wait may have timed out, or the worker may have finished
    // before the subscription was registered. The row is the source of truth,
    // never the notification.
    const tenant = req.tenant!;
    const current =
      (await this.runs
        .runs()
        .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, accepted.id)) ?? accepted;

    await respondWithRun(this.runs, current, res);
  }
}
```

Register `RunsModule` in `apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { IngestModule } from './ingest/ingest.module.js';
import { RunsModule } from './runs/runs.module.js';

@Module({
  imports: [AuthModule, RunsModule, IngestModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 6: Run the tests**

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/verdict.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Falsify the code-parity guarantee**

In `RunsController.get`, replace `await respondWithRun(this.runs, run, res)` with `res.status(200).json(await this.runs.toResponse(run))`. Re-run.

Expected: FAIL on "answers 422 when a rule fails" and on "POST and GET return the identical code". Restore — and note that sharing `respondWithRun` is what makes the drift impossible rather than merely unlikely.

- [ ] **Step 8: Falsify the re-read after waiting**

In `IngestController.post`, use `accepted` directly instead of re-reading `current`. Re-run.

Expected: FAIL on "POST and GET return the identical code" — the POST answers 202 from the stale row. Restore.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): the adaptive verdict

200 passed/not_evaluated, 422 failed, 400 rejected, 202 still processing —
and GET returns the SAME code for the SAME state, because both paths call one
respondWithRun function. That identity is the contract, not an implementation
detail: it lets a CI script handle the fast and slow paths with one branch.
Falsified by giving GET its own response path; two tests fail.

Departs from spec §6.1 step 7, which specified Redis pub/sub. Postgres
LISTEN/NOTIFY is used instead: the worker's pg_notify is issued after COMMIT
returns, so a wake-up can never announce a state that rolled back, whereas a
Redis publish is a second system that can fire on a transaction that then
fails. It also keeps Redis off the API read path. Redis remains the queue.

The waiter listens on a dedicated connection — a pooled one would be handed
to another query mid-wait and lose the LISTEN registration. After waking, the
row is re-read: the notification is a hint, the row is the truth, and the
worker can finish before the subscription is even registered.

202 is a timing outcome, never an error."
```

---

## Task 14: Read endpoints and OpenAPI

Enough to prove the persisted shape is usable, no more. The series endpoint is where the partition key must be threaded through, and a test asserts it.

**Files:**
- Create: `apps/api/src/metrics/{metrics.controller,metrics.module}.ts`
- Create: `apps/api/src/openapi.ts`
- Create: `apps/api/test/read.integration.test.ts`
- Modify: `apps/api/src/runs/runs.controller.ts` (add the list route), `apps/api/src/app.module.ts`, `apps/api/src/main.ts`

**Interfaces:**
- Consumes: `MetricReader`, `RunRepository`; `StatsResponse`, `SeriesResponse`, `ErrorsResponse`, `RunListResponse` from `@perfportal/contracts`.
- Produces: `GET /v1/runs/:id/stats`, `GET /v1/runs/:id/series`, `GET /v1/runs/:id/errors`, `GET /v1/projects/:slug/runs`, `GET /v1/openapi.json`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/read.integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ErrorsResponseSchema,
  RunListResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
} from '@perfportal/contracts';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'read-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(FIXTURE_LOG, join(results, 'simulation.log'));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

async function ingested(): Promise<string> {
  const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
  await q.obliterate({ force: true });
  await q.close();

  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  await runPipelineFor(ctx, res.body.id);
  return res.body.id;
}

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });

describe('GET /v1/runs/:id/stats', () => {
  it('returns the run-scope statistics matching the fixture', async () => {
    ctx = await createTestApp();
    const id = await ingested();

    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.status).toBe(200);
    expect(() => StatsResponseSchema.parse(res.body)).not.toThrow();

    const runStat = res.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(runStat.count).toBe(895);
    expect(runStat.okCount).toBe(871);
    expect(runStat.koCount).toBe(24);
    expect(Math.round(runStat.maxMs)).toBe(2503);
  });

  it('reports the indicator bands the Gatling report shows', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/stats`).set(auth());
    expect(res.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
  });

  it('filters by scope', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats?scope=request`)
      .set(auth());
    expect(res.body.stats.length).toBeGreaterThan(0);
    expect(res.body.stats.every((s: { scope: string }) => s.scope === 'request')).toBe(true);
  });
});

describe('GET /v1/runs/:id/series', () => {
  it('returns buckets that account for every request', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/series?scope=run&name=`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(() => SeriesResponseSchema.parse(res.body)).not.toThrow();
    expect(
      res.body.buckets.reduce((a: number, b: { startedCount: number }) => a + b.startedCount, 0),
    ).toBe(895);
  });
});

describe('GET /v1/runs/:id/errors', () => {
  it('returns the error table with the fixture counts', async () => {
    ctx = await createTestApp();
    const id = await ingested();
    const res = await request(ctx.app.getHttpServer()).get(`/v1/runs/${id}/errors`).set(auth());

    expect(() => ErrorsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
  });
});

describe('GET /v1/projects/:slug/runs', () => {
  it('lists runs newest first and paginates by cursor', async () => {
    ctx = await createTestApp();
    await ingested();
    await ingested();

    const first = await request(ctx.app.getHttpServer())
      .get('/v1/projects/checkout/runs?limit=1')
      .set(auth());
    expect(() => RunListResponseSchema.parse(first.body)).not.toThrow();
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(ctx.app.getHttpServer())
      .get(`/v1/projects/checkout/runs?limit=1&cursor=${first.body.nextCursor}`)
      .set(auth());
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it('refuses a project the token does not belong to', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/projects/some-other-project/runs')
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('is served and describes the ingest endpoint', async () => {
    ctx = await createTestApp();
    const res = await request(ctx.app.getHttpServer()).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/v1/runs']).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts
```

Expected: FAIL — every metrics route 404s.

- [ ] **Step 3: Write the metrics controller**

`apps/api/src/metrics/metrics.controller.ts`:

```ts
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import type {
  ErrorsResponse,
  SeriesResponse,
  StatsResponse,
} from '@perfportal/contracts';
import { MetricReader, RunRepository } from '@perfportal/persistence';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import pg from 'pg';
import { AuthGuard } from '../auth/auth.guard.js';
import { Scopes } from '../auth/scopes.decorator.js';

@Controller('/v1/runs/:id')
@UseGuards(AuthGuard)
export class MetricsController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
  ) {}

  /**
   * Resolves the run first, for two reasons: it enforces tenancy, and it
   * supplies run.startedOn — the partition key. A series query filtering only
   * on run_id cannot prune and would scan every partition.
   */
  async #run(req: Request, id: string) {
    const tenant = req.tenant!;
    const run = await new RunRepository(this.prisma).findById(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      id,
    );
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);
    return run;
  }

  @Get('stats')
  @Scopes('read')
  async stats(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('family') family?: string,
  ): Promise<StatsResponse> {
    const run = await this.#run(req, id);
    const all = await new MetricReader(this.pool).stats(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
    );
    const stats = all
      .filter((s) => (scope ? s.scope === scope : true))
      .filter((s) => (family ? s.family === family : true));

    const runStat = all.find((s) => s.scope === 'run' && s.family === 'response_time');

    return {
      runId: run.id,
      stats: stats.map((s) => ({
        scope: s.scope as StatsResponse['stats'][number]['scope'],
        name: s.name,
        family: s.family as StatsResponse['stats'][number]['family'],
        count: s.count,
        okCount: s.okCount,
        koCount: s.koCount,
        errorRate: s.errorRate,
        minMs: s.minMs,
        maxMs: s.maxMs,
        meanMs: s.meanMs,
        stddevMs: s.stddevMs,
        throughputRps: s.throughputRps,
        percentiles: s.percentiles,
      })),
      indicators: await this.#indicators(run.id, run.orgId, run.projectId, runStat?.koCount ?? 0),
    };
  }

  /**
   * Indicator bands are recomputed from the persisted run-scope buckets rather
   * than stored separately, so they can never disagree with the series.
   */
  async #indicators(
    runId: string,
    orgId: string,
    projectId: string,
    failed: number,
  ): Promise<StatsResponse['indicators']> {
    const { rows } = await this.pool.query<{ under: string; between: string; over: string }>(
      `SELECT
         coalesce(sum(under), 0)::text   AS under,
         coalesce(sum(between_), 0)::text AS between_,
         coalesce(sum(over), 0)::text    AS over
       FROM run_indicator
       WHERE run_id = $1 AND org_id = $2 AND project_id = $3`,
      [runId, orgId, projectId],
    );
    const r = rows[0];
    return {
      under: Number(r?.under ?? 0),
      between: Number(r?.between_ ?? 0),
      over: Number(r?.over ?? 0),
      failed,
    };
  }

  @Get('series')
  @Scopes('read')
  async series(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('scope') scope = 'run',
    @Query('name') name = '',
  ): Promise<SeriesResponse> {
    const run = await this.#run(req, id);
    const buckets = await new MetricReader(this.pool).series(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      run.startedOn,
      { scope, name },
    );
    return {
      runId: run.id,
      scope: scope as SeriesResponse['scope'],
      name,
      buckets,
    };
  }

  @Get('errors')
  @Scopes('read')
  async errors(@Param('id') id: string, @Req() req: Request): Promise<ErrorsResponse> {
    const run = await this.#run(req, id);
    const errors = await new MetricReader(this.pool).errors(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
    );
    return { runId: run.id, errors };
  }
}
```

- [ ] **Step 4: Persist the indicator bands**

The controller above reads a `run_indicator` table that does not exist yet — it will not compile until this step is done. Add it, because the bands are part of the Gatling report's global page and recomputing them from scalar buckets would be an estimate rather than the engine's exact count.

Add to `packages/persistence/prisma/schema.prisma`:

```prisma
model RunIndicator {
  id        String @id @default(uuid()) @db.Uuid
  runId     String @unique @map("run_id") @db.Uuid
  orgId     String @map("org_id") @db.Uuid
  projectId String @map("project_id") @db.Uuid
  under     Int
  between   Int    @map("between_")
  over      Int
  failed    Int

  @@map("run_indicator")
}
```

Migrate:

```bash
cd packages/persistence && pnpm exec prisma migrate dev --name run_indicator --schema prisma/schema.prisma && cd ../..
```

Add `'run_indicator'` to `SCHEMA_TABLES` in `packages/persistence/src/client.ts`, and to the `TABLES` list in `apps/api/test/support/app.ts` and `apps/worker/test/pipeline.integration.test.ts`.

Write it in `MetricWriter.persist` (`packages/persistence/src/metrics/write.ts`), at the end of the method:

```ts
    await insertBatched(
      client,
      'run_indicator',
      ['id', 'run_id', 'org_id', 'project_id', 'under', 'between_', 'over', 'failed'],
      [[
        crypto.randomUUID(), ctx.runId, ctx.orgId, ctx.projectId,
        result.indicators.under, result.indicators.between,
        result.indicators.over, result.indicators.failed,
      ]],
    );
```

Re-run the persistence and worker suites after this change — `MetricWriter.persist` now writes one more table, and the pipeline tests exercise it:

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/ apps/worker/test/
```

Expected: PASS, unchanged counts.

- [ ] **Step 5: Add the list route and OpenAPI**

Append to `apps/api/src/runs/runs.controller.ts`, as a second controller in the same file:

```ts
import { Controller as NestController } from '@nestjs/common';
import type { RunListResponse } from '@perfportal/contracts';
import { ProjectRepository } from '@perfportal/persistence';

@NestController('/v1/projects/:slug/runs')
@UseGuards(AuthGuard)
export class ProjectRunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
  ) {}

  @Get()
  @Scopes('read')
  async list(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: string,
  ): Promise<RunListResponse> {
    const tenant = req.tenant!;
    const project = await this.projects.byId(tenant.projectId);
    // The token names the project; the slug must agree with it. A token cannot
    // read a project it does not belong to by naming a different slug.
    if (!project || project.slug !== slug) {
      throw new NotFoundException(`No project "${slug}" available to this token.`);
    }

    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      { limit: Math.min(Number(limit) || 25, 100), ...(cursor ? { cursor } : {}) },
    );
    return {
      items: page.items.map((r) => ({
        id: r.id,
        status: r.status as RunListResponse['items'][number]['status'],
        verdict: (r.verdict ?? null) as RunListResponse['items'][number]['verdict'],
        tool: r.tool,
        startedAt: r.startedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
```

Add `Query` to the `@nestjs/common` import list at the top of that file, and add `byId` to `ProjectRepository` in `packages/persistence/src/repositories/project.ts`:

```ts
  async byId(projectId: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      settings: (row.settings ?? {}) as ProjectSettings,
    };
  }
```

`apps/api/src/openapi.ts`:

```ts
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export function mountOpenApi(app: INestApplication): void {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PerfPortal API')
      .setVersion('1.0.0')
      .setDescription(
        [
          'Ingest and read performance test runs.',
          '',
          'POST /v1/runs and GET /v1/runs/{id} return THE SAME STATUS CODE for the same run state:',
          '  200 ingested, verdict passed or not_evaluated',
          '  422 ingested, verdict failed',
          '  400 bundle rejected (problem+json with a remediation field)',
          '  202 still processing — a TIMING OUTCOME, NEVER AN ERROR. Poll statusUrl.',
          '',
          'A client that treats 202 as failure is misusing this API.',
        ].join('\n'),
      )
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('/v1/docs', app, doc, {
    jsonDocumentUrl: '/v1/openapi.json',
  });
}
```

Register the new controllers in `apps/api/src/runs/runs.module.ts` (`controllers: [RunsController, ProjectRunsController]`), create `apps/api/src/metrics/metrics.module.ts` exporting `MetricsController`, add both to `AppModule`, and call `mountOpenApi(app)` in `main.ts` and in `createTestApp` before `app.init()`.

- [ ] **Step 6: Run the tests**

```bash
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/read.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Falsify the partition-key threading**

In `MetricsController.series`, pass `new Date('2020-01-01')` instead of `run.startedOn`. Re-run.

Expected: FAIL on "returns buckets that account for every request" — zero buckets, because the query prunes to a partition that holds none. This is the good failure: a wrong partition key returns *nothing*, not *wrong numbers*. Restore.

- [ ] **Step 8: Falsify the project-slug check**

In `ProjectRunsController.list`, drop the `project.slug !== slug` condition. Re-run.

Expected: FAIL on "refuses a project the token does not belong to". Restore.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): read endpoints and OpenAPI

Every metrics route resolves the run first, which enforces tenancy AND
supplies run.startedOn — the partition key. Falsified by passing a wrong
date: the series comes back empty rather than wrong, which is the failure
mode to want.

Indicator bands are persisted from the engine's exact counts rather than
recomputed from scalar buckets, so the global page's numbers can never
disagree with the series it sits above.

The OpenAPI description states in prose that 202 is a timing outcome and
never an error, because that is the one part of this contract a client can
misread while still 'working'."
```

---

## Task 15: End-to-end parity, developer setup, and CI

The keystone. One test drives the whole slice — HTTP in, statistics out — and asserts figures proven independently by the package tests and by the Gatling report itself.

**Files:**
- Create: `apps/api/test/parity.e2e.test.ts`
- Create: `infra/README.md`
- Create: `.github/workflows/ci.yml` (replace)
- Modify: root `package.json`, root `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: a green CI pipeline running unit and integration suites on a clean install.

- [ ] **Step 1: Write the keystone test**

`apps/api/test/parity.e2e.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

const REPORT_DIR = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report', import.meta.url),
);

let bundle: Buffer;
let ctx: TestContext;

/**
 * The bundle is the WHOLE reference report directory, exactly as a CI pipeline
 * would archive target/gatling/<run>. Not a hand-picked simulation.log.
 */
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const results = join(dir, 'paritysimulation-20260807123456789');
  mkdirSync(results, { recursive: true });
  for (const entry of readdirSync(REPORT_DIR)) {
    copyFileSync(join(REPORT_DIR, entry), join(results, entry));
  }
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'paritysimulation-20260807123456789']);
  bundle = readFileSync(out);
});

afterEach(async () => {
  await ctx?.close();
});

describe('end-to-end parity with the Gatling reference report', () => {
  it('reproduces every exact statistic through HTTP', async () => {
    const q = new Queue('ingest', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6380' } });
    await q.obliterate({ force: true });
    await q.close();

    ctx = await createTestApp();

    // 1. Ingest, asking for no synchronous wait.
    const accepted = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'parity-1' }))
      .attach('bundle', bundle, 'bundle.tgz');

    expect(accepted.status).toBe(202);
    const runId: string = accepted.body.id;

    // 2. Run the pipeline.
    await runPipelineFor(ctx, runId);

    // 3. The run is complete, with no rules configured.
    const run = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('complete');
    expect(run.body.verdict).toBe('not_evaluated');
    expect(run.body.toolVersion).toBe('3.15.1');

    // 4. Exact statistics — every one of these appears in the Gatling report.
    const stats = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/stats`)
      .set('Authorization', `Bearer ${ctx.readToken}`);

    const global = stats.body.stats.find(
      (s: { scope: string; family: string }) => s.scope === 'run' && s.family === 'response_time',
    );
    expect(global.count).toBe(895);
    expect(global.okCount).toBe(871);
    expect(global.koCount).toBe(24);
    expect(Math.round(global.maxMs)).toBe(2503);
    expect(Math.round(global.meanMs)).toBe(228);
    expect(Math.round(global.stddevMs)).toBe(370);

    expect(stats.body.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });

    // 5. The error table, with both messages and their exact counts.
    const errors = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/errors`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(errors.body.errors.map((e: { count: number }) => e.count)).toEqual([15, 9]);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('500'))).toHaveLength(1);
    expect(errors.body.errors.filter((e: { message: string }) => e.message.includes('503'))).toHaveLength(1);

    // 6. Groups — Gatling reports cumulated response time and duration
    //    separately, and they diverge whenever requests inside a group overlap.
    const groups = stats.body.stats.filter((s: { scope: string }) => s.scope === 'group');
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(groups.map((g: { family: string }) => g.family))).toEqual(
      new Set(['group_cumulated', 'group_duration']),
    );
    expect(groups.some((g: { name: string }) => g.name === 'Catalog/Recommendations')).toBe(true);

    // 7. The time series accounts for every request, at both edges.
    const series = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/series?scope=run&name=`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    const started = series.body.buckets.reduce(
      (a: number, b: { startedCount: number }) => a + b.startedCount, 0,
    );
    const ended = series.body.buckets.reduce(
      (a: number, b: { endedCount: number }) => a + b.endedCount, 0,
    );
    expect(started).toBe(895);
    expect(ended).toBe(895);

    // 8. Percentiles are ESTIMATES and are checked against ground truth, not
    //    against Gatling — Gatling's own printed percentiles are histogram
    //    estimates and three of its four never occur in the data (spec §A.9 F-6).
    //    DDSketch guarantees 1% relative error, and 1.000% is reachable, so
    //    this bound is <=, never <.
    expect(Math.abs(global.percentiles.p95 - 654) / 654).toBeLessThanOrEqual(0.01);
  });

  it('is idempotent end to end — re-posting the same key yields one run', async () => {
    ctx = await createTestApp();
    const post = () =>
      request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, idempotencyKey: 'same' }))
        .attach('bundle', bundle, 'bundle.tgz');

    const a = await post();
    await runPipelineFor(ctx, a.body.id);
    const b = await post();

    expect(b.body.id).toBe(a.body.id);
    expect(await ctx.prisma.run.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

```bash
export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
export REDIS_URL='redis://localhost:6380'
pnpm build
pnpm vitest run --config vitest.integration.config.ts apps/api/test/parity.e2e.test.ts
```

Expected: PASS, 2 tests.

If the group assertion fails on the exact name, print the actual group names first — the fixture nests `Catalog` → `Recommendations`, joined with `/` by the engine — and correct the expectation to the observed value rather than changing the engine.

- [ ] **Step 3: Falsify the keystone**

Break the engine's warm-up handling by editing `packages/statistics/src/engine.ts` to always skip the first event's rollup (`if (endpoints.size === 1) continue;` after the `endpoints.add`). Rebuild and re-run.

Expected: FAIL with a count other than 895. Restore with `git checkout packages/statistics/src/engine.ts` and rebuild.

- [ ] **Step 4: Write developer setup docs**

`infra/README.md`:

```markdown
# Local infrastructure

    docker compose -f infra/docker-compose.yml up -d

Ports are deliberately offset so an existing local Postgres or Redis is never
shadowed:

| Service    | Port | Credentials              |
|------------|------|--------------------------|
| PostgreSQL | 5433 | perfportal / perfportal  |
| Redis      | 6380 | —                        |
| MinIO      | 9000 | perfportal / perfportal123 |

## Environment

    export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
    export REDIS_URL='redis://localhost:6380'
    export S3_ENDPOINT='http://localhost:9000'
    export S3_ACCESS_KEY='perfportal'
    export S3_SECRET_KEY='perfportal123'

## First run

    nvm use                      # Node 22 — the repo floor, and what CI pins
    pnpm install
    pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
    pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
    pnpm build                   # REQUIRED before running either app: the packages
                                 # resolve to dist/ at runtime, source only under vitest
    pnpm test                    # unit
    pnpm test:integration        # needs the services above

## Running the slice

    pnpm --filter @perfportal/api start &
    pnpm --filter @perfportal/worker start &

Then post the reference fixture:

    tar -czf /tmp/bundle.tgz -C fixtures/gatling-3.15.1.2 reference-report
    curl -sS -X POST http://localhost:3000/v1/runs \
      -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
      -F 'metadata={"tool":"gatling"}' \
      -F bundle=@/tmp/bundle.tgz
```

- [ ] **Step 5: Rewrite CI**

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: perfportal
          POSTGRES_PASSWORD: perfportal
          POSTGRES_DB: perfportal
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U perfportal"
          --health-interval 5s --health-timeout 5s --health-retries 20

      redis:
        image: redis:7-alpine
        ports: ['6380:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 5s --health-retries 20

      minio:
        image: bitnami/minio:latest
        env:
          MINIO_ROOT_USER: perfportal
          MINIO_ROOT_PASSWORD: perfportal123
        ports: ['9000:9000']
        options: >-
          --health-cmd "curl -f http://localhost:9000/minio/health/live"
          --health-interval 5s --health-timeout 5s --health-retries 20

    env:
      DATABASE_URL: postgresql://perfportal:perfportal@localhost:5433/perfportal
      REDIS_URL: redis://localhost:6380
      S3_ENDPOINT: http://localhost:9000
      S3_ACCESS_KEY: perfportal
      S3_SECRET_KEY: perfportal123

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      # A dependency change is only validated from a clean install. The single
      # CI failure in this project's history was a removal verified against a
      # stale node_modules that still had the package hoisted.
      - run: pnpm install --frozen-lockfile

      - run: pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
      - run: pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma

      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test:unit
      - run: pnpm test:integration
```

`node-version-file: .nvmrc` keeps CI and developer machines on one version rather than two that can drift — and this repo has already been running local tests on Node 20 against a declared floor of 22.

- [ ] **Step 6: Add the engine-floor guard**

Root `package.json` — make the mismatch loud instead of silent:

```json
  "engines": { "node": ">=22" },
  "scripts": {
    "preinstall": "node -e \"const [maj]=process.versions.node.split('.').map(Number); if (maj < 22) { console.error('\\nNode ' + process.versions.node + ' is below this repo\\'s floor of 22. Run: nvm use\\n'); process.exit(1); }\""
  }
```

- [ ] **Step 7: Full verification from a clean install**

```bash
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
rm -rf node_modules packages/*/node_modules apps/*/node_modules
pnpm install --frozen-lockfile
pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit && pnpm test:integration
```

Expected: all green. Record the final test counts in the commit message.

- [ ] **Step 8: Update the root README**

Add a section describing what now exists: the two apps, the packages they consume, the local setup pointer to `infra/README.md`, and the verdict contract table from §7 of the spec.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test: end-to-end parity, developer setup, and CI

One test drives the whole slice — multipart POST, object storage, queue,
plugin, engine, persistence, HTTP read — and asserts figures proven
independently by the package tests and by the Gatling report itself: 895
requests, 871/24 OK/KO, bands 848/0/23, max 2503, mean 228, stddev 370, and
15x500 / 9x503 errors. Its ground truth predates the stack, so if ingest,
persistence, or serialization corrupts anything, the numbers move.

It posts the WHOLE reference-report directory, exactly as a CI pipeline would
archive target/gatling/<run>, rather than a hand-picked simulation.log.

Percentiles are checked against ground truth rather than against Gatling.
Gatling's printed percentiles are histogram estimates and three of its four
never occur in the data, so matching them would mean reproducing another
tool's estimator error. The bound is <= 1%, never <, because DDSketch can
legitimately reach exactly 1.000%.

CI runs on a clean --frozen-lockfile install with real Postgres, Redis, and
MinIO, and takes its Node version from .nvmrc so CI and developer machines
cannot drift — this repo has been running local tests on Node 20 against a
declared floor of 22. A preinstall guard now makes that mismatch loud."
```

---

## Done

The slice is complete when:

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm install --frozen-lockfile && pnpm build
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration
```

is green from a clean checkout, and `apps/api/test/parity.e2e.test.ts` reproduces the Gatling reference report's exact statistics through HTTP.

**What is deliberately not here** (spec §1.2): users, sessions, SSO, RBAC roles · Kubernetes · WebSockets and live ingest · baselines, regressions, trends, comparison · notifications · the React UI · report generation · Gatling's assertion protobuf · non-Gatling plugins · and the §20.2 throughput budget, which becomes a measurement task now that there is something to measure.
