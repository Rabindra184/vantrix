import { describe, expect, it } from 'vitest';
import {
  FigureMismatchSchema,
  GatlingDifferenceSchema,
  RunIdentitySchema,
  RunProcessingSchema,
  RunResponseSchema,
  VerificationSchema,
  VerificationSummarySchema,
} from '../src/index.js';

const base = {
  id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'passed',
  tool: 'gatling',
  startedAt: '2026-08-15T10:00:00.000Z',
  assertions: [],
};

/** The shape `VerificationRepository` stores: a table's figure, both values. */
const mismatch = {
  scope: 'request',
  name: 'Search',
  family: 'response_time',
  population: 'all',
  bucket: null,
  table: 'run_stat',
  figure: 'p95',
  stored: 812,
  recomputed: 790,
};

describe('VerificationSummarySchema', () => {
  it('accepts the four statuses, with a reason only an unverifiable run carries', () => {
    for (const status of ['pending', 'verified', 'mismatch', 'unverifiable'] as const) {
      expect(VerificationSummarySchema.parse({ status, reason: null })).toEqual({ status, reason: null });
    }
    for (const reason of ['raw_log_deleted', 'raw_log_missing', 'raw_log_unreadable', 'not_exact'] as const) {
      expect(VerificationSummarySchema.parse({ status: 'unverifiable', reason }).reason).toBe(reason);
    }
  });

  it('refuses a status or reason outside its words', () => {
    expect(VerificationSummarySchema.safeParse({ status: 'checked', reason: null }).success).toBe(false);
    expect(VerificationSummarySchema.safeParse({ status: 'unverifiable', reason: 'lost' }).success).toBe(false);
    expect(VerificationSummarySchema.safeParse({ status: 'verified' }).success).toBe(false);
  });
});

/**
 * `verification` on the run identity. OPTIONAL for the rolling-deploy reason
 * every identity field gives, and NULLABLE because a run with no row yet —
 * not verifiable, or not reached — is a different fact from a pending one.
 */
describe('RunIdentitySchema.verification', () => {
  it('accepts an identity without it (rolling deploy), with null, and with a summary', () => {
    expect(RunIdentitySchema.parse(base).verification).toBeUndefined();
    expect(RunIdentitySchema.parse({ ...base, verification: null }).verification).toBeNull();
    const summary = { status: 'unverifiable', reason: 'raw_log_deleted' };
    expect(RunIdentitySchema.parse({ ...base, verification: summary }).verification).toEqual(summary);
  });

  it('reaches both bodies a run is read through', () => {
    const summary = { status: 'verified', reason: null };
    expect(RunResponseSchema.parse({ ...base, verification: summary }).verification).toEqual(summary);
    expect(
      RunProcessingSchema.parse({ id: base.id, status: 'parsing', statusUrl: '/v1/runs/x', verification: summary }).verification,
    ).toEqual(summary);
  });

  it('refuses a summary that is not one', () => {
    expect(RunIdentitySchema.safeParse({ ...base, verification: { status: 'ok', reason: null } }).success).toBe(false);
  });
});

describe('FigureMismatchSchema', () => {
  it('accepts the stored shape, a bucket figure and a string-valued one', () => {
    expect(FigureMismatchSchema.parse(mismatch)).toEqual(mismatch);
    const bucket = { ...mismatch, table: 'run_series_bucket', population: 'ok', bucket: 4000, figure: 'ok_count', stored: 3, recomputed: 4 };
    expect(FigureMismatchSchema.parse(bucket)).toEqual(bucket);
    // An error-table mismatch carries the message in `family` and a whole
    // missing row as figure 'row' with a null on one side.
    const row = { ...mismatch, table: 'run_error', family: 'j.n.ConnectException: refused', population: null, figure: 'row', stored: null, recomputed: 'present' };
    expect(FigureMismatchSchema.parse(row)).toEqual(row);
  });

  it('refuses a table outside the six and a population outside the three', () => {
    expect(FigureMismatchSchema.safeParse({ ...mismatch, table: 'run_assertion' }).success).toBe(false);
    expect(FigureMismatchSchema.safeParse({ ...mismatch, population: 'failed' }).success).toBe(false);
  });
});

describe('VerificationSchema', () => {
  const verification = {
    status: 'mismatch',
    reason: null,
    checkedAt: '2026-10-16T09:00:00.000Z',
    verifierVersion: 1,
    figuresChecked: 4120,
    mismatches: [mismatch],
    rawLogRetainedUntil: '2027-01-14',
    rawLogDeleted: false,
  };

  it('accepts a checked run, and a pending one with nothing recorded', () => {
    expect(VerificationSchema.parse(verification)).toEqual(verification);
    const pending = {
      status: 'pending',
      reason: null,
      checkedAt: null,
      verifierVersion: null,
      figuresChecked: 0,
      mismatches: [],
      rawLogRetainedUntil: null,
      rawLogDeleted: false,
    };
    expect(VerificationSchema.parse(pending)).toEqual(pending);
  });

  it('takes the retention as a calendar date, never an instant', () => {
    expect(VerificationSchema.safeParse({ ...verification, rawLogRetainedUntil: '2027-01-14T00:00:00.000Z' }).success).toBe(false);
  });

  it('refuses a negative figure count and a missing deleted flag', () => {
    expect(VerificationSchema.safeParse({ ...verification, figuresChecked: -1 }).success).toBe(false);
    const rest: Record<string, unknown> = { ...verification };
    delete rest.rawLogDeleted;
    expect(VerificationSchema.safeParse(rest).success).toBe(false);
  });
});

/**
 * ═══ ONE PERCENTILE WHERE GATLING'S REPORT DIFFERS FROM THE EXACT VALUE ═══
 *
 * The shape `@perfportal/verify` builds (GatlingDifference in
 * gatling-method.ts), restated: contracts cannot import that package. A RANGE,
 * because Gatling's own estimate changes between two reports of one log.
 */
describe('GatlingDifferenceSchema', () => {
  const difference = {
    scope: 'request',
    name: 'Cart/Add To Cart',
    population: 'all',
    figure: 'p95',
    gatlingLow: 2389,
    gatlingHigh: 3410,
    exact: 2458,
  };

  it('accepts the stored shape, and a range of one value', () => {
    expect(GatlingDifferenceSchema.parse(difference)).toEqual(difference);
    const single = { ...difference, scope: 'run', name: '', population: 'ko', figure: 'p99', gatlingLow: 0, gatlingHigh: 0 };
    expect(GatlingDifferenceSchema.parse(single)).toEqual(single);
    // group is a scope Gatling's report has a row for; p50 and p75 its other figures.
    expect(GatlingDifferenceSchema.safeParse({ ...difference, scope: 'group', figure: 'p50' }).success).toBe(true);
    expect(GatlingDifferenceSchema.safeParse({ ...difference, population: 'ok', figure: 'p75' }).success).toBe(true);
  });

  it('refuses a range whose low end is above its high end', () => {
    expect(GatlingDifferenceSchema.safeParse({ ...difference, gatlingLow: 3411, gatlingHigh: 3410 }).success).toBe(false);
  });

  it('refuses a fraction or a negative millisecond count, on every side', () => {
    for (const field of ['gatlingLow', 'gatlingHigh', 'exact'] as const) {
      expect(GatlingDifferenceSchema.safeParse({ ...difference, [field]: 2400.5 }).success, field).toBe(false);
      expect(GatlingDifferenceSchema.safeParse({ ...difference, gatlingLow: -1, [field]: -1 }).success, field).toBe(false);
    }
  });

  /**
   * On its own: the case above makes gatlingLow -1 beside each field, so it
   * would still pass if `exact` lost its nonnegative() — a negative exact with
   * a valid range is refused here by `exact` alone.
   */
  it('refuses a negative exact beside a valid range', () => {
    expect(GatlingDifferenceSchema.safeParse({ ...difference, exact: -1 }).success).toBe(false);
  });

  it('refuses a scope, population or figure outside its words', () => {
    expect(GatlingDifferenceSchema.safeParse({ ...difference, scope: 'scenario' }).success).toBe(false);
    expect(GatlingDifferenceSchema.safeParse({ ...difference, population: 'failed' }).success).toBe(false);
    expect(GatlingDifferenceSchema.safeParse({ ...difference, figure: 'p99.9' }).success).toBe(false);
    expect(GatlingDifferenceSchema.safeParse({ ...difference, figure: 'max' }).success).toBe(false);
  });
});

/**
 * The two Gatling fields on the record are OPTIONAL — an API pod older than
 * them sends neither — and `gatlingReplays` is null when the method did not
 * run, the seed count when it did.
 */
describe('VerificationSchema: the Gatling differences', () => {
  const verification = {
    status: 'verified',
    reason: null,
    checkedAt: '2026-10-21T09:00:00.000Z',
    verifierVersion: 2,
    figuresChecked: 4120,
    mismatches: [],
    rawLogRetainedUntil: '2027-01-14',
    rawLogDeleted: false,
  };
  const difference = {
    scope: 'run', name: '', population: 'all', figure: 'p99', gatlingLow: 2349, gatlingHigh: 2412, exact: 2401,
  };

  it('accepts a record without either field (rolling deploy), with null replays, and with both', () => {
    const absent = VerificationSchema.parse(verification);
    expect(absent.gatlingDifferences).toBeUndefined();
    expect(absent.gatlingReplays).toBeUndefined();
    expect(VerificationSchema.parse({ ...verification, gatlingDifferences: [], gatlingReplays: null })).toEqual({
      ...verification, gatlingDifferences: [], gatlingReplays: null,
    });
    const full = { ...verification, gatlingDifferences: [difference], gatlingReplays: 16 };
    expect(VerificationSchema.parse(full)).toEqual(full);
  });

  it('refuses a difference the difference schema refuses, and a replay count that is not a positive integer', () => {
    expect(
      VerificationSchema.safeParse({ ...verification, gatlingDifferences: [{ ...difference, gatlingLow: 2413 }] }).success,
    ).toBe(false);
    for (const replays of [0, -1, 1.5]) {
      expect(VerificationSchema.safeParse({ ...verification, gatlingReplays: replays }).success, String(replays)).toBe(false);
    }
  });
});
