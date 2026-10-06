import { describe, expect, it } from 'vitest';
import { ActivityAttentionRowSchema, ActivityResponseSchema } from '../src/index.js';

/**
 * ═══ THE PORTFOLIO HOME'S ONE REQUEST ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * `GET /v1/activity` answers everything the home page draws: a seven-day
 * glance, a pass rate, a "running now" count, runs per project, the tests that
 * need attention and the last run. The shape is pinned here from both sides —
 * what a real answer looks like, and each bound a malformed one trips.
 */

const PROJECT = { slug: 'checkout', name: 'Checkout' };

const DAY = (date: string, total: number, successful: number, needsAttention: number) => ({
  date,
  total,
  successful,
  needsAttention,
});

const DAYS = [
  DAY('2026-10-01', 0, 0, 0),
  DAY('2026-10-02', 4, 3, 1),
  DAY('2026-10-03', 2, 2, 0),
  DAY('2026-10-04', 0, 0, 0),
  DAY('2026-10-05', 6, 4, 2),
  DAY('2026-10-06', 3, 1, 1),
  DAY('2026-10-07', 1, 0, 0),
];

const ATTENTION_ROW = {
  test: { slug: 'checkout-soak', name: 'Checkout soak' },
  project: PROJECT,
  run: {
    id: '22222222-2222-4222-8222-222222222222',
    runNumber: 12,
    status: 'complete',
    verdict: 'failed',
    startedAt: '2026-10-06T09:00:00.000Z',
    durationMs: 62_136,
    checks: { failed: 1, total: 3 },
    simulation: 'example.ParitySimulation',
  },
  reasons: ['gate_failed', 'assertion_failed'],
};

const RESPONSE = {
  window: { from: '2026-09-30T10:00:00.000Z', to: '2026-10-07T10:00:00.000Z', tz: 'Asia/Kolkata' },
  days: DAYS,
  runCount: 16,
  passRate: 0.75,
  running: 2,
  byProject: [{ project: PROJECT, runs: 16 }],
  attention: [ATTENTION_ROW],
  attentionTotal: 1,
  lastRun: {
    id: '33333333-3333-4333-8333-333333333333',
    runNumber: 12,
    test: { slug: 'checkout-soak', name: 'Checkout soak' },
    project: PROJECT,
    startedAt: '2026-10-06T09:00:00.000Z',
  },
};

describe('ActivityResponseSchema', () => {
  it('round-trips a full response unchanged', () => {
    expect(ActivityResponseSchema.parse(RESPONSE)).toEqual(RESPONSE);
  });

  /** A brand-new org: nothing ran, nothing to attend to, no last run. */
  it('accepts an empty org', () => {
    const empty = {
      window: RESPONSE.window,
      days: DAYS.map((d) => DAY(d.date, 0, 0, 0)),
      runCount: 0,
      passRate: null,
      running: 0,
      byProject: [],
      attention: [],
      attentionTotal: 0,
      lastRun: null,
    };
    const parsed = ActivityResponseSchema.parse(empty);
    expect(parsed.passRate).toBeNull();
    expect(parsed.lastRun).toBeNull();
  });

  it('accepts a null lastRun beside a populated week', () => {
    expect(ActivityResponseSchema.parse({ ...RESPONSE, lastRun: null }).lastRun).toBeNull();
  });

  it('echoes the time zone as a plain string', () => {
    const parsed = ActivityResponseSchema.parse({
      ...RESPONSE,
      window: { ...RESPONSE.window, tz: 'Asia/Kolkata' },
    });
    expect(parsed.window.tz).toBe('Asia/Kolkata');
  });

  describe('days', () => {
    it('refuses a week of six days', () => {
      expect(ActivityResponseSchema.safeParse({ ...RESPONSE, days: DAYS.slice(0, 6) }).success).toBe(
        false,
      );
    });

    it('refuses a week of eight days', () => {
      expect(
        ActivityResponseSchema.safeParse({
          ...RESPONSE,
          days: [...DAYS, DAY('2026-10-08', 0, 0, 0)],
        }).success,
      ).toBe(false);
    });

    it('refuses a date that is not a calendar day', () => {
      for (const date of ['2026-10-1', '10/01/2026', '2026-10-01T00:00:00Z', 'Mon']) {
        const days = [DAY(date, 0, 0, 0), ...DAYS.slice(1)];
        expect(ActivityResponseSchema.safeParse({ ...RESPONSE, days }).success).toBe(false);
      }
    });

    it('refuses a negative or fractional count', () => {
      for (const bad of [DAY('2026-10-01', -1, 0, 0), DAY('2026-10-01', 1.5, 0, 0)]) {
        expect(
          ActivityResponseSchema.safeParse({ ...RESPONSE, days: [bad, ...DAYS.slice(1)] }).success,
        ).toBe(false);
      }
    });
  });

  describe('passRate', () => {
    it('accepts the ends of its range', () => {
      for (const passRate of [0, 1]) {
        expect(ActivityResponseSchema.parse({ ...RESPONSE, passRate }).passRate).toBe(passRate);
      }
    });

    it('refuses a rate above 1, which is a percentage sent as a fraction', () => {
      expect(ActivityResponseSchema.safeParse({ ...RESPONSE, passRate: 1.2 }).success).toBe(false);
    });

    it('refuses a negative rate', () => {
      expect(ActivityResponseSchema.safeParse({ ...RESPONSE, passRate: -0.1 }).success).toBe(false);
    });
  });

  describe('byProject', () => {
    it('accepts five projects and refuses six', () => {
      const row = (n: number) => ({ project: { slug: `p${n}`, name: `P${n}` }, runs: n });
      const five = [1, 2, 3, 4, 5].map(row);
      expect(ActivityResponseSchema.safeParse({ ...RESPONSE, byProject: five }).success).toBe(true);
      expect(
        ActivityResponseSchema.safeParse({ ...RESPONSE, byProject: [...five, row(6)] }).success,
      ).toBe(false);
    });
  });

  describe('attention', () => {
    it('accepts twenty rows and refuses twenty-one', () => {
      const rows = (n: number) => Array.from({ length: n }, () => ATTENTION_ROW);
      expect(
        ActivityResponseSchema.safeParse({ ...RESPONSE, attention: rows(20), attentionTotal: 35 })
          .success,
      ).toBe(true);
      expect(
        ActivityResponseSchema.safeParse({ ...RESPONSE, attention: rows(21), attentionTotal: 21 })
          .success,
      ).toBe(false);
    });

    /** `attentionTotal` is the true count and the list is capped, so the total
     *  may exceed the rows sent. It must never be negative. */
    it('refuses a negative attentionTotal', () => {
      expect(ActivityResponseSchema.safeParse({ ...RESPONSE, attentionTotal: -1 }).success).toBe(
        false,
      );
    });

    it('requires attentionTotal, so a header can never count only the rows sent', () => {
      const withoutTotal: Record<string, unknown> = { ...RESPONSE };
      delete withoutTotal['attentionTotal'];
      expect(ActivityResponseSchema.safeParse(withoutTotal).success).toBe(false);
    });
  });

  describe('lastRun', () => {
    it('accepts a last run that belongs to no test', () => {
      const parsed = ActivityResponseSchema.parse({
        ...RESPONSE,
        lastRun: { ...RESPONSE.lastRun, test: null, runNumber: null },
      });
      expect(parsed.lastRun?.test).toBeNull();
      expect(parsed.lastRun?.runNumber).toBeNull();
    });
  });
});

describe('ActivityAttentionRowSchema', () => {
  it('accepts a row for a test, with its reasons', () => {
    expect(ActivityAttentionRowSchema.parse(ATTENTION_ROW)).toEqual(ATTENTION_ROW);
  });

  /**
   * A run that never parsed a header cannot be grouped under a test, so it is
   * its own row — the "stuck ingest" — and its simulation may be unknown too.
   */
  it('accepts a row with no test, no number, no duration, no checks and no simulation', () => {
    const stuck = {
      test: null,
      project: PROJECT,
      run: {
        id: ATTENTION_ROW.run.id,
        runNumber: null,
        status: 'failed',
        verdict: null,
        startedAt: '2026-10-06T09:00:00.000Z',
        durationMs: null,
        checks: null,
        simulation: null,
      },
      reasons: ['failed'],
    };
    expect(ActivityAttentionRowSchema.parse(stuck)).toEqual(stuck);
  });

  /** A row is listed BECAUSE a clause held, so a row naming none is a defect
   *  upstream that must fail loudly rather than draw an unexplained line. */
  it('refuses a row with no reason', () => {
    expect(ActivityAttentionRowSchema.safeParse({ ...ATTENTION_ROW, reasons: [] }).success).toBe(
      false,
    );
  });

  it('refuses a reason that is not one of the four', () => {
    expect(
      ActivityAttentionRowSchema.safeParse({ ...ATTENTION_ROW, reasons: ['slow'] }).success,
    ).toBe(false);
  });

  it('refuses a run id that is not a uuid', () => {
    expect(
      ActivityAttentionRowSchema.safeParse({
        ...ATTENTION_ROW,
        run: { ...ATTENTION_ROW.run, id: 'not-a-uuid' },
      }).success,
    ).toBe(false);
  });

  it('refuses a status the run lifecycle does not have', () => {
    expect(
      ActivityAttentionRowSchema.safeParse({
        ...ATTENTION_ROW,
        run: { ...ATTENTION_ROW.run, status: 'stuck' },
      }).success,
    ).toBe(false);
  });

  it('refuses a run number of zero, which is no test number at all', () => {
    expect(
      ActivityAttentionRowSchema.safeParse({
        ...ATTENTION_ROW,
        run: { ...ATTENTION_ROW.run, runNumber: 0 },
      }).success,
    ).toBe(false);
  });
});
