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
  slaMetricLabel,
  describeSlaRule,
  slaMetricUnit,
  slaThresholdWarning,
  SLA_METRIC_UNITS,
  describeSlaMeasurement,
  describeSlaOutcome,
  formatSlaValue,
  fractionToPercent,
  percentToFraction,
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

/**
 * THE UNIT A THRESHOLD IS MEASURED IN.
 *
 * `error_rate` is a fraction and every other surface renders it as a
 * percentage, so an author who types `1` for "one percent" builds `≤ 100%` —
 * a gate no run can breach, that reports PASSED forever. A schema cannot
 * refuse it, because 100% is a legal bound; the only defence is telling the
 * author the unit, which means the unit has to be a fact code can read.
 */
describe('slaMetricUnit', () => {
  // EVERY scalar, enumerated from the list itself rather than spelled out
  // again: a metric added to `SLA_METRIC_SCALARS` without a unit would
  // otherwise reach the form with a blank label and no one would notice.
  it.each(SLA_METRIC_SCALARS)('gives %s a unit', (metric) => {
    expect(slaMetricUnit(metric)).toBeTruthy();
  });

  it('measures percentiles in milliseconds, like the scalars they sit beside', () => {
    expect(slaMetricUnit('p95')).toBe('ms');
    expect(slaMetricUnit('p99.9')).toBe('ms');
    expect(slaMetricUnit('mean')).toBe('ms');
  });

  it('calls the error rate a fraction, which is the whole point', () => {
    expect(slaMetricUnit('error_rate')).toBe('fraction');
    expect(SLA_METRIC_UNITS.error_rate).toBe('fraction');
  });

  it('returns null for a metric the evaluator cannot resolve', () => {
    // `p95th` is the typo `SlaMetricSchema` already refuses; a unit for it
    // would imply the form should label a field it is about to reject.
    expect(slaMetricUnit('p95th')).toBeNull();
    expect(slaMetricUnit('')).toBeNull();
  });
});

describe('slaThresholdWarning', () => {
  it('warns that a fraction above 1 is a gate nothing can breach', () => {
    const warning = slaThresholdWarning('error_rate', 1);
    expect(warning).toBeNull(); // exactly 1 IS 100% — legal, and the boundary

    const above = slaThresholdWarning('error_rate', 5);
    expect(above).toContain('fraction');
    expect(above).toContain('500%');
    // Naming the number to type instead is what makes this actionable rather
    // than merely disapproving.
    expect(above).toContain('0.05');
  });

  it('says nothing about a millisecond threshold, however large', () => {
    // 30000 ms is a perfectly ordinary max-response-time bound.
    expect(slaThresholdWarning('p95', 30000)).toBeNull();
    expect(slaThresholdWarning('mean', 2)).toBeNull();
  });

  it('says nothing about a sane fraction', () => {
    expect(slaThresholdWarning('error_rate', 0.01)).toBeNull();
    expect(slaThresholdWarning('error_rate', 0)).toBeNull();
  });

  it('says nothing when the threshold is not a number yet', () => {
    // The form calls this on every keystroke, so a half-typed value must not
    // flash a warning.
    expect(slaThresholdWarning('error_rate', Number.NaN)).toBeNull();
  });
});

/**
 * REVIEW M17 — THE AUTHOR SHOULD NOT BE THE ONE PLACE THAT CONVERTS.
 *
 * `error_rate` is `koCount / count`, so the evaluator compares against 0.0268
 * while every other surface renders that as 2.68%. An author authoring a gate
 * had to do the conversion in their head, and CLAUDE.md records what happens
 * when they do not: `1` meaning "one percent" is a legal, resolvable,
 * permanently PASSING rule of ≤ 100%.
 *
 * Nothing about the wire or the evaluator changes — the contract still carries
 * a fraction and a run's verdict is computed from exactly the value it always
 * was. Only the author's side of the boundary moves.
 */
describe('SLA threshold units', () => {
  it('renders a fraction metric as the percentage every other surface shows', () => {
    expect(formatSlaValue('error_rate', 0.0268)).toBe('2.68%');
    expect(formatSlaValue('error_rate', 0.01)).toBe('1%');
  });

  it('names milliseconds for a latency metric', () => {
    expect(formatSlaValue('p95', 800)).toBe('800 ms');
    expect(formatSlaValue('mean', 250)).toBe('250 ms');
  });

  it('names the rate and count units too', () => {
    expect(formatSlaValue('throughput_rps', 12)).toBe('12/s');
    expect(formatSlaValue('count', 900)).toBe('900');
  });

  /** IEEE 754 makes the naive form ugly AND wrong-looking: `0.07 * 100` is
   *  7.000000000000001, and extra digits in a gate invite a reader to wonder
   *  what they mean. */
  it('does not leak floating-point noise into a gate', () => {
    expect(formatSlaValue('error_rate', 0.07)).toBe('7%');

    /* ═══ THE ACTUAL GOES THROUGH THE SAME FUNCTION AS THE LIMIT ═══
     *
     * The rename is the fix: a rule's bound and the measurement judged against
     * it are one quantity in one unit, and only the bound used to come through
     * here. A failed error-rate rule read `Actual 0.02` under `≤ 1%` — the
     * value that BREACHED the gate looking like half of it.
     *
     * Asserted as the PAIR rather than as one string, because that is the
     * property: whatever the rendering becomes, the two sides of a comparison
     * must not be in different units. The raw actual is included so the
     * floating-point noise the evidence table used to print is visibly gone. */
    const stored = 0.0223463687150838;
    expect(formatSlaValue('error_rate', stored)).toBe('2.2346%');
    expect(formatSlaValue('error_rate', stored)).not.toBe(String(stored));
    // Both sides of the one comparison a reader has to make, in one unit.
    expect(formatSlaValue('error_rate', 0.01)).toBe('1%');
    expect(fractionToPercent(0.07)).toBe(7);
    expect(fractionToPercent(0.001)).toBe(0.1);
  });

  it('round-trips a percentage an author would actually type', () => {
    for (const percent of [1, 2.68, 0.5, 100, 0.01]) {
      expect(fractionToPercent(percentToFraction(percent))).toBe(percent);
    }
  });

  /** The stored value is what the evaluator compares, so the conversion has to
   *  land on the fraction the old hand-entered rules already use. */
  it('stores one percent as the fraction the evaluator expects', () => {
    expect(percentToFraction(1)).toBe(0.01);
    expect(percentToFraction(2.68)).toBe(0.0268);
    expect(percentToFraction(100)).toBe(1);
  });

  it('passes a non-finite value through rather than inventing one', () => {
    expect(Number.isNaN(fractionToPercent(Number.NaN))).toBe(true);
    expect(Number.isNaN(percentToFraction(Number.NaN))).toBe(true);
  });
});

/* ======================================================================== *
 * READING A RULE BACK IN WORDS (review M17)
 * ======================================================================== */

describe('slaMetricLabel', () => {
  /**
   * `error_rate` and `throughput_rps` are COLUMN NAMES, and the review's
   * objection to the authoring form was exactly that it exposed them. The
   * labels live here rather than in the form for the reason `slaMetricUnit`
   * gives one function up: a fact about a metric that code can read does not
   * drift, and a sentence somebody has to remember does.
   */
  it('names the scalars the way a reader says them', () => {
    expect(slaMetricLabel('error_rate')).toBe('error rate');
    expect(slaMetricLabel('throughput_rps')).toBe('throughput');
    expect(slaMetricLabel('stddev')).toBe('response time spread');
  });

  /**
   * DERIVED, NOT LISTED. The evaluator resolves any percentile strictly
   * between 0 and 100, so a closed map would fall back to the raw key for the
   * p99.95 somebody legitimately configured — the same argument the form's
   * `<datalist>` makes against being a `<select>`.
   */
  it('derives a percentile label rather than looking one up', () => {
    expect(slaMetricLabel('p50')).toBe('50th percentile response time');
    expect(slaMetricLabel('p99.9')).toBe('99.9th percentile response time');
    expect(slaMetricLabel('p1')).toBe('1st percentile response time');
    expect(slaMetricLabel('p2')).toBe('2nd percentile response time');
    expect(slaMetricLabel('p13')).toBe('13th percentile response time');
  });

  /** A metric the engine would refuse gets NO label. Dressing up `p95th` would
   *  make the preview read as valid in the one case the author needs telling. */
  it('returns an unresolvable metric unchanged', () => {
    expect(slaMetricLabel('p95th')).toBe('p95th');
    expect(slaMetricLabel('p100')).toBe('p100');
    expect(slaMetricLabel('nonsense')).toBe('nonsense');
  });
});

describe('describeSlaRule', () => {
  it('names the target, the measure, the direction and the unit', () => {
    expect(
      describeSlaRule({
        scope: 'request',
        targetName: 'Search',
        metric: 'p95',
        comparator: 'lte',
        threshold: 800,
      }),
    ).toBe('Request “Search”: 95th percentile response time must be at most 800 ms.');
  });

  /**
   * THE COMPARATOR IS ONE OF THE TWO THINGS THAT GO WRONG IN SILENCE, and a
   * sentence is where it stops being silent: `throughput at least 50/s` reads
   * as a floor, which is what it is, while `at most` over the same numbers
   * reads as a gate that fails a run for being FAST.
   */
  it('reads a floor as a floor', () => {
    expect(
      describeSlaRule({
        scope: 'run',
        targetName: null,
        metric: 'throughput_rps',
        comparator: 'gte',
        threshold: 50,
      }),
    ).toBe('The whole run: throughput must be at least 50/s.');
  });

  /**
   * AND THE UNIT IS THE OTHER. The stored value is a fraction and every read
   * surface shows a percentage; this takes the STORED value and renders it the
   * way the rules table does, so a preview cannot agree with the form and
   * disagree with the row it creates.
   */
  it('renders a stored fraction as the percentage every other surface shows', () => {
    expect(
      describeSlaRule({
        scope: 'run',
        targetName: null,
        metric: 'error_rate',
        comparator: 'lte',
        threshold: 0.01,
      }),
    ).toBe('The whole run: error rate must be at most 1%.');
  });

  /** A scoped rule with no target yet judges every one of them — which is what
   *  the evaluator does, and is worth saying rather than leaving blank. */
  it('says “every” for a scoped rule that names nothing', () => {
    expect(
      describeSlaRule({
        scope: 'group',
        targetName: '   ',
        metric: 'mean',
        comparator: 'lte',
        threshold: 200,
      }),
    ).toBe('Every group: mean response time must be at most 200 ms.');
  });
});

describe('describeSlaMeasurement', () => {
  /**
   * THE REVIEW'S OWN THREE EXAMPLES, VERBATIM. Finding 3 gives them as the
   * specification, so they are the test rather than a paraphrase of it.
   */
  it('renders the second review’s three worked examples', () => {
    expect(
      describeSlaMeasurement({ scope: 'run', targetName: null, family: 'response_time', metric: 'error_rate' }),
    ).toBe('Whole-run error rate');
    expect(
      describeSlaMeasurement({ scope: 'request', targetName: 'Search', family: 'response_time', metric: 'p95' }),
    ).toBe('Search p95 response time');
    expect(
      describeSlaMeasurement({ scope: 'group', targetName: 'Cart', family: 'group_cumulated', metric: 'p95' }),
    ).toBe('Cart p95 cumulative response time');
  });

  /**
   * THE RULE UNDERNEATH THOSE EXAMPLES, asserted as a pair so neither half can
   * be satisfied by a function that always or never qualifies. A family names
   * the quantity a TIME statistic is taken over; an error rate, a throughput
   * and a count are quantities in themselves, and `(response_time)` beside one
   * of those states something false.
   */
  it('qualifies a time statistic with its family and leaves other metrics alone', () => {
    const run = { scope: 'run', targetName: null } as const;
    expect(describeSlaMeasurement({ ...run, family: 'response_time', metric: 'mean' })).toBe(
      'Whole-run mean response time',
    );
    expect(describeSlaMeasurement({ ...run, family: 'response_time', metric: 'throughput_rps' })).toBe(
      'Whole-run throughput',
    );
    expect(describeSlaMeasurement({ ...run, family: 'response_time', metric: 'count' })).toBe(
      'Whole-run request count',
    );
  });

  /** The group pair `engine.ts` files separately, and the reason the family
   *  could not simply be dropped: these two differ only by it. */
  it('keeps cumulative and duration apart for a group', () => {
    const cart = { scope: 'group', targetName: 'Cart', metric: 'p95' } as const;
    expect(describeSlaMeasurement({ ...cart, family: 'group_cumulated' })).toBe(
      'Cart p95 cumulative response time',
    );
    expect(describeSlaMeasurement({ ...cart, family: 'group_duration' })).toBe('Cart p95 duration');
  });

  /** A scope-mismatched rule still reads: a request rule with no target is
   *  authorable through the API (only the FORM prevents it), and it must not
   *  render as `undefined p95 response time`. */
  it('falls back to the whole run when a target is missing', () => {
    expect(
      describeSlaMeasurement({ scope: 'request', targetName: '  ', family: 'response_time', metric: 'p95' }),
    ).toBe('Whole-run p95 response time');
  });

  /** An unknown family contributes nothing rather than its own identifier —
   *  printing a word nobody can act on is what this function removes. */
  it('says nothing about a family it does not recognise', () => {
    expect(
      describeSlaMeasurement({ scope: 'run', targetName: null, family: 'future_family', metric: 'p95' }),
    ).toBe('Whole-run p95');
  });
});

/**
 * review.md's copy table, row 1. Its "current pattern" column holds the exact
 * string `packages/sla` writes into every assertion's message, and until this
 * function existed the run page rendered it in two places: the decision band,
 * at the largest size on the page, and the last column of the gates table,
 * beside three cells that had already been corrected.
 */
describe('describeSlaOutcome', () => {
  const errorRate = (outcome: 'passed' | 'failed', actualValue: number | null) => ({
    outcome,
    actualValue,
    rule: {
      scope: 'run' as const,
      targetName: null,
      family: 'response_time',
      metric: 'error_rate',
      comparator: 'lte' as const,
      threshold: 0.01,
    },
  });

  /** The row-1 case itself: a fraction on the wire, a percentage on both
   *  sides of the comparison, and the same formatter the Actual column beside
   *  it uses — which is why the precision is 4dp rather than the review's
   *  illustrative `2.23%`. Agreeing with the adjacent cell matters more than
   *  matching an example that elides its own digits with an ellipsis. */
  it('states the breach in the vocabulary the gates table already uses', () => {
    expect(describeSlaOutcome(errorRate('failed', 0.0223463687150838))).toBe(
      'Whole-run error rate 2.2346% exceeds the 1% limit.',
    );
  });

  /** The claim that actually matters, and the one a verbatim assertion above
   *  would not survive a rewording of: none of the stored schema reaches the
   *  reader. `(response_time)` is the half review.md 3 calls not merely
   *  unreadable but FALSE, and the raw fraction is the half review.md 1 calls
   *  a correctness defect. */
  it('lets no part of the stored expression through', () => {
    const sentence = describeSlaOutcome(errorRate('failed', 0.0223463687150838))!;
    expect(sentence).not.toMatch(/\(response_time\)/);
    expect(sentence).not.toMatch(/error_rate/);
    expect(sentence).not.toMatch(/of the run/);
    expect(sentence).not.toMatch(/0\.0223/);
  });

  /** A breached `gte` is under a MINIMUM, not over a limit. Calling both a
   *  limit would misdescribe every throughput or count rule in the product,
   *  which is why the comparator picks the noun as well as the verb. */
  it('calls a breached lower bound a minimum, never a limit', () => {
    const sentence = describeSlaOutcome({
      outcome: 'failed',
      actualValue: 41.5,
      rule: {
        scope: 'run',
        targetName: null,
        family: 'response_time',
        metric: 'throughput_rps',
        comparator: 'gte',
        threshold: 50,
      },
    })!;
    expect(sentence).toBe('Whole-run throughput 41.5/s is below the 50/s minimum.');
    expect(sentence).not.toMatch(/limit/);
  });

  /** Both outcomes are rendered, because this is the gates table's column for
   *  every row and not only the failing one — and a passing gate described as
   *  exceeding its limit would invert the verdict beside it. */
  it('describes a passing gate without saying it exceeded anything', () => {
    const sentence = describeSlaOutcome(errorRate('passed', 0.004))!;
    expect(sentence).toBe('Whole-run error rate 0.4% is within the 1% limit.');
    expect(sentence).not.toMatch(/exceeds/);
  });

  /** The one case the fields cannot describe. `not_applicable` has no actual,
   *  and the evaluator's own message says WHY nothing was checked ("3 of 20
   *  observations", "no response_time statistics for Search in this run") —
   *  reasons with no structured equivalent. Null tells the caller to keep it. */
  it('answers null when there is no measurement, so the caller keeps the reason', () => {
    expect(describeSlaOutcome({ ...errorRate('failed', null), outcome: 'not_applicable' })).toBeNull();
    expect(describeSlaOutcome(errorRate('failed', null))).toBeNull();
  });

  /** A scoped rule names its target, so a reader knows which request breached
   *  without going back to the table. Same describer the Measurement column
   *  uses, so the two cannot drift. */
  it('names the target of a scoped rule', () => {
    expect(
      describeSlaOutcome({
        outcome: 'failed',
        actualValue: 812,
        rule: {
          scope: 'request',
          targetName: 'Search',
          family: 'response_time',
          metric: 'p95',
          comparator: 'lte',
          threshold: 800,
        },
      }),
    ).toBe('Search p95 response time 812 ms exceeds the 800 ms limit.');
  });
});

