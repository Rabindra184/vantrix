import { ingestError } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { isTransient } from '../src/pipeline/retry.js';

describe('isTransient', () => {
  it('treats a lost database connection as transient', () => {
    const e = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats object storage being unreachable as transient', () => {
    const e = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
    expect(isTransient(e)).toBe(true);
  });

  it('treats every IngestError as deterministic — retrying reaches the same conclusion', () => {
    for (const code of ['LOG_MALFORMED', 'BUNDLE_EMPTY', 'ENDPOINT_CARDINALITY_EXCEEDED'] as const) {
      expect(isTransient(ingestError(code, { message: 'm', remediation: 'r' }))).toBe(false);
    }
  });

  it('treats an unknown error as deterministic, so a bug does not burn three worker slots', () => {
    expect(isTransient(new TypeError('x is not a function'))).toBe(false);
  });
});
