import { describe, expect, it } from 'vitest';
import type { Assertion } from '@perfportal/contracts';
import { assertionsCsv } from '../src/routes/assertionExport';
import { describeAssertionRule } from '../src/routes/assertions';

const ASSERTION: Assertion = {
  ruleId: '11111111-1111-4111-8111-111111111111',
  outcome: 'failed',
  actualValue: 450,
  message: '=slow endpoint',
  rule: {
    scope: 'request',
    targetName: '=Catalog',
    family: 'response_time',
    metric: 'p95',
    comparator: 'lte',
    threshold: 300,
  },
};

describe('assertionsCsv', () => {
  it('exports evaluated assertions and guards spreadsheet formulas', () => {
    const csv = assertionsCsv([ASSERTION]);

    expect(csv).toContain('"Outcome","Rule","Actual","Message"');
    expect(csv).toContain('"failed","p95 of =Catalog (response_time) \u2264 300","450","\'=slow endpoint"');
  });

  /**
   * The FILE and the SCREEN spell the rule the same way, because they call
   * the same function. It briefly did not: `describeRule` rendered `\u2264`
   * on the run page for its whole life, and the move into this module
   * silently rewrote the assertions table as `<=` — a copy change to the SLA
   * table shipped as a side effect of adding an export button.
   *
   * `downloadCsv` writes a BOM (`tables/csv.ts`), which is what makes a
   * non-ASCII comparator safe in the file, so there is no reason for the two
   * to differ and no second spelling to keep in step.
   */
  it('writes the rule exactly as the assertions table renders it', () => {
    expect(assertionsCsv([ASSERTION])).toContain(describeAssertionRule(ASSERTION.rule));
    expect(describeAssertionRule(ASSERTION.rule)).toContain('\u2264');
    expect(describeAssertionRule({ ...ASSERTION.rule, comparator: 'gte' })).toContain('\u2265');
  });
});
