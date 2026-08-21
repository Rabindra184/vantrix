import type { Assertion } from '@perfportal/contracts';
import { toCsv } from '../tables/csv';
import { describeAssertionRule } from './assertions';

/**
 * The assertions table as a file — the same four columns the table renders,
 * in the same order, described by the same `describeAssertionRule` the table
 * calls. A second spelling of the rule here would be a second thing to keep
 * in step with `packages/sla`'s own wording.
 *
 * `toCsv` guards spreadsheet formulas and quotes every cell; see
 * `tables/csv.ts` for why that guard is not optional on a payload whose
 * request names came from someone's simulation.
 */
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
