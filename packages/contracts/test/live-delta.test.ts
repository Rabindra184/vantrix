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
      {
        startOffsetMs: 0, startedCount: 5, endedCount: 5, okCount: 5, koCount: 0,
        startedOkCount: 5, startedKoCount: 0,
        minMs: 10, maxMs: 40, meanMs: 22,
        percentiles: { p50: 20, p95: 38 },
        percentilesOk: { p50: 20, p95: 38 },
        percentilesKo: {},
      },
    ],
  },
  users: {
    widthMs: 1000,
    buckets: [{ scenario: 'checkout', startOffsetMs: 0, started: 3, ended: 0, active: 3 }],
  },
  errors: {
    rows: [{ message: 'connection reset', count: 1 }],
  },
  sla: {
    evaluated: 2,
    breaching: [
      { ruleId: 'rule-1', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 3000 },
    ],
  },
};

/**
 * A deep clone of `valid`, for cases that mutate a nested field (e.g.
 * `delete`ing a bucket property) -- `valid` itself is shared across every
 * case in this file via shallow spreads, so mutating it in place would leak
 * into unrelated tests.
 */
function validDelta(): typeof valid {
  return structuredClone(valid);
}

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it from the payload under test
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
          buckets: [{ scenario: 'checkout', startOffsetMs: 0.5, started: 3, ended: 0, active: 3 }],
        },
      }),
    ).toThrow();
  });

  it('rejects a response bucket missing its latency fields', () => {
    const delta = validDelta();
    delete (delta.responseTime.buckets[0] as Record<string, unknown>).percentiles;
    expect(() => LiveDeltaSchema.parse(delta)).toThrow();
  });

  /**
   * Whole-branch review, B1. A body written before `sla` existed is not
   * hypothetical during a rolling deploy: the browser drops every frame that
   * fails this schema (`apps/web/src/api/live.ts`'s `parseFrame`) and the
   * gateway forwards stored bodies without validating them, so a required
   * `sla` blanks the live page for the whole deploy window — and permanently
   * for a run that closed just before it, whose snapshot has no owner left to
   * republish.
   */
  it('accepts a delta written before sla existed, and reads it as nothing evaluated', () => {
    const delta = validDelta();
    delete (delta as Record<string, unknown>).sla;
    const parsed = LiveDeltaSchema.parse(delta);
    expect(parsed.sla).toEqual({ evaluated: 0, breaching: [] });
  });
});
