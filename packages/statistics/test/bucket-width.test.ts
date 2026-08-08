import { describe, expect, it } from 'vitest';
import { inferBucketWidthMs } from '../src/buckets.js';

describe('inferBucketWidthMs', () => {
  it('is the smallest positive gap, so a missing bucket cannot inflate it', () => {
    expect(inferBucketWidthMs([0, 1000, 2000, 5000])).toBe(1000);
  });
  it('reads a coalesced series correctly', () => {
    expect(inferBucketWidthMs([0, 4000, 8000])).toBe(4000);
  });
  it('falls back to one second when there is nothing to infer from', () => {
    expect(inferBucketWidthMs([])).toBe(1000);
    expect(inferBucketWidthMs([0])).toBe(1000);
  });
});
