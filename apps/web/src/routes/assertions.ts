import type { Assertion } from '@perfportal/contracts';

/** One count per outcome, keyed by the outcome itself. */
export type AssertionCounts = Record<Assertion['outcome'], number>;

/**
 * The rule in the same words the evaluator used when it wrote the assertion's
 * message (`describe` in packages/sla/src/evaluate.ts). Restated here rather
 * than parsed back out of that message: the structured `rule` snapshot is the
 * fact, and a UI that read prose to recover data it already has would break
 * the day the prose was reworded.
 *
 * `≤`/`≥`, NOT `<=`/`>=`. The comparator is typeset, like every other
 * relation this product renders, and the same string is what
 * `assertionsCsv` writes — `downloadCsv` prepends a BOM precisely so a
 * non-ASCII character survives the trip into Excel, so there is no ASCII
 * fallback to keep in step. This shipped as ASCII for one commit while the
 * function was moving between modules, which changed the run page's
 * assertions table as a side effect of an export refactor.
 */
export function describeAssertionRule(rule: Assertion['rule']): string {
  const target = rule.targetName ?? 'the run';
  const comparator = rule.comparator === 'lte' ? '≤' : '≥';
  return `${rule.metric} of ${target} (${rule.family}) ${comparator} ${rule.threshold}`;
}

/**
 * ONE counter, for the two components that draw these three numbers.
 *
 * `RunDecisionBand` (the band under the header) and `RunDetail`'s SLA
 * evidence panel are the same three counts over the same array on the same
 * page. They were two reductions with two different key spellings —
 * `notApplicable` and `not_applicable` — so a fourth outcome added to
 * `AssertionOutcome` would have had to be found twice, with neither copy's
 * type error pointing at the other. Keyed by the outcome itself, a new
 * member is a type error in exactly one place.
 */
export function countAssertions(assertions: readonly Assertion[]): AssertionCounts {
  const counts: AssertionCounts = { passed: 0, failed: 0, not_applicable: 0 };
  for (const assertion of assertions) counts[assertion.outcome] += 1;
  return counts;
}

/**
 * The failure a reader should start from — `evaluate.ts` already emits
 * `failed` first, so this is the worst rule rather than merely an early one.
 */
export function firstFailedAssertion(
  assertions: readonly Assertion[],
): Assertion | undefined {
  return assertions.find((assertion) => assertion.outcome === 'failed');
}
