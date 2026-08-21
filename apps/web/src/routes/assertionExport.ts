import type { Assertion } from '@perfportal/contracts';
import { toCsv } from '../tables/csv';

export function assertionsCsv(assertions: readonly Assertion[]): string {
  return toCsv(
    ['Outcome', 'Rule', 'Actual', 'Message'],
    assertions.map((assertion) => [
      assertion.outcome,
      describeAssertionRule(assertion.rule),
      assertion.actualValue === null ? '' : String(assertion.actualValue),
      assertion.message,
    ]),
  );
}

export function describeAssertionRule(rule: Assertion['rule']): string {
  const target = rule.targetName ?? 'the run';
  const comparator = rule.comparator === 'lte' ? '<=' : '>=';
  return `${rule.metric} of ${target} (${rule.family}) ${comparator} ${rule.threshold}`;
}
