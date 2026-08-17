# Live Run Monitoring, Part 1 — The Resumable Fold and the Streaming Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run can be opened, fed `simulation.log` bytes while it is still being written, and closed — finalizing into a row indistinguishable from an uploaded bundle.

**Architecture:** `runEngine`'s local fold state is extracted into a `LiveEngine` class with `add()`/`snapshot()`. `BinaryReader` gains bounds-checked reads that throw a distinguishable `TruncatedError`, which lets a streaming decoder consume whole records and hold a partial tail until more bytes arrive. Three new endpoints (open / stream / close) drive a run through two new states, `running` and `incomplete`. No WebSocket and no Redis fan-out in this plan — those are Part 2.

**Tech Stack:** TypeScript, NestJS on Express, Prisma + raw `pg`, BullMQ/ioredis, Vitest, Playwright, S3-compatible storage via `@aws-sdk/lib-storage`.

**Spec:** `docs/superpowers/specs/2026-08-17-live-run-monitoring-design.md`

## Scope

This plan implements **§9 stages 1 and 2** of the spec. Stages 3–5 (Redis
ownership and pub/sub fan-out, the live dashboard, sweeper finalization and the
AC-LIVE-4 load measurement) are a second plan.

The split is where the spec puts it: *"Steps 1 and 2 are the design's
substance. If the transport in 3 turns out wrong, it is rewritten against a
contract and a fold that are already proven."* This plan ends with working,
independently testable software — a run streamed over HTTP and finalized —
verifiable by polling `GET /v1/runs/:id`, with no live UI yet.

## Global Constraints

- **Node 22 (`.nvmrc`). `nvm use` first.** On Node 20 every DOM-environment test file silently fails to load and Vitest still prints a green summary. A run reporting fewer than **88 files / 1005 tests** did not run everything.
- **Update the floor in `CLAUDE.md`** when this plan adds suites, or the next reader calibrates against a stale number.
- `pnpm test:unit` runs **neither** integration nor e2e. The full gate is `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`, **integration before e2e**, never the reverse.
- Integration and e2e need the local stack up (`docker compose -f infra/docker-compose.yml up -d`) and the env vars in `CLAUDE.md`.
- **Pure packages may not touch the filesystem, network, or database** — enforced by `no-restricted-imports` in `eslint.config.js`. `@perfportal/statistics` and `@perfportal/plugin-gatling` are both pure.
- **Expectations are computed from the payload, never hard-coded.** A test that writes down a number the fixture supplies breaks on the next re-capture for a reason that is not a defect.
- **Any instant column added must be `timestamptz`.** Prisma decodes a bare `timestamp` as UTC; node-postgres decodes it in the process's local zone.
- Commit messages in this repo carry reasoning. Merge with `--merge`, never squash.

## File Structure

| File | Responsibility |
|---|---|
| `packages/statistics/src/engine.ts` *(modify)* | Gains `LiveEngine`; `runEngine` becomes a thin wrapper over it |
| `packages/statistics/test/live-engine.test.ts` *(create)* | `LiveEngine` equivalence and snapshot-isolation tests |
| `packages/plugin-gatling/src/reader.ts` *(modify)* | `TruncatedError`, bounds-checked primitives, `append()`, `seek()` |
| `packages/plugin-gatling/src/stream.ts` *(create)* | `StreamingLogDecoder` — bytes in, whole `CanonicalEvent`s out |
| `packages/plugin-gatling/test/stream.test.ts` *(create)* | Chunk-invariance at byte level — the load-bearing test |
| `packages/contracts/src/run.ts` *(modify)* | `running` / `incomplete` statuses; live open/stream/close schemas |
| `packages/persistence/src/repositories/run.ts` *(modify)* | `createLive`, `advanceOffset`, `markIncomplete` |
| `packages/storage/src/live-chunks.ts` *(create)* | Per-chunk blob objects and their ordered concatenation |
| `apps/api/src/ingest/live.controller.ts` *(create)* | `POST /v1/runs/live`, `/:id/stream`, `/:id/close` |
| `apps/api/src/ingest/live.service.ts` *(create)* | Offset negotiation, chunk persistence, close orchestration |
| `apps/api/test/live.integration.test.ts` *(create)* | A streamed run finalizes identically to an uploaded one |

---

### Task 1: Extract `LiveEngine` from `runEngine`

`runEngine` (`packages/statistics/src/engine.ts:94`) is already a single-pass
fold. This task moves its local state into a class without changing its
behaviour. `parity.e2e.test.ts` and `packages/statistics/test/parity.test.ts`
are the guard: they pin exact figures, so any behavioural drift fails loudly.

**Files:**
- Modify: `packages/statistics/src/engine.ts:94-350`
- Test: `packages/statistics/test/live-engine.test.ts` (create)

**Interfaces:**
- Consumes: `CanonicalEvent`, `EngineOptions`, `EngineResult` (all already exported from `engine.ts`)
- Produces:
  ```ts
  export class LiveEngine {
    constructor(opts?: EngineOptions);
    add(event: CanonicalEvent): void;
    snapshot(): EngineResult;
  }
  ```
  `runEngine(events, opts)` keeps its exact current signature and semantics.

- [ ] **Step 1: Write the failing test**

Create `packages/statistics/test/live-engine.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { LiveEngine, runEngine } from '../src/index.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

/** Sketches and histograms are class instances; compare their observable numbers. */
const comparable = (r: ReturnType<typeof runEngine>) => ({
  stats: r.stats.map((s) => ({
    scope: s.scope, name: s.name, family: s.family,
    count: s.count, okCount: s.okCount, koCount: s.koCount,
    minMs: s.minMs, maxMs: s.maxMs, meanMs: s.meanMs, stddevMs: s.stddevMs,
    percentiles: s.percentiles, throughputRps: s.throughputRps,
    histogramOkTotal: s.histogramOk.total, histogramKoTotal: s.histogramKo.total,
  })),
  series: [...r.series.entries()].map(([k, v]) => [k, v.buckets.map((b) => ({
    startOffsetMs: b.startOffsetMs, startedCount: b.startedCount,
    endedCount: b.endedCount, okCount: b.okCount, koCount: b.koCount,
  }))]),
  users: r.users,
  errors: r.errors,
  errorSeries: r.errorSeries,
  endpointCount: r.endpointCount,
  runStartedAtMs: r.runStartedAtMs,
  simulation: r.simulation,
  description: r.description,
  durationMs: r.durationMs,
  toolAssertions: r.toolAssertions,
});

describe('LiveEngine', () => {
  it('folded event-by-event, equals runEngine over the same events', () => {
    const events = [...parseSimulationLog(readFileSync(LOG))];

    const engine = new LiveEngine();
    for (const e of events) engine.add(e);

    expect(comparable(engine.snapshot())).toEqual(comparable(runEngine(events)));
  });

  it('snapshot is non-destructive — folding continues after it', () => {
    const events = [...parseSimulationLog(readFileSync(LOG))];
    const half = Math.floor(events.length / 2);

    const engine = new LiveEngine();
    for (const e of events.slice(0, half)) engine.add(e);
    const mid = engine.snapshot();
    for (const e of events.slice(half)) engine.add(e);
    const end = engine.snapshot();

    // Derived from the payload, never written down: the run's total request
    // count must grow between the two snapshots, and the second must equal a
    // batch fold of everything.
    const runCount = (r: ReturnType<typeof runEngine>) =>
      r.stats.find((s) => s.scope === 'run' && s.family === 'response_time')?.count ?? 0;

    expect(runCount(mid)).toBeGreaterThan(0);
    expect(runCount(end)).toBeGreaterThan(runCount(mid));
    expect(comparable(end)).toEqual(comparable(runEngine(events)));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/statistics/test/live-engine.test.ts
```

Expected: FAIL — `LiveEngine` is not exported from `../src/index.js`.

- [ ] **Step 3: Extract the class**

In `packages/statistics/src/engine.ts`, convert the function body into a class.
The three regions map directly:

- constructor ← the local declarations at lines 102–154 and the option defaults at 95–100
- `add(e)` ← the loop body at lines 182–311 (the `for` header itself goes away; every `continue` becomes `return`)
- `snapshot()` ← the tail at lines 313–349

Every `const`/`let` at 102–154 becomes a private field. The helper closures
(`seriesFor`, `rollupFor`, `errorsFor`, `rollupKey`) become private methods.
Preserve every comment — they record why edges, warm-up guards and key shapes
are what they are.

Then redefine the exported function in terms of it:

```ts
export function runEngine(events: Iterable<CanonicalEvent>, opts: EngineOptions = {}): EngineResult {
  const engine = new LiveEngine(opts);
  for (const e of events) engine.add(e);
  return engine.snapshot();
}
```

Two things that must not change:

- `errorSeries` is lazily constructed on the first failure (`engine.ts:295`) because `runStartMs` is 0 until the `meta` event lands. As a field it must stay `null`-initialised and be created at the same point, for the same reason.
- `runResponseSeries` is captured by reference (`engine.ts:280`), not looked up by key, because the run-scope key contains a **double space**. Keep the capture.

- [ ] **Step 4: Run the new test and the parity guards**

```bash
nvm use && pnpm vitest run packages/statistics/test/live-engine.test.ts packages/statistics/test/parity.test.ts packages/statistics/test/engine.test.ts
```

Expected: PASS, all three.

- [ ] **Step 5: Run the full unit suite**

```bash
nvm use && pnpm test:unit
```

Expected: PASS, and **at least 88 files / 1005 tests**. A lower count means Node 20.

- [ ] **Step 6: Commit**

```bash
git add packages/statistics/src/engine.ts packages/statistics/test/live-engine.test.ts
git commit -m "refactor(statistics): extract LiveEngine, so the fold can be resumed

runEngine was already a single-pass fold over accumulators that all have
non-destructive reads. Moving its local state into a class changes no
behaviour -- parity.test.ts pins the exact figures and still passes -- and
makes the same fold feedable one event at a time."
```

---

### Task 2: Isolate a snapshot from the accumulators still being fed

`RollupBuilder.finish()` (`packages/statistics/src/rollup.ts:53`) returns live
references to `#sketch`, `#histOk` and `#histKo`. In batch use the accumulator
is dead by then, so this is free. In live use it is a bug: a snapshot handed to
an async publisher watches its own sketches mutate as the next batch folds in,
and serializes a state that existed at no instant.

**Files:**
- Modify: `packages/statistics/src/rollup.ts:53-77`
- Modify: `packages/statistics/src/engine.ts` (the `snapshot()` added in Task 1)
- Test: `packages/statistics/test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `LiveEngine` from Task 1; `Sketch.merge()` (`sketch.ts:46`), `Histogram.merge()` (`histogram.ts:77`)
- Produces:
  ```ts
  // rollup.ts
  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
    clone?: boolean;          // default false — batch callers keep today's behaviour
  }): StatRollup;

  // engine.ts
  snapshot(opts?: { clone?: boolean }): EngineResult;
  ```

**Why cloning rather than serializing.** The spec's §2.3 says "serializes
sketches through `Sketch.serialize()`". That would change `StatRollup.sketch`
from `Sketch` to `Uint8Array` and break `MetricWriter.persist()`, which
consumes `EngineResult` directly. Cloning into a fresh `Sketch` preserves the
type, so every existing consumer is untouched — and because DDSketch merges are
exact (`buckets.ts:117`), a clone is lossless.

`clone` defaults to **false** so `runEngine`'s hot path allocates nothing new;
only the live caller pays.

- [ ] **Step 1: Write the failing test**

Append to `packages/statistics/test/live-engine.test.ts`:

```ts
it('a cloned snapshot does not move when more events are folded in', () => {
  const events = [...parseSimulationLog(readFileSync(LOG))];
  const half = Math.floor(events.length / 2);

  const engine = new LiveEngine();
  for (const e of events.slice(0, half)) engine.add(e);

  const snap = engine.snapshot({ clone: true });
  const runStat = snap.stats.find((s) => s.scope === 'run' && s.family === 'response_time');
  if (!runStat) throw new Error('fixture produced no run-scope response_time rollup');

  // Read the sketch and histogram BEFORE folding the rest in.
  const p95Before = runStat.sketch.quantile(0.95);
  const okTotalBefore = runStat.histogramOk.total;

  for (const e of events.slice(half)) engine.add(e);

  // The snapshot is a value, not a view: nothing about it may have changed.
  expect(runStat.sketch.quantile(0.95)).toBe(p95Before);
  expect(runStat.histogramOk.total).toBe(okTotalBefore);

  // And the engine really did keep going, so the test is not vacuously true.
  const after = engine.snapshot({ clone: true })
    .stats.find((s) => s.scope === 'run' && s.family === 'response_time');
  expect(after?.histogramOk.total).toBeGreaterThan(okTotalBefore);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/statistics/test/live-engine.test.ts -t 'does not move'
```

Expected: FAIL — `histogramOk.total` has grown, because the snapshot aliases
the live histogram.

- [ ] **Step 3: Implement cloning**

In `packages/statistics/src/rollup.ts`, add the option and clone on the way out:

```ts
  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
    /**
     * Hand back COPIES of the sketch and histograms rather than the live
     * accumulators.
     *
     * Off by default: a batch fold finishes once and never touches the builder
     * again, so copying would be pure cost. A LIVE fold keeps going after the
     * snapshot, and a snapshot that aliases the accumulator would mutate under
     * whoever is serializing it — a state that existed at no instant.
     *
     * Lossless: DDSketch and Histogram merges are exact, which is the same
     * property that makes BucketSeries coalescing lossless.
     */
    clone?: boolean;
  }): StatRollup {
    const percentiles: Record<string, number> = {};
    for (const p of opts.percentiles) percentiles[`p${p}`] = this.#sketch.quantile(p / 100);

    const copyOf = <T extends { merge(other: T): void }>(src: T, empty: T): T => {
      empty.merge(src);
      return empty;
    };

    return {
      // ... every existing field unchanged ...
      sketch: opts.clone ? copyOf(this.#sketch, new Sketch()) : this.#sketch,
      histogramOk: opts.clone ? copyOf(this.#histOk, new Histogram()) : this.#histOk,
      histogramKo: opts.clone ? copyOf(this.#histKo, new Histogram()) : this.#histKo,
    };
  }
```

In `engine.ts`, thread the flag through `snapshot()`:

```ts
  snapshot(opts: { clone?: boolean } = {}): EngineResult {
    // ... unchanged, except:
    for (const { scope, name, family, builder } of this.#rollups.values()) {
      stats.push(builder.finish({ scope, name, family, windowMs, percentiles, clone: opts.clone }));
    }
    // ...
  }
```

> **Series buckets are not cloned here.** `BucketSeries.buckets()` returns a
> fresh array, but the `Bucket` objects inside it are the live ones. Part 2's
> publisher reads only their scalar counts and derived percentiles, which it
> copies at serialization. If a later consumer needs to hold a `Bucket` across
> an await, extend `clone` to cover them then — not before there is a caller.

- [ ] **Step 4: Run the test to verify it passes**

```bash
nvm use && pnpm vitest run packages/statistics/test/live-engine.test.ts
```

Expected: PASS, all three cases.

- [ ] **Step 5: Confirm the batch path is untouched**

```bash
nvm use && pnpm vitest run packages/statistics packages/sla
```

Expected: PASS. `clone` defaults to false, so no existing caller changes behaviour.

- [ ] **Step 6: Commit**

```bash
git add packages/statistics/src/rollup.ts packages/statistics/src/engine.ts packages/statistics/test/live-engine.test.ts
git commit -m "feat(statistics): let a snapshot be a value, not a view

RollupBuilder.finish handed back the live sketch and histograms. Harmless
for a batch fold, which finishes once and never touches the builder again;
a bug for a live one, where the next batch mutates the snapshot underneath
whoever is serializing it.

Cloned rather than serialized: StatRollup.sketch stays a Sketch, so
MetricWriter.persist is untouched. Exact, because DDSketch merges are."
```

---

### Task 3: A `BinaryReader` that can say "not yet"

`BinaryReader` (`packages/plugin-gatling/src/reader.ts`) assumes a complete
buffer. Streaming means chunk boundaries land mid-record, so the reader must
distinguish "malformed" from "incomplete".

**The hazard this closes.** `readString()` (`reader.ts:34`) calls
`subarray(pos, pos + len)`, and **`subarray` does not throw when it runs past
the end** — it silently returns a shorter buffer. A truncated string therefore
decodes to a plausible-looking wrong value rather than an error. Bounds must be
checked explicitly, not inferred from a throw.

**Files:**
- Modify: `packages/plugin-gatling/src/reader.ts`
- Test: `packages/plugin-gatling/test/reader.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: nothing new
- Produces:
  ```ts
  export class TruncatedError extends Error {}
  // on BinaryReader:
  get pos(): number;              // already exists
  seek(pos: number): void;
  append(chunk: Buffer): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { BinaryReader, TruncatedError } from '../src/reader.js';

describe('BinaryReader truncation', () => {
  it('throws TruncatedError rather than reading a short int', () => {
    const r = new BinaryReader(Buffer.from([0x00, 0x01]));   // 2 bytes; readInt needs 4
    expect(() => r.readInt()).toThrow(TruncatedError);
  });

  it('throws TruncatedError rather than returning a half string', () => {
    // [int len = 5][only 3 of the 5 bytes]
    const buf = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(5); return b; })(),
      Buffer.from('abc', 'latin1'),
    ]);
    const r = new BinaryReader(buf);
    expect(() => r.readString()).toThrow(TruncatedError);
  });

  it('append lets a read that was truncated succeed', () => {
    const head = Buffer.alloc(2);                 // half an int
    const r = new BinaryReader(head);
    const mark = r.pos;
    expect(() => r.readInt()).toThrow(TruncatedError);

    r.seek(mark);
    r.append(Buffer.from([0x00, 0x07]));          // completes 0x00000007
    expect(r.readInt()).toBe(7);
  });

  it('append preserves the string cache across the boundary', () => {
    const define = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(3); return b; })(),   // cache index 3
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(2); return b; })(),   // len 2
      Buffer.from('hi', 'latin1'),
      Buffer.from([0x00]),                                                      // latin1 coder
    ]);
    const r = new BinaryReader(define);
    expect(r.readCachedString()).toBe('hi');

    // The back-reference arrives only in the next chunk.
    const back = Buffer.alloc(4); back.writeInt32BE(-3);
    r.append(back);
    expect(r.readCachedString()).toBe('hi');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/plugin-gatling/test/reader.test.ts
```

Expected: FAIL — `TruncatedError` is not exported; `seek` and `append` do not exist.

- [ ] **Step 3: Implement**

In `packages/plugin-gatling/src/reader.ts`:

```ts
/**
 * The buffer ended mid-record.
 *
 * DISTINCT from a malformed log, and the distinction is the whole point: a
 * streaming caller rewinds and waits for more bytes on this, and gives up on
 * anything else. `subarray` does not throw when it overruns -- it returns a
 * short buffer -- so bounds are checked explicitly below rather than inferred
 * from a failure.
 */
export class TruncatedError extends Error {
  constructor(need: number, have: number, at: number) {
    super(`needed ${need} bytes at ${at}, have ${have}`);
    this.name = 'TruncatedError';
  }
}
```

Add a guard and use it in every primitive:

```ts
  #need(n: number): void {
    const have = this.#buf.length - this.#pos;
    if (have < n) throw new TruncatedError(n, have, this.#pos);
  }

  seek(pos: number): void { this.#pos = pos; }

  /**
   * Appends bytes, keeping `#pos` AND `#stringCache`. The cache is why a
   * streaming decoder cannot simply construct a new reader per chunk: string
   * back-references point at entries defined arbitrarily far upstream.
   */
  append(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
  }

  readByte(): number { this.#need(1); return this.#buf.readInt8(this.#pos++); }
  readBoolean(): boolean { this.#need(1); return this.#buf.readInt8(this.#pos++) !== 0; }
  readInt(): number { this.#need(4); const v = this.#buf.readInt32BE(this.#pos); this.#pos += 4; return v; }
  readLong(): number { this.#need(8); const v = this.#buf.readBigInt64BE(this.#pos); this.#pos += 8; return Number(v); }
  readShort(): number { this.#need(2); const v = this.#buf.readInt16BE(this.#pos); this.#pos += 2; return v; }
  readDoubleLE(): number { this.#need(8); const v = this.#buf.readDoubleLE(this.#pos); this.#pos += 8; return v; }

  readString(): string {
    const len = this.readInt();
    if (len === 0) return '';
    this.#need(len + 1);                 // +1 for the coder byte; subarray would NOT throw
    const bytes = this.#buf.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    const coder = this.readByte();
    return coder === 0 ? bytes.toString('latin1') : bytes.toString('utf16le');
  }
```

Leave `readCachedString`'s dangling-reference error as a plain `Error` — a
back-reference to an undefined index is corruption, not truncation, and must
not make a streaming caller wait forever for bytes that would not help.

Export `TruncatedError` from `packages/plugin-gatling/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run packages/plugin-gatling
```

Expected: PASS, including the existing `header.test.ts`, `assertions.test.ts` and `plugin.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-gatling/src/reader.ts packages/plugin-gatling/src/index.ts packages/plugin-gatling/test/reader.test.ts
git commit -m "feat(plugin-gatling): let the reader distinguish truncated from malformed

A streaming caller has to tell 'the chunk ended mid-record' apart from 'this
log is corrupt': it rewinds and waits on the first, gives up on the second.

readString was the trap. subarray does NOT throw when it overruns -- it
returns a short buffer -- so a truncated string decoded to a plausible wrong
value with nothing raised. Bounds are now checked explicitly."
```

---

### Task 4: A streaming decoder

Turns an append-only byte feed into whole `CanonicalEvent`s, holding back a
partial trailing record until the bytes completing it arrive.

**Files:**
- Create: `packages/plugin-gatling/src/stream.ts`
- Modify: `packages/plugin-gatling/src/index.ts` (export it)
- Test: `packages/plugin-gatling/test/stream.test.ts` (create)

**Interfaces:**
- Consumes: `BinaryReader`, `TruncatedError` (Task 3); `readRunHeader` (`header.ts:19`); `RECORD` (`header.ts`)
- Produces:
  ```ts
  export class StreamingLogDecoder {
    constructor();
    /** Feed bytes; get back every event now decodable. Order is file order. */
    push(chunk: Buffer): CanonicalEvent[];
    /** Bytes consumed into complete records so far. */
    get consumedBytes(): number;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-gatling/test/stream.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '../src/records.js';
import { StreamingLogDecoder } from '../src/stream.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

describe('StreamingLogDecoder', () => {
  it('one chunk yields exactly what the batch parser yields', () => {
    const buf = readFileSync(LOG);
    const d = new StreamingLogDecoder();
    expect(d.push(buf)).toEqual([...parseSimulationLog(buf)]);
  });

  it('byte-at-a-time yields the same events in the same order', () => {
    const buf = readFileSync(LOG);
    const d = new StreamingLogDecoder();
    const got = [];
    for (const byte of buf) got.push(...d.push(Buffer.from([byte])));
    expect(got).toEqual([...parseSimulationLog(buf)]);
  });

  it('is invariant to where the chunk boundaries fall', () => {
    const buf = readFileSync(LOG);
    const expected = [...parseSimulationLog(buf)];

    // Deterministic pseudo-random splits: a fixed split can miss a boundary
    // landing inside a cached-string back-reference.
    let seed = 20260817;
    const nextCut = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % Math.max(1, max));
    };

    for (let trial = 0; trial < 20; trial++) {
      const d = new StreamingLogDecoder();
      const got = [];
      let at = 0;
      while (at < buf.length) {
        const n = Math.min(nextCut(4096), buf.length - at);
        got.push(...d.push(buf.subarray(at, at + n)));
        at += n;
      }
      expect(got).toEqual(expected);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/plugin-gatling/test/stream.test.ts
```

Expected: FAIL — `../src/stream.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/plugin-gatling/src/stream.ts`:

```ts
import type { CanonicalEvent } from '@perfportal/core';
import { RECORD, readRunHeader, type RunHeader } from './header.js';
import { BinaryReader, TruncatedError } from './reader.js';

/**
 * The append-only twin of `parseSimulationLog`.
 *
 * Same decoding, driven by a feed instead of a finished buffer. It exists
 * because Gatling's log is written as the run proceeds and `file` is the only
 * output modern Gatling OSS still supports -- see the design's section 0.
 *
 * ONE reader for the whole stream, never one per chunk: string back-references
 * point at cache entries defined arbitrarily far upstream, so the cache must
 * outlive every chunk boundary.
 *
 * The loop marks its position before each record and rewinds on
 * TruncatedError. Re-reading a rewound record is safe even though
 * readCachedString mutates the cache on the way through: it re-defines the
 * same index with the same value, which is idempotent.
 */
export class StreamingLogDecoder {
  #reader = new BinaryReader(Buffer.alloc(0));
  #header: RunHeader | null = null;
  #userSeq = 0;
  #consumed = 0;

  get consumedBytes(): number { return this.#consumed; }

  push(chunk: Buffer): CanonicalEvent[] {
    this.#reader.append(chunk);
    const out: CanonicalEvent[] = [];

    if (this.#header === null) {
      const mark = this.#reader.pos;
      try {
        this.#header = readRunHeader(this.#reader);
      } catch (err) {
        if (err instanceof TruncatedError) { this.#reader.seek(mark); return out; }
        throw err;
      }
      out.push({
        type: 'meta',
        simulation: this.#header.simulationClassName,
        toolVersion: this.#header.gatlingVersion,
        startedAtMs: this.#header.runStartEpochMs,
        description: this.#header.description || undefined,
        assertions: this.#header.assertions,
      });
      this.#consumed = this.#reader.pos;
    }

    const h = this.#header;
    const base = h.runStartEpochMs;

    for (;;) {
      const mark = this.#reader.pos;
      try {
        if (this.#reader.eof) break;
        const event = this.#readRecord(h, base);
        if (event !== null) out.push(event);
        this.#consumed = this.#reader.pos;
      } catch (err) {
        if (err instanceof TruncatedError) { this.#reader.seek(mark); break; }
        throw err;
      }
    }
    return out;
  }

  /**
   * One record. Mirrors `records.ts`'s switch exactly -- the two must stay in
   * step, and `stream.test.ts` asserts they do by comparing against
   * parseSimulationLog over the same bytes.
   */
  #readRecord(h: RunHeader, base: number): CanonicalEvent | null {
    const r = this.#reader;
    const type = r.readByte();
    switch (type) {
      case RECORD.REQUEST: {
        const groups = r.readGroups();
        const name = r.readCachedString();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const ok = r.readBoolean();
        const message = r.readCachedString();
        return { type: 'request', name, groups, userId: '', startMs, endMs, ok, message: message || undefined };
      }
      case RECORD.USER: {
        const scenarioIndex = r.readInt();
        const isStart = r.readBoolean();
        const tsMs = base + r.readInt();
        const scenario = h.scenarios[scenarioIndex];
        if (scenario === undefined) throw new Error(`unknown scenario index ${scenarioIndex}`);
        return { type: 'user', scenario, userId: String(this.#userSeq++), kind: isStart ? 'start' : 'end', tsMs };
      }
      // GROUP and ERROR: copy the remaining cases from records.ts verbatim,
      // including their comments.
      default:
        throw new Error(`unknown record type ${type} at byte ${r.pos - 1}`);
    }
  }
}
```

> The implementer must copy the `GROUP` and `ERROR` cases from
> `packages/plugin-gatling/src/records.ts:49` onward verbatim. They are omitted
> here only to keep the plan readable — leaving them out is a defect, and
> `stream.test.ts`'s first case fails immediately if they are missing.

Export from `packages/plugin-gatling/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run packages/plugin-gatling/test/stream.test.ts
```

Expected: PASS, all three cases — including byte-at-a-time.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-gatling/src/stream.ts packages/plugin-gatling/src/index.ts packages/plugin-gatling/test/stream.test.ts
git commit -m "feat(plugin-gatling): decode simulation.log as it is written

The append-only twin of parseSimulationLog: bytes in, whole events out, a
partial trailing record held until the bytes completing it arrive.

One reader for the whole stream, never one per chunk -- string
back-references point at cache entries defined arbitrarily far upstream.
The byte-at-a-time test is the strong one: every record boundary is also a
chunk boundary there."
```

---

### Task 5: Chunk invariance end to end — the load-bearing test

The design's §2.2 claims the live fold and a batch fold produce identical
output, and §1's `close` finalizes from the live accumulators on the strength
of it. This is that claim, executable.

**Files:**
- Test: `packages/statistics/test/chunk-invariance.test.ts` (create)

**Interfaces:**
- Consumes: `LiveEngine` (Task 1), `StreamingLogDecoder` (Task 4), `runEngine`, `parseSimulationLog`
- Produces: nothing — this is a guard

- [ ] **Step 1: Write the test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog, StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { LiveEngine, runEngine } from '../src/index.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

/**
 * THE test that licenses `close` finalizing from the live accumulators.
 *
 * If this fails, the design's section 2.2 is wrong and close must re-parse the
 * finished log instead of trusting the fold. Do not weaken it to make a change
 * pass.
 */
describe('chunk invariance', () => {
  const comparable = (r: ReturnType<typeof runEngine>) => JSON.parse(JSON.stringify({
    stats: r.stats.map((s) => ({
      scope: s.scope, name: s.name, family: s.family, count: s.count,
      okCount: s.okCount, koCount: s.koCount, errorRate: s.errorRate,
      minMs: s.minMs, maxMs: s.maxMs, meanMs: s.meanMs, stddevMs: s.stddevMs,
      percentiles: s.percentiles, throughputRps: s.throughputRps,
      okTotal: s.histogramOk.total, koTotal: s.histogramKo.total,
    })),
    series: [...r.series.entries()].map(([k, v]) => [k, v.buckets]),
    users: r.users, errors: r.errors, errorSeries: r.errorSeries,
    endpointCount: r.endpointCount, runStartedAtMs: r.runStartedAtMs,
    simulation: r.simulation, description: r.description,
    durationMs: r.durationMs, toolAssertions: r.toolAssertions,
  }));

  it('streamed at random boundaries, equals a batch fold of the whole log', () => {
    const buf = readFileSync(LOG);
    const expected = comparable(runEngine(parseSimulationLog(buf)));

    let seed = 1178;
    const nextCut = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % Math.max(1, max));
    };

    for (let trial = 0; trial < 10; trial++) {
      const decoder = new StreamingLogDecoder();
      const engine = new LiveEngine();
      let at = 0;
      while (at < buf.length) {
        const n = Math.min(nextCut(8192), buf.length - at);
        for (const e of decoder.push(buf.subarray(at, at + n))) engine.add(e);
        at += n;
      }
      expect(comparable(engine.snapshot({ clone: true }))).toEqual(expected);
    }
  });

  it('bucket widths agree, so coalescing happened at the same points', () => {
    const buf = readFileSync(LOG);
    const batch = runEngine(parseSimulationLog(buf));

    const decoder = new StreamingLogDecoder();
    const engine = new LiveEngine();
    for (let at = 0; at < buf.length; at += 997) {          // prime stride
      for (const e of decoder.push(buf.subarray(at, at + 997))) engine.add(e);
    }
    const live = engine.snapshot({ clone: true });

    // Derived from the payload: whatever widths the batch fold chose, the live
    // fold must have chosen the same ones for the same keys.
    const widths = (r: typeof batch) => [...r.series.entries()].map(
      ([k, v]) => [k, v.buckets.length, v.buckets[0]?.startOffsetMs ?? null] as const,
    );
    expect(widths(live)).toEqual(widths(batch));
  });
});
```

- [ ] **Step 2: Run it**

```bash
nvm use && pnpm vitest run packages/statistics/test/chunk-invariance.test.ts
```

Expected: PASS. **If it fails, stop.** The design's §2.2 is wrong; report the
divergence rather than adjusting the test.

- [ ] **Step 3: Commit**

```bash
git add packages/statistics/test/chunk-invariance.test.ts
git commit -m "test(statistics): pin the property that lets close trust the live fold

runEngine is a deterministic order-preserving fold, so streaming the same
bytes in the same order must produce the same result -- including the points
at which BucketSeries coalesces. close() finalizes from the live
accumulators on the strength of that, so it is asserted rather than assumed.

The second case is the sharp one: equal bucket counts and offsets mean
coalescing fired at the same positions, not merely that the totals agree."
```

---

### Task 6: Contracts — two states, one scope, three payloads

**Files:**
- Modify: `packages/contracts/src/run.ts:3`, `:148`
- Create: `packages/contracts/src/live.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/live.test.ts` (create)

**Interfaces:**
- Consumes: `zod`, existing `RunStatusSchema`
- Produces:
  ```ts
  export const RunStatusSchema: z.ZodEnum<['pending','parsing','running','complete','failed','incomplete']>;
  export const TokenScopeSchema: z.ZodEnum<['ingest','read','telemetry','stream']>;
  export const OpenLiveRunRequestSchema: z.ZodObject<{
    environment: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    commitSha: z.ZodOptional<z.ZodString>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
  }>;
  export const OpenLiveRunResponseSchema: z.ZodObject<{
    runId: z.ZodString; streamUrl: z.ZodString; nextOffset: z.ZodNumber;
  }>;
  export const StreamAcceptedSchema: z.ZodObject<{ nextOffset: z.ZodNumber }>;
  export type OpenLiveRunRequest = z.infer<typeof OpenLiveRunRequestSchema>;
  export type OpenLiveRunResponse = z.infer<typeof OpenLiveRunResponseSchema>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  OpenLiveRunRequestSchema, OpenLiveRunResponseSchema,
  PendingRunSchema, RunStatusSchema, TokenScopeSchema,
} from '../src/index.js';

describe('live contracts', () => {
  it('accepts the two new run states', () => {
    expect(RunStatusSchema.parse('running')).toBe('running');
    expect(RunStatusSchema.parse('incomplete')).toBe('incomplete');
  });

  it('treats a running run as pending-shaped, so a CI poll loop is unchanged', () => {
    // PendingRunSchema enumerates its own statuses INDEPENDENTLY of
    // RunStatusSchema (run.ts:148), so widening one does not widen the other
    // and a typecheck will not catch the omission.
    expect(() => PendingRunSchema.parse({
      status: 'running', statusUrl: 'https://example.test/v1/runs/abc',
    })).not.toThrow();
  });

  it('knows the stream scope', () => {
    expect(TokenScopeSchema.parse('stream')).toBe('stream');
  });

  it('open takes the same frozen metadata a bundle upload takes', () => {
    const parsed = OpenLiveRunRequestSchema.parse({
      environment: 'staging', branch: 'main',
      commitSha: 'deadbeef', idempotencyKey: 'run-42',
    });
    expect(parsed.branch).toBe('main');
  });

  it('open with no metadata is valid', () => {
    expect(() => OpenLiveRunRequestSchema.parse({})).not.toThrow();
  });

  it('open returns where to stream and from which byte', () => {
    const r = OpenLiveRunResponseSchema.parse({
      runId: '0f9b1d4e-1111-2222-3333-444455556666',
      streamUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666/stream',
      nextOffset: 0,
    });
    expect(r.nextOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run packages/contracts/test/live.test.ts
```

Expected: FAIL — `running` is not in the enum; the new schemas do not exist.

- [ ] **Step 3: Implement**

In `packages/contracts/src/run.ts`:

```ts
export const RunStatusSchema = z.enum([
  'pending', 'parsing',
  // Opened for streaming, accepting batches. Reported as 202 exactly like
  // pending/parsing, so a CI poll loop needs no change.
  'running',
  'complete', 'failed',
  // Closed without its producer saying so -- inactivity or abort. All received
  // data is retained and the run is labelled; its verdict is always
  // not_evaluated, because a partial run can satisfy every SLA rule purely by
  // having stopped before the load that would have broken it (FR-LIVE-5).
  'incomplete',
]);
```

And at `run.ts:148`, widen the independently-declared pending shape:

```ts
  status: z.enum(['pending', 'parsing', 'running']),
```

Create `packages/contracts/src/live.ts` with the schemas listed under
**Interfaces** above, and add `'stream'` to the token scope enum wherever it is
declared. Re-export `./live.js` from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run packages/contracts && pnpm typecheck
```

Expected: PASS. `typecheck` catches any exhaustive `switch` over `RunStatus`
that the two new members break — fix each by handling `running` as pending-like
and `incomplete` as terminal.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): running and incomplete states, and the live payloads

PendingRunSchema enumerates its statuses independently of RunStatusSchema,
so widening one does not widen the other and nothing typechecks the gap --
hence a test for exactly that.

A new 'stream' scope rather than reusing 'ingest': the token lives on a
load generator, the least-trusted and most disposable host in a deployment,
and 'ingest' would let it upload a bundle for the whole project."
```

---

### Task 7: Persistence — open, advance, finalize

**Files:**
- Modify: `packages/persistence/src/repositories/run.ts`
- Create: `packages/persistence/prisma/migrations/<timestamp>_run_stream_offset/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (`Run`)
- Test: `packages/persistence/test/run-live.integration.test.ts` (create)

**Interfaces:**
- Consumes: `PrismaClient`, existing `RunRepository`
- Produces:
  ```ts
  // on RunRepository:
  createLive(input: {
    orgId: string; projectId: string;
    environment?: string; branch?: string; commitSha?: string;
    idempotencyKey?: string; engineOptions: unknown;
  }): Promise<RunRecord>;                       // status 'running', streamOffset 0
  advanceOffset(runId: string, from: number, to: number): Promise<boolean>;  // false on mismatch
  markIncomplete(runId: string): Promise<void>;
  ```

**Schema note.** `Run.status` is a plain `String` (`schema.prisma:63`), so the
two new states need **no migration**. The new column does:

```sql
ALTER TABLE "run" ADD COLUMN "stream_offset" BIGINT NOT NULL DEFAULT 0;
```

`BIGINT`, because a 250 MB log is comfortably inside `INT` but the cap is a
product decision, not a storage one, and widening later means a rewrite.
No timestamptz concern here — this column is a byte count, not an instant.

- [ ] **Step 1: Write the failing test**

Create `packages/persistence/test/run-live.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { RunRepository } from '../src/index.js';
// Follow the setup helper the sibling integration tests in this package use.
import { prisma, seedProject, truncateAll } from './helpers.js';

describe('RunRepository live runs', () => {
  beforeEach(async () => { await truncateAll(); });

  it('opens a run in running state at offset zero', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive({ orgId, projectId, engineOptions: {} });

    expect(run.status).toBe('running');
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.streamOffset).toBe(0n);
  });

  it('advances the offset only from the expected position', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive({ orgId, projectId, engineOptions: {} });

    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(true);
    // A replay of the chunk just consumed must not double-count.
    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(false);
    // A gap must be refused.
    expect(await repo.advanceOffset(run.id, 4096, 8192)).toBe(false);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.streamOffset).toBe(1024n);
  });

  it('reopening with the same idempotency key returns the same run', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const a = await repo.createLive({ orgId, projectId, engineOptions: {}, idempotencyKey: 'k1' });
    const b = await repo.createLive({ orgId, projectId, engineOptions: {}, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
  });

  it('markIncomplete is terminal and leaves the verdict unevaluated', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive({ orgId, projectId, engineOptions: {} });
    await repo.markIncomplete(run.id);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('incomplete');
    expect(row.verdict).toBe('not_evaluated');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/run-live.integration.test.ts
```

Expected: FAIL — `createLive` does not exist.

- [ ] **Step 3: Migrate and implement**

Add `streamOffset BigInt @default(0) @map("stream_offset")` to `Run` in
`schema.prisma`, write the migration SQL above, then:

```bash
pnpm --filter @perfportal/persistence exec prisma migrate dev --schema prisma/schema.prisma --name run_stream_offset
```

In `packages/persistence/src/repositories/run.ts`:

```ts
  /**
   * Opens a run that will be fed by a stream rather than a bundle.
   *
   * Mirrors create()'s freezing of environment/branch/commitSha/engineOptions:
   * they describe the run as submitted, and submission is `open` for a live
   * run exactly as it is the POST for an uploaded one.
   */
  async createLive(input: { /* as in Interfaces */ }): Promise<RunRecord> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.run.findUnique({
        where: { projectId_idempotencyKey: {
          projectId: input.projectId, idempotencyKey: input.idempotencyKey } },
      });
      if (existing) return toRecord(existing);
    }
    // ... create with status: 'running', streamOffset: 0n, startedAt/startedOn as create() does
  }

  /**
   * Compare-and-set on the byte cursor.
   *
   * The WHERE clause carries `from`, so this is atomic rather than
   * check-then-act: two concurrent chunks claiming the same offset cannot both
   * win, and the loser is told to resync. A replay of an already-consumed
   * chunk simply matches no row and returns false -- the caller treats that as
   * a no-op, which is what makes agent retries idempotent.
   */
  async advanceOffset(runId: string, from: number, to: number): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, status: 'running', streamOffset: BigInt(from) },
      data: { streamOffset: BigInt(to) },
    });
    return count === 1;
  }

  async markIncomplete(runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { notIn: ['complete', 'failed', 'incomplete'] } },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/persistence
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence
git commit -m "feat(persistence): open, advance and finalize a streamed run

advanceOffset is a compare-and-set, not check-then-act: the expected offset
is in the WHERE clause, so two chunks claiming one position cannot both win,
and a replayed chunk matches no row and is a no-op -- which is what makes
the agent's retries idempotent.

status needed no migration (it is a plain String column); the byte cursor
did. BIGINT because the size cap is a product decision, not a storage one."
```

---

### Task 8: Live byte chunks in blob storage

**S3 has no append.** `BlobStore` offers `putStream`, `get` and `delete`
(`packages/storage/src/blob.ts`) and nothing else. Live bytes therefore land as
sequential per-chunk objects and are concatenated at close.

**Files:**
- Create: `packages/storage/src/live-chunks.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/live-chunks.integration.test.ts` (create)

**Interfaces:**
- Consumes: `BlobStore` (`putStream`, `get`, `delete`)
- Produces:
  ```ts
  export class LiveChunkStore {
    constructor(blobs: BlobStore);
    put(runId: string, offset: number, bytes: Buffer): Promise<void>;
    /** Every chunk in ascending offset order, concatenated. */
    assemble(runId: string): Promise<Buffer>;
    /** Writes the assembled log to `key` and removes the chunk objects. */
    finalize(runId: string, key: string): Promise<void>;
  }
  ```

**Key shape:** `live/{runId}/{offset padded to 16 digits}.bin`. Zero-padded
because listing and re-folding depend on **lexicographic order matching numeric
order**; `1000.bin` sorting before `999.bin` would silently reorder the byte
stream, and §3's opening sentence is that ordering is the whole problem.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { LiveChunkStore } from '../src/live-chunks.js';
// Use the BlobStore construction the sibling storage integration tests use.
import { blobs } from './helpers.js';

describe('LiveChunkStore', () => {
  it('assembles chunks in numeric offset order, not lexicographic', async () => {
    const store = new LiveChunkStore(blobs);
    const runId = 'ordering-probe';

    // Offsets chosen so naive string sorting reverses them: '1000' < '999'.
    await store.put(runId, 0, Buffer.from('a'.repeat(999), 'latin1'));
    await store.put(runId, 999, Buffer.from('b', 'latin1'));
    await store.put(runId, 1000, Buffer.from('c', 'latin1'));

    const out = await store.assemble(runId);
    expect(out.toString('latin1')).toBe(`${'a'.repeat(999)}bc`);
  });

  it('finalize writes the whole log to the key and clears the chunks', async () => {
    const store = new LiveChunkStore(blobs);
    const runId = 'finalize-probe';
    await store.put(runId, 0, Buffer.from('hello ', 'latin1'));
    await store.put(runId, 6, Buffer.from('world', 'latin1'));

    await store.finalize(runId, 'runs/finalize-probe/simulation.log');
    expect((await blobs.get('runs/finalize-probe/simulation.log')).toString('latin1'))
      .toBe('hello world');
    await expect(store.assemble(runId)).resolves.toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/storage/test/live-chunks.integration.test.ts
```

Expected: FAIL — `../src/live-chunks.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/storage/src/live-chunks.ts` implementing the interface above.
`put` builds the key with `String(offset).padStart(16, '0')`. `assemble` lists
the prefix, sorts by key (equivalent to numeric order because of the padding),
`get`s each, and concatenates. `finalize` calls `assemble`, `putStream`s the
result to `key`, then `delete`s each chunk.

Export from `packages/storage/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts packages/storage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/storage
git commit -m "feat(storage): per-chunk live byte objects, assembled in order

S3 has no append and BlobStore offers putStream/get/delete only, so a live
byte feed lands as sequential objects and is concatenated at close.

Offsets are zero-padded to 16 digits because assembly depends on
lexicographic order matching numeric order: '1000' sorts before '999', and
an out-of-order byte stream corrupts every record after it through the
decoder's back-referencing string cache."
```

---

### Task 9: The three endpoints

**Files:**
- Create: `apps/api/src/ingest/live.controller.ts`
- Create: `apps/api/src/ingest/live.service.ts`
- Modify: `apps/api/src/ingest/ingest.module.ts`
- Modify: `apps/api/src/openapi/document.ts`, `apps/api/src/openapi/schemas.ts`
- Test: `apps/api/test/live.integration.test.ts` (create)

**Interfaces:**
- Consumes: `RunRepository.createLive/advanceOffset` (Task 7), `LiveChunkStore` (Task 8), `OpenLiveRunRequestSchema` (Task 6), `IngestQueue` (`apps/api/src/ingest/queue.ts`), `@Scopes` (`apps/api/src/auth/scopes.decorator.ts`)
- Produces: the three routes in the design's §1.3

**Behaviour, exactly:**

| Route | Scope | Success | Failure |
|---|---|---|---|
| `POST /v1/runs/live` | `stream` | `201` + `{ runId, streamUrl, nextOffset }` | `400 PROJECT_REQUIRED` for a session (no project named) |
| `POST /v1/runs/:id/stream` | `stream` | `202` + `{ nextOffset }` | `409` + `{ nextOffset }` on gap or replay; `404` unknown run; `409` if not `running` |
| `POST /v1/runs/:id/close` | `stream` | `200`/`422` per the verdict contract | `409` if not `running` |

`close` enqueues the existing ingest job after `LiveChunkStore.finalize` has
written the assembled log to the run's `bundleKey`, so finalization runs
through `PipelineService` unchanged and the run becomes indistinguishable from
an uploaded one.

Every error body is RFC 9457 `application/problem+json` with a **required
`remediation` field** — `/v1`'s contract, and `problem.ts` already provides the
helper.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/live.integration.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Follow the app/token construction the sibling API integration tests use.
import { createTestApp, mintToken } from './helpers.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

describe('live streaming', () => {
  it('rejects a token without the stream scope', async () => {
    const { app, projectId } = await createTestApp();
    const token = await mintToken({ projectId, scopes: ['ingest', 'read'] });

    const res = await app.inject({
      method: 'POST', url: '/v1/runs/live',
      headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).remediation).toBeTruthy();
  });

  it('opens at offset zero and reports where to stream', async () => {
    const { app, projectId } = await createTestApp();
    const token = await mintToken({ projectId, scopes: ['stream'] });

    const res = await app.inject({
      method: 'POST', url: '/v1/runs/live',
      headers: { authorization: `Bearer ${token}` },
      payload: { environment: 'staging', branch: 'main' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.nextOffset).toBe(0);
    expect(body.streamUrl).toContain(body.runId);
  });

  it('refuses a gap and names the offset to resume from', async () => {
    const { app, projectId } = await createTestApp();
    const token = await mintToken({ projectId, scopes: ['stream'] });
    const opened = JSON.parse((await app.inject({
      method: 'POST', url: '/v1/runs/live',
      headers: { authorization: `Bearer ${token}` }, payload: {},
    })).body);

    const res = await app.inject({
      method: 'POST', url: `/v1/runs/${opened.runId}/stream`,
      headers: { authorization: `Bearer ${token}`, 'x-stream-offset': '4096' },
      payload: Buffer.from('nonsense'),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).nextOffset).toBe(0);
  });

  it('a streamed run finalizes to the same figures as an uploaded one', async () => {
    const { app, projectId } = await createTestApp();
    const token = await mintToken({ projectId, scopes: ['stream', 'read'] });
    const buf = readFileSync(LOG);

    const opened = JSON.parse((await app.inject({
      method: 'POST', url: '/v1/runs/live',
      headers: { authorization: `Bearer ${token}` }, payload: {},
    })).body);

    let offset = 0;
    while (offset < buf.length) {
      const n = Math.min(64 * 1024, buf.length - offset);
      const res = await app.inject({
        method: 'POST', url: `/v1/runs/${opened.runId}/stream`,
        headers: { authorization: `Bearer ${token}`, 'x-stream-offset': String(offset) },
        payload: buf.subarray(offset, offset + n),
      });
      expect(res.statusCode).toBe(202);
      offset = JSON.parse(res.body).nextOffset;
    }

    await app.inject({
      method: 'POST', url: `/v1/runs/${opened.runId}/close`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Poll to terminal, then compare against the parity figures the uploaded
    // path produces -- derived by reading them back, never written down here.
    const stats = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/runs/${opened.runId}/stats`,
      headers: { authorization: `Bearer ${token}` },
    })).body);

    const runRow = stats.find((s: { scope: string }) => s.scope === 'run');
    expect(runRow.count).toBeGreaterThan(0);
    expect(runRow.okCount + runRow.koCount).toBe(runRow.count);
  });
});
```

> The last case's poll-to-terminal loop and the exact parity comparison follow
> `apps/api/test/parity.e2e.test.ts`'s existing helper — reuse it rather than
> writing a second waiter.

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api/test/live.integration.test.ts
```

Expected: FAIL — the routes 404.

- [ ] **Step 3: Implement the service and controller**

`live.service.ts` holds the logic:

- `open()` → `RunRepository.createLive`, returns `{ runId, streamUrl, nextOffset: 0 }`
- `stream(runId, offset, bytes)` → `LiveChunkStore.put` **then** `advanceOffset(runId, offset, offset + bytes.length)`. If `advanceOffset` returns false, re-read the run and return its current `streamOffset` as `nextOffset` with a `409`. Writing the chunk before advancing means a crash between the two leaves a duplicate object that assembly overwrites at the same key — safe — rather than a gap, which is not.
- `close(runId)` → `LiveChunkStore.finalize(runId, run.bundleKey)`, mark `parsing`, `IngestQueue.add(runId)`, then reuse the existing terminal waiter (`apps/api/src/runs/terminal-waiter.ts`) so `close` returns the same 200/422 the bundle POST does.

The controller takes the raw body as a `Buffer`. Follow the multipart handling
in `apps/api/src/ingest/multipart.ts` for how this app reads a raw request
stream rather than letting a body parser buffer it.

Register both in `ingest.module.ts`, and add the three routes to the OpenAPI
document.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api
```

Expected: PASS.

- [ ] **Step 5: Run the whole gate**

```bash
nvm use
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: PASS, integration **before** e2e. Unit must report at least the
updated floor.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): open, stream and close a live run

close assembles the streamed chunks into the run's bundleKey and enqueues
the existing ingest job, so finalization runs through PipelineService
unchanged and a streamed run lands as a row indistinguishable from an
uploaded one.

The chunk is written to blob storage BEFORE the offset advances: a crash
between the two leaves a duplicate object that assembly overwrites at the
same key, which is safe, rather than a gap, which is not."
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md` (the verdict contract table, the scopes table)
- Modify: `CLAUDE.md` (the unit-test floor, and a conventions entry)

- [ ] **Step 1: Update the verdict contract table**

`README.md`'s "The verdict contract" table gains two rows, and the scopes table
gains `stream`:

| Code | Run state | Meaning to CI |
|---|---|---|
| `202` | pending / parsing / **running** | Still working. |
| `200` | **complete · pass**, or **incomplete** | Incomplete carries `verdict: not_evaluated` — it never passes a gate. |

| Scope | Grants |
|---|---|
| `stream` | `POST /v1/runs/live`, `/:id/stream`, `/:id/close` only. Its own scope, not a reuse of `ingest`, because the token lives on a load generator. |

- [ ] **Step 2: Update the CLAUDE.md floor**

Count the suites this plan added and raise the `88 files / 1005 tests` floor,
naming what was added, in the style of the existing entries.

- [ ] **Step 3: Add a conventions entry**

Under "Conventions that bite", record the `subarray` trap:

> **A truncated read does not throw — `subarray` returns a short buffer.**
> `BinaryReader.readString` reads a length then slices, and slicing past the
> end yields fewer bytes with nothing raised, so a truncated string decoded to
> a plausible wrong value. Every primitive now bounds-checks explicitly and
> throws `TruncatedError`, which a streaming caller distinguishes from
> corruption: it rewinds and waits on the first, gives up on the second.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: the two live run states, the stream scope, and the subarray trap"
```

---

## Self-Review

**Spec coverage.** §0 → Tasks 3–5 (tail the log, one decoder). §1.1 → Task 6.
§1.2 → Tasks 6, 7. §1.3 → Tasks 6, 9. §1.4 → Tasks 6, 9. §2.1 → Task 1.
§2.2 → Task 5. §2.3 → Task 2. §3.1 → Tasks 7, 9. §3.5 → Task 8.
§6.1 → Task 5. §6.2 → Task 1 step 4. §6.3 → Task 9. §6.4 → Task 9 step 5,
Task 10.

**Deferred to Part 2, deliberately:** §3.2 (Redis Stream, owning worker), §3.3
(pub/sub fan-out), §3.4 (replay buffer), §4 (dashboard), §5 (sweeper
finalization), §8's AC-LIVE-4 measurement. `markIncomplete` ships here
(Task 7) so Part 2's sweeper has its transition ready.

**Two corrections to the spec, found while planning.** Both need the spec
amended before Part 2 is written:

1. **§2.3 says "serializes sketches".** Serializing changes
   `StatRollup.sketch` from `Sketch` to `Uint8Array` and breaks
   `MetricWriter.persist()`, which consumes `EngineResult` directly. Task 2
   clones instead — lossless, since DDSketch merges are exact — which
   preserves the type and leaves every existing consumer untouched.
2. **§3.5 says bytes "append to `BlobStore`".** `BlobStore` has no append and
   S3 has no append operation. Task 8 writes per-chunk objects under
   `live/{runId}/{paddedOffset}.bin`, assembled at close. The spec's
   crash-recovery property survives — a new owner re-folds by reading chunks in
   offset order — but the mechanism is not what §3.5 describes.
