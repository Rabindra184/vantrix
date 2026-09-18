import { z } from 'zod';

/**
 * SLA rules, as a reader authors them.
 *
 * The evaluator's own view of a rule already exists — `AssertionSchema.rule`
 * in `run.ts` is the six fields it needs to judge a run. This module is the
 * other half: what a person may WRITE, which is a wider shape (a rule has a
 * name and a history) and a much narrower validation.
 */

export const SLA_RULE_SCOPES = ['run', 'scenario', 'group', 'request'] as const;
export type SlaRuleScope = (typeof SLA_RULE_SCOPES)[number];

export const SLA_RULE_FAMILIES = [
  'response_time',
  'latency',
  'group_cumulated',
  'group_duration',
] as const;
export type SlaRuleFamily = (typeof SLA_RULE_FAMILIES)[number];

export const SLA_RULE_COMPARATORS = ['lte', 'gte'] as const;
export type SlaRuleComparator = (typeof SLA_RULE_COMPARATORS)[number];

/**
 * The non-percentile metrics `resolveMetric` knows, in its own order.
 *
 * MIRRORED FROM `packages/sla/src/metrics.ts`'s `SCALARS`, and
 * `packages/contracts/test/rules.test.ts` fails if the two ever disagree —
 * the same mirror discipline `palette.test.ts` enforces between `theme.ts`
 * and `tokens.css`, and for the same reason: two hand-maintained copies of one
 * list is the arrangement that drifts.
 *
 * `error_rate` and `throughput_rps` are in here, and their presence is worth
 * noticing: a gate on the error rate needs no new rule FAMILY. `family`
 * selects which stat row to read and `metric` selects the value out of it, so
 * "error rate under 1%" is `family: 'response_time', metric: 'error_rate'`.
 */
export const SLA_METRIC_SCALARS = [
  'count',
  'mean',
  'min',
  'max',
  'stddev',
  'error_rate',
  'throughput_rps',
] as const;
export type SlaMetricScalar = (typeof SLA_METRIC_SCALARS)[number];

/** `p` followed by a number — the shape `resolveMetric` matches. */
const PERCENTILE = /^p(\d+(?:\.\d+)?)$/;

/**
 * Whether the evaluator could resolve this metric name against a stat row.
 *
 * EXPORTED so the browser can decide before a round trip, and so the test that
 * pins this against `resolveMetric` has one function to check rather than a
 * regex copied into three files.
 *
 * The bound is STRICT on both ends, matching `metrics.ts:52`'s
 * `p > 0 && p < 100`. `p0` and `p100` are not percentiles the sketch can
 * answer — they are the min and the max, which have their own scalar names.
 */
export function isResolvableSlaMetric(metric: string): boolean {
  if ((SLA_METRIC_SCALARS as readonly string[]).includes(metric)) return true;
  const match = PERCENTILE.exec(metric);
  if (!match?.[1]) return false;
  const p = Number(match[1]);
  return p > 0 && p < 100;
}

/**
 * What a threshold for a given metric is MEASURED IN.
 *
 * ═══ WHY A MACHINE-READABLE UNIT AND NOT JUST PROSE ═══
 *
 * `error_rate` is a FRACTION — `koCount / count`, so 0.17753 — while every
 * other surface in the product renders that same number as `17.75%`. An author
 * who reads "error rate" on a percentage-shaped screen and types `1` meaning
 * "one percent" gets `≤ 1`, which is `≤ 100%`, which no run can ever breach.
 *
 * Nothing catches it. The rule is valid, the metric resolves, the gate
 * evaluates, and it reports PASSED forever — configured protection that
 * cannot fire. That is the same failure shape as a rule authored as `p95th`,
 * which `SlaMetricSchema` above already refuses for exactly this reason: the
 * engine is right to degrade, and the author is the one who must be told.
 *
 * A schema cannot refuse `≤ 1` — 100% is a legal, if pointless, bound — so the
 * defence has to be telling the author the unit BEFORE they type. This makes
 * that a fact the form can read rather than a sentence somebody has to
 * remember, and it generalises: every metric gets a label, so no future one
 * repeats the trap by being added without a note.
 */
export const SLA_METRIC_UNITS = {
  count: 'requests',
  mean: 'ms',
  min: 'ms',
  max: 'ms',
  stddev: 'ms',
  error_rate: 'fraction',
  throughput_rps: 'req/s',
} as const satisfies Record<SlaMetricScalar, SlaMetricUnit>;

export type SlaMetricUnit = 'ms' | 'fraction' | 'requests' | 'req/s';

/**
 * The unit for any metric the evaluator can resolve, or null for one it cannot.
 *
 * Percentiles fall through to milliseconds: `resolveMetric` answers them from
 * the response-time sketch, so `p95` is the same kind of quantity as `mean`.
 */
export function slaMetricUnit(metric: string): SlaMetricUnit | null {
  const scalar = (SLA_METRIC_UNITS as Record<string, SlaMetricUnit | undefined>)[metric];
  if (scalar !== undefined) return scalar;
  return isResolvableSlaMetric(metric) ? 'ms' : null;
}

/**
 * A threshold that is legal but almost certainly not what the author meant.
 *
 * Only `fraction` metrics have one: a bound above 1 is 100%-or-more, which for
 * `error_rate` is a gate no run can breach. Returns null when there is nothing
 * to say, so a caller renders a warning only when there is a real one.
 */
export function slaThresholdWarning(metric: string, threshold: number): string | null {
  if (slaMetricUnit(metric) !== 'fraction') return null;
  if (!Number.isFinite(threshold) || threshold <= 1) return null;
  return `${metric} is a fraction, so ${threshold} means ${threshold * 100}% — no run can breach it. Use ${threshold / 100} for ${threshold}%.`;
}

/**
 * A metric name the evaluator can actually resolve.
 *
 * THIS IS THE POINT OF THE WHOLE WRITE PATH. `resolveMetric` returns `null`
 * for a name it does not know, and `evaluateRules` turns that into
 * `not_applicable` rather than an error — correctly, because a rule may
 * legitimately target a metric a given run has no data for. The cost is that
 * a rule authored as `p95th` instead of `p95` renders "not checked" on every
 * run forever while looking like configured protection. The engine is right to
 * degrade; the author is the one who must be told.
 */
export const SlaMetricSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isResolvableSlaMetric, {
    message:
      'must be one of count, mean, min, max, stddev, error_rate, throughput_rps, or a percentile like p95 or p99.9',
  });

/**
 * `run` scope reads the run's own aggregate row and takes no target; every
 * other scope matches a target BY NAME, and a null one matches nothing.
 *
 * Enforced as a `.refine()` on the object rather than two optional fields,
 * because it is a relationship between them — the same shape
 * `ProjectSettingsSchema` uses for `lowerMs < higherMs`.
 */
const targetMatchesScope = <T extends { scope: string; targetName: string | null }>(
  value: T,
): boolean => (value.scope === 'run' ? value.targetName === null : (value.targetName ?? '') !== '');

const TARGET_MESSAGE =
  'a run-scoped rule takes no target name; a scenario, group or request rule needs one';

export const CreateSlaRuleRequestSchema = z
  .object({
    /** Optional — an unnamed rule is described by its own expression. */
    name: z.string().trim().min(1).max(120).nullable().optional(),
    /**
     * WHAT THIS RULE APPLIES TO. Absent or null makes a PROJECT-WIDE rule —
     * every run of every test, which is what every rule meant before this
     * field existed, so an existing client's body keeps its exact meaning.
     * A test slug narrows it to that test's runs.
     *
     * ═══ NOT CALLED A SCOPE, AND THAT IS DELIBERATE ═══
     *
     * `scope` right below already means run/scenario/group/request — what the
     * rule MEASURES — and `ProjectScope` in the repositories means the tenant.
     * A third sense of the word is how somebody authors a gate on the wrong
     * thing while reading their own configuration as correct.
     *
     * A SLUG, not an id, because a slug is what a URL and a human both carry;
     * the server resolves it within THIS project, which is the only scope in
     * which a test slug is unique. An unknown slug is a 404, never a silently
     * project-wide rule.
     */
    testSlug: z.string().trim().min(1).max(200).nullable().optional(),
    scope: z.enum(SLA_RULE_SCOPES),
    targetName: z.string().trim().min(1).max(500).nullable(),
    family: z.enum(SLA_RULE_FAMILIES),
    metric: SlaMetricSchema,
    comparator: z.enum(SLA_RULE_COMPARATORS),
    /**
     * Finite, and NOT further bounded. A threshold's sane range depends
     * entirely on its metric — 800 is a reasonable p95 in milliseconds and an
     * absurd error rate — and a bound that has to know the metric to be right
     * is a bound this schema cannot express. `NaN` and `Infinity` are rejected
     * because no comparison against them can ever pass.
     */
    threshold: z.number().finite(),
  })
  .strict()
  .refine(targetMatchesScope, { message: TARGET_MESSAGE, path: ['targetName'] });
export type CreateSlaRuleRequest = z.infer<typeof CreateSlaRuleRequestSchema>;

/**
 * WHAT A RULE MAY BECOME, which is deliberately not everything it is.
 *
 * `scope`, `family`, `metric` and `comparator` are absent, and their absence
 * is the design: a rule's identity is WHAT it measures. Change that and every
 * assertion already recorded against this rule id refers to something the rule
 * never was — `run_assertion` keeps a `ruleSnapshot` precisely so history
 * survives a threshold change, and it cannot help with a rule that silently
 * became a different measurement. Retuning is an edit; re-aiming is a new rule.
 *
 * The `.refine()` makes an empty patch a 400 rather than a write that does
 * nothing and reports success.
 */
export const UpdateSlaRuleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    threshold: z.number().finite().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'send at least one of name, threshold or enabled',
  });
export type UpdateSlaRuleRequest = z.infer<typeof UpdateSlaRuleRequestSchema>;

/**
 * A rule as the API returns it.
 *
 * `scope`, `family` and `comparator` are `z.string()`, NOT the enums the
 * request uses, and that asymmetry is deliberate — `TokenSummarySchema`
 * records the argument. A response schema echoes whatever is stored, and the
 * column is `text`: one row written before an enum narrowed (or by a fixture,
 * or by a future family this build does not know) would otherwise fail
 * validation and 500 the entire list rather than rendering as itself.
 */
export const SlaRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  /**
   * The test this rule applies to, or null for a project-wide one.
   *
   * The whole ref rather than a slug: a list has to NAME what each rule
   * judges, and re-fetching the test list to turn slugs into names would make
   * a rules table depend on a second request to be readable.
   *
   * NULLABLE AND OPTIONAL, the same pairing `RunResponse.test` documents:
   * `null` is a genuine project-wide rule, `undefined` is a response from an
   * API pod that predates the field, and a required field would blank the
   * rules panel for a whole rolling deploy.
   */
  test: z
    .object({ id: z.string().uuid(), slug: z.string(), name: z.string() })
    .nullable()
    .optional(),
  scope: z.string(),
  targetName: z.string().nullable(),
  family: z.string(),
  metric: z.string(),
  comparator: z.string(),
  threshold: z.number(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SlaRule = z.infer<typeof SlaRuleSchema>;

export const SlaRuleListResponseSchema = z.object({ rules: z.array(SlaRuleSchema) });
export type SlaRuleListResponse = z.infer<typeof SlaRuleListResponseSchema>;

/**
 * A threshold as an author should read it, with its unit.
 *
 * ═══ THE STORED VALUE IS A FRACTION AND THE READ VALUE IS A PERCENTAGE ═══
 *
 * `error_rate` is `koCount / count`, so the evaluator compares against 0.0268
 * and every OTHER surface in this product renders that same number as 17.75%
 * or 2.68%. An author authoring a gate had to be the one place that converted,
 * and the trap this file already carries a warning for is what happens when
 * they do not: `1` meaning "one percent" is a legal, resolvable, permanently
 * PASSING rule of ≤ 100%.
 *
 * So the conversion moves out of the author's head. The form takes a
 * percentage, `percentToFraction` stores a fraction, and this renders a stored
 * fraction back as a percentage — the same number the tiles, the statistics
 * table and the errors tab all show.
 *
 * NOTHING ABOUT THE WIRE OR THE EVALUATOR CHANGES. The contract still carries
 * a fraction, older rules still read correctly, and a run's verdict is
 * computed from exactly the value it always was.
 */
/**
 * A rule's value, in the unit the rest of the product shows it in.
 *
 * ═══ ONE FUNCTION FOR THE LIMIT AND THE ACTUAL, BECAUSE THEY ARE ONE
 *     QUANTITY ═══
 *
 * This was `formatSlaThreshold`, and the name was the defect. An assertion
 * displays a bound AND the measurement that met or missed it -- the same
 * metric, the same unit, necessarily the same rendering -- but only the bound
 * went through here. The actual was printed raw, so a failed error-rate rule
 * read `Actual 0.02` beside `Limit ≤ 1%`: a fraction next to a percentage, and
 * the number that BREACHED the gate looked like half of it.
 *
 * The evidence TABLE was worse, printing `assertion.actualValue` with no
 * formatting at all -- `0.0223463687150838`, floating-point serialisation in a
 * column a reader is asked to compare against `1%`.
 *
 * So the name says `Value`, and the two callers that must never disagree call
 * the same function. A separate `formatSlaActual` would be the drift this
 * repo has already paid for between a form and the row it creates.
 */
export function formatSlaValue(metric: string, value: number): string {
  const unit = slaMetricUnit(metric);
  if (unit === 'fraction') return `${fractionToPercent(value)}%`;
  if (unit === 'ms') return `${value} ms`;
  if (unit === 'req/s') return `${value}/s`;
  if (unit === 'requests') return `${value}`;
  return `${value}`;
}

/**
 * ROUNDED, because floating point makes the naive form ugly and wrong-looking.
 * `0.07 * 100` is `7.000000000000001` in IEEE 754, and a gate reading
 * "≤ 7.000000000000001%" invites the reader to wonder what the extra digits
 * mean. Four decimal places keeps 0.0001% — finer than any run this product
 * measures can resolve — and discards the noise below it.
 */
export function fractionToPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return fraction;
  return Number((fraction * 100).toFixed(4));
}

/** The inverse, for the authoring form. Same rounding argument. */
export function percentToFraction(percent: number): number {
  if (!Number.isFinite(percent)) return percent;
  return Number((percent / 100).toFixed(8));
}

/* ======================================================================== *
 * READING A RULE BACK IN WORDS (review M17)
 * ======================================================================== */

/**
 * A metric as a reader says it, rather than as the evaluator spells it.
 *
 * ═══ WHY THIS LIVES BESIDE THE UNITS AND NOT IN THE FORM ═══
 *
 * `slaMetricUnit` already argues that the unit has to be a fact code can read
 * rather than a sentence somebody remembers, because the one time it was prose
 * it cost a permanently-passing gate. The NAME has exactly the same property:
 * `error_rate` and `throughput_rps` are column names, and the review's
 * objection to them is the same objection — the form exposes the data model.
 *
 * Percentiles are derived rather than listed, because the evaluator resolves
 * ANY percentile in (0, 100) and a closed map would silently fall back to the
 * raw key for the p99.95 somebody legitimately configured.
 *
 * Returns the metric unchanged when it resolves to nothing. That is the honest
 * answer for a typo — inventing a label for `p95th` would dress up a string
 * the engine is about to refuse.
 */
export function slaMetricLabel(metric: string): string {
  const scalars: Record<SlaMetricScalar, string> = {
    count: 'request count',
    mean: 'mean response time',
    min: 'fastest response',
    max: 'slowest response',
    stddev: 'response time spread',
    error_rate: 'error rate',
    throughput_rps: 'throughput',
  };
  const scalar = (scalars as Record<string, string | undefined>)[metric];
  if (scalar !== undefined) return scalar;

  const match = PERCENTILE.exec(metric);
  if (match?.[1] !== undefined && isResolvableSlaMetric(metric)) {
    return `${ordinal(match[1])} percentile response time`;
  }
  return metric;
}

/** `95` → `95th`, `99.9` → `99.9th`. The run page's own rule, restated. */
function ordinal(digits: string): string {
  const n = Number(digits);
  // A fraction has no ordinal form, and "99.9th" is how they are conventionally
  // written — the same decision `StatisticsTable.percentileColumnLabel` makes.
  if (!Number.isInteger(n)) return `${digits}th`;
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** What a rule judges: the whole run, or one named thing inside it. */
export interface SlaRuleSubject {
  readonly scope: SlaRuleScope;
  readonly targetName: string | null;
}

/**
 * The rule as a sentence — review M17's "Search p95 must be ≤ 800 ms."
 *
 * ═══ WHAT THIS IS FOR, AND IT IS NOT DECORATION ═══
 *
 * The form asks for Applies-to, Scope, Target, Family, Metric, Comparator and
 * Threshold as seven independent controls, each individually reasonable and
 * none of which states what the reader has actually built. Two of those
 * controls are the ones that go wrong in silence: a metric whose unit the
 * author misjudged (the fraction trap this file already carries a warning
 * for), and a comparator pointing the wrong way — `throughput ≤ 50/s` is a
 * legal rule that fails a run for being FAST.
 *
 * A sentence is the only rendering in which both are obvious, because it reads
 * as a claim that is either true or absurd.
 *
 * ═══ IT TAKES THE STORED THRESHOLD, NOT THE TYPED ONE ═══
 *
 * `formatSlaValue` converts a fraction back to the percentage every other
 * surface shows, so the caller must pass what would be SENT — the same value
 * the rules table renders. A preview built from the raw input would agree with
 * the form and disagree with the row it is about to create, which is the one
 * way a preview can be worse than nothing.
 */
export function describeSlaRule(rule: {
  readonly scope: SlaRuleScope;
  readonly targetName: string | null;
  readonly metric: string;
  readonly comparator: SlaRuleComparator;
  readonly threshold: number;
}): string {
  const subject =
    rule.scope === 'run'
      ? 'The whole run'
      : rule.targetName === null || rule.targetName.trim() === ''
        ? `Every ${rule.scope}`
        : `${rule.scope === 'request' ? 'Request' : rule.scope === 'group' ? 'Group' : 'Scenario'} “${rule.targetName.trim()}”`;

  const bound = rule.comparator === 'lte' ? 'at most' : 'at least';
  return `${subject}: ${slaMetricLabel(rule.metric)} must be ${bound} ${formatSlaValue(rule.metric, rule.threshold)}.`;
}
