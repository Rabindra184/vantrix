import { describeSlaMeasurement, formatSlaValue } from '@perfportal/contracts';
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
  /* WITH ITS UNIT, and for `error_rate` that means a PERCENTAGE. The stored
     value is a fraction — `koCount / count`, which is what the evaluator
     compares — and every other surface in this product renders that same
     number as a percentage. A rule reading "≤ 0.01" beside tiles reading
     "2.68%" made the author the one person who had to convert, which is the
     trap `slaThresholdWarning` exists to catch. `formatSlaValue` is the
     single place that decision lives, so the table, the run page's evidence
     panel and the CSV export cannot drift apart. */
  return `${rule.metric} of ${target} (${rule.family}) ${comparator} ${formatSlaValue(rule.metric, rule.threshold)}`;
}

/**
 * The same rule, for a READER rather than for a machine.
 *
 * ═══ TWO DESCRIBERS ON PURPOSE, AND WHICH IS WHICH IS THE POINT ═══
 *
 * `describeAssertionRule` above is the PRECISE form — `metric of target
 * (family)` — every field of the stored snapshot, in the evaluator's own
 * vocabulary. The second review's finding 3 is that it was also the only form,
 * so `error_rate of the run (response_time)` was what the run page and the
 * rules table showed people.
 *
 * This one is what those surfaces render now. The precise form is not deleted:
 * it still writes the CSV, which is the artifact somebody attaches to a review
 * or diffs against another run, and where a field the UI folds away is exactly
 * what a reader has gone looking for. That is the finding's own "put the raw
 * expression in Details", with the export as the details.
 *
 * The BOUND is identical in both, through `formatSlaValue` — the one place that
 * decision lives, so a table cell and the exported row cannot disagree about
 * what `≤ 0.01` means.
 */
export function describeAssertionRuleForReader(rule: Assertion['rule']): string {
  const comparator = rule.comparator === 'lte' ? '≤' : '≥';
  return `${describeSlaMeasurement(rule)} ${comparator} ${formatSlaValue(rule.metric, rule.threshold)}`;
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
