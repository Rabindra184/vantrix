# Live SLA signals implementation plan (FR-LIVE-6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a load test is running, evaluate the project's SLA rules against the same fold the live page already draws, and show which rules are currently breaching.

**Architecture:** `LiveFoldOwner` loads the project's rules once when it claims a run, and on every tick runs the existing pure `evaluateRules` against the fold's stats. Rules with too little data are gated out. The breaching ones ride the delta already going to the browser, as a state with a "since" offset, and render as a banner. Nothing is persisted and no verdict changes.

**Tech Stack:** TypeScript, Prisma, ioredis, React, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-19-live-sla-signals-design.md`

## Global Constraints

- **Node 22.** `nvm use` first. On Node 20 roughly two thirds of the unit suite silently does not load — every DOM file — while vitest prints a green summary above the errors.
- **Baselines:** unit **103 files / 1150 tests**, integration **108 files / 1269 tests**, e2e **89** — measured before this branch. **`pnpm test:integration` runs the unit files too** (`vitest.integration.config.ts` includes every `test/**/*.test.ts` with no exclude), so a new unit file raises BOTH counts. A drop in any means something stopped loading.
- **Full gate, in this order:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. Integration BEFORE e2e.
- **Run each suite as a single blocking foreground call, once, alone.** `pnpm test:integration` truncates every table on setup, so two overlapping runs sabotage each other and produce failures that reproduce on nothing. If you see unique-constraint violations on slugs, check `pgrep -f vitest` before believing them.
- **The batch path must stay byte-identical.** `evaluateRules` called with two arguments produces exactly what it produces today; every existing SLA and verdict test is the proof. If one changes, the change is wrong.
- **This work writes nothing to the database.** No migration, no new table, no write path in the fold owner. If you find yourself adding one, stop — it is out of scope.
- **It changes no verdict.** `run.verdict` and `run_assertion` are written only by `PipelineService` at parse time. A live breach is a signal.
- **Expectations are computed from the payload, never written down.**
- **Never put `uppercase` on anything queried by accessible name** — Playwright applies `text-transform` when computing accessible names; jsdom does not.
- **Do not put a decorative `<svg>` inside a chart `<figure>`** — nine specs count SVG elements there to prove a chart drew.

---

## File Structure

**Created**
- `packages/sla/src/stats.ts` — `toEvaluableStats`, the one mapping from the engine's rollups into the evaluator's input.
- `packages/sla/test/stats.test.ts`
- `packages/sla/test/evidence-gate.test.ts`
- `apps/web/src/routes/SlaBanner.tsx` — the breaching-rules banner.
- `apps/web/test/SlaBanner.test.tsx`

**Modified**
- `packages/sla/src/evaluate.ts` — the opt-in evidence gate.
- `packages/sla/src/index.ts` — export the new module.
- `apps/worker/src/pipeline/pipeline.service.ts:301-316` — call the shared mapping.
- `apps/worker/src/live/fold-owner.ts` — rules at claim, evaluation per tick, the breach-since map.
- `apps/worker/src/main.ts:112` — pass a `RuleRepository`.
- `apps/worker/src/live/delta.ts` — emit the `sla` envelope.
- `packages/contracts/src/live-delta.ts` — the envelope's schema.
- `apps/web/src/routes/RunDetail.tsx` — render the banner.

---

## Task 1: Extract `toEvaluableStats`

Pure refactor. No behaviour change; the existing suites are the proof.

**Files:**
- Create: `packages/sla/src/stats.ts`, `packages/sla/test/stats.test.ts`
- Modify: `packages/sla/src/index.ts`, `apps/worker/src/pipeline/pipeline.service.ts:301-316`

**Interfaces:**
- Consumes: `StatRollup` from `@perfportal/statistics` (already a declared dependency of `@perfportal/sla`), `EvaluableStat` from `./metrics.js`.
- Produces: `toEvaluableStats(stats: readonly StatRollup[]): EvaluableStat[]`, exported from `@perfportal/sla`.

**Read this before you start.** `StatRollup` is *already structurally assignable* to `EvaluableStat` — every field lines up, and `sketch` is required on the former and optional on the latter. **The mapping is therefore redundant to the type checker, and that is not a reason to delete it.** Its value is that it pins the field list: adding a field to `StatRollup` must not silently become an input to SLA evaluation. Keep the explicit map; do not "simplify" it to a cast or a pass-through.

- [ ] **Step 1: Write the failing test**

`packages/sla/test/stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Sketch } from '@perfportal/statistics';
import { toEvaluableStats } from '../src/index.js';

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'run' as const,
    name: '',
    family: 'response_time' as const,
    count: 3,
    okCount: 2,
    koCount: 1,
    errorRate: 1 / 3,
    minMs: 10,
    maxMs: 60,
    meanMs: 30,
    stddevMs: 5,
    throughputRps: 1.5,
    percentiles: { p95: 55 },
    sketch: new Sketch(),
    ...overrides,
  };
}

describe('toEvaluableStats', () => {
  it('carries every field the evaluator reads', () => {
    const [out] = toEvaluableStats([rollup()]);
    const source = rollup();
    for (const key of [
      'scope', 'name', 'family', 'count', 'okCount', 'koCount', 'errorRate',
      'minMs', 'maxMs', 'meanMs', 'stddevMs', 'throughputRps',
    ] as const) {
      expect(out[key]).toEqual(source[key]);
    }
    expect(out.percentiles).toEqual(source.percentiles);
    expect(out.sketch).toBeDefined();
  });

  // The mapping is a boundary, not a convenience: a field added to StatRollup
  // must not become an SLA input without someone deciding it should.
  it('does not carry a field the evaluator does not know about', () => {
    const [out] = toEvaluableStats([rollup({ unrelatedFuture: 42 }) as never]);
    expect('unrelatedFuture' in out).toBe(false);
  });

  it('maps every rollup it is given', () => {
    expect(toEvaluableStats([rollup(), rollup({ scope: 'request' })])).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/sla/test/stats.test.ts`
Expected: FAIL — `toEvaluableStats` is not exported.

- [ ] **Step 3: Write the mapping**

`packages/sla/src/stats.ts`:

```ts
import type { StatRollup } from '@perfportal/statistics';
import type { EvaluableStat } from './metrics.js';

/**
 * THE ONE MAPPING from the engine's rollups into the evaluator's input.
 *
 * `PipelineService` evaluates a finished run; `LiveFoldOwner` evaluates the
 * same run while it streams. A second copy drifts, and the drift surfaces as a
 * live breach that disagrees with the final verdict for the same run -- the
 * same failure, on the same product surface, as a live chart contradicting the
 * final report. This project has already paid for that lesson twice, in the
 * record decoder and in `bucketLatency`.
 *
 * THE EXPLICIT FIELD LIST IS THE POINT, even though `StatRollup` is already
 * structurally assignable to `EvaluableStat` and the type checker would accept
 * a pass-through. This is a boundary: a field added to `StatRollup` must not
 * become an input to SLA evaluation without someone deciding that it should.
 */
export function toEvaluableStats(stats: readonly StatRollup[]): EvaluableStat[] {
  return stats.map((s) => ({
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
}
```

- [ ] **Step 4: Export it**

Add to `packages/sla/src/index.ts`:

```ts
export * from './stats.js';
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run packages/sla/test/stats.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the parity test — spec §5.1, the load-bearing one**

This is the case the whole extraction exists to protect. Add to
`packages/sla/test/stats.test.ts`:

```ts
import { runEngine } from '@perfportal/statistics';
import { evaluateRules } from '../src/index.js';

// The batch path and the live path must reach the same assertions from the
// same fold. They call the same two functions, so this test's job is to fail
// the day someone gives one of them its own mapping.
it('produces assertions identical to a second caller of the same two functions', () => {
  const result = runEngine([
    { type: 'request', name: 'GET /cart', groups: [], userId: 'u1', startMs: 0, endMs: 120, ok: true },
    { type: 'request', name: 'GET /cart', groups: [], userId: 'u1', startMs: 100, endMs: 900, ok: false },
  ]);
  const rules = [{
    id: 'r1', scope: 'run', targetName: null, family: 'response_time' as const,
    metric: 'max', comparator: 'lte' as const, threshold: 100,
  }];

  const viaBatch = evaluateRules(rules, toEvaluableStats(result.stats));
  const viaLive = evaluateRules(rules, toEvaluableStats(result.stats));

  expect(viaLive.assertions).toEqual(viaBatch.assertions);
  expect(viaLive.verdict).toBe(viaBatch.verdict);
  // And it must be a real judgement, not two matching empties.
  expect(viaBatch.assertions).not.toHaveLength(0);
  expect(viaBatch.verdict).not.toBe('not_evaluated');
});
```

The final assertions matter: two paths agreeing on "nothing was evaluated"
would pass this test while proving nothing.

- [ ] **Step 7: Switch the pipeline to it**

In `apps/worker/src/pipeline/pipeline.service.ts`, replace the inline map at
`:301-316`:

```ts
    const evaluable: EvaluableStat[] = result.stats.map((s) => ({
      scope: s.scope,
      // ... fourteen fields ...
    }));
```

with:

```ts
    const evaluable = toEvaluableStats(result.stats);
```

and update the import on line 12 — `EvaluableStat` may become unused, which
**fails lint** if left:

```ts
import { evaluateRules, toEvaluableStats, type EvaluableRule } from '@perfportal/sla';
```

- [ ] **Step 8: Prove the refactor changed nothing**

Run: `pnpm test:unit`
Expected: PASS, **at least 104 files / 1154 tests**. The SLA, verdict and parity suites are what prove this is behaviour-preserving — **if one of them moves, the extraction is wrong, not the test.**

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/sla apps/worker/src/pipeline/pipeline.service.ts
git commit -m "refactor(sla,worker): one mapping from rollups into the evaluator

PipelineService maps StatRollup into EvaluableStat inline, and the live fold
owner needs the identical mapping. A second copy drifts, and the drift shows
up as a live breach disagreeing with the final verdict for the same run --
the same argument that keeps one record decoder and one bucketLatency.

The explicit field list stays even though StatRollup is already structurally
assignable: it is a boundary, so a field added to the rollup does not become
an SLA input by accident."
```

---

## Task 2: The evidence gate

**Files:**
- Modify: `packages/sla/src/evaluate.ts`
- Create: `packages/sla/test/evidence-gate.test.ts`

**Interfaces:**
- Produces: `evaluateRules(rules, stats, opts?)` where `opts` is `{ minObservations?: (rule: EvaluableRule) => number }`. **Omitted, behaviour is exactly as today.**
- Produces: `liveEvidenceFloor(rule: EvaluableRule): number`, exported, so the fold owner passes it rather than inventing its own.

**Where the gate goes.** In `evaluateRules`, after `const actual = resolveMetric(...)` and its null/NaN branch, and **before** the `const passed = ...` comparison. Not earlier: a rule that cannot resolve a stat at all is already `not_applicable` for a better reason, and that branch must keep its own message.

- [ ] **Step 1: Write the failing test**

`packages/sla/test/evidence-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateRules, liveEvidenceFloor, type EvaluableRule, type EvaluableStat } from '../src/index.js';

const RULE: EvaluableRule = {
  id: 'r1', scope: 'run', targetName: null, family: 'response_time',
  metric: 'p99', comparator: 'lte', threshold: 100,
};

function stat(count: number): EvaluableStat {
  return {
    scope: 'run', name: '', family: 'response_time',
    count, okCount: count, koCount: 0, errorRate: 0,
    minMs: 1, maxMs: 900, meanMs: 400, stddevMs: 10, throughputRps: 1,
    percentiles: { p99: 900 },
  };
}

describe('the evidence gate', () => {
  // The whole point: 900ms against a 100ms threshold is a blatant breach, and
  // on 40 samples a p99 is one observation deep in the tail. Reporting it
  // would teach readers to ignore the banner.
  it('does not report a breach on too little data', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.outcome).toBe('not_applicable');
    expect(assertions[0]!.message).toMatch(/observations/i);
  });

  it('reports the value it could not trust, rather than discarding it', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.actualValue).toBe(900);
  });

  it('breaches once the same rule and data clear the floor', () => {
    const floor = liveEvidenceFloor(RULE);
    const { assertions, verdict } = evaluateRules([RULE], [stat(floor)], { minObservations: liveEvidenceFloor });
    expect(assertions[0]!.outcome).toBe('failed');
    expect(verdict).toBe('failed');
  });

  // Deeper in the tail needs more evidence: p99 reads 1 observation in 100.
  it('demands more observations the deeper in the tail the metric reads', () => {
    const p50 = liveEvidenceFloor({ ...RULE, metric: 'p50' });
    const p95 = liveEvidenceFloor({ ...RULE, metric: 'p95' });
    const p99 = liveEvidenceFloor({ ...RULE, metric: 'p99' });
    expect(p50).toBeLessThan(p95);
    expect(p95).toBeLessThan(p99);
  });

  it('uses a flat floor for a scalar metric', () => {
    expect(liveEvidenceFloor({ ...RULE, metric: 'error_rate' })).toBe(100);
  });

  // The batch path passes no options and must be untouched.
  it('is absent unless asked for', () => {
    const { assertions } = evaluateRules([RULE], [stat(40)]);
    expect(assertions[0]!.outcome).toBe('failed');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/sla/test/evidence-gate.test.ts`
Expected: FAIL — `liveEvidenceFloor` is not exported and the third argument is not accepted.

- [ ] **Step 3: Add the floor**

In `packages/sla/src/evaluate.ts`:

```ts
/**
 * How many observations a rule needs before a LIVE evaluation will judge it.
 *
 * The batch evaluator runs once, on a finished run. The live one runs every
 * few seconds, including at second six when a p99 rests on a handful of
 * requests -- and ungated, the first minute of every run would breach almost
 * any latency threshold. A banner that is wrong for the first minute of every
 * run is worse than no banner, because readers learn to ignore it.
 *
 * SCALED TO HOW DEEP IN THE TAIL THE METRIC READS. A flat number is wrong in
 * both directions: 100 observations is generous for a p50 and meaningless for
 * a p99, where it is a single sample past the quantile. `pXX` therefore asks
 * for ten expected observations beyond the quantile -- p50 wants 20, p95 wants
 * 200, p99 wants 1000 -- and the scalar metrics take a flat 100.
 *
 * The factor of ten is a judgement, not a derivation. It is one constant in
 * one file, and it is meant to be revised against real runs.
 */
export function liveEvidenceFloor(rule: EvaluableRule): number {
  const m = /^p(\d+(?:\.\d+)?)$/.exec(rule.metric);
  if (!m) return 100;
  const q = Number(m[1]);
  if (!Number.isFinite(q) || q <= 0 || q >= 100) return 100;
  return Math.ceil((100 / (100 - q)) * 10);
}
```

- [ ] **Step 4: Add the option and the branch**

Widen the signature:

```ts
export interface EvaluateOptions {
  /**
   * Minimum observations before a rule is judged. Omitted, no rule is gated
   * and behaviour is exactly as it was -- which is what keeps the batch path
   * and its suites untouched.
   */
  minObservations?: (rule: EvaluableRule) => number;
}

export function evaluateRules(
  rules: readonly EvaluableRule[],
  stats: readonly EvaluableStat[],
  opts: EvaluateOptions = {},
): { assertions: EvaluatedAssertion[]; verdict: Verdict } {
```

and insert, after the `actual === null || Number.isNaN(actual)` branch and
before `const passed = ...`:

```ts
    // AFTER the metric resolves, so the value can be reported. A rule that
    // could not resolve a stat at all is already not_applicable above, for a
    // better reason, and that branch keeps its own message.
    const floor = opts.minObservations?.(rule) ?? 0;
    if (stat.count < floor) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        // NOT null. There was something to measure -- just not enough of it,
        // and "900 on 40 observations" tells a reader more than a blank does.
        actualValue: actual,
        message:
          `${describe(rule)} was not checked yet — ${stat.count} of ${floor} observations. ` +
          `Actual so far: ${actual}.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }
```

- [ ] **Step 5: Widen the `actualValue` doc comment**

`EvaluatedAssertion.actualValue` currently reads `/** null when not_applicable — there was nothing to measure. */`. It becomes:

```ts
  /**
   * null when there was nothing to measure; POPULATED when there was too
   * little to trust (the live evidence gate). Both are `not_applicable` --
   * "we did not check" is one outcome with two reasons, and the message says
   * which.
   */
  actualValue: number | null;
```

- [ ] **Step 6: Run and watch it pass**

Run: `pnpm vitest run packages/sla/test/evidence-gate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Prove the batch path is untouched**

Run: `pnpm test:unit`
Expected: PASS, at least **105 files / 1160 tests** — `evidence-gate.test.ts` is a NEW file, so the file count rises too. The existing SLA and verdict suites must be unchanged — they call `evaluateRules` with two arguments.

Then run the integration suite, **alone**, because `apps/api/test/verdict.integration.test.ts` asserts on `actualValue`:

```bash
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
pnpm test:integration
```
Expected: PASS, 108 files / 1269 tests, unchanged.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/sla
git commit -m "feat(sla): an opt-in evidence gate for live evaluation

The batch evaluator runs once on a finished run; a live one runs every few
seconds, including when a p99 rests on a handful of requests. Ungated, the
first minute of every run breaches almost any latency threshold and readers
learn to ignore the result.

The gate is an option defaulting to off, so the batch path is byte-identical
and its suites are the proof. It lives inside the evaluator because deciding
which stat a rule resolves to is the evaluator's own job -- a caller filtering
thin rules first would reimplement that matching.

A gated rule is not_applicable, which already means 'could not be judged',
rather than a fourth outcome every consumer would have to learn. It carries
the value it could not trust: '900 on 40 observations' beats a blank."
```

---

## Task 3: Evaluate in the fold owner

**Files:**
- Modify: `apps/worker/src/live/fold-owner.ts`, `apps/worker/src/main.ts:112`
- Test: `apps/worker/test/fold-owner.integration.test.ts`

**Interfaces:**
- Consumes: `toEvaluableStats`, `evaluateRules`, `liveEvidenceFloor` from `@perfportal/sla`; `RuleRepository` and `SlaRuleRecord` from `@perfportal/persistence`.
- Produces: on `FoldState`, `rules: EvaluableRule[]` and `breachingSince: Map<string, number>`; and per tick, an `EvaluatedAssertion[]` the next task puts on the wire.

**Two things to get right:**

1. **The discovery query does not carry the tenant.** `#doTick`'s query is `SELECT id FROM run WHERE status = 'running'` — no `org_id`, no `project_id`, and `RuleRepository.listEnabled` needs both. Widen it to `SELECT id, org_id, project_id FROM run WHERE status = 'running'`: it is the same rows and the same index, so it costs nothing, and it avoids a second round trip per claim.
2. **Rules load once, at claim.** Not per tick. A run's SLA should be the SLA it started under — a rule edited at minute 40 of a soak retroactively changing what a running evaluation reports is worse than a stale read, because the reader would see a breach appear with no change in the data.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/fold-owner.integration.test.ts`:

```ts
it('reports a rule that is breaching, with the offset it started breaching at', async () => {
  await seedRule({ metric: 'error_rate', comparator: 'lte', threshold: 0.01 });
  await owner.tick();                       // fold enough failures to breach
  const first = breachesOf(owner, runId);
  expect(first).toHaveLength(1);
  expect(first[0]!.sinceOffsetMs).toBeGreaterThanOrEqual(0);

  await owner.tick();
  // A STATE, not an event: the same breach, and the "since" does not move.
  expect(breachesOf(owner, runId)[0]!.sinceOffsetMs).toBe(first[0]!.sinceOffsetMs);
});

it('clears a breach when the metric recovers', async () => {
  await seedRule({ metric: 'error_rate', comparator: 'lte', threshold: 0.01 });
  await owner.tick();
  expect(breachesOf(owner, runId)).toHaveLength(1);

  await foldEnoughSuccessesToRecover();
  await owner.tick();
  expect(breachesOf(owner, runId)).toHaveLength(0);
});

// The rules a run is judged against are the ones it started under.
it('does not pick up a rule edited after the run was claimed', async () => {
  await seedRule({ metric: 'error_rate', comparator: 'lte', threshold: 0.99 });
  await owner.tick();
  expect(breachesOf(owner, runId)).toHaveLength(0);

  await tightenRuleTo(0.0001);              // would breach, if it were re-read
  await owner.tick();
  expect(breachesOf(owner, runId)).toHaveLength(0);
});
```

Author `seedRule`, `breachesOf`, `tightenRuleTo` and `foldEnoughSuccessesToRecover` against the file's existing helpers — they do not exist yet.

- [ ] **Step 2: Run them and watch them fail**

Run the integration suite alone, with the env exported above:
`pnpm test:integration`
Expected: FAIL — no SLA evaluation exists.

- [ ] **Step 3: Widen the discovery query**

In `#doTick`:

```ts
    const { rows } = await this.#pool.query<{ id: string; org_id: string; project_id: string }>(
      // org_id and project_id ride along because the claim needs them to read
      // the project's SLA rules -- the same rows and the same index, so this
      // costs nothing over selecting `id` alone, and it saves a round trip.
      "SELECT id, org_id, project_id FROM run WHERE status = 'running'",
    );
```

Keep `runningIds` as it is; carry the tenant through to the claim.

- [ ] **Step 4: Load rules at claim, hold them on `FoldState`**

Add to `FoldState`:

```ts
  /**
   * The project's rules AS THEY READ WHEN THIS RUN WAS CLAIMED. Deliberately
   * not re-read per tick: a run's SLA should be the SLA it started under, and
   * a rule edited mid-run would otherwise make a breach appear with no change
   * in the data.
   */
  rules: EvaluableRule[];
  /** ruleId -> the elapsed offset at which it began breaching. */
  breachingSince: Map<string, number>;
```

Populate `rules` in the claim path from `new RuleRepository(prisma).listEnabled({ orgId, projectId })`, mapped to `EvaluableRule` the same way `pipeline.service.ts:318` does. Initialise `breachingSince` empty.

- [ ] **Step 5: Evaluate on the tick, and maintain the state**

Where the tick already has its `EngineResult`:

```ts
    const { assertions } = evaluateRules(
      state.rules,
      toEvaluableStats(snapshot.stats),
      { minObservations: liveEvidenceFloor },
    );

    const breaching = assertions.filter((a) => a.outcome === 'failed');
    const seen = new Set(breaching.map((a) => a.ruleId));
    // A rule that recovered -- or that fell back BELOW the evidence floor --
    // loses its entry. Freezing the timer through a period where the rule was
    // not judged at all would report "breaching for 4 minutes" about three
    // minutes nobody looked at.
    for (const ruleId of state.breachingSince.keys()) {
      if (!seen.has(ruleId)) state.breachingSince.delete(ruleId);
    }
    for (const a of breaching) {
      if (!state.breachingSince.has(a.ruleId)) {
        state.breachingSince.set(a.ruleId, snapshot.durationMs);
      }
    }
```

- [ ] **Step 6: Pass the repository in**

`apps/worker/src/main.ts:112` currently reads:

```ts
const foldOwner = new LiveFoldOwner(config, pool, chunks, new Redis(config.redisUrl));
```

`createPrisma` is already imported on line 3 and a client already exists for the pipeline — pass a `RuleRepository` built on it. Do not construct a second Prisma client: its pool is already counted in this file's connection sizing.

- [ ] **Step 7: Run the integration suite, alone, and watch it pass**

Run: `pnpm test:integration`
Expected: PASS, at least **110 files / 1282 tests** — your three cases go into
an existing file, so the file count does not move.

**Note the baselines in Global Constraints are the WHOLE non-e2e suite, not a
separate integration suite.** `vitest.integration.config.ts` includes
`packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts` with **no
exclude**, so `pnpm test:integration` runs every unit file as well. Adding a
unit test file therefore raises this count too.

- [ ] **Step 8: Typecheck, lint, full unit, commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
git add apps/worker
git commit -m "feat(worker): evaluate SLA rules against a live fold

The fold owner already holds an EngineResult every tick. It now runs the same
pure evaluator the parse pipeline runs, through the same shared mapping, with
the evidence gate on -- so a breach means the run is genuinely in trouble
rather than that it is six seconds old.

Rules are read ONCE, at claim: a run's SLA should be the SLA it started
under, and a rule edited at minute 40 of a soak retroactively changing what a
running evaluation reports would make a breach appear with no change in the
data. The discovery query carries org_id and project_id so the claim can read
them without a second round trip.

A breach is a state. Its 'since' offset is stamped on the transition into
breaching and cleared on recovery -- including when a rule falls back below
the evidence floor, because freezing the timer through a period where nothing
was judged would overstate how long the run was in trouble."
```

---

## Task 4: The `sla` envelope on the wire

**Files:**
- Modify: `packages/contracts/src/live-delta.ts`, `apps/worker/src/live/delta.ts`, `apps/worker/src/live/fold-owner.ts`
- Test: `packages/contracts/test/live-delta.test.ts`, `apps/worker/test/live-delta.test.ts`

**Interfaces:**
- Produces: `LiveDelta['sla']` — `{ evaluated: number; breaching: { ruleId: string; description: string; actualValue: number; sinceOffsetMs: number }[] }`.

- [ ] **Step 1: Write the failing test**

In `apps/worker/test/live-delta.test.ts`:

```ts
it('carries only the breaching rules, and a count of those evaluated', () => {
  // `buildDeltaWithSla` is a thin wrapper you write over `buildDelta`, so the
  // case reads as one call; it does not exist yet.
  const delta = buildDeltaWithSla({
    assertions: [
      { ruleId: 'a', outcome: 'failed', actualValue: 900, message: 'p95 ≤ 100 — actual 900' },
      { ruleId: 'b', outcome: 'passed', actualValue: 20, message: 'p95 ≤ 100 — actual 20' },
      { ruleId: 'c', outcome: 'not_applicable', actualValue: null, message: 'not checked yet' },
    ],
    breachingSince: new Map([['a', 42_000]]),
  });

  expect(delta.sla.breaching).toEqual([
    { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 42_000 },
  ]);
  // Passed AND failed count as evaluated; not_applicable did not get judged.
  expect(delta.sla.evaluated).toBe(2);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/worker/test/live-delta.test.ts`
Expected: FAIL — `delta.sla` is `undefined`.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/live-delta.ts`, before `LiveDeltaSchema`:

```ts
export const LiveBreachSchema = z.object({
  ruleId: z.string(),
  /** The evaluator's own message — one sentence, already human-readable. */
  description: z.string(),
  actualValue: z.number(),
  /** Elapsed run offset at which this rule began breaching. */
  sinceOffsetMs: z.number().int(),
});
export type LiveBreach = z.infer<typeof LiveBreachSchema>;

/**
 * ONLY the breaching rules travel. `evaluated` is a count so a reader can be
 * told "2 of 7 breaching" without six passing rules riding every tick, and a
 * rule below the evidence floor is in neither number -- it was not judged.
 */
export const LiveSlaSchema = z.object({
  evaluated: z.number().int(),
  breaching: z.array(LiveBreachSchema),
});
export type LiveSla = z.infer<typeof LiveSlaSchema>;
```

and add `sla: LiveSlaSchema` to `LiveDeltaSchema`.

- [ ] **Step 4: Populate it**

`buildDelta(runId, result, prev)` has no way to know about assertions, so it
gains a fourth parameter. Keep it **required** rather than optional: an
optional one would let a future caller silently omit the SLA state and publish
a delta claiming nothing is breaching.

```ts
export interface SlaInput {
  assertions: readonly EvaluatedAssertion[];
  /** ruleId -> the offset at which it began breaching (`FoldState`'s map). */
  breachingSince: ReadonlyMap<string, number>;
}

export function buildDelta(
  runId: string,
  result: EngineResult,
  prev: DeltaCursor,
  sla: SlaInput,
): { delta: LiveDelta; next: DeltaCursor } {
```

`buildSnapshot(runId, result, seq)` calls `buildDelta` from `INITIAL_CURSOR`
and must pass the same `sla` through — a seed that reported no breaches while
the run was breaching would clear the banner for every newly-connecting
viewer. Give it the same fourth parameter and forward it.

Then map:

```ts
  const breaching = assertions
    .filter((a) => a.outcome === 'failed')
    .map((a) => ({
      ruleId: a.ruleId,
      description: a.message,
      actualValue: a.actualValue ?? 0,
      sinceOffsetMs: breachingSince.get(a.ruleId) ?? 0,
    }));
  const evaluated = assertions.filter((a) => a.outcome !== 'not_applicable').length;
```

- [ ] **Step 5: Fix every existing `LiveDelta` fixture**

Adding a required field breaks any hand-built delta. Fix the constructions, **do not make the field optional** — `packages/contracts/test/live-delta.test.ts`'s `valid` fixture and `apps/api/test/live-gateway.integration.test.ts`'s fixtures are the likely sites. Grep for them.

- [ ] **Step 6: Run, typecheck, lint, full unit, commit**

```bash
pnpm vitest run apps/worker/test/live-delta.test.ts packages/contracts/test/live-delta.test.ts
pnpm typecheck && pnpm lint && pnpm test:unit
git add packages/contracts apps/worker
git commit -m "feat(contracts,worker): the delta carries currently-breaching rules

Only the breaching ones, plus a count of those evaluated -- so a page can say
'2 of 7 breaching' without six passing rules riding every tick, and a rule
below the evidence floor is in neither number because it was not judged."
```

---

## Task 5: The banner

**Files:**
- Create: `apps/web/src/routes/SlaBanner.tsx`, `apps/web/test/SlaBanner.test.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx`
- Test: `apps/web/e2e/run-live.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/test/SlaBanner.test.tsx`:

```tsx
it('names each breaching rule and how long it has been breaching', () => {
  render(<SlaBanner sla={{ evaluated: 7, breaching: [
    { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 },
  ] }} />);
  expect(screen.getByRole('status')).toHaveTextContent(/p95/);
  expect(screen.getByRole('status')).toHaveTextContent(/1m 2s/);
});

it('renders nothing when no rule is breaching', () => {
  const { container } = render(<SlaBanner sla={{ evaluated: 7, breaching: [] }} />);
  expect(container).toBeEmptyDOMElement();
});

// A condition you can look at, not an event you might miss -- so it must
// survive a re-render rather than firing once.
it('still renders when the same breach arrives again', () => {
  const sla = { evaluated: 7, breaching: [
    { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 },
  ] };
  const { rerender } = render(<SlaBanner sla={sla} />);
  rerender(<SlaBanner sla={sla} />);
  expect(screen.getByRole('status')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, watch it fail, then implement**

Run: `pnpm vitest run apps/web/test/SlaBanner.test.tsx`
Expected: FAIL, then PASS once `SlaBanner.tsx` exists.

No `<svg>` in it, and no `uppercase` on any text a test queries by accessible name.

- [ ] **Step 3: Render it on the live page**

In `RunDetail.tsx`'s `Live`, above the charts, from `lastDelta.sla`.

- [ ] **Step 4: Add the e2e case**

In `apps/web/e2e/run-live.spec.ts`: seed a run and a rule it breaches, and assert the banner appears. Before adding any table, grep the e2e suite for `getByRole('table'` — this task adds none, so there is nothing to collide with, but check rather than assume.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add apps/web
git commit -m "feat(web): show which SLA rules a running run is breaching

A banner, not a toast: the breach is a condition you can look at, so a reader
who arrives mid-run sees the truth rather than having missed an alert -- and a
toast would fire again on every reconnect."
```

- [ ] **Step 6: Raise the floor in CLAUDE.md**

Set the unit and integration numbers to what the final run reported, and name the suites this sub-project added.
