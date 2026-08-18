import { describe, expect, it } from 'vitest';
import { LiveDeltaSchema } from '../src/index.js';

const valid = {
  runId: '0f9b1d4e-1111-2222-3333-444455556666',
  seq: 1,
  summary: {
    count: 10, okCount: 9, koCount: 1, errorRate: 0.1,
    percentiles: { p50: 12, p95: 40 }, maxUsers: 3, durationMs: 5000,
  },
  responseTime: {
    widthMs: 1000,
    replaces: false,
    buckets: [
      { startOffsetMs: 0, startedCount: 5, endedCount: 5, okCount: 5, koCount: 0 },
    ],
  },
  users: {
    widthMs: 1000,
    buckets: [{ scenario: 'checkout', startOffsetMs: 0, active: 3 }],
  },
};

describe('LiveDeltaSchema', () => {
  it('accepts a well-formed delta', () => {
    expect(LiveDeltaSchema.parse(valid).seq).toBe(1);
  });

  it('rejects a negative or fractional seq — a consumer detects gaps with it', () => {
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: -1 })).toThrow();
    expect(() => LiveDeltaSchema.parse({ ...valid, seq: 1.5 })).toThrow();
  });

  it('rejects a non-positive response-time width — it is a divisor downstream', () => {
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, responseTime: { ...valid.responseTime, widthMs: 0 } }),
    ).toThrow();
  });

  it('rejects a non-positive users width — same divisor, same reason', () => {
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, users: { ...valid.users, widthMs: 0 } }),
    ).toThrow();
  });

  it('requires responseTime.replaces rather than defaulting it', () => {
    const { replaces: _omitted, ...restResponseTime } = valid.responseTime;
    expect(() =>
      LiveDeltaSchema.parse({ ...valid, responseTime: restResponseTime }),
    ).toThrow();
  });

  it('accepts empty series — a tick with no new buckets is normal', () => {
    expect(() =>
      LiveDeltaSchema.parse({
        ...valid,
        responseTime: { ...valid.responseTime, buckets: [] },
        users: { ...valid.users, buckets: [] },
      }),
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
        responseTime: {
          ...valid.responseTime,
          buckets: [
            { startOffsetMs: 0, startedCount: 5.5, endedCount: 5, okCount: 5, koCount: 0 },
          ],
        },
      }),
    ).toThrow();
  });

  it('rejects a fractional users[].startOffsetMs — it matches UsersResponseSchema', () => {
    expect(() =>
      LiveDeltaSchema.parse({
        ...valid,
        users: {
          ...valid.users,
          buckets: [{ scenario: 'checkout', startOffsetMs: 0.5, active: 3 }],
        },
      }),
    ).toThrow();
  });
});
