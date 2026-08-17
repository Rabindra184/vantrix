# Live Fold Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run that is currently streaming has live, incrementally-maintained statistics, published to Redis on a timer.

**Architecture:** a `LiveFoldOwner` in the worker claims each `running` run with the advisory lock `PipelineService` already uses, reads the chunk objects the API has written to blob storage, folds them through `StreamingLogDecoder` + `LiveEngine`, and publishes a bounded delta every tick to `live:{runId}` plus a capped `live:{runId}:deltas` stream. The API publishes a run id — never bytes — to `live:advance` so the owner wakes without polling.

**Tech Stack:** TypeScript, Node 22, `ioredis`, raw `pg` (advisory locks), Prisma, S3-compatible storage via `@aws-sdk`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-live-run-monitoring-part-2a-design.md`

## Scope

This plan implements the whole of Part 2a — the spec's §8 stages 1–4, plus docs. Part 2b (WebSocket, replay *reads*, dashboard) is a separate spec and plan. This one ends with deltas on a Redis channel and a test subscriber proving their shape; nothing a user can see.

## Global Constraints

- **Node 22 (`.nvmrc`). `nvm use` first.** On Node 20 every DOM-environment test file silently fails to load while Vitest prints a green summary. Floor: **92 files / 1029 tests**; fewer means the run was incomplete, not that tests passed.
- The full gate, in this order — **integration BEFORE e2e**, never the reverse:
  `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
- **Never run `pnpm test:integration` (the whole suite) while iterating** — it truncates every table on setup. Run your own file by path.
- Integration tests need the stack: `docker compose -f infra/docker-compose.yml up -d` plus `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` per `CLAUDE.md`.
- **Expectations are computed from the payload, never hard-coded** where a fixture supplies them.
- **Any instant column must be `timestamptz`.** This plan adds no columns; do not add one casually.
- `@perfportal/statistics`, `@perfportal/contracts` and `@perfportal/plugin-gatling` are **pure** — no `fs`, `net`, or DB client in production code. Test files are exempt.
- **The advisory lock must be taken and released on ONE connection** (`pipeline.service.ts:99-119`), or it is orphaned.
- Commit messages here carry the argument, not just the change. Merge with `--merge`, never squash.

## File Structure

| File | Responsibility |
|---|---|
| `packages/storage/src/live-chunks.ts` *(modify)* | Gains `readFrom(runId, offset)` — the chunks at or past a byte offset |
| `packages/contracts/src/live-delta.ts` *(create)* | The delta wire schema, shared with Part 2b's browser client |
| `packages/contracts/src/index.ts` *(modify)* | Re-export it |
| `apps/worker/src/live/delta.ts` *(create)* | Pure `buildDelta` — `EngineResult` + cursor → delta + next cursor. Where the coalesce rule lives |
| `apps/worker/src/live/fold-owner.ts` *(create)* | Claim, fold, tick, publish, release |
| `apps/worker/src/config.ts` *(modify)* | `liveTickMs`, `maxOwnedRuns` |
| `apps/worker/src/main.ts` *(modify)* | Construct, start, close the owner |
| `apps/api/src/ingest/live.service.ts` *(modify)* | Publish the `live:advance` ping |
| `README.md`, `CLAUDE.md` *(modify)* | Document the channels; raise the test floor |

---

### Task 1: `LiveChunkStore.readFrom(runId, offset)`

The owner needs "the bytes at or past offset N", which nothing provides today: `assemble()` returns everything and `finalize()` consumes it.

**Files:**
- Modify: `packages/storage/src/live-chunks.ts`
- Test: `packages/storage/test/live-chunks.integration.test.ts` (append)

**Interfaces:**
- Consumes: `BlobStore.list(prefix)` (`blobs.ts:175`), `BlobStore.get(key)`; the existing private `chunkPrefix(runId)` / `chunkKey(runId, offset)` (`live-chunks.ts:6,20`)
- Produces:
  ```ts
  /** Every chunk whose start offset is >= `offset`, concatenated in offset order. */
  async readFrom(runId: string, offset: number): Promise<Buffer>
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/storage/test/live-chunks.integration.test.ts`:

```ts
it('readFrom returns only the chunks at or past an offset, in order', async () => {
  const store = new LiveChunkStore(blobs);
  const runId = `readfrom-${randomUUID()}`;

  await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));      // [0,4)
  await store.put(runId, 4, Buffer.from('bbbb', 'latin1'));      // [4,8)
  await store.put(runId, 8, Buffer.from('cccc', 'latin1'));      // [8,12)

  expect((await store.readFrom(runId, 0)).toString('latin1')).toBe('aaaabbbbcccc');
  expect((await store.readFrom(runId, 4)).toString('latin1')).toBe('bbbbcccc');
  expect((await store.readFrom(runId, 8)).toString('latin1')).toBe('cccc');
});

it('readFrom past the end is an empty buffer, not a throw', async () => {
  const store = new LiveChunkStore(blobs);
  const runId = `readfrom-end-${randomUUID()}`;
  await store.put(runId, 0, Buffer.from('aaaa', 'latin1'));

  expect(await store.readFrom(runId, 4)).toHaveLength(0);
  expect(await store.readFrom(`never-${randomUUID()}`, 0)).toHaveLength(0);
});

it('readFrom orders numerically, not lexicographically', async () => {
  const store = new LiveChunkStore(blobs);
  const runId = `readfrom-order-${randomUUID()}`;
  // 999 vs 1000: naive string sort puts 1000 first.
  await store.put(runId, 0, Buffer.from('x'.repeat(999), 'latin1'));
  await store.put(runId, 999, Buffer.from('y', 'latin1'));
  await store.put(runId, 1000, Buffer.from('z', 'latin1'));

  expect((await store.readFrom(runId, 999)).toString('latin1')).toBe('yz');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/storage/test/live-chunks.integration.test.ts -t readFrom
```

Expected: FAIL — `store.readFrom is not a function`.

- [ ] **Step 3: Implement**

In `packages/storage/src/live-chunks.ts`:

```ts
  /**
   * The chunks at or past `offset`, concatenated in offset order.
   *
   * The fold owner's read: it holds a byte position and wants everything
   * after it, without re-reading a run's whole history on every tick.
   *
   * Filters on the offset PARSED OUT of the key rather than on the key
   * string, even though the padding makes the two orders agree. A string
   * comparison would silently start behaving differently the day an offset
   * needs 17 digits, and the parse is what the caller's units actually are.
   *
   * A chunk that STRADDLES `offset` (starts before it, ends after) is
   * returned whole. The caller is a decoder that tracks its own position in
   * whole records, so it can be handed bytes it has already seen -- what it
   * must never be handed is a gap.
   */
  async readFrom(runId: string, offset: number): Promise<Buffer> {
    const keys = await this.#listChunkKeys(runId);
    const wanted = keys.filter((k) => offsetOf(k) >= offset);
    if (wanted.length === 0) return Buffer.alloc(0);
    return Buffer.concat(await Promise.all(wanted.map((k) => this.#blobs.get(k))));
  }
```

and beside `chunkKey`:

```ts
/** The offset a chunk key encodes. Inverse of `chunkKey`. */
function offsetOf(key: string): number {
  const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.bin$/, '');
  return Number(base);
}
```

> `#listChunkKeys` already returns keys sorted (it is what `assemble` relies on for byte order), so `wanted` is ordered by construction. Do not re-sort.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/storage/test/live-chunks.integration.test.ts
```

Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat(storage): read a live run's chunks from a byte offset

The fold owner holds a position and wants everything after it; assemble()
returns the whole run and finalize() consumes it, so neither fits.

Filters on the offset parsed out of the key rather than the key string.
The padding makes those two orders agree today, and a string comparison
would start behaving differently the day an offset needs 17 digits -- the
parse is what the caller's units actually are."
```

---

### Task 2: The delta wire schema

Shared with Part 2b's browser client, so it belongs in `contracts` rather than the worker.

**Files:**
- Create: `packages/contracts/src/live-delta.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/live-delta.test.ts`

**Interfaces:**
- Consumes: `zod`
- Produces:
  ```ts
  export const LiveSummarySchema: z.ZodObject<{
    count: z.ZodNumber; okCount: z.ZodNumber; koCount: z.ZodNumber;
    errorRate: z.ZodNumber; percentiles: z.ZodRecord<z.ZodString, z.ZodNumber>;
    maxUsers: z.ZodNumber; durationMs: z.ZodNumber;
  }>;
  export const LiveSeriesBucketSchema: z.ZodObject<{
    startOffsetMs: z.ZodNumber; startedCount: z.ZodNumber; endedCount: z.ZodNumber;
    okCount: z.ZodNumber; koCount: z.ZodNumber;
  }>;
  export const LiveDeltaSchema: z.ZodObject<{
    runId: z.ZodString; seq: z.ZodNumber; bucketWidthMs: z.ZodNumber;
    replacesSeries: z.ZodBoolean;
    summary: typeof LiveSummarySchema;
    responseTime: z.ZodArray<typeof LiveSeriesBucketSchema>;
    users: z.ZodArray<z.ZodObject<{ scenario: z.ZodString; startOffsetMs: z.ZodNumber; active: z.ZodNumber }>>;
  }>;
  export type LiveDelta = z.infer<typeof LiveDeltaSchema>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/live-delta.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LiveDeltaSchema } from '../src/index.js';

const valid = {
  runId: '0f9b1d4e-1111-2222-3333-444455556666',
  seq: 1,
  bucketWidthMs: 1000,
  replacesSeries: false,
  summary: {
    count: 10, okCount: 9, koCount: 1, errorRate: 0.1,
    percentiles: { p50: 12, p95: 40 }, maxUsers: 3, durationMs: 5000,
  },
  responseTime: [
    { startOffsetMs: 0, startedCount: 5, endedCount: 5, okCount: 5, koCount: 0 },
  ],
  users: [{ scenario: 'checkout', startOffsetMs: 0, active: 3 }],
};

describe('LiveDeltaSchema', () => {
  it('accepts a well-formed delta', () => {
    expect(LiveDeltaSchema.parse(valid).seq).toBe(1);
  });

  it('rejects a negative or fractional seq — a consumer detects gaps with it', () => {
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: -1 })).toThrow();
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: 1.5 })).toThrow();
  });

  it('rejects a non-positive bucket width — it is a divisor downstream', () => {
    expect(() => LiveDeltaSchema.parse({ ...valid, bucketWidthMs: 0 })).toThrow();
  });

  it('requires replacesSeries rather than defaulting it', () => {
    const { replacesSeries: _omitted, ...without } = valid;
    expect(() => LiveDeltaSchema.parse(without)).toThrow();
  });

  it('accepts empty series — a tick with no new buckets is normal', () => {
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, responseTime: [], users: [] }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/contracts/test/live-delta.test.ts
```

Expected: FAIL — `LiveDeltaSchema` is not exported.

- [ ] **Step 3: Implement**

Create `packages/contracts/src/live-delta.ts` with the schemas from **Interfaces**. Constraints that must be present:

- `seq`: `z.number().int().min(0)` — a consumer detects gaps by comparing consecutive values, so a fractional or negative one is meaningless.
- `bucketWidthMs`: `z.number().int().positive()` — downstream divides by it to convert an offset to a rate; zero is a division by zero and negative is nonsense.
- `replacesSeries`: `z.boolean()` with **no default**. A missing flag defaulting to `false` would make a full replacement look like an append, which is the exact silent failure §3.3 exists to prevent.
- `summary.errorRate`: `z.number().min(0).max(1)` — a ratio, matching how `StatRollup.errorRate` is computed.

Comment each non-obvious constraint in the style of `packages/contracts/src/live.ts`, which explains *why* rather than *what*. Re-export from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run packages/contracts && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): the live delta wire shape

In contracts rather than the worker because part 2b's browser client is
the other end of this wire.

replacesSeries carries no default deliberately. A missing flag defaulting
to false would make a full series replacement look like an append, which
is precisely the silent corruption the flag exists to prevent -- see the
design's section 3.3."
```

---

### Task 3: `buildDelta` — the pure transform, and the coalesce rule

The whole of §3.2 and §3.3 as a pure function, so the hazard is testable without Redis, blob storage, or a worker.

**Files:**
- Create: `apps/worker/src/live/delta.ts`
- Test: `apps/worker/test/live-delta.test.ts`

**Interfaces:**
- Consumes: `EngineResult` (`@perfportal/statistics`), `LiveDelta` (Task 2)
- Produces:
  ```ts
  export interface DeltaCursor {
    seq: number;
    lastPublishedOffsetMs: number;   // -1 before the first delta
    lastBucketWidthMs: number;       // 0 before the first delta
  }
  export const INITIAL_CURSOR: DeltaCursor;
  export function buildDelta(
    runId: string,
    result: EngineResult,
    prev: DeltaCursor,
  ): { delta: LiveDelta; next: DeltaCursor };
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/live-delta.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { LiveEngine, runEngine } from '@perfportal/statistics';
import { buildDelta, INITIAL_CURSOR } from '../src/live/delta.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);
const events = () => [...parseSimulationLog(readFileSync(LOG))];

describe('buildDelta', () => {
  it('summarises the run from the payload, not from written-down numbers', () => {
    const all = events();
    const { delta } = buildDelta('r1', runEngine(all), INITIAL_CURSOR);
    const batch = runEngine(all).stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

    expect(delta.summary.count).toBe(batch.count);
    expect(delta.summary.okCount).toBe(batch.okCount);
    expect(delta.summary.koCount).toBe(batch.koCount);
    expect(delta.summary.errorRate).toBeCloseTo(batch.errorRate, 10);
    expect(delta.seq).toBe(0);
    expect(delta.replacesSeries).toBe(true);   // first delta always replaces
  });

  it('emits only buckets past the cursor on the second call', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.seq).toBe(1);
    const firstMax = Math.max(...first.delta.responseTime.map((b) => b.startOffsetMs));
    for (const b of second.delta.responseTime) expect(b.startOffsetMs).toBeGreaterThan(firstMax);
  });

  it('flags a full replacement when the bucket width changes', () => {
    const all = events();

    // A tiny cap forces BucketSeries to coalesce partway through.
    const engine = new LiveEngine({ maxBucketsRun: 4 });
    const third = Math.floor(all.length / 3);
    for (const e of all.slice(0, third)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);

    for (const e of all.slice(third)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    // Derived, not asserted as a literal: the width MUST have grown for this
    // case to be testing anything, so assert that first.
    expect(second.delta.bucketWidthMs).toBeGreaterThan(first.delta.bucketWidthMs);
    expect(second.delta.replacesSeries).toBe(true);
    // A replacement carries the WHOLE series, including offset 0.
    expect(Math.min(...second.delta.responseTime.map((b) => b.startOffsetMs))).toBe(0);
  });

  it('does not flag a replacement when the width is unchanged', () => {
    const all = events();
    const engine = new LiveEngine();
    const half = Math.floor(all.length / 2);
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR);
    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next);

    expect(second.delta.bucketWidthMs).toBe(first.delta.bucketWidthMs);
    expect(second.delta.replacesSeries).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run apps/worker/test/live-delta.test.ts
```

Expected: FAIL — `../src/live/delta.js` does not exist.

- [ ] **Step 3: Implement**

Create `apps/worker/src/live/delta.ts`. The shape:

```ts
export const INITIAL_CURSOR: DeltaCursor = {
  seq: 0,
  lastPublishedOffsetMs: -1,   // -1, not 0: bucket 0 is real and must be sent
  lastBucketWidthMs: 0,        // 0 never equals a real width, so delta 0 replaces
};

/**
 * One tick's message, plus the cursor the next tick needs.
 *
 * PURE, and deliberately so: the coalesce rule below is the one part of
 * this sub-project that fails silently, and keeping it out of the owner
 * means it can be tested without Redis, blob storage, or a claimed run.
 *
 * ═══ THE COALESCE RULE ═══
 * BucketSeries halves its resolution IN PLACE when a run passes
 * maxBucketsRun, rewriting every bucket's startOffsetMs. "Buckets past
 * offset N" therefore stops meaning the same thing across that event: a
 * consumer's accumulated series is wrong from there on, with nothing
 * thrown and nothing logged.
 *
 * So a width change makes the message a REPLACEMENT -- it carries the
 * whole series and the consumer discards what it held. The first delta is
 * a replacement for the same reason (lastBucketWidthMs starts at 0, which
 * no real width equals), which also makes a late subscriber correct
 * without a special case.
 */
export function buildDelta(
  runId: string,
  result: EngineResult,
  prev: DeltaCursor,
): { delta: LiveDelta; next: DeltaCursor } {
  const runSeries = result.series.get('run  response_time');   // NOTE: double space
  const buckets = runSeries?.buckets ?? [];
  const widthMs = inferBucketWidthMs(buckets.map((b) => b.startOffsetMs)) || 1000;

  const replacesSeries = widthMs !== prev.lastBucketWidthMs;
  const since = replacesSeries ? -1 : prev.lastPublishedOffsetMs;
  const fresh = buckets.filter((b) => b.startOffsetMs > since);

  const runStat = result.stats.find((s) => s.scope === 'run' && s.family === 'response_time');
  // ... summary from runStat, users from result.users, all derived
}
```

Three things the implementer must get right, each of which is silent if wrong:

1. **The run-scope series key contains a DOUBLE SPACE** — it is `${scope} ${name} ${family}` with an empty name, so `'run  response_time'`. Getting the spacing wrong yields `undefined` and an always-empty series. `engine.ts` has a comment about exactly this trap.
2. **`since` is `-1` on a replacement, not `0`** — bucket 0 is a real bucket and must be included.
3. **`next.lastPublishedOffsetMs` is the max offset actually emitted**, not the max in the snapshot. They differ when a bucket has no observations and is absent.

Use `inferBucketWidthMs` from `@perfportal/statistics` (it exists, and its docstring explains why the width is not always 1000).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/worker/test/live-delta.test.ts && pnpm typecheck
```

Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/live/delta.ts apps/worker/test/live-delta.test.ts
git commit -m "feat(worker): build a live delta, and say when the series was replaced

Pure on purpose. The coalesce rule is the one part of this sub-project
that fails silently, so it is testable without Redis, blob storage, or a
claimed run.

BucketSeries halves resolution in place, rewriting every bucket's offset,
so 'buckets past offset N' stops meaning the same thing across that event
and a consumer's accumulated series is quietly wrong from there. A width
change therefore marks the message a replacement carrying the whole
series. The first delta is a replacement by the same mechanism, which
makes a late subscriber correct without a special case."
```

---

### Task 4: `LiveFoldOwner` — claim, fold, release

No publishing yet. This task ends with an owner that folds a streaming run to the same numbers a batch parse produces.

**Files:**
- Create: `apps/worker/src/live/fold-owner.ts`
- Modify: `apps/worker/src/config.ts`
- Test: `apps/worker/test/fold-owner.integration.test.ts`

**Interfaces:**
- Consumes: `LiveChunkStore.readFrom` (Task 1); `StreamingLogDecoder`, `LiveEngine`; `pg.Pool`
- Produces:
  ```ts
  export class LiveFoldOwner {
    constructor(config: WorkerConfig, pool: pg.Pool, chunks: LiveChunkStore);
    /** Claims new runs, folds owned ones, releases finished ones. */
    async tick(): Promise<void>;
    /** Test seam: the fold result for an owned run, or null. */
    snapshotOf(runId: string): EngineResult | null;
    async close(): Promise<void>;
  }
  ```
  Config gains `liveTickMs: number` (`LIVE_TICK_MS`, default 5000, **floored at 1000**) and `maxOwnedRuns: number` (`MAX_OWNED_RUNS`, default 25).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/fold-owner.integration.test.ts`. Follow the setup in `apps/worker/test/pipeline.integration.test.ts` (its `TABLES` truncate, its `createPool`/`createPrisma`/`BlobStore` construction). Cases:

```ts
it('folds a streaming run to the same numbers a batch parse produces', async () => {
  // seed a run at status 'running' with stream_offset = log length,
  // and put the reference log into LiveChunkStore as several chunks
  const log = readFileSync(FIXTURE_LOG);
  const ctx = await seedRunningRun();
  for (let at = 0; at < log.length; at += 8192) {
    await chunks.put(ctx.runId, at, log.subarray(at, Math.min(at + 8192, log.length)));
  }

  const owner = new LiveFoldOwner(config, pool, chunks);
  await owner.tick();

  const live = owner.snapshotOf(ctx.runId);
  const batch = runEngine(parseSimulationLog(log));
  const pick = (r: EngineResult) =>
    r.stats.find((s) => s.scope === 'run' && s.family === 'response_time');

  expect(pick(live!)!.count).toBe(pick(batch)!.count);
  expect(pick(live!)!.okCount).toBe(pick(batch)!.okCount);
  expect(pick(live!)!.koCount).toBe(pick(batch)!.koCount);
  await owner.close();
});

it('folds only the new bytes on a second tick', async () => {
  // put half the log, tick, put the rest, tick again; assert the count grew
  // and equals the batch fold of the whole log
});

it('two owners race for one run and exactly one wins', async () => {
  const a = new LiveFoldOwner(config, pool, chunks);
  const b = new LiveFoldOwner(config, pool, chunks);
  await a.tick();
  await b.tick();
  const owned = [a.snapshotOf(ctx.runId), b.snapshotOf(ctx.runId)].filter(Boolean);
  expect(owned).toHaveLength(1);
  await a.close(); await b.close();
});

it('releases a run that has left running, and frees its lock', async () => {
  const owner = new LiveFoldOwner(config, pool, chunks);
  await owner.tick();
  expect(owner.snapshotOf(ctx.runId)).not.toBeNull();

  await pool.query(`UPDATE run SET status = 'parsing' WHERE id = $1`, [ctx.runId]);
  await owner.tick();
  expect(owner.snapshotOf(ctx.runId)).toBeNull();

  // the lock is genuinely free: a second owner can now claim it
  await pool.query(`UPDATE run SET status = 'running' WHERE id = $1`, [ctx.runId]);
  const other = new LiveFoldOwner(config, pool, chunks);
  await other.tick();
  expect(other.snapshotOf(ctx.runId)).not.toBeNull();
  await other.close(); await owner.close();
});

it('does not exceed maxOwnedRuns', async () => {
  // seed 3 running runs with maxOwnedRuns: 2; assert exactly 2 are owned
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/worker/test/fold-owner.integration.test.ts
```

Expected: FAIL — `../src/live/fold-owner.js` does not exist.

- [ ] **Step 3: Implement**

Create `apps/worker/src/live/fold-owner.ts`. Requirements, each of which the tests above pin:

- **The lock is `pg_try_advisory_lock(RUN_INGEST_LOCK_NAMESPACE, hashtext(runId))`**, the same constant `pipeline.service.ts:67` declares (`8_531_001`). **Export it from `pipeline.service.ts` rather than re-declaring the number** — two copies of a lock namespace that must agree is exactly the drift this codebase keeps getting bitten by.
- **The lock is held on a dedicated `pg.PoolClient` for the run's whole ownership**, taken and released on that same client (`pipeline.service.ts:99-119` is the pattern and its comment says why). Store the client in the fold state; release it on release and in `close()`.
- **Discovery:** `SELECT id FROM run WHERE status = 'running'`, skipping already-owned ids, stopping at `maxOwnedRuns`.
- **Folding:** `chunks.readFrom(runId, state.fetchedBytes)` → `decoder.push(bytes)` → `engine.add(event)` for each → **`state.fetchedBytes += bytes.length`**.

  **The cursor is the fetch frontier, NOT `decoder.consumedBytes`** — see spec §2.2.1. `consumedBytes` is the last whole-record boundary and routinely sits *before* the last byte fetched, so feeding it back to `readFrom` re-selects chunks already delivered; the decoder splices them after the tail it correctly retained and every absolute position after that is wrong, silently, for the rest of the run. The trigger is ordinary: the stream endpoint caps chunk size but sets **no minimum**, so a chunk can be smaller than one Gatling record.

  `+= bytes.length` is exact because offset negotiation only accepts `offset === cursor`, so a run's chunks tile `[0, stream_offset)` with no gap and no overlap.

  **Add a test for exactly this:** deliver a run in chunks small enough that records span them (e.g. 4 bytes each), fold across several ticks, and assert the resulting statistics equal a batch parse of the same log. With the cursor set to `consumedBytes` this fails; with the frontier it passes.
- **Release:** when a run's status is no longer `running`, drop the state, `pg_advisory_unlock`, release the client.
- **`close()` releases every owned run**, or a test that constructs two owners leaks connections and the pool exhausts.

Config additions in the existing style (`config.ts:75-81`):

```ts
liveTickMs: Math.max(1000, Number(env.LIVE_TICK_MS ?? 5000)),
maxOwnedRuns: Number(env.MAX_OWNED_RUNS ?? 25),
```

The floor is `Math.max`, not a validation error: FR-LIVE-3 states 1000 ms as a floor, and silently clamping a misconfiguration is friendlier than refusing to boot. Comment it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/worker/test/fold-owner.integration.test.ts
```

Expected: PASS, all five cases.

- [ ] **Step 5: Run the full unit suite**

```bash
nvm use && pnpm test:unit
```

Expected: PASS, at least **92 files / 1029 tests** plus this plan's additions.

- [ ] **Step 6: Commit**

```bash
git add apps/worker packages
git commit -m "feat(worker): own a live run's fold, on the lock that already exists

Reuses RUN_INGEST_LOCK_NAMESPACE rather than minting a second one, and
exports it rather than copying the number. That buys a property a separate
lock would not: a run cannot be folded while PipelineService is parsing
it, which matters because close() hands the run to the pipeline while an
owner may still hold it.

The fold position is not persisted -- an owner starts at byte 0 and
re-folds. That is the design's checkpoint property doing its job: no
engine state to serialize, no checkpoint format to version, and a worker
dying mid-run costs seconds of CPU rather than correctness.

Each owned run holds a pooled connection for its lock's lifetime, so
maxOwnedRuns is a real bound and not a preference."
```

---

### Task 5: The tick publishes

Wire `buildDelta` into the owner and put deltas on Redis.

**Files:**
- Modify: `apps/worker/src/live/fold-owner.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/fold-owner.integration.test.ts` (append)

**Interfaces:**
- Consumes: `buildDelta`, `INITIAL_CURSOR` (Task 3); `ioredis`
- Produces: `LiveFoldOwner`'s constructor gains a `Redis` — `constructor(config, pool, chunks, redis: Redis)`. Publishes to `live:{runId}` and `XADD live:{runId}:deltas MAXLEN ~ 200`.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/test/fold-owner.integration.test.ts`:

```ts
it('publishes a delta per tick, with monotonic seq and append-only series', async () => {
  const log = readFileSync(FIXTURE_LOG);
  const ctx = await seedRunningRun();
  const sub = new Redis(config.redisUrl);
  const seen: LiveDelta[] = [];
  await sub.subscribe(`live:${ctx.runId}`);
  sub.on('message', (_c, m) => seen.push(LiveDeltaSchema.parse(JSON.parse(m))));

  const owner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
  const half = Math.floor(log.length / 2);
  await chunks.put(ctx.runId, 0, log.subarray(0, half));
  await owner.tick();
  await chunks.put(ctx.runId, half, log.subarray(half));
  await owner.tick();

  await vi.waitFor(() => expect(seen.length).toBe(2));
  expect(seen.map((d) => d.seq)).toEqual([0, 1]);
  expect(seen[0].replacesSeries).toBe(true);         // first is always a replacement
  expect(seen[1].summary.count).toBeGreaterThan(seen[0].summary.count);
  await sub.quit(); await owner.close();
});

it('appends every delta to the capped replay stream', async () => {
  // after two ticks, XLEN live:{runId}:deltas is 2 and XRANGE yields the
  // same seqs the subscriber saw
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/worker/test/fold-owner.integration.test.ts -t publishes
```

Expected: FAIL — the constructor takes three arguments.

- [ ] **Step 3: Implement**

In `fold-owner.ts`, after folding each owned run on a tick:

```ts
const { delta, next } = buildDelta(runId, state.engine.snapshot({ clone: true }), state.cursor);
state.cursor = next;
const body = JSON.stringify(delta);
await this.#redis.publish(`live:${runId}`, body);
await this.#redis.xadd(`live:${runId}:deltas`, 'MAXLEN', '~', '200', '*', 'delta', body);
```

`snapshot({ clone: true })` is not optional: without it the rollups alias accumulators the next fold mutates, and a delta serialized across an await would describe a state that existed at no instant.

Publish **after** folding, never between reads, so a delta always describes a whole number of records.

In `main.ts`, construct the owner with a `Redis`, drive `tick()` on `setInterval(config.liveTickMs)` in the same shape the sweeper's timer already uses, and `await owner.close()` in `shutdown()`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/worker/test/fold-owner.integration.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): publish a delta per tick, and record it for replay

Two destinations, one message: pub/sub for part 2b's fan-out, and a
MAXLEN-capped stream so a reconnecting client can be replayed. Part 2a
writes that stream even though nothing reads it yet -- splitting a
stream's writer from its reader across two sub-projects would leave the
reader with nothing real to test against.

snapshot({ clone: true }) is load-bearing here. Without it the rollups
alias accumulators the next fold mutates, and a delta serialized across an
await would describe a state that existed at no instant."
```

---

### Task 6: The API's ping

One call, so the owner wakes on a chunk instead of waiting a tick.

**Files:**
- Create: `apps/api/src/ingest/live-notifier.ts`
- Modify: `apps/api/src/ingest/ingest.module.ts`
- Modify: `apps/api/src/ingest/live.service.ts`
- Modify: `apps/worker/src/live/fold-owner.ts` (subscribe)
- Test: `apps/api/test/live.integration.test.ts` (append)

**Interfaces:**
- Consumes: `AppConfig.redisUrl` (`apps/api/src/config.ts:4`), `ioredis`
- Produces:
  ```ts
  // apps/api/src/ingest/live-notifier.ts
  export class LiveNotifier implements OnModuleDestroy {
    constructor(redisUrl: string);
    opened(runId: string): void;    // fire-and-forget
    advanced(runId: string): void;  // fire-and-forget
    async onModuleDestroy(): Promise<void>;
  }
  ```

> **The API has no Redis client to reuse.** `IngestQueue` (`apps/api/src/ingest/queue.ts:14`) takes a `redisUrl` and wraps a BullMQ `Queue`; it exposes no raw connection, and `LiveService`'s injected dependencies (`live.service.ts:44-50`) are config, projects, runs, blobs, chunks, queue, waiter — no `Redis`. So this task adds one small provider rather than reaching into BullMQ's connection, which would couple a notification path to a queue's internals. Provide it in `ingest.module.ts` with the same `useFactory` + `inject: [CONFIG]` shape `IngestQueue` already uses (`ingest.module.ts:40-43`), and close it in `onModuleDestroy` so integration tests do not leak connections — `createTestApp`'s `close()` is called in every suite's teardown.

- [ ] **Step 1: Write the failing test**

```ts
it('pings live:advance when a chunk is accepted, and not when it is rejected', async () => {
  const sub = new Redis(REDIS_URL);
  const pings: string[] = [];
  await sub.subscribe('live:advance');
  sub.on('message', (_c, m) => pings.push(m));

  const opened = await openLiveRun(ctx);
  await streamChunk(ctx, opened.runId, 0, Buffer.from('abc'));      // accepted
  await vi.waitFor(() => expect(pings).toContain(opened.runId));

  const before = pings.length;
  await streamChunk(ctx, opened.runId, 9999, Buffer.from('xyz'));   // gap → 409
  await new Promise((r) => setTimeout(r, 200));
  expect(pings.length).toBe(before);                                 // no ping for a refusal
  await sub.quit();
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api/test/live.integration.test.ts -t "pings live:advance"
```

Expected: FAIL — nothing publishes.

- [ ] **Step 3: Implement**

Create `LiveNotifier` with the interface above. Both methods are **synchronous and fire-and-forget** — they return `void`, not a promise, so a caller cannot accidentally `await` them into the request path:

```ts
  /**
   * Tells the fold owner a run advanced. Fire-and-forget by signature, not
   * just by convention: this must never block the 202, and a failure here
   * must never fail a chunk that was already accepted and durably stored.
   *
   * The message carries a run id, never bytes. The bytes are already in
   * blob storage, which is the whole reason this is a notification rather
   * than a queue (design §0).
   *
   * A dropped message is harmless: the owner's tick polls for `running`
   * runs regardless, and that poll is not redundant -- pub/sub has no
   * persistence, so anything published while every worker is down reaches
   * nobody.
   */
  advanced(runId: string): void {
    void this.#redis.publish('live:advance', runId).catch(() => {});
  }
```

Then in `LiveService.stream`, on the **accepted branch only** — a gap or a replay changes nothing the owner needs to know:

```ts
this.notifier.advanced(runId);
```

and in `open()`, `this.notifier.opened(runId)`.

In `fold-owner.ts`, subscribe to both channels: `live:opened` triggers a claim attempt, `live:advance` triggers a fold of that run if owned. Both are optimisations over the tick — **neither may be the only path**, because Redis pub/sub is fire-and-forget with no persistence and a message published while every worker is down reaches nobody.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api/test/live.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/worker
git commit -m "feat(api,worker): ping the fold owner, carrying a run id and no bytes

The bytes are already durable in blob storage, so this is a notification
rather than a queue -- which is what lets Redis stay out of the byte path
entirely (design section 0).

Fire-and-forget, and only on an accepted chunk: a gap or a replay changes
nothing the owner needs to know. A dropped ping is harmless because the
tick polls for running runs regardless, and that poll is not redundant --
a message published while every worker is down reaches nobody."
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Document the channels in `README.md`**

Beside the streaming section Part 1 added, record: `live:opened`, `live:advance`, `live:{runId}`, `live:{runId}:deltas`, what each carries, and that **none of them ever carries bytes**.

- [ ] **Step 2: Raise the `CLAUDE.md` floor**

Measure with `pnpm test:unit` — do not compute it. Name the suites this plan added, in the existing chain style.

- [ ] **Step 3: Add a "Conventions that bite" entry**

> **A live delta's series is append-only until the buckets move under it.** `BucketSeries` halves its resolution in place when a run passes `maxBucketsRun`, rewriting every bucket's `startOffsetMs` — so "buckets past offset N" silently stops meaning the same thing and a consumer's accumulated series is wrong from there on, with nothing thrown. Every delta carries the width it was built at, and a width change marks the message a full replacement. `apps/worker/test/live-delta.test.ts` is the guard.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: the live channels, and why a delta's series can be replaced"
```

---

## Self-Review

**Spec coverage.** §0 → Tasks 1, 6 (blob-read + ping, no Redis byte path). §1.1 → Task 4 (shared lock, exported not copied). §1.2 → Tasks 4, 6 (poll + pub/sub, poll is not redundant). §1.3 → Task 4 (`maxOwnedRuns`). §2.1 → Task 4 (`FoldState`, `foldedBytes` from 0). §2.2 → Tasks 1, 4 (`readFrom`, `consumedBytes`). §2.3 → Task 6. §3.1 → Task 5 (`liveTickMs`, floor, `clone: true`). §3.2 → Tasks 2, 3. §3.3 → Task 3, guarded by its own case, plus Task 7's convention entry. §3.4 → Task 5 (both destinations). §4 → Task 4 (release). §5.1 → Task 4. §5.2 → Task 5. §5.3 → Task 3. §5.4 → Task 4. §5.5 → Task 7.

**Placeholder scan.** Task 4's and Task 5's test bodies describe two cases in prose rather than full code (`'folds only the new bytes on a second tick'`, `'does not exceed maxOwnedRuns'`, `'appends every delta to the capped replay stream'`). Each states its exact assertion and the setup is the same shape as the case above it — that is deliberate compression, not a gap, but an implementer should write them out fully rather than skip them.

**Type consistency.** `DeltaCursor` fields (`seq`, `lastPublishedOffsetMs`, `lastBucketWidthMs`) are used identically in Tasks 3 and 5. `readFrom(runId, offset)` matches between Tasks 1 and 4. `LiveFoldOwner`'s constructor gains its fourth parameter in Task 5, which is the only signature that changes mid-plan and is called out there.

**One thing this plan does not resolve.** AC-LIVE-1's <2 s p95 delta latency has no end-to-end path to measure until Part 2b, and §7 of the spec says so. Nothing here should be read as evidence it holds.
