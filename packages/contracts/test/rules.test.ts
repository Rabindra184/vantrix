import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CreateSlaRuleRequestSchema,
  SLA_METRIC_SCALARS,
  SlaMetricSchema,
  SlaRuleSchema,
  UpdateSlaRuleRequestSchema,
  isResolvableSlaMetric,
} from '../src/rules.js';

/**
 * THE MIRROR, READ OFF THE EVALUATOR'S OWN SOURCE.
 *
 * `SLA_METRIC_SCALARS` is a hand-copy of `SCALARS` in
 * `packages/sla/src/metrics.ts`, and two hand-maintained copies of one list is
 * the arrangement this repo has already been bitten by — `palette.test.ts`
 * exists for exactly this, between `theme.ts` and `tokens.css`, and it works
 * the same way: read the other file and compare.
 *
 * READING THE FILE RATHER THAN IMPORTING IT IS THE POINT. `@perfportal/contracts`
 * depends on nothing but zod and must keep doing so — it is the package the
 * browser ships — so it cannot import the evaluator to check itself. The
 * source text is available without a dependency, and a test that reads it
 * fails on the day someone edits `SCALARS` and forgets this list.
 *
 * The drift is silent in BOTH directions and neither is harmless. A scalar the
 * engine gains but this list does not makes the authoring API reject a gate
 * that would have worked. One the engine loses but this list keeps lets an
 * author save a gate that can never be checked: `resolveMetric` returns null,
 * `evaluateRules` records `not_applicable`, and the rule reads "not checked"
 * on every run forever while looking like protection.
 */
describe('SLA_METRIC_SCALARS mirrors the evaluator', () => {
  const metricsSource = readFileSync(
    fileURLToPath(new URL('../../sla/src/metrics.ts', import.meta.url)),
    'utf8',
  );

  it('lists exactly the scalars SCALARS declares', () => {
    const block = /const SCALARS[^{]*\{([\s\S]*?)\n\};/.exec(metricsSource);
    expect(block?.[1], 'SCALARS block not found in packages/sla/src/metrics.ts').toBeDefined();
    const declared = [...block![1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(declared).toEqual([...SLA_METRIC_SCALARS]);
  });

  /**
   * The percentile shape and its bound, pinned as TEXT for the same reason.
   * `metrics.ts` gates on `p > 0 && p < 100`, which is why `p0` and `p100` are
   * refused here — the min and the max have their own scalar names.
   */
  it('uses the same percentile pattern and the same exclusive bound', () => {
    expect(metricsSource).toContain('/^p(\\d+(?:\\.\\d+)?)$/');
    expect(metricsSource).toContain('p > 0 && p < 100');
  });
});

describe('SlaMetricSchema', () => {
  it.each(SLA_METRIC_SCALARS)('accepts the scalar %s', (metric) => {
    expect(SlaMetricSchema.safeParse(metric).success).toBe(true);
  });

  it('accepts a percentile, including a fractional one', () => {
    expect(SlaMetricSchema.safeParse('p95').success).toBe(true);
    expect(SlaMetricSchema.safeParse('p99.9').success).toBe(true);
  });

  /**
   * The case the whole write path exists for. Each of these resolves to
   * `null` in the evaluator, which `evaluateRules` records as
   * `not_applicable` — a gate that reads "not checked" forever while looking
   * like configured protection.
   */
  it.each(['p95th', 'P95', 'p', 'mean_ms', 'errorRate', 'p0', 'p100', ''])(
    'rejects %j, which the evaluator would silently never check',
    (metric) => {
      expect(SlaMetricSchema.safeParse(metric).success).toBe(false);
    },
  );

  /**
   * The bound is strict at BOTH ends and the two endpoints are the ones a
   * reader is most likely to try. `metrics.ts` gates on `p > 0 && p < 100`;
   * the min and the max have their own scalar names.
   */
  it('excludes the endpoints while accepting either side of them', () => {
    expect(isResolvableSlaMetric('p0')).toBe(false);
    expect(isResolvableSlaMetric('p100')).toBe(false);
    expect(isResolvableSlaMetric('p0.1')).toBe(true);
    expect(isResolvableSlaMetric('p99.99')).toBe(true);
  });
});

describe('CreateSlaRuleRequestSchema', () => {
  const base = {
    scope: 'run' as const,
    targetName: null,
    family: 'response_time' as const,
    metric: 'p95',
    comparator: 'lte' as const,
    threshold: 800,
  };

  it('accepts a run-scoped rule with no target', () => {
    expect(CreateSlaRuleRequestSchema.safeParse(base).success).toBe(true);
  });

  /**
   * BOTH DIRECTIONS, because one alone is satisfied by a schema that always
   * rejects (or always accepts). A run rule reads the run's own aggregate row
   * and has nothing to name; every other scope matches BY name, and a null one
   * matches nothing at all — the rule evaluates `not_applicable` forever,
   * which is the same silent failure the metric check exists to prevent.
   */
  it('refuses a target on a run rule, and a missing one on a request rule', () => {
    expect(
      CreateSlaRuleRequestSchema.safeParse({ ...base, targetName: 'GET /catalog' }).success,
    ).toBe(false);
    expect(
      CreateSlaRuleRequestSchema.safeParse({ ...base, scope: 'request', targetName: null }).success,
    ).toBe(false);
    expect(
      CreateSlaRuleRequestSchema.safeParse({
        ...base,
        scope: 'request',
        targetName: 'GET /catalog',
      }).success,
    ).toBe(true);
  });

  it('rejects a threshold no comparison could ever pass', () => {
    expect(CreateSlaRuleRequestSchema.safeParse({ ...base, threshold: Number.NaN }).success).toBe(
      false,
    );
    expect(
      CreateSlaRuleRequestSchema.safeParse({ ...base, threshold: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    // Zero and negatives ARE allowed: "error_rate lte 0" is a real gate.
    expect(CreateSlaRuleRequestSchema.safeParse({ ...base, threshold: 0 }).success).toBe(true);
  });

  it('is strict, so a misspelled field is rejected rather than dropped', () => {
    expect(CreateSlaRuleRequestSchema.safeParse({ ...base, treshold: 900 }).success).toBe(false);
  });
});

describe('UpdateSlaRuleRequestSchema', () => {
  it('accepts each mutable field on its own', () => {
    expect(UpdateSlaRuleRequestSchema.safeParse({ threshold: 900 }).success).toBe(true);
    expect(UpdateSlaRuleRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateSlaRuleRequestSchema.safeParse({ name: 'Checkout gate' }).success).toBe(true);
  });

  it('rejects an empty patch rather than reporting success for a write it never made', () => {
    expect(UpdateSlaRuleRequestSchema.safeParse({}).success).toBe(false);
  });

  /**
   * A rule's identity is WHAT it measures. Re-aiming one keeps its id while
   * every assertion already recorded against that id refers to a measurement
   * it never took — `ruleSnapshot` survives a threshold change and cannot help
   * with this. `.strict()` is what turns each of these into a 400.
   */
  it.each([
    { metric: 'p99' },
    { scope: 'request' },
    { family: 'latency' },
    { comparator: 'gte' },
  ])('refuses %j, which would re-aim the rule rather than retune it', (patch) => {
    expect(UpdateSlaRuleRequestSchema.safeParse(patch).success).toBe(false);
  });
});

/**
 * ═══ WHAT A RULE APPLIES TO, WHICH IS NOT WHAT IT MEASURES ═══
 *
 * `scope` on this same object means run/scenario/group/request — the metric
 * target — and `ProjectScope` in the repositories means the tenant. `testSlug`
 * is a third question and is never called a scope, in the schema or in the UI,
 * because a reader who conflates the two authors a gate on the wrong thing
 * while reading their own configuration as correct.
 */
describe('CreateSlaRuleRequestSchema — which test a rule applies to', () => {
  const RULE = {
    scope: 'run' as const,
    targetName: null,
    family: 'response_time' as const,
    metric: 'p95',
    comparator: 'lte' as const,
    threshold: 800,
  };

  /**
   * THE COMPATIBILITY CASE. Every rule authored before this field existed
   * judged every run in its project, and a client that has never heard of
   * `testSlug` must keep meaning exactly that — so an absent field is
   * project-wide, not a validation error.
   */
  it('accepts a body with no testSlug at all, which is project-wide', () => {
    expect(CreateSlaRuleRequestSchema.parse(RULE).testSlug).toBeUndefined();
  });

  it('reads an explicit null as project-wide too', () => {
    expect(CreateSlaRuleRequestSchema.parse({ ...RULE, testSlug: null }).testSlug).toBeNull();
  });

  it('carries a test slug through', () => {
    expect(CreateSlaRuleRequestSchema.parse({ ...RULE, testSlug: 'payments-sweep' }).testSlug).toBe(
      'payments-sweep',
    );
  });

  /**
   * A blank slug names no test and cannot resolve, so it would either 404 or —
   * worse, if anything ever coerced it — become project-wide. Rejecting it
   * here means the only two ways to say "every test" are absence and null.
   */
  it('refuses a blank test slug rather than treating it as every test', () => {
    expect(() => CreateSlaRuleRequestSchema.parse({ ...RULE, testSlug: '   ' })).toThrow();
  });

  /**
   * `.strict()` doing its job. A caller reaching for the obvious-but-wrong
   * field name gets a 400 rather than a rule that silently went project-wide —
   * which is the failure that matters here, because a gate applied to
   * everything looks exactly like a gate applied to something.
   */
  it('refuses testId, so a caller cannot half-say what it meant', () => {
    expect(() =>
      CreateSlaRuleRequestSchema.parse({
        ...RULE,
        testId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow();
  });
});

describe('SlaRuleSchema — the test a rule reports', () => {
  const STORED = {
    id: '11111111-1111-4111-8111-111111111111',
    name: null,
    scope: 'run',
    targetName: null,
    family: 'response_time',
    metric: 'p95',
    comparator: 'lte',
    threshold: 800,
    enabled: true,
    createdAt: '2026-08-22T10:00:00.000Z',
    updatedAt: '2026-08-22T10:00:00.000Z',
  };

  it('carries the test a rule judges', () => {
    const parsed = SlaRuleSchema.parse({
      ...STORED,
      test: { id: '33333333-3333-4333-8333-333333333333', slug: 'payments', name: 'Payments' },
    });
    expect(parsed.test?.slug).toBe('payments');
  });

  it('accepts null for a project-wide rule', () => {
    expect(SlaRuleSchema.parse({ ...STORED, test: null }).test).toBeNull();
  });

  /**
   * The rolling-deploy case, the same pairing `RunResponse.test` documents: a
   * required field here would blank the whole rules panel while an old API pod
   * is still answering.
   */
  it('accepts a rule from an API pod that predates the field', () => {
    expect(SlaRuleSchema.parse(STORED).test).toBeUndefined();
  });
});
