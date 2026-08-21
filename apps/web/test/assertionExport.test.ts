import { describe, expect, it } from 'vitest';
import type { Assertion } from '@perfportal/contracts';
import { assertionsCsv } from '../src/routes/assertionExport';

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
    expect(csv).toContain('"failed","p95 of =Catalog (response_time) <= 300","450","\'=slow endpoint"');
  });
});
