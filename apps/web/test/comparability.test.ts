import type { TrendRun } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { comparability, needsComparabilityCheck } from '../src/routes/comparability';

/**
 * REVIEW C06 — COHORT MEMBERSHIP IS NOT COMPARABILITY.
 *
 * `TRENDS_SQL` groups completed runs by (project, test). That says they ran
 * the same simulation and nothing about the conditions. The picker labels them
 * by start time and the summary calls one "Best selected", so a p95 that fell
 * because the offered load halved was presented as an improvement.
 */
const run = (over: Partial<TrendRun> = {}): TrendRun => ({
  id: '11111111-1111-4111-8111-111111111111',
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
  environment: 'staging',
  branch: 'main',
  commitSha: 'abcdef1234567890',
  ...over,
});

const find = (runs: readonly TrendRun[], label: string) =>
  comparability(runs).find((f) => f.label === label)!;

describe('comparability', () => {
  it('says nothing about a single run — there is no comparison to qualify', () => {
    expect(comparability([run()])).toEqual([]);
  });

  it('reports two identical runs as comparable on every dimension', () => {
    const findings = comparability([run(), run()]);
    expect(findings.every((f) => f.kind === 'same')).toBe(true);
    expect(needsComparabilityCheck(findings)).toBe(false);
  });

  it('identifies a cross-environment selection', () => {
    const findings = comparability([run(), run({ environment: 'production' })]);
    expect(find([run(), run({ environment: 'production' })], 'Environment').kind).toBe('differs');
    expect(needsComparabilityCheck(findings)).toBe(true);
  });

  /**
   * THE ACCEPTANCE, AND THE WHOLE REASON THIS EXISTS: a lower p95 at
   * substantially lower load must not read as an unqualified improvement.
   */
  it('flags a materially lower offered load', () => {
    const findings = find([run({ throughputRps: 15 }), run({ throughputRps: 7 })], 'Throughput');
    expect(findings.kind).toBe('differs');
    expect(findings.values).toEqual(['15.00/s', '7.00/s']);
  });

  it('tolerates ordinary run-to-run variance rather than crying wolf', () => {
    expect(find([run({ throughputRps: 15 }), run({ throughputRps: 14 })], 'Throughput').kind)
      .toBe('same');
  });

  /* ═══ UNKNOWN IS NOT COMPATIBLE ═══ */

  it('reads a missing environment as unknown, never as matching', () => {
    expect(find([run({ environment: null }), run({ environment: null })], 'Environment').kind)
      .toBe('unknown');
  });

  /** A server that predates the field reports `undefined`; that is not
   *  evidence the two runs agree either. */
  it('reads an unreported environment as unknown too', () => {
    expect(find([run({ environment: undefined }), run({ environment: 'staging' })], 'Environment').kind)
      .toBe('unknown');
  });

  it('does not call runs comparable just because the values it CAN see agree', () => {
    const findings = comparability([run({ branch: null }), run({ branch: null })]);
    expect(needsComparabilityCheck(findings)).toBe(true);
  });

  it('shortens a commit sha to something a human can compare', () => {
    expect(find([run(), run()], 'Build').values).toEqual(['abcdef12', 'abcdef12']);
  });

  it('does not divide by a zero baseline', () => {
    expect(find([run({ throughputRps: 0 }), run({ throughputRps: 10 })], 'Throughput').kind)
      .toBe('same');
  });
});
