import { describe, expect, it } from 'vitest';
import { ingestError } from '../src/errors.js';

describe('ingestError', () => {
  it('carries code, message, remediation and detail', () => {
    const e = ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
      message: 'Run contains 4812 distinct request names, exceeding the limit of 2000.',
      remediation: 'Request names appear to contain dynamic values. Parameterize them.',
      detail: { found: 4812, limit: 2000 },
    });
    expect(e.code).toBe('ENDPOINT_CARDINALITY_EXCEEDED');
    expect(e.remediation.length).toBeGreaterThan(0);
    expect(e.detail).toEqual({ found: 4812, limit: 2000 });
    expect(e).toBeInstanceOf(Error);
  });
});
