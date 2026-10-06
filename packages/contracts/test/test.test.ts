import { describe, expect, it } from 'vitest';
import {
  OrgTestListResponseSchema,
  TestListResponseSchema,
  TestSummarySchema,
  UpdateTestRequestSchema,
} from '../src/test.js';

const SUMMARY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'example-paritysimulation',
  name: 'example.ParitySimulation',
  simulationClass: 'example.ParitySimulation',
  description: null,
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  runCount: 3,
  latestRun: { id: '22222222-2222-4222-8222-222222222222', status: 'complete', verdict: 'passed' },
};

describe('TestSummarySchema', () => {
  it('accepts a test with runs', () => {
    expect(TestSummarySchema.parse(SUMMARY).runCount).toBe(3);
  });

  /**
   * A test with no runs is reachable: every run of it can be deleted, and a
   * row whose runs are gone is still a test somebody named. `latestRun: null`
   * with `runCount: 0` is the honest shape, not an error.
   */
  it('accepts a test whose runs have all gone', () => {
    const parsed = TestSummarySchema.parse({ ...SUMMARY, runCount: 0, latestRun: null });
    expect(parsed.latestRun).toBeNull();
  });

  /**
   * ═══ STATUS RIDES ALONG WITH VERDICT, AND THE NULL IS THE POINT ═══
   *
   * A pending run has no verdict yet. A consumer that read `verdict` alone
   * would render "not evaluated" for a run nobody has measured — the same
   * overclaim `ProjectSummary` carries this pairing to prevent.
   */
  it('carries a running run as status with a null verdict, not as a verdict', () => {
    const parsed = TestSummarySchema.parse({
      ...SUMMARY,
      latestRun: { id: SUMMARY.latestRun.id, status: 'running', verdict: null },
    });
    expect(parsed.latestRun?.status).toBe('running');
    expect(parsed.latestRun?.verdict).toBeNull();
  });

  it('rejects a negative run count, which no query can produce', () => {
    expect(() => TestSummarySchema.parse({ ...SUMMARY, runCount: -1 })).toThrow();
  });

  /**
   * ═══ THE RESPONSE IS LOOSE WHERE THE REQUEST IS STRICT ═══
   *
   * `simulationClass` is a plain string on the way out. A stored row that
   * somehow fails a tighter shape must not 500 a list the reader is entitled
   * to see — the stance `RunListResponse` already takes on status.
   */
  it('does not second-guess a stored simulation class', () => {
    const odd = { ...SUMMARY, simulationClass: 'weird one with spaces' };
    expect(TestSummarySchema.parse(odd).simulationClass).toBe('weird one with spaces');
  });
});

describe('TestListResponseSchema', () => {
  it('accepts a project with no tests', () => {
    expect(TestListResponseSchema.parse({ tests: [] }).tests).toEqual([]);
  });
});

/**
 * ═══ THE ORG-WIDE LIST: ONE ROW PER TEST, WITH THE RUN IT IS ABOUT ═══
 *
 * `GET /v1/tests` serves the portfolio home table and the command palette, so
 * a row carries what both draw without a request per test: the project it
 * belongs to, its latest run with the figures a row shows, and a short p95
 * history for a sparkline.
 */
const ORG_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'checkout-soak',
  name: 'Checkout soak',
  simulationClass: 'example.ParitySimulation',
  runCount: 12,
  project: { slug: 'checkout', name: 'Checkout' },
  latestRun: {
    id: '33333333-3333-4333-8333-333333333333',
    runNumber: 12,
    status: 'complete',
    verdict: 'failed',
    startedAt: '2026-10-05T09:30:00.000Z',
    durationMs: 62136,
    checks: { failed: 1, total: 3 },
    p95Ms: 645.59,
  },
  p95History: [
    { runId: '44444444-4444-4444-8444-444444444444', runNumber: 11, p95Ms: 612.4 },
    { runId: '33333333-3333-4333-8333-333333333333', runNumber: 12, p95Ms: 645.59 },
  ],
};

describe('OrgTestListResponseSchema', () => {
  it('parses a test with a latest run and a p95 history', () => {
    const body = { items: [ORG_ROW], nextCursor: 'opaque-cursor' };
    expect(OrgTestListResponseSchema.parse(body)).toEqual(body);
  });

  /**
   * A test can be declared and never run (or have every run deleted), so the
   * run, its figures and its history are all absent together rather than
   * half-present: `latestRun: null` with an empty history is the whole shape.
   */
  it('parses a test that has never run', () => {
    const body = {
      items: [{ ...ORG_ROW, runCount: 0, latestRun: null, p95History: [] }],
      nextCursor: null,
    };
    expect(OrgTestListResponseSchema.parse(body)).toEqual(body);
  });

  /**
   * A latest run that is still running, or that carries no statistics yet,
   * has no verdict, no check tally and no p95 — each is null on its own, and
   * a consumer that read `verdict` alone would call it "not evaluated".
   */
  it('carries an unfinished latest run with its measurements null', () => {
    const body = {
      items: [
        {
          ...ORG_ROW,
          latestRun: {
            ...ORG_ROW.latestRun,
            runNumber: null,
            status: 'running',
            verdict: null,
            durationMs: null,
            checks: null,
            p95Ms: null,
          },
        },
      ],
      nextCursor: null,
    };
    expect(OrgTestListResponseSchema.parse(body)).toEqual(body);
  });

  /**
   * The history is a sparkline, so it is bounded where it is produced (the
   * query takes ten) and bounded again here: a contract that let a longer one
   * through would let a row grow without anything noticing.
   */
  it('refuses a p95 history longer than ten points', () => {
    const point = (n: number) => ({
      runId: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`,
      runNumber: n,
      p95Ms: 600 + n,
    });
    const ten = Array.from({ length: 10 }, (_, i) => point(i + 1));
    const eleven = Array.from({ length: 11 }, (_, i) => point(i + 1));

    expect(
      OrgTestListResponseSchema.safeParse({
        items: [{ ...ORG_ROW, p95History: ten }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      OrgTestListResponseSchema.safeParse({
        items: [{ ...ORG_ROW, p95History: eleven }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  /**
   * `nextCursor` is how a client knows there is no more: null means the last
   * page, a string means ask again. Absent means neither, which a consumer
   * would read as "more" or "none" at random, so the schema refuses it.
   */
  it('requires nextCursor to be present, null or a string', () => {
    expect(OrgTestListResponseSchema.safeParse({ items: [ORG_ROW] }).success).toBe(false);
    expect(OrgTestListResponseSchema.safeParse({ items: [ORG_ROW], nextCursor: null }).success).toBe(
      true,
    );
    expect(OrgTestListResponseSchema.safeParse({ items: [ORG_ROW], nextCursor: 'c' }).success).toBe(
      true,
    );
  });
});

describe('UpdateTestRequestSchema', () => {
  it('accepts a rename', () => {
    expect(UpdateTestRequestSchema.parse({ name: 'Checkout smoke' }).name).toBe('Checkout smoke');
  });

  /**
   * `null` CLEARS a description and `undefined` leaves it alone. A caller that
   * wants to remove one has to be able to SAY so, and omitting the field
   * already means something else.
   */
  it('tells clearing a description apart from not mentioning it', () => {
    expect(UpdateTestRequestSchema.parse({ description: null }).description).toBeNull();
    expect(UpdateTestRequestSchema.parse({ name: 'x' }).description).toBeUndefined();
  });

  it('refuses an empty body rather than treating it as a no-op write', () => {
    expect(() => UpdateTestRequestSchema.parse({})).toThrow();
  });

  /**
   * ═══ THE CASE THE WHOLE SCHEMA EXISTS FOR ═══
   *
   * `simulationClass` is the key the worker matches a parsed run on. Accepting
   * an edit to it would not rename the test — it would SPLIT it: every future
   * run of the old class would create a second test and start a second
   * history, while the runs already recorded stayed on this one. Nothing would
   * error, and the only symptom would be a trend line that went quiet.
   *
   * `.strict()` is what turns that from a silently-ignored field into a 400.
   */
  it('refuses to re-aim a test at a different simulation class', () => {
    expect(() =>
      UpdateTestRequestSchema.parse({ name: 'ok', simulationClass: 'other.Simulation' }),
    ).toThrow();
  });

  it('refuses to change the slug, which is a URL people have shared', () => {
    expect(() => UpdateTestRequestSchema.parse({ slug: 'something-else' })).toThrow();
  });

  it('refuses a blank name rather than storing an unnameable test', () => {
    expect(() => UpdateTestRequestSchema.parse({ name: '   ' })).toThrow();
  });

  it('trims, so a name is not stored with the whitespace someone pasted', () => {
    expect(UpdateTestRequestSchema.parse({ name: '  Checkout  ' }).name).toBe('Checkout');
  });
});
