import { describe, expect, it } from 'vitest';
import { OrgTestSummarySchema, RunListResponseSchema, TrendRunSchema } from '../src/index.js';

/**
 * ═══ `statsMethod` ON THE VIEWS THAT SHOW MANY RUNS ═══
 *
 * The run list, a test's trend and the Home tests table each carry one run's
 * figures per row (or per point), so each says which engine produced them —
 * the same field `RunIdentity` carries for one run.
 *
 * OPTIONAL EVERYWHERE, and that is the claim these cases pin rather than a
 * politeness: the browser drops a body that fails its schema, so a required
 * field would blank the run list, the trends page or Home against an API pod
 * that predates it — for the length of a rolling deploy. An ENUM, so a value
 * outside the two cannot reach a reader who would then guess what it means.
 */
const ID = '11111111-1111-4111-8111-111111111111';

describe('RunListResponseSchema item statsMethod', () => {
  // A COMPLETE item: a fixture missing a required field fails the parse for
  // that reason, and "refuses a value outside the two" would then pass
  // whatever the schema did with `statsMethod`.
  const row = {
    id: ID,
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    status: 'complete',
    verdict: null,
    tool: 'gatling',
    startedAt: '2026-10-05T09:30:00.000Z',
  };

  it('parses an item without it, and carries it when present', () => {
    const parsed = RunListResponseSchema.parse({
      items: [row, { ...row, statsMethod: 'estimated' }, { ...row, statsMethod: 'exact-v1' }],
      nextCursor: null,
    });
    expect(parsed.items.map((item) => item.statsMethod)).toEqual([undefined, 'estimated', 'exact-v1']);
  });

  it('refuses a value outside the two', () => {
    expect(RunListResponseSchema.safeParse({ items: [row], nextCursor: null }).success).toBe(true);
    expect(
      RunListResponseSchema.safeParse({ items: [{ ...row, statsMethod: 'sketch' }], nextCursor: null }).success,
    ).toBe(false);
  });
});

describe('TrendRunSchema statsMethod', () => {
  const run = {
    id: ID,
    startedAt: '2026-08-14T10:43:49.546Z',
    toolStartedAt: null,
    durationMs: 60_000,
    verdict: null,
    count: 900,
    okCount: 880,
    koCount: 20,
    errorRate: 0.02,
    minMs: 10,
    maxMs: 2500,
    meanMs: 220,
    throughputRps: 15,
    percentiles: { p95: 650 },
  };

  it('parses a run without it, and carries it when present', () => {
    expect(TrendRunSchema.parse(run).statsMethod).toBeUndefined();
    expect(TrendRunSchema.parse({ ...run, statsMethod: 'estimated' }).statsMethod).toBe('estimated');
    expect(TrendRunSchema.safeParse({ ...run, statsMethod: 'sketch' }).success).toBe(false);
  });
});

describe('OrgTestSummarySchema statsMethod', () => {
  const summary = {
    id: ID,
    slug: 'checkout-soak',
    name: 'Checkout soak',
    simulationClass: 'example.ParitySimulation',
    runCount: 2,
    project: { slug: 'checkout', name: 'Checkout' },
    latestRun: {
      id: '33333333-3333-4333-8333-333333333333',
      runNumber: 2,
      status: 'complete',
      verdict: 'passed',
      startedAt: '2026-10-05T09:30:00.000Z',
      durationMs: 62136,
      checks: null,
      p95Ms: 645.59,
    },
    p95History: [
      { runId: '44444444-4444-4444-8444-444444444444', runNumber: 1, p95Ms: 612.4 },
      { runId: '33333333-3333-4333-8333-333333333333', runNumber: 2, p95Ms: 645.59 },
    ],
  };

  it('parses a latest run and history points without it', () => {
    const parsed = OrgTestSummarySchema.parse(summary);
    expect(parsed.latestRun?.statsMethod).toBeUndefined();
    expect(parsed.p95History.map((point) => point.statsMethod)).toEqual([undefined, undefined]);
  });

  it('carries it on the latest run and on each history point when present', () => {
    const parsed = OrgTestSummarySchema.parse({
      ...summary,
      latestRun: { ...summary.latestRun, statsMethod: 'exact-v1' },
      p95History: [
        { ...summary.p95History[0]!, statsMethod: 'estimated' },
        { ...summary.p95History[1]!, statsMethod: 'exact-v1' },
      ],
    });
    expect(parsed.latestRun?.statsMethod).toBe('exact-v1');
    expect(parsed.p95History.map((point) => point.statsMethod)).toEqual(['estimated', 'exact-v1']);
  });

  it('refuses a value outside the two', () => {
    expect(
      OrgTestSummarySchema.safeParse({
        ...summary,
        p95History: [{ ...summary.p95History[0]!, statsMethod: 'sketch' }],
      }).success,
    ).toBe(false);
    expect(
      OrgTestSummarySchema.safeParse({ ...summary, latestRun: { ...summary.latestRun, statsMethod: 'sketch' } })
        .success,
    ).toBe(false);
  });
});
