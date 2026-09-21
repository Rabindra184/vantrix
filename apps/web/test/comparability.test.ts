import type { TrendRun } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  comparability,
  comparabilityBreaks,
  needsComparabilityCheck,
  summariseBreaks,
} from '../src/routes/comparability';

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

/**
 * AC-STAT-5 — a trend line must never silently connect runs measured on
 * different footing. This is the rule that decides where it stops.
 */
describe('comparabilityBreaks', () => {
  const seq = (...overs: Partial<TrendRun>[]) => overs.map((o) => run(o));

  it('breaks where the environment changed, naming the transition', () => {
    const breaks = comparabilityBreaks(seq(
      { environment: 'staging' }, { environment: 'staging' }, { environment: 'production' },
    ));
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.index).toBe(2);       // the FIRST run on the new footing
    expect(breaks[0]!.changed).toEqual(['environment']);
    expect(breaks[0]!.detail).toBe('staging → production');
  });

  it('breaks on tool and on simulation, the other axes of the fingerprint', () => {
    expect(comparabilityBreaks(seq({ tool: 'gatling' }, { tool: 'k6' }))[0]!.changed).toEqual(['tool']);
    expect(comparabilityBreaks(seq({ simulation: 'A' }, { simulation: 'B' }))[0]!.changed)
      .toEqual(['simulation']);
  });

  /**
   * THE HALF THAT KEEPS THE FEATURE USABLE. §24.1 excludes branch and commit
   * because they are "what varies between comparable runs" — a trend that
   * broke on every commit would be nothing but breaks, and watching the
   * effect of commits is what a reader opens a trend FOR.
   */
  it('does NOT break on a branch or commit change', () => {
    expect(comparabilityBreaks(seq(
      { branch: 'main', commitSha: 'aaa' },
      { branch: 'feature/x', commitSha: 'bbb' },
    ))).toEqual([]);
  });

  /**
   * A break is a positive claim that two runs sit on different footing, and
   * absence is not evidence for it — the rule this module already applies to
   * its findings. It also keeps the line whole for runs predating the fields,
   * which is what `nullable().optional()` exists for.
   */
  it('does NOT break where a value is unknown on either side', () => {
    expect(comparabilityBreaks(seq({ environment: null }, { environment: 'staging' }))).toEqual([]);
    expect(comparabilityBreaks(seq({ environment: 'staging' }, { environment: undefined }))).toEqual([]);
    expect(comparabilityBreaks(seq({ environment: 'staging' }, { environment: '' }))).toEqual([]);
  });

  it('reports one break per transition, and none for a steady cohort', () => {
    expect(comparabilityBreaks(seq(
      { environment: 'staging' }, { environment: 'staging' }, { environment: 'staging' },
    ))).toEqual([]);
    expect(comparabilityBreaks(seq(
      { environment: 'a' }, { environment: 'b' }, { environment: 'a' },
    ))).toHaveLength(2);
  });

  it('summarises every axis that moved, once for the whole chart', () => {
    const breaks = comparabilityBreaks(seq(
      { environment: 'staging' }, { environment: 'production' },
    ));
    const note = summariseBreaks(breaks)!;
    expect(note).toContain('broken at a gap');
    expect(note).toContain('environment');
    expect(summariseBreaks([])).toBeUndefined();
  });
});
