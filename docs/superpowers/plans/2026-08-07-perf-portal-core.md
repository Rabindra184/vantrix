# Perf Portal Core — Canonical Model, Gatling Plugin, Statistics Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given the checked-in Gatling 3.15.1.2 fixture, produce complete, verified statistics matching the parity matrix — with no database, no HTTP, and no infrastructure.

**Architecture:** Three pure packages with no I/O beyond reading a byte buffer. `core` holds the canonical event model and error taxonomy. `plugin-gatling` decodes Gatling's binary `simulation.log` into canonical events. `statistics` consumes canonical events and produces rollups, time series, distributions, and error tables. All three depend only on `core`, which is what makes them testable without infrastructure and makes PRD NFR-EX-1 true by construction.

**Tech Stack:** Node 22 LTS · TypeScript 5 strict · ESM · pnpm workspaces · Vitest · `@datadog/sketches-js` 2.1.1 · `protobufjs`

## Why this scope, and what comes next

This plan deliberately covers the **pure core only**, not PRD milestones M0–M2 verbatim. The reasoning:

- The statistics engine and plugin have **zero infrastructure dependencies** (PRD §15.1). They can be fully TDD'd against the checked-in fixture on day one.
- **All remaining correctness risk lives here** — AC-STAT-1, AC-STAT-2, and the parity matrix. Building NestJS/Postgres/Redis wiring first would delay the risky part behind the routine part.
- It ends with something genuinely verifiable: run the engine over the fixture, get numbers that match the Gatling report exactly.

**A second plan covers the service layer** — NestJS, Postgres schema and migrations, BullMQ/Redis, S3 blob store, the ingest endpoint, the adaptive verdict contract, and deployment. It consumes this plan's packages unchanged.

## Global Constraints

- **Node 22 LTS**, TypeScript **strict** mode, **ESM** throughout (`"type": "module"`).
- **`core`, `plugin-gatling`, and `statistics` must not import** `node:fs`, `node:http`, `node:net`, `pg`, `@nestjs/*`, or any database/HTTP library. Enforced by lint (Task 1).
- **Averaging percentiles is a defect** (PRD FR-STAT-4). Percentiles are always derived from a sketch; any aggregation merges sketches.
- **DDSketch `relativeAccuracy: 0.01`.** Measured error 0.597% on realistic latency; serialized ~2.1 KB.
- **`protobufjs` must be an explicit dependency** — `@datadog/sketches-js` needs it for `toProto`/`fromProto` but does not declare it.
- **Accuracy assertions use `<= 1%`, never `< 1%`.** Measured error reaches exactly 1.0% on uniform data.
- Bucket caps: **1200** run-wide, **300** per-endpoint. Endpoint cardinality cap **2000**.
- Indicator bounds default **800 ms / 1200 ms**. Default percentiles **50/75/95/99**.
- Error rollup retains **top 200** messages, remainder to `other`.
- Every error type carries a **required `remediation` string**.
- Reference fixture: `fixtures/gatling-3.15.1.2/reference-report/simulation.log`. Format spec: PRD **Appendix A.10**. Working reference decoder: `spikes/gatling-binary-log/decode.mjs`.

## Fixture ground truth (asserted repeatedly below)

| Quantity | Value |
|---|---|
| Records | 895 request · 490 user · 405 group · 0 error |
| Requests OK / KO | 871 / 24 |
| Indicator bands (OK) | `<800ms` 848 · `800–1200ms` 0 · `≥1200ms` 23 |
| max / mean / stddev | 2503 / 228 / 370 |
| Scenarios | `Browse`, `Checkout` |
| Groups | `Catalog`, `Catalog/Recommendations`, `Cart` |
| Endpoints | List Products, Product Detail, Related Items, Search, Add To Cart, View Cart, Place Order |
| Errors | 15× `status.find.is(200), found 500` · 9× `status.find.is(200), found 503` |
| Gatling version / simulation | `3.15.1` / `example.ParitySimulation` |

**Do not assert against Gatling's printed percentiles** (109/250/654/2369). Three of those four are values that never occur in the data (PRD §A.9 F-6). Percentiles are asserted against the true value computed from the sorted set.

## File Structure

```
package.json                       workspace root, scripts
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.js                   module boundary enforcement
vitest.config.ts
.github/workflows/ci.yml

packages/core/
  src/events.ts                    CanonicalEvent union, scopes, families
  src/capabilities.ts              CapabilityDescriptor
  src/errors.ts                    IngestError + codes, remediation required
  src/index.ts
  test/errors.test.ts

packages/plugin-gatling/
  src/reader.ts                    binary primitives (byte/int/long/string/cachedString)
  src/header.ts                    Run record -> RunHeader
  src/records.ts                   record stream -> CanonicalEvent
  src/plugin.ts                    detect / capabilities / parse / metadata
  src/index.ts
  test/reader.test.ts
  test/header.test.ts
  test/records.test.ts
  test/plugin.test.ts

packages/statistics/
  src/sketch.ts                    DDSketch wrapper + serialize/merge
  src/buckets.ts                   adaptive bucketing + lossless coalescing
  src/rollup.ts                    counts, min/max/mean/stddev, percentiles
  src/indicators.ts                indicator bands + warm-up exclusion
  src/distribution.ts              log-spaced histogram
  src/errors-rollup.ts             top-200 + other
  src/scopes.ts                    run / scenario / group / request fan-out
  src/engine.ts                    orchestrates the above over an event stream
  src/index.ts
  test/sketch.test.ts              AC-STAT-1
  test/buckets.test.ts             AC-STAT-2
  test/rollup.test.ts
  test/indicators.test.ts
  test/distribution.test.ts
  test/errors-rollup.test.ts
  test/scopes.test.ts
  test/parity.test.ts              end-to-end vs fixture
  test/throughput.bench.test.ts    NFR-PF-4
  test/support/generate.ts         synthetic event generator
```

---

### Task 1: Workspace, tooling, and enforced module boundaries

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `pnpm test` / `pnpm lint`; the boundary rule every later package relies on

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "perf-portal",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Write the module boundary rule**

`eslint.config.js` — this is the mechanical enforcement of PRD §15.1:
```js
import tseslint from 'typescript-eslint';

const FORBIDDEN_IN_PURE = [
  { group: ['node:fs', 'node:fs/*'],   message: 'Pure packages must not touch the filesystem (PRD 15.1).' },
  { group: ['node:http', 'node:https', 'node:net'], message: 'Pure packages must not do I/O (PRD 15.1).' },
  { group: ['pg', 'prisma', '@prisma/*'], message: 'Pure packages must not reach the database (PRD 15.1).' },
  { group: ['@nestjs/*'], message: 'Pure packages must not depend on the web framework (PRD 15.1).' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'spikes/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/{core,plugin-gatling,statistics}/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_PURE }],
    },
  },
);
```

- [ ] **Step 3: Create the core package skeleton**

`packages/core/package.json`:
```json
{
  "name": "@perfportal/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/core/src/index.ts`:
```ts
export const VERSION = '0.0.0';
```

- [ ] **Step 4: Prove the boundary rule actually fires**

Create a deliberate violation at `packages/core/src/violation.ts`:
```ts
import { readFileSync } from 'node:fs';
export const bad = readFileSync;
```

Run: `pnpm install && pnpm lint`
Expected: FAIL with `Pure packages must not touch the filesystem (PRD 15.1).`

A boundary rule nobody has seen fire is a boundary rule that might not work.

- [ ] **Step 5: Remove the violation and confirm green**

```bash
rm packages/core/src/violation.ts
pnpm lint && pnpm typecheck
```
Expected: both exit 0.

- [ ] **Step 6: Add CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts eslint.config.js .github packages/core
git commit -m "chore: workspace, tooling, and enforced module boundaries"
```

---

### Task 2: Canonical event model and error taxonomy

**Files:**
- Create: `packages/core/src/events.ts`, `packages/core/src/capabilities.ts`, `packages/core/src/errors.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CanonicalEvent`, `MetricScope`, `MetricFamily`, `CapabilityDescriptor`, `IngestError`, `ingestError()`

- [ ] **Step 1: Write the failing test**

`packages/core/test/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ingestError } from '../src/errors.js';

describe('ingestError', () => {
  it('carries code, message, remediation and detail', () => {
    const e = ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
      message: 'Run contains 4812 distinct request names, exceeding the limit of 2000.',
      remediation: 'Request names appear to contain dynamic values. Parameterize them.',
      detail: { found: 4812, limit: 2000 },
    });
    expect(e.code).toBe('ENDPOINT_CARDINALITY_EXCEEDED');
    expect(e.remediation.length).toBeGreaterThan(0);
    expect(e.detail).toEqual({ found: 4812, limit: 2000 });
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/test/errors.test.ts`
Expected: FAIL — `Cannot find module '../src/errors.js'`

- [ ] **Step 3: Write the model**

`packages/core/src/events.ts`:
```ts
export type ToolId = 'gatling' | 'k6' | 'jmeter' | 'locust' | 'artillery' | (string & {});
export type MetricScope = 'run' | 'scenario' | 'group' | 'request';
export type MetricFamily = 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';

export interface MetaEvent {
  type: 'meta';
  simulation: string;
  toolVersion: string;
  startedAtMs: number;
  description?: string;
}

/** startMs and endMs are both retained: FR-STAT-7 needs each edge independently. */
export interface RequestEvent {
  type: 'request';
  name: string;
  groups: string[];
  scenario?: string;
  userId: string;
  startMs: number;
  endMs: number;
  firstByteMs?: number;
  ok: boolean;
  message?: string;
}

export interface UserEvent {
  type: 'user';
  scenario: string;
  userId: string;
  kind: 'start' | 'end';
  tsMs: number;
}

/** cumulatedResponseTimeMs is carried explicitly — it diverges from (endMs - startMs)
 *  whenever requests inside the group overlap, and Gatling reports both. */
export interface GroupEvent {
  type: 'group';
  groups: string[];
  userId: string;
  startMs: number;
  endMs: number;
  cumulatedResponseTimeMs: number;
  ok: boolean;
}

export type CanonicalEvent = MetaEvent | RequestEvent | UserEvent | GroupEvent;
```

`packages/core/src/capabilities.ts`:
```ts
export interface CapabilityDescriptor {
  latency: boolean;
  groups: boolean;
  scenarios: boolean;
  sessionEvents: boolean;
  nativeAssertions: boolean;
  errorMessages: boolean;
}
```

`packages/core/src/errors.ts`:
```ts
export type IngestErrorCode =
  | 'BUNDLE_TOO_LARGE' | 'BUNDLE_NOT_ARCHIVE' | 'BUNDLE_EMPTY'
  | 'TOOL_AMBIGUOUS' | 'TOOL_UNKNOWN'
  | 'LOG_NOT_FOUND' | 'LOG_BINARY_FORMAT' | 'LOG_MALFORMED'
  | 'ENDPOINT_CARDINALITY_EXCEEDED' | 'NO_REQUESTS'
  | 'PROJECT_MISMATCH' | 'TOKEN_REVOKED'
  | 'PLUGIN_TIMEOUT' | 'PLUGIN_MEMORY_EXCEEDED';

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  /** Required. An error that cannot state a fix will not compile. */
  readonly remediation: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: IngestErrorCode, opts: { message: string; remediation: string; detail?: Record<string, unknown> }) {
    super(opts.message);
    this.name = 'IngestError';
    this.code = code;
    this.remediation = opts.remediation;
    this.detail = opts.detail;
  }
}

export function ingestError(
  code: IngestErrorCode,
  opts: { message: string; remediation: string; detail?: Record<string, unknown> },
): IngestError {
  return new IngestError(code, opts);
}
```

`packages/core/src/index.ts`:
```ts
export * from './events.js';
export * from './capabilities.js';
export * from './errors.js';
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run packages/core/test/errors.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): canonical event model, capabilities, error taxonomy"
```

---

### Task 3: Binary reader primitives

**Files:**
- Create: `packages/plugin-gatling/package.json`, `packages/plugin-gatling/tsconfig.json`, `packages/plugin-gatling/src/reader.ts`
- Test: `packages/plugin-gatling/test/reader.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class BinaryReader` with `readByte(): number`, `readBoolean(): boolean`, `readInt(): number`, `readLong(): number`, `readString(): string`, `readCachedString(): string`, `readGroups(): string[]`, `get eof(): boolean`, `get pos(): number`

The two rules below cause silent corruption if guessed. Test them explicitly.

- [ ] **Step 1: Write the failing tests**

`packages/plugin-gatling/test/reader.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/reader.js';

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe('BinaryReader primitives', () => {
  it('reads big-endian signed int', () => {
    expect(new BinaryReader(buf(0, 0, 0, 6)).readInt()).toBe(6);
    expect(new BinaryReader(buf(0xff, 0xff, 0xff, 0xfb)).readInt()).toBe(-5);
  });

  it('reads a string as [len][bytes][coder]', () => {
    const b = Buffer.concat([buf(0, 0, 0, 6), Buffer.from('3.15.1', 'latin1'), buf(0)]);
    const r = new BinaryReader(b);
    expect(r.readString()).toBe('3.15.1');
    expect(r.eof).toBe(true);
  });

  it('treats a zero length as empty string with NO trailing coder byte', () => {
    const r = new BinaryReader(buf(0, 0, 0, 0, 0xaa));
    expect(r.readString()).toBe('');
    expect(r.pos).toBe(4);          // the 0xaa must NOT have been consumed
  });
});

describe('cachedString sign discriminator', () => {
  it('non-negative index means a new string follows inline', () => {
    const b = Buffer.concat([buf(0, 0, 0, 3), buf(0, 0, 0, 4), Buffer.from('Cart', 'latin1'), buf(0)]);
    expect(new BinaryReader(b).readCachedString()).toBe('Cart');
  });

  it('negative index is a back-reference to cache[-i]', () => {
    const b = Buffer.concat([
      buf(0, 0, 0, 3), buf(0, 0, 0, 4), Buffer.from('Cart', 'latin1'), buf(0),  // define at index 3
      buf(0xff, 0xff, 0xff, 0xfd),                                              // -3 -> back-ref
    ]);
    const r = new BinaryReader(b);
    expect(r.readCachedString()).toBe('Cart');
    expect(r.readCachedString()).toBe('Cart');
  });

  it('throws a dangling back-reference rather than returning undefined', () => {
    const r = new BinaryReader(buf(0xff, 0xff, 0xff, 0xfd));
    expect(() => r.readCachedString()).toThrow(/back-reference/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/plugin-gatling/test/reader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/plugin-gatling/package.json`:
```json
{
  "name": "@perfportal/plugin-gatling",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@perfportal/core": "workspace:*" }
}
```

`packages/plugin-gatling/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/plugin-gatling/src/reader.ts`:
```ts
/**
 * Gatling binary simulation.log primitives. Format: PRD Appendix A.10,
 * recovered from io.gatling.core.stats.writer.* and io.gatling.charts.stats.LogFileParser.
 */
export class BinaryReader {
  #buf: Buffer;
  #pos = 0;
  #stringCache = new Map<number, string>();

  constructor(buf: Buffer) { this.#buf = buf; }

  get pos(): number { return this.#pos; }
  get eof(): boolean { return this.#pos >= this.#buf.length; }

  readByte(): number { return this.#buf.readInt8(this.#pos++); }
  readBoolean(): boolean { return this.#buf.readInt8(this.#pos++) !== 0; }
  readInt(): number { const v = this.#buf.readInt32BE(this.#pos); this.#pos += 4; return v; }
  readLong(): number { const v = this.#buf.readBigInt64BE(this.#pos); this.#pos += 8; return Number(v); }

  /** [int len][len bytes][coder byte]. len === 0 means empty AND no coder byte follows. */
  readString(): string {
    const len = this.readInt();
    if (len === 0) return '';
    const bytes = this.#buf.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    const coder = this.readByte();
    return coder === 0 ? bytes.toString('latin1') : bytes.toString('utf16le');
  }

  /** The SIGN is the discriminator: i >= 0 defines cache[i] inline; i < 0 reads cache[-i]. */
  readCachedString(): string {
    const i = this.readInt();
    if (i >= 0) {
      const s = this.readString();
      this.#stringCache.set(i, s);
      return s;
    }
    const s = this.#stringCache.get(-i);
    if (s === undefined) {
      throw new Error(`dangling string back-reference ${-i} at byte ${this.#pos - 4}`);
    }
    return s;
  }

  readGroups(): string[] {
    const n = this.readInt();
    const out: string[] = [];
    for (let k = 0; k < n; k++) out.push(this.readCachedString());
    return out;
  }
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run packages/plugin-gatling/test/reader.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-gatling
git commit -m "feat(plugin-gatling): binary reader primitives with sign-discriminated string cache"
```

---

### Task 4: Header parsing

**Files:**
- Create: `packages/plugin-gatling/src/header.ts`
- Test: `packages/plugin-gatling/test/header.test.ts`

**Interfaces:**
- Consumes: `BinaryReader` (Task 3)
- Produces: `RECORD` constants; `interface RunHeader { gatlingVersion, simulationClassName, runStartEpochMs, description, scenarios: string[], assertionCount }`; `readRunHeader(r: BinaryReader): RunHeader`

- [ ] **Step 1: Write the failing test**

`packages/plugin-gatling/test/header.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/reader.js';
import { readRunHeader } from '../src/header.js';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';

describe('readRunHeader', () => {
  it('parses the Run record from the reference fixture', () => {
    const h = readRunHeader(new BinaryReader(readFileSync(FIXTURE)));
    expect(h.gatlingVersion).toBe('3.15.1');
    expect(h.simulationClassName).toBe('example.ParitySimulation');
    expect(h.scenarios).toEqual(['Browse', 'Checkout']);
    expect(h.assertionCount).toBe(3);
    expect(new Date(h.runStartEpochMs).toISOString()).toBe('2026-08-07T05:30:02.171Z');
  });
});
```

*(Tests may read the fixture — the lint boundary applies to `src/`, not `test/`.)*

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/plugin-gatling/test/header.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/plugin-gatling/src/header.ts`:
```ts
import { BinaryReader } from './reader.js';

/** NOTE: Request=1 and User=2 are NOT in declaration order. Guessing corrupts every record. */
export const RECORD = { RUN: 0, REQUEST: 1, USER: 2, GROUP: 3, ERROR: 4 } as const;

export interface RunHeader {
  gatlingVersion: string;
  simulationClassName: string;
  runStartEpochMs: number;
  description: string;
  scenarios: string[];
  assertionCount: number;
}

export function readRunHeader(r: BinaryReader): RunHeader {
  const header = r.readByte();
  if (header !== RECORD.RUN) {
    throw new Error(`expected Run record (0) at byte 0, got ${header}`);
  }
  const gatlingVersion = r.readString();
  const simulationClassName = r.readString();
  const runStartEpochMs = r.readLong();
  const description = r.readString();

  const scenarioCount = r.readInt();
  const scenarios: string[] = [];
  for (let i = 0; i < scenarioCount; i++) scenarios.push(r.readString());

  const assertionCount = r.readInt();
  for (let i = 0; i < assertionCount; i++) {
    const len = r.readInt();          // protobuf-serialized assertion; opaque here
    for (let k = 0; k < len; k++) r.readByte();
  }

  return { gatlingVersion, simulationClassName, runStartEpochMs, description, scenarios, assertionCount };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/plugin-gatling/test/header.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-gatling
git commit -m "feat(plugin-gatling): Run header parsing"
```

---

### Task 5: Record stream to canonical events

**Files:**
- Create: `packages/plugin-gatling/src/records.ts`, `packages/plugin-gatling/src/index.ts`
- Test: `packages/plugin-gatling/test/records.test.ts`

**Interfaces:**
- Consumes: `BinaryReader`, `readRunHeader`, `RECORD`, `CanonicalEvent`
- Produces: `parseSimulationLog(buf: Buffer): Generator<CanonicalEvent>` — yields `meta` first, then request/user/group/error events with **absolute** epoch-ms timestamps

- [ ] **Step 1: Write the failing test**

`packages/plugin-gatling/test/records.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '../src/records.js';
import type { RequestEvent, UserEvent, GroupEvent } from '@perfportal/core';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';
const events = [...parseSimulationLog(readFileSync(FIXTURE))];

describe('parseSimulationLog', () => {
  it('yields meta first', () => {
    expect(events[0]).toMatchObject({ type: 'meta', toolVersion: '3.15.1', simulation: 'example.ParitySimulation' });
  });

  it('decodes exactly the expected record counts', () => {
    const count = (t: string) => events.filter((e) => e.type === t).length;
    expect(count('request')).toBe(895);
    expect(count('user')).toBe(490);
    expect(count('group')).toBe(405);
  });

  it('recovers all seven endpoints', () => {
    const names = new Set(events.filter((e): e is RequestEvent => e.type === 'request').map((e) => e.name));
    expect(names).toEqual(new Set([
      'List Products', 'Product Detail', 'Related Items', 'Search',
      'Add To Cart', 'View Cart', 'Place Order',
    ]));
  });

  it('recovers the nested group hierarchy', () => {
    const hierarchies = new Set(
      events.filter((e): e is GroupEvent => e.type === 'group').map((e) => e.groups.join('/')),
    );
    expect(hierarchies).toEqual(new Set(['Catalog', 'Catalog/Recommendations', 'Cart']));
  });

  it('splits OK and KO correctly and keeps failure messages', () => {
    const reqs = events.filter((e): e is RequestEvent => e.type === 'request');
    expect(reqs.filter((r) => r.ok).length).toBe(871);
    const ko = reqs.filter((r) => !r.ok);
    expect(ko.length).toBe(24);
    expect(ko.filter((r) => r.message === 'status.find.is(200), found 500').length).toBe(15);
    expect(ko.filter((r) => r.message === 'status.find.is(200), found 503').length).toBe(9);
  });

  it('converts relative offsets to absolute epoch timestamps', () => {
    const first = events.find((e): e is RequestEvent => e.type === 'request')!;
    expect(first.startMs).toBeGreaterThan(1_700_000_000_000);
    expect(first.endMs).toBeGreaterThanOrEqual(first.startMs);
  });

  it('emits user start and end events per scenario', () => {
    const users = events.filter((e): e is UserEvent => e.type === 'user');
    expect(new Set(users.map((u) => u.scenario))).toEqual(new Set(['Browse', 'Checkout']));
    expect(users.filter((u) => u.kind === 'start').length).toBe(245);
    expect(users.filter((u) => u.kind === 'end').length).toBe(245);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/plugin-gatling/test/records.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/plugin-gatling/src/records.ts`:
```ts
import type { CanonicalEvent } from '@perfportal/core';
import { BinaryReader } from './reader.js';
import { RECORD, readRunHeader } from './header.js';

/**
 * All record timestamps are int32 offsets in ms from runStart (PRD Appendix A.10),
 * which caps a single run at ~24.8 days. We convert to absolute epoch ms here so
 * nothing downstream needs to know about the encoding.
 */
export function* parseSimulationLog(buf: Buffer): Generator<CanonicalEvent> {
  const r = new BinaryReader(buf);
  const h = readRunHeader(r);
  const base = h.runStartEpochMs;

  yield {
    type: 'meta',
    simulation: h.simulationClassName,
    toolVersion: h.gatlingVersion,
    startedAtMs: base,
    description: h.description || undefined,
  };

  let userSeq = 0;
  while (!r.eof) {
    const type = r.readByte();
    switch (type) {
      case RECORD.REQUEST: {
        const groups = r.readGroups();
        const name = r.readCachedString();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const ok = r.readBoolean();
        const message = r.readCachedString();
        yield { type: 'request', name, groups, userId: '', startMs, endMs, ok, message: message || undefined };
        break;
      }
      case RECORD.USER: {
        const scenarioIndex = r.readInt();
        const isStart = r.readBoolean();
        const tsMs = base + r.readInt();
        const scenario = h.scenarios[scenarioIndex];
        if (scenario === undefined) throw new Error(`unknown scenario index ${scenarioIndex}`);
        yield { type: 'user', scenario, userId: String(userSeq++), kind: isStart ? 'start' : 'end', tsMs };
        break;
      }
      case RECORD.GROUP: {
        const groups = r.readGroups();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const cumulatedResponseTimeMs = r.readInt();
        const ok = r.readBoolean();
        yield { type: 'group', groups, userId: '', startMs, endMs, cumulatedResponseTimeMs, ok };
        break;
      }
      case RECORD.ERROR: {
        r.readCachedString();
        r.readInt();
        break;                        // standalone error records carry no request context
      }
      default:
        throw new Error(`unknown record type ${type} at byte ${r.pos - 1}`);
    }
  }
}
```

`packages/plugin-gatling/src/index.ts`:
```ts
export * from './reader.js';
export * from './header.js';
export * from './records.js';
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/plugin-gatling/test/records.test.ts`
Expected: PASS (7 tests)

Every number in this test is verified against the fixture — 895/490/405 records, 871 OK, 24 KO, 15/9 error split, 245 user starts and 245 ends. A failure here is a defect in the implementation, not in the expectations.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-gatling
git commit -m "feat(plugin-gatling): decode records into canonical events"
```

---

### Task 6: Sketch wrapper and the AC-STAT-1 accuracy property

**Files:**
- Create: `packages/statistics/package.json`, `packages/statistics/tsconfig.json`, `packages/statistics/src/sketch.ts`
- Test: `packages/statistics/test/sketch.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class Sketch` with `accept(v: number)`, `quantile(q: number): number`, `merge(o: Sketch)`, `serialize(): Uint8Array`, `static deserialize(b: Uint8Array): Sketch`, `get count(): number`, `get min(): number`, `get max(): number`, `get sum(): number`; `SKETCH_KIND = 'ddsketch'`; `RELATIVE_ACCURACY = 0.01`

Verified facts this task depends on: `@datadog/sketches-js` 2.1.1 · `protobufjs` is an **undeclared** dependency of `toProto`/`fromProto` and must be installed explicitly · `fromProto` returns a `BaseDDSketch` which still merges correctly · merge is exact to float precision.

- [ ] **Step 1: Write the failing tests**

`packages/statistics/test/sketch.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Sketch } from '../src/sketch.js';

/** Deterministic, roughly log-normal latency — no Math.random, so failures reproduce. */
function latencies(n: number): number[] {
  let seed = 7;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return Math.abs(seed) / 2147483647; };
  return Array.from({ length: n }, () => {
    const r = rnd();
    return r < 0.9 ? 20 + rnd() * 180 : r < 0.99 ? 300 + rnd() * 500 : 1500 + rnd() * 1500;
  });
}
const trueQuantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

describe('Sketch accuracy (AC-STAT-1)', () => {
  it('is within 1% relative error of the true quantile at every percentile', () => {
    const vals = latencies(200_000);
    const sorted = [...vals].sort((a, b) => a - b);
    const s = new Sketch();
    for (const v of vals) s.accept(v);
    for (const q of [0.5, 0.75, 0.95, 0.99, 0.999]) {
      const err = Math.abs(s.quantile(q) - trueQuantile(sorted, q)) / trueQuantile(sorted, q);
      // <= not <: measured error reaches exactly 1.0% on uniform data.
      expect(err).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('Sketch merge', () => {
  it('merging halves equals accepting the whole', () => {
    const vals = latencies(50_000);
    const whole = new Sketch(); for (const v of vals) whole.accept(v);
    const a = new Sketch(), b = new Sketch();
    vals.forEach((v, i) => (i % 2 ? a : b).accept(v));
    a.merge(b);
    expect(a.count).toBe(whole.count);
    expect(a.quantile(0.99)).toBeCloseTo(whole.quantile(0.99), 6);
  });

  it('survives the persist -> reload -> merge path', () => {
    const a = new Sketch(), b = new Sketch(), whole = new Sketch();
    for (let i = 1; i <= 5000; i++) { a.accept(i); whole.accept(i); }
    for (let i = 5001; i <= 10000; i++) { b.accept(i); whole.accept(i); }
    const ra = Sketch.deserialize(a.serialize());
    const rb = Sketch.deserialize(b.serialize());
    ra.merge(rb);
    expect(ra.quantile(0.99)).toBeCloseTo(whole.quantile(0.99), 6);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/statistics/test/sketch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/statistics/package.json` — note `protobufjs` is explicit:
```json
{
  "name": "@perfportal/statistics",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@perfportal/core": "workspace:*",
    "@datadog/sketches-js": "^2.1.1",
    "protobufjs": "^7.4.0"
  }
}
```

`packages/statistics/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/statistics/src/sketch.ts`:
```ts
import { DDSketch } from '@datadog/sketches-js';

export const SKETCH_KIND = 'ddsketch' as const;
/** Measured: 0.597% max error across p50-p99.9 on realistic latency; ~2.1 KB serialized. */
export const RELATIVE_ACCURACY = 0.01;

export class Sketch {
  #inner: DDSketch;
  constructor(inner?: DDSketch) {
    this.#inner = inner ?? new DDSketch({ relativeAccuracy: RELATIVE_ACCURACY });
  }

  accept(value: number): void { this.#inner.accept(value); }
  quantile(q: number): number { return this.#inner.getValueAtQuantile(q); }
  merge(other: Sketch): void { this.#inner.merge(other.#inner); }

  get count(): number { return this.#inner.count; }
  get min(): number { return this.#inner.min; }
  get max(): number { return this.#inner.max; }
  get sum(): number { return this.#inner.sum; }

  serialize(): Uint8Array { return this.#inner.toProto(); }
  /** fromProto returns a BaseDDSketch; it merges correctly, so the cast is safe. */
  static deserialize(bytes: Uint8Array): Sketch {
    return new Sketch(DDSketch.fromProto(bytes) as unknown as DDSketch);
  }
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm install && pnpm vitest run packages/statistics/test/sketch.test.ts`
Expected: PASS (3 tests)

If `toProto` throws `Cannot find module 'protobufjs/minimal'`, `protobufjs` was not installed — it is an undeclared dependency of the sketch library.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): DDSketch wrapper with accuracy and merge-after-persist tests"
```

---

### Task 7: Adaptive bucketing and the AC-STAT-2 lossless-coalescing invariant

**Files:**
- Create: `packages/statistics/src/buckets.ts`
- Test: `packages/statistics/test/buckets.test.ts`

**Interfaces:**
- Consumes: `Sketch`
- Produces: `class BucketSeries` with `constructor(opts: { startMs: number; maxBuckets: number })`, `add(tsMs: number, value: number, ok: boolean, edge: 'start' | 'end')`, `get widthMs(): number`, `buckets(): Bucket[]`; `interface Bucket { startOffsetMs, startedCount, endedCount, okCount, koCount, sketch }`

This invariant is the executable form of the whole percentile argument. If it breaks, the product is lying.

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/buckets.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BucketSeries } from '../src/buckets.js';
import { Sketch } from '../src/sketch.js';

const sample = (i: number) => 20 + ((i * 37) % 500);

describe('BucketSeries coalescing (AC-STAT-2)', () => {
  it('coalesces losslessly — each 4s bucket equals a sketch built from that window directly', () => {
    const coalesced = new BucketSeries({ startMs: 0, maxBuckets: 4 });   // forces 1s -> 2s -> 4s
    const values: number[] = [];
    for (let i = 0; i < 16_000; i++) {
      const v = sample(i);
      values.push(v);
      coalesced.add(i, v, true, 'end');   // 1 event per ms over 16 s
    }
    expect(coalesced.widthMs).toBe(4000);

    const merged = coalesced.buckets();
    expect(merged.length).toBe(4);

    // THE INVARIANT: a coalesced bucket must be indistinguishable from one built
    // directly from exactly the values that fall in its window. If this fails,
    // percentiles are being degraded by re-aggregation and the product is lying.
    for (const b of merged) {
      const direct = new Sketch();
      for (let ms = b.startOffsetMs; ms < b.startOffsetMs + coalesced.widthMs; ms++) {
        const v = values[ms];
        if (v !== undefined) direct.accept(v);
      }
      expect(b.sketch.count).toBe(direct.count);
      for (const q of [0.5, 0.95, 0.99]) {
        expect(b.sketch.quantile(q)).toBe(direct.quantile(q));
      }
    }

    expect(merged.reduce((n, b) => n + b.endedCount, 0)).toBe(16_000);
  });

  it('never exceeds maxBuckets', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 8 });
    for (let i = 0; i < 100_000; i++) s.add(i * 10, sample(i), true, 'end');
    expect(s.buckets().length).toBeLessThanOrEqual(8);
  });

  it('counts start and end edges separately', () => {
    const s = new BucketSeries({ startMs: 0, maxBuckets: 64 });
    s.add(0, 100, true, 'start');
    s.add(0, 100, true, 'end');
    s.add(0, 100, false, 'end');
    const b = s.buckets()[0]!;
    expect(b.startedCount).toBe(1);
    expect(b.endedCount).toBe(2);
    expect(b.koCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/statistics/test/buckets.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/statistics/src/buckets.ts`:
```ts
import { Sketch } from './sketch.js';

export interface Bucket {
  startOffsetMs: number;
  startedCount: number;
  endedCount: number;
  okCount: number;
  koCount: number;
  sketch: Sketch;
}

/**
 * Starts at 1-second buckets and halves resolution in place whenever the count
 * exceeds maxBuckets. Because DDSketch merges are exact, coalescing is lossless.
 */
export class BucketSeries {
  #startMs: number;
  #maxBuckets: number;
  #widthMs = 1000;
  #buckets = new Map<number, Bucket>();

  constructor(opts: { startMs: number; maxBuckets: number }) {
    this.#startMs = opts.startMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
  }

  get widthMs(): number { return this.#widthMs; }

  add(tsMs: number, value: number, ok: boolean, edge: 'start' | 'end'): void {
    const idx = Math.floor((tsMs - this.#startMs) / this.#widthMs);
    let b = this.#buckets.get(idx);
    if (!b) {
      b = { startOffsetMs: idx * this.#widthMs, startedCount: 0, endedCount: 0, okCount: 0, koCount: 0, sketch: new Sketch() };
      this.#buckets.set(idx, b);
    }
    if (edge === 'start') { b.startedCount++; return; }
    b.endedCount++;
    if (ok) b.okCount++; else b.koCount++;
    b.sketch.accept(value);
    if (this.#buckets.size > this.#maxBuckets) this.#coalesce();
  }

  #coalesce(): void {
    while (this.#buckets.size > this.#maxBuckets) {
      const next = new Map<number, Bucket>();
      const newWidth = this.#widthMs * 2;
      for (const [idx, b] of [...this.#buckets.entries()].sort((x, y) => x[0] - y[0])) {
        const ni = Math.floor(idx / 2);
        const target = next.get(ni);
        if (!target) {
          next.set(ni, { ...b, startOffsetMs: ni * newWidth });
        } else {
          target.startedCount += b.startedCount;
          target.endedCount += b.endedCount;
          target.okCount += b.okCount;
          target.koCount += b.koCount;
          target.sketch.merge(b.sketch);      // exact — this is why coalescing is lossless
        }
      }
      this.#buckets = next;
      this.#widthMs = newWidth;
    }
  }

  buckets(): Bucket[] {
    return [...this.#buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/statistics/test/buckets.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): adaptive bucketing with lossless in-place coalescing"
```

---

### Task 8: Statistic rollups

**Files:**
- Create: `packages/statistics/src/rollup.ts`
- Test: `packages/statistics/test/rollup.test.ts`

**Interfaces:**
- Consumes: `Sketch`, `MetricScope`, `MetricFamily`
- Produces: `interface StatRollup { scope, name, family, count, okCount, koCount, errorRate, minMs, maxMs, meanMs, stddevMs, percentiles: Record<string, number>, throughputRps, sketch }`; `class RollupBuilder` with `add(durationMs: number, ok: boolean)`, `finish(opts: { scope, name, family, windowMs, percentiles: number[] }): StatRollup`

`meanMs` and `stddevMs` use Welford's algorithm so a single streaming pass is exact and needs no retained sample array.

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/rollup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RollupBuilder } from '../src/rollup.js';

describe('RollupBuilder', () => {
  it('computes exact counts, min, max, mean and population stddev', () => {
    const b = new RollupBuilder();
    for (const v of [10, 20, 30, 40]) b.add(v, true);
    b.add(50, false);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 95] });
    expect(r.count).toBe(5);
    expect(r.okCount).toBe(4);
    expect(r.koCount).toBe(1);
    expect(r.errorRate).toBeCloseTo(0.2, 10);
    expect(r.minMs).toBe(10);
    expect(r.maxMs).toBe(50);
    expect(r.meanMs).toBeCloseTo(30, 10);
    expect(r.stddevMs).toBeCloseTo(Math.sqrt(200), 10);   // population sd of 10..50 step 10
    expect(r.throughputRps).toBeCloseTo(5, 10);           // 5 events over 1000 ms
  });

  it('exposes percentiles keyed as p50, p95', () => {
    const b = new RollupBuilder();
    for (let i = 1; i <= 1000; i++) b.add(i, true);
    const r = b.finish({ scope: 'run', name: '', family: 'response_time', windowMs: 1000, percentiles: [50, 95] });
    expect(Object.keys(r.percentiles).sort()).toEqual(['p50', 'p95']);
    expect(r.percentiles.p95!).toBeGreaterThan(r.percentiles.p50!);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/statistics/test/rollup.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/statistics/src/rollup.ts`:
```ts
import type { MetricFamily, MetricScope } from '@perfportal/core';
import { Sketch } from './sketch.js';

export interface StatRollup {
  scope: MetricScope;
  name: string;
  family: MetricFamily;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  /** A projection of `sketch`, exact at this scope. Aggregation merges `sketch`, never these. */
  percentiles: Record<string, number>;
  throughputRps: number;
  sketch: Sketch;
}

export class RollupBuilder {
  #sketch = new Sketch();
  #count = 0;
  #ok = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;
  #mean = 0;
  #m2 = 0;                        // Welford

  add(durationMs: number, ok: boolean): void {
    this.#count++;
    if (ok) this.#ok++;
    if (durationMs < this.#min) this.#min = durationMs;
    if (durationMs > this.#max) this.#max = durationMs;
    const delta = durationMs - this.#mean;
    this.#mean += delta / this.#count;
    this.#m2 += delta * (durationMs - this.#mean);
    this.#sketch.accept(durationMs);
  }

  finish(opts: {
    scope: MetricScope; name: string; family: MetricFamily;
    windowMs: number; percentiles: number[];
  }): StatRollup {
    const percentiles: Record<string, number> = {};
    for (const p of opts.percentiles) percentiles[`p${p}`] = this.#sketch.quantile(p / 100);
    return {
      scope: opts.scope,
      name: opts.name,
      family: opts.family,
      count: this.#count,
      okCount: this.#ok,
      koCount: this.#count - this.#ok,
      errorRate: this.#count === 0 ? 0 : (this.#count - this.#ok) / this.#count,
      minMs: this.#count === 0 ? 0 : this.#min,
      maxMs: this.#count === 0 ? 0 : this.#max,
      meanMs: this.#mean,
      stddevMs: this.#count === 0 ? 0 : Math.sqrt(this.#m2 / this.#count),
      percentiles,
      throughputRps: opts.windowMs === 0 ? 0 : (this.#count / opts.windowMs) * 1000,
      sketch: this.#sketch,
    };
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/statistics/test/rollup.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): streaming statistic rollups via Welford"
```

---

### Task 9: Indicator bands, warm-up exclusion, and error rollup

**Files:**
- Create: `packages/statistics/src/indicators.ts`, `packages/statistics/src/errors-rollup.ts`
- Test: `packages/statistics/test/indicators.test.ts`, `packages/statistics/test/errors-rollup.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface IndicatorBands { under, between, over, failed }`; `class IndicatorCounter` with `constructor(opts: { lowerMs: number; higherMs: number })`, `add(durationMs, ok)`, `bands(): IndicatorBands`; `class ErrorRollup` with `add(message: string)`, `top(limit?: number): { message: string; count: number }[]`
- Also produces: `isWarmup(tsMs: number, runStartMs: number, warmupMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

`packages/statistics/test/indicators.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IndicatorCounter, isWarmup } from '../src/indicators.js';

describe('IndicatorCounter', () => {
  it('splits OK requests across the three bands and counts failures separately', () => {
    const c = new IndicatorCounter({ lowerMs: 800, higherMs: 1200 });
    c.add(100, true); c.add(799, true);      // under
    c.add(800, true); c.add(1199, true);     // between
    c.add(1200, true); c.add(5000, true);    // over
    c.add(50, false);                        // failed, regardless of duration
    expect(c.bands()).toEqual({ under: 2, between: 2, over: 2, failed: 1 });
  });
});

describe('isWarmup', () => {
  it('is true strictly inside the warm-up window', () => {
    expect(isWarmup(1_000_500, 1_000_000, 1000)).toBe(true);
    expect(isWarmup(1_001_000, 1_000_000, 1000)).toBe(false);
    expect(isWarmup(1_000_500, 1_000_000, 0)).toBe(false);
  });
});
```

`packages/statistics/test/errors-rollup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ErrorRollup } from '../src/errors-rollup.js';

describe('ErrorRollup', () => {
  it('counts distinct messages, most frequent first', () => {
    const r = new ErrorRollup();
    for (let i = 0; i < 15; i++) r.add('found 500');
    for (let i = 0; i < 9; i++) r.add('found 503');
    expect(r.top()).toEqual([
      { message: 'found 500', count: 15 },
      { message: 'found 503', count: 9 },
    ]);
  });

  it('caps at the limit and rolls the remainder into "other" preserving the total', () => {
    const r = new ErrorRollup();
    for (let i = 0; i < 250; i++) for (let k = 0; k <= i; k++) r.add(`msg-${i}`);
    const top = r.top(200);
    expect(top.length).toBe(201);                       // 200 + other
    expect(top.at(-1)!.message).toBe('other');
    const total = top.reduce((n, e) => n + e.count, 0);
    expect(total).toBe((250 * 251) / 2);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/statistics/test/indicators.test.ts packages/statistics/test/errors-rollup.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement**

`packages/statistics/src/indicators.ts`:
```ts
export interface IndicatorBands { under: number; between: number; over: number; failed: number; }

export class IndicatorCounter {
  #lower: number; #higher: number;
  #b: IndicatorBands = { under: 0, between: 0, over: 0, failed: 0 };

  constructor(opts: { lowerMs: number; higherMs: number }) {
    this.#lower = opts.lowerMs; this.#higher = opts.higherMs;
  }
  add(durationMs: number, ok: boolean): void {
    if (!ok) { this.#b.failed++; return; }
    if (durationMs < this.#lower) this.#b.under++;
    else if (durationMs < this.#higher) this.#b.between++;
    else this.#b.over++;
  }
  bands(): IndicatorBands { return { ...this.#b }; }
}

/** Warm-up requests stay in the time series but are excluded from summary stats (PRD 7.4). */
export function isWarmup(tsMs: number, runStartMs: number, warmupMs: number): boolean {
  return warmupMs > 0 && tsMs - runStartMs < warmupMs;
}
```

`packages/statistics/src/errors-rollup.ts`:
```ts
export class ErrorRollup {
  #counts = new Map<string, number>();

  add(message: string): void {
    this.#counts.set(message, (this.#counts.get(message) ?? 0) + 1);
  }

  /** Retains the top `limit` messages; the remainder collapses into one `other` row. */
  top(limit = 200): { message: string; count: number }[] {
    const sorted = [...this.#counts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
    if (sorted.length <= limit) return sorted;
    const kept = sorted.slice(0, limit);
    const other = sorted.slice(limit).reduce((n, e) => n + e.count, 0);
    return [...kept, { message: 'other', count: other }];
  }
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run packages/statistics/test/indicators.test.ts packages/statistics/test/errors-rollup.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): indicator bands, warm-up exclusion, error rollup"
```

---

### Task 10: Scope fan-out and the engine

**Files:**
- Create: `packages/statistics/src/scopes.ts`, `packages/statistics/src/engine.ts`, `packages/statistics/src/index.ts`
- Test: `packages/statistics/test/scopes.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent`, `RollupBuilder`, `BucketSeries`, `IndicatorCounter`, `ErrorRollup`, `isWarmup`
- Produces: `interface EngineOptions { warmupMs?, lowerMs?, higherMs?, percentiles?, maxEndpoints?, maxBucketsRun?, maxBucketsEndpoint? }`; `interface EngineResult { stats: StatRollup[]; series: Map<string, Bucket[]>; indicators: IndicatorBands; errors: { message, count }[]; endpointCount: number }`; `function runEngine(events: Iterable<CanonicalEvent>, opts?: EngineOptions): EngineResult`

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/scopes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import type { CanonicalEvent } from '@perfportal/core';

const base = 1_000_000;
const req = (name: string, groups: string[], off: number, dur: number, ok = true): CanonicalEvent => ({
  type: 'request', name, groups, userId: 'u', startMs: base + off, endMs: base + off + dur, ok,
});

describe('runEngine scope fan-out', () => {
  const events: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
    req('A', ['G1'], 0, 100),
    req('B', ['G1'], 100, 200),
    req('C', [], 300, 300, false),
  ];

  it('produces a run scope plus one scope per request name', () => {
    const r = runEngine(events);
    const run = r.stats.find((s) => s.scope === 'run')!;
    expect(run.count).toBe(3);
    expect(run.koCount).toBe(1);
    const names = r.stats.filter((s) => s.scope === 'request').map((s) => s.name).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });

  it('rejects a run that exceeds the endpoint cardinality cap', () => {
    const many: CanonicalEvent[] = [{ type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base }];
    for (let i = 0; i < 12; i++) many.push(req(`ep-${i}`, [], i, 10));
    expect(() => runEngine(many, { maxEndpoints: 10 }))
      .toThrow(/ENDPOINT_CARDINALITY_EXCEEDED|cardinality/i);
  });

  it('excludes warm-up from summary stats but keeps it in the series', () => {
    // warmupMs 50 covers only the request starting at offset 0; the others start at 100 and 300.
    const r = runEngine(events, { warmupMs: 50 });
    const run = r.stats.find((s) => s.scope === 'run')!;
    expect(run.count).toBe(2);                               // the 0ms-offset request is warm-up
    const runSeries = r.series.get('run:')!;
    const total = runSeries.reduce((n, b) => n + b.endedCount, 0);
    expect(total).toBe(3);                                   // series still has all three
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/statistics/test/scopes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`packages/statistics/src/scopes.ts`:
```ts
export const scopeKey = (scope: string, name: string): string => `${scope}:${name}`;
```

`packages/statistics/src/engine.ts`:
```ts
import { ingestError, type CanonicalEvent } from '@perfportal/core';
import { BucketSeries, type Bucket } from './buckets.js';
import { ErrorRollup } from './errors-rollup.js';
import { IndicatorCounter, isWarmup, type IndicatorBands } from './indicators.js';
import { RollupBuilder, type StatRollup } from './rollup.js';
import { scopeKey } from './scopes.js';

export interface EngineOptions {
  warmupMs?: number;
  lowerMs?: number;
  higherMs?: number;
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
}

export interface EngineResult {
  stats: StatRollup[];
  series: Map<string, Bucket[]>;
  indicators: IndicatorBands;
  errors: { message: string; count: number }[];
  endpointCount: number;
}

export function runEngine(events: Iterable<CanonicalEvent>, opts: EngineOptions = {}): EngineResult {
  const warmupMs = opts.warmupMs ?? 0;
  const percentiles = opts.percentiles ?? [50, 75, 95, 99];
  const maxEndpoints = opts.maxEndpoints ?? 2000;
  const maxBucketsRun = opts.maxBucketsRun ?? 1200;
  const maxBucketsEndpoint = opts.maxBucketsEndpoint ?? 300;

  let runStartMs = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;

  const rollups = new Map<string, RollupBuilder>();
  const series = new Map<string, BucketSeries>();
  const indicators = new IndicatorCounter({ lowerMs: opts.lowerMs ?? 800, higherMs: opts.higherMs ?? 1200 });
  const errors = new ErrorRollup();
  const endpoints = new Set<string>();

  const seriesFor = (key: string, max: number): BucketSeries => {
    let s = series.get(key);
    if (!s) { s = new BucketSeries({ startMs: runStartMs, maxBuckets: max }); series.set(key, s); }
    return s;
  };
  const rollupFor = (key: string): RollupBuilder => {
    let b = rollups.get(key);
    if (!b) { b = new RollupBuilder(); rollups.set(key, b); }
    return b;
  };

  for (const e of events) {
    if (e.type === 'meta') { runStartMs = e.startedAtMs; continue; }
    if (e.type !== 'request') continue;                     // group/user scopes: Task 11

    endpoints.add(e.name);
    if (endpoints.size > maxEndpoints) {
      throw ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
        message: `Run contains more than ${maxEndpoints} distinct request names.`,
        remediation: 'Request names appear to contain dynamic values such as IDs. Parameterize them in the simulation, or raise the limit in project settings.',
        detail: { limit: maxEndpoints, samples: [...endpoints].slice(0, 5) },
      });
    }

    const duration = e.endMs - e.startMs;
    firstMs = Math.min(firstMs, e.startMs);
    lastMs = Math.max(lastMs, e.endMs);

    // Series always includes warm-up (PRD 7.4).
    const runSeries = seriesFor(scopeKey('run', ''), maxBucketsRun);
    runSeries.add(e.startMs, duration, e.ok, 'start');
    runSeries.add(e.endMs, duration, e.ok, 'end');
    const epSeries = seriesFor(scopeKey('request', e.name), maxBucketsEndpoint);
    epSeries.add(e.startMs, duration, e.ok, 'start');
    epSeries.add(e.endMs, duration, e.ok, 'end');

    // Summary stats exclude warm-up.
    if (isWarmup(e.startMs, runStartMs, warmupMs)) continue;
    rollupFor(scopeKey('run', '')).add(duration, e.ok);
    rollupFor(scopeKey('request', e.name)).add(duration, e.ok);
    indicators.add(duration, e.ok);
    if (!e.ok && e.message) errors.add(e.message);
  }

  const windowMs = Math.max(0, lastMs - Math.max(firstMs, runStartMs + warmupMs));
  const stats: StatRollup[] = [];
  for (const [key, b] of rollups) {
    const [scope, name] = key.split(':') as ['run' | 'request', string];
    stats.push(b.finish({ scope, name, family: 'response_time', windowMs, percentiles }));
  }

  return {
    stats,
    series: new Map([...series].map(([k, v]) => [k, v.buckets()])),
    indicators: indicators.bands(),
    errors: errors.top(200),
    endpointCount: endpoints.size,
  };
}
```

`packages/statistics/src/index.ts`:
```ts
export * from './sketch.js';
export * from './buckets.js';
export * from './rollup.js';
export * from './indicators.js';
export * from './errors-rollup.js';
export * from './scopes.js';
export * from './engine.js';
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/statistics/test/scopes.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): scope fan-out engine with cardinality cap and warm-up handling"
```

---

### Task 11: Group and scenario scopes

**Files:**
- Modify: `packages/statistics/src/engine.ts`
- Test: `packages/statistics/test/scopes.test.ts` (append)

**Interfaces:**
- Consumes: `GroupEvent`, `RequestEvent.scenario`
- Produces: `EngineResult.stats` additionally containing `scope: 'group'` rows for both `group_cumulated` and `group_duration` families

`group_cumulated` and `group_duration` are different quantities and Gatling reports both (PRD Appendix A GR-01/GR-02). Deriving one from the other is the most common group-parity error.

- [ ] **Step 1: Write the failing test — append to `packages/statistics/test/scopes.test.ts`**

```ts
import type { GroupEvent } from '@perfportal/core';

describe('group scopes', () => {
  it('records cumulated response time and wall-clock duration as separate families', () => {
    const grp = (groups: string[], start: number, end: number, cumulated: number): GroupEvent => ({
      type: 'group', groups, userId: 'u', startMs: base + start, endMs: base + end,
      cumulatedResponseTimeMs: cumulated, ok: true,
    });
    const r = runEngine([
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      req('A', ['Catalog'], 0, 100),
      grp(['Catalog'], 0, 500, 300),          // duration 500, cumulated 300 — deliberately different
      grp(['Catalog', 'Recommendations'], 0, 200, 150),
    ]);
    const cumulated = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_cumulated')!;
    const duration = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_duration')!;
    expect(cumulated.maxMs).toBe(300);
    expect(duration.maxMs).toBe(500);
    const nested = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog/Recommendations');
    expect(nested).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/statistics/test/scopes.test.ts`
Expected: FAIL — no `group` scope rows exist

- [ ] **Step 3: Implement — replace the `if (e.type !== 'request') continue;` guard in `engine.ts`**

```ts
    if (e.type === 'group') {
      const name = e.groups.join('/');
      rollupFor(`group|${name}|group_cumulated`).add(e.cumulatedResponseTimeMs, e.ok);
      rollupFor(`group|${name}|group_duration`).add(e.endMs - e.startMs, e.ok);
      continue;
    }
    if (e.type !== 'request') continue;
```

And replace the stats-assembly loop so it understands both key shapes:

```ts
  const stats: StatRollup[] = [];
  for (const [key, b] of rollups) {
    if (key.startsWith('group|')) {
      const [, name, family] = key.split('|') as [string, string, 'group_cumulated' | 'group_duration'];
      stats.push(b.finish({ scope: 'group', name, family, windowMs, percentiles }));
    } else {
      const [scope, name] = key.split(':') as ['run' | 'request', string];
      stats.push(b.finish({ scope, name, family: 'response_time', windowMs, percentiles }));
    }
  }
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/statistics/test/scopes.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): group scopes with distinct cumulated and duration families"
```

---

### Task 12: End-to-end parity assertion against the fixture

**Files:**
- Test: `packages/statistics/test/parity.test.ts`

**Interfaces:**
- Consumes: `parseSimulationLog`, `runEngine`
- Produces: the `PT-*` suite this plan is judged by

- [ ] **Step 1: Write the failing test**

`packages/statistics/test/parity.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { runEngine } from '../src/engine.js';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';
const events = [...parseSimulationLog(readFileSync(FIXTURE))];
const result = runEngine(events);
const run = result.stats.find((s) => s.scope === 'run')!;

/** Values Gatling PRINTS. Exact quantities only — never its percentiles (PRD A.9 F-6). */
describe('PT-G: global page exact quantities', () => {
  it('PT-G-11/12 total, OK, KO', () => {
    expect(run.count).toBe(895);
    expect(run.okCount).toBe(871);
    expect(run.koCount).toBe(24);
  });

  it('PT-G-06..09 indicator bands', () => {
    expect(result.indicators).toEqual({ under: 848, between: 0, over: 23, failed: 24 });
  });

  it('PT-G-12 max, mean, stddev match Gatling exactly', () => {
    expect(run.maxMs).toBe(2503);
    expect(Math.round(run.meanMs)).toBe(228);
    expect(Math.round(run.stddevMs)).toBe(370);
  });

  it('PT-G-29 error table', () => {
    expect(result.errors).toEqual([
      { message: 'status.find.is(200), found 500', count: 15 },
      { message: 'status.find.is(200), found 503', count: 9 },
    ]);
  });

  it('PT-G-11 all seven endpoints present as request scopes', () => {
    expect(result.stats.filter((s) => s.scope === 'request').length).toBe(7);
  });
});

/** Percentiles are compared to GROUND TRUTH, not to Gatling's histogram estimate. */
describe('PT-G-12 percentiles vs ground truth', () => {
  const durations = events
    .filter((e): e is Extract<typeof e, { type: 'request' }> => e.type === 'request')
    .map((e) => e.endMs - e.startMs)
    .sort((a, b) => a - b);
  const truth = (q: number) => durations[Math.min(durations.length - 1, Math.ceil(q * durations.length) - 1)]!;

  it('is within 1% relative of the true percentile', () => {
    for (const p of [50, 75, 95, 99]) {
      const got = run.percentiles[`p${p}`]!;
      const want = truth(p / 100);
      expect(Math.abs(got - want) / want).toBeLessThanOrEqual(0.01);
    }
  });

  it('does NOT reproduce Gatling\'s p99, which is a histogram artifact', () => {
    // Gatling prints 2369; no request took that long. True p99 is 2501.
    expect(durations.includes(2369)).toBe(false);
    expect(run.percentiles.p99!).toBeGreaterThan(2400);
  });
});
```

- [ ] **Step 2: Run and watch it fail or pass**

Run: `pnpm vitest run packages/statistics/test/parity.test.ts`
Expected: PASS if Tasks 3–11 are correct. Any failure here is a real defect — investigate rather than adjusting the expected values, since every number above is verified against the generated report.

- [ ] **Step 3: Add the workspace dependency if the import fails**

`packages/statistics/package.json` → `dependencies`:
```json
"@perfportal/plugin-gatling": "workspace:*"
```
Then `pnpm install`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "test: end-to-end Gatling parity assertions against the reference fixture"
```

---

### Task 13: Throughput benchmark

**Files:**
- Create: `packages/statistics/test/support/generate.ts`, `packages/statistics/test/throughput.bench.test.ts`

**Interfaces:**
- Consumes: `runEngine`, `CanonicalEvent`
- Produces: `generateEvents(count: number, endpoints: number): Generator<CanonicalEvent>`

This is the mitigation owed for choosing TypeScript against PRD NFR-PF-4 (R-2). It starts as a **reported metric**, not a gate — there is no production baseline yet, and a gate calibrated on a laptop would be noise.

- [ ] **Step 1: Write the generator**

`packages/statistics/test/support/generate.ts`:
```ts
import type { CanonicalEvent } from '@perfportal/core';

/** Deterministic synthetic load, roughly log-normal latency across N endpoints. */
export function* generateEvents(count: number, endpoints: number): Generator<CanonicalEvent> {
  const base = 1_700_000_000_000;
  yield { type: 'meta', simulation: 'synthetic', toolVersion: '0', startedAtMs: base };
  let seed = 12345;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return Math.abs(seed) / 2147483647; };
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const dur = r < 0.9 ? 20 + rnd() * 180 : r < 0.99 ? 300 + rnd() * 500 : 1500 + rnd() * 1500;
    const start = base + Math.floor((i / count) * 3_600_000);
    yield {
      type: 'request',
      name: `endpoint-${i % endpoints}`,
      groups: [],
      userId: String(i % 500),
      startMs: start,
      endMs: start + Math.round(dur),
      ok: rnd() > 0.02,
      message: undefined,
    };
  }
}
```

- [ ] **Step 2: Write the benchmark**

`packages/statistics/test/throughput.bench.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { generateEvents } from './support/generate.js';

const EVENTS = Number(process.env.BENCH_EVENTS ?? 1_000_000);
const ENDPOINTS = 100;

describe('throughput (PRD NFR-PF-4)', () => {
  it(`aggregates ${EVENTS.toLocaleString()} events within budget`, () => {
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = runEngine(generateEvents(EVENTS, ENDPOINTS));
    const seconds = (performance.now() - t0) / 1000;
    const peakMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    const rate = Math.round(EVENTS / seconds);

    // Reported, not gated — see PRD 20.2. Budget is 5M events in 180s => ~28k/s.
    console.log(`\n  events/sec: ${rate.toLocaleString()}  wall: ${seconds.toFixed(1)}s  heap delta: ${peakMb.toFixed(0)} MB`);
    console.log(`  extrapolated 5M events: ${(5_000_000 / rate).toFixed(0)}s (budget 180s)\n`);

    expect(r.stats.length).toBeGreaterThan(0);
    expect(peakMb).toBeLessThan(1024);          // hard guard: must not approach the 8 GiB worker
  }, 600_000);
});
```

- [ ] **Step 3: Run it**

Run: `pnpm vitest run packages/statistics/test/throughput.bench.test.ts`
Expected: PASS, printing the events/sec figure and the extrapolation to 5M.

Record the number in the PR description. **If the extrapolation exceeds 180 s, stop and report** — that is R-2 materializing, and it is a stack-level finding, not a tuning task.

- [ ] **Step 4: Commit**

```bash
git add packages/statistics/test
git commit -m "test: synthetic generator and ingestion throughput benchmark"
```

---

## Definition of done

- [ ] `pnpm lint && pnpm typecheck && pnpm test` green
- [ ] Boundary lint demonstrably fires on an I/O import from a pure package
- [ ] Every exact quantity in the parity suite matches the Gatling report
- [ ] AC-STAT-1 (≤1% relative error) and AC-STAT-2 (lossless coalescing) pass
- [ ] Throughput figure recorded, with the 5M extrapolation stated

## Not in this plan

NestJS app · Postgres schema and migrations · BullMQ and Redis · S3 blob store · `BundleView` over tar.gz · plugin `detect`/`capabilities` registration · ingest endpoint and the adaptive verdict contract · SLA evaluation · distribution and correlation charts · latency family (Gatling reports none — PRD §A.9 F-2) · scenario scope rollups (not a Gatling parity surface — §A.9 F-3).

Distribution (`src/distribution.ts`) and correlation are listed in the File Structure for continuity but are **not implemented here** — they belong with the service plan, where the run-detail API consumes them.
