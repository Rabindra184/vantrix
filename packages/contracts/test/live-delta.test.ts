import { describe, expect, it } from 'vitest';
import { LiveDeltaSchema } from '../src/index.js';

const valid = {
  runId: '0f9b1d4e-1111-2222-3333-444455556666',
  seq: 1,
  bucketWidthMs: 1000,
  replacesSeries: false,
  summary: {
    count: 10, okCount: 9, koCount: 1, errorRate: 0.1,
    percentiles: { p50: 12, p95: 40 }, maxUsers: 3, durationMs: 5000,
  },
  responseTime: [
    { startOffsetMs: 0, startedCount: 5, endedCount: 5, okCount: 5, koCount: 0 },
  ],
  users: [{ scenario: 'checkout', startOffsetMs: 0, active: 3 }],
};

describe('LiveDeltaSchema', () => {
  it('accepts a well-formed delta', () => {
    expect(LiveDeltaSchema.parse(valid).seq).toBe(1);
  });

  it('rejects a negative or fractional seq — a consumer detects gaps with it', () => {
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: -1 })).toThrow();
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: 1.5 })).toThrow();
  });

  it('rejects a non-positive bucket width — it is a divisor downstream', () => {
    expect(() => LiveDeltaSchema.parse({ ...valid, bucketWidthMs: 0 })).toThrow();
  });

  it('requires replacesSeries rather than defaulting it', () => {
    const { replacesSeries: _omitted, ...without } = valid;
    expect(() => LiveDeltaSchema.parse(without)).toThrow();
  });

  it('accepts empty series — a tick with no new buckets is normal', () => {
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, responseTime: [], users: [] }),
    ).not.toThrow();
  });

  it('rejects errorRate outside [0, 1] — it is a ratio', () => {
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, summary: { ...valid.summary, errorRate: 1.5 } }),
    ).toThrow();
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, summary: { ...valid.summary, errorRate: -0.1 } }),
    ).toThrow();
  });

  it('rejects fractional counts — they match batch-wire constraints', () => {
    expect(() =>
      LiveDeltaSchema.parse({
        ...valid,
        responseTime: [
          { startOffsetMs: 0, startedCount: 5.5, endedCount: 5, okCount: 5, koCount: 0 },
        ],
      }),
    ).toThrow();
  });
});
