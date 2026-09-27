import { describe, expect, it } from 'vitest';
import {
  RunIdentitySchema,
  RunListResponseSchema,
  RunNumberSchema,
  TestSummarySchema,
  TrendRunSchema,
} from '../src/index.js';

/**
 * ═══ A RUN'S NUMBER ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * Positive and whole — a run is the 1st, 2nd, 12th of its test — or null for a
 * run with no test. And OPTIONAL on every schema that carries it: the browser
 * drops a body that fails safeParse, so a required field would blank the page
 * against an API pod that predates it for a whole rolling deploy.
 */
const MINIMAL_IDENTITY = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-27T09:00:00.000Z',
};

const LIST_ROW = {
  id: MINIMAL_IDENTITY.id,
  project: MINIMAL_IDENTITY.project,
  status: 'complete',
  verdict: null,
  tool: 'gatling',
  startedAt: MINIMAL_IDENTITY.startedAt,
};

const TREND_ROW = {
  id: MINIMAL_IDENTITY.id,
  startedAt: MINIMAL_IDENTITY.startedAt,
  toolStartedAt: null,
  durationMs: null,
  verdict: null,
  count: 1,
  okCount: 1,
  koCount: 0,
  errorRate: 0,
  minMs: 1,
  maxMs: 1,
  meanMs: 1,
  throughputRps: 1,
  percentiles: {},
};

const TEST = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'checkout-smoke',
  name: 'Checkout smoke',
  simulationClass: 'example.CheckoutSimulation',
  description: null,
  createdAt: '2026-09-27T09:00:00.000Z',
  updatedAt: '2026-09-27T09:00:00.000Z',
  runCount: 1,
  latestRun: { id: MINIMAL_IDENTITY.id, status: 'complete', verdict: 'passed' },
};

describe('a run number', () => {
  it('is a positive whole number', () => {
    expect(RunNumberSchema.parse(1)).toBe(1);
    expect(RunNumberSchema.parse(12)).toBe(12);
  });

  it('refuses zero, negatives, fractions and strings', () => {
    for (const bad of [0, -1, 1.5, '12']) {
      expect(RunNumberSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rides a run’s identity, null for a run with no test, and is absent from an older pod', () => {
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, runNumber: 12 }).runNumber).toBe(12);
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, runNumber: null }).runNumber).toBeNull();
    expect(RunIdentitySchema.parse(MINIMAL_IDENTITY).runNumber).toBeUndefined();
    expect(RunIdentitySchema.safeParse({ ...MINIMAL_IDENTITY, runNumber: 0 }).success).toBe(false);
  });

  it('rides a list row, a trend row and a test’s latest run — each still parsing without it', () => {
    const list = RunListResponseSchema.parse({
      items: [{ ...LIST_ROW, runNumber: 3 }, LIST_ROW],
      nextCursor: null,
    });
    expect(list.items.map((i) => i.runNumber)).toEqual([3, undefined]);

    expect(TrendRunSchema.parse({ ...TREND_ROW, runNumber: 3 }).runNumber).toBe(3);
    expect(TrendRunSchema.parse(TREND_ROW).runNumber).toBeUndefined();

    expect(
      TestSummarySchema.parse({ ...TEST, latestRun: { ...TEST.latestRun, runNumber: 3 } }).latestRun
        ?.runNumber,
    ).toBe(3);
    expect(TestSummarySchema.parse(TEST).latestRun?.runNumber).toBeUndefined();
  });
});
