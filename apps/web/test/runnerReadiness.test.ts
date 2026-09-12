import type { RunnerJob, RunnerJobStatus } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { agoLabel, durationLabel, runnerReadiness } from '../src/routes/runnerReadiness.js';

/**
 * ═══ WHAT THIS FILE IS GUARDING, AND IT IS NOT THE WORDING ═══
 *
 * `runnerReadiness` exists because the launch form used to show a static
 * "Concurrency: one active job" panel — a fact about the product, presented
 * where an engineer looks for a fact about the machine. The whole value of
 * replacing it is that the new sentences are only ever as strong as the
 * evidence, so the cases below are about the BOUNDARY between "a runner is
 * there" and "we cannot tell", not about the prose.
 *
 * The two that matter most are the ones that must NOT say a runner is
 * available: a project with no jobs at all, and a project whose jobs are all
 * finished. Both look like "nothing is wrong" and neither is evidence of
 * anything. An implementation that collapsed them into "Available" would pass
 * any test that only checked the busy and stalled paths.
 */

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function job(status: RunnerJobStatus, agedMs: number): { job: RunnerJob } {
  return {
    job: {
      id: '00000000-0000-4000-8000-000000000001',
      artifactId: '00000000-0000-4000-8000-000000000002',
      runId: null,
      status,
      requestedBy: 'someone@example.test',
      environment: null,
      branch: null,
      commitSha: null,
      testSlug: null,
      javaOptions: null,
      systemProperties: {},
      error: null,
      createdAt: ago(agedMs),
      updatedAt: ago(agedMs),
    },
  };
}

describe('runnerReadiness', () => {
  it('says nothing is known when the project has never queued a job', () => {
    const state = runnerReadiness([], NOW);
    expect(state.kind).toBe('unknown');
    expect(state.ahead).toBe(0);
    // The load-bearing half: no claim of availability anywhere in the text.
    expect(`${state.headline} ${state.detail}`).not.toMatch(/available|online|ready|connected now/i);
  });

  it('reports a claimed job as proof a runner is there, with the queue depth', () => {
    const state = runnerReadiness([job('running', 5_000), job('queued', 1_000)], NOW);
    expect(state.kind).toBe('busy');
    // One running plus one queued — a run started now is third.
    expect(state.ahead).toBe(2);
    expect(state.detail).toContain('2 jobs');
  });

  it.each<RunnerJobStatus>(['starting', 'running', 'closing'])(
    'treats %s as claimed, because all three mean a node took the job',
    (status) => {
      expect(runnerReadiness([job(status, 1_000)], NOW).kind).toBe('busy');
    },
  );

  it('calls a briefly-queued job normal rather than broken', () => {
    const state = runnerReadiness([job('queued', 3_000)], NOW);
    expect(state.kind).toBe('waiting');
    expect(state.ahead).toBe(1);
  });

  /**
   * THE ONE STATE THAT ACCUSES SOMETHING OF BEING WRONG, so its threshold is
   * asserted from both sides. A single "is it stalled" case would pass for an
   * implementation that always says yes.
   */
  it('turns a long-unclaimed job into an explicit unavailable state', () => {
    expect(runnerReadiness([job('queued', 119_000)], NOW).kind).toBe('waiting');
    expect(runnerReadiness([job('queued', 121_000)], NOW).kind).toBe('stalled');
  });

  it('measures the wait from the OLDEST queued job, not the newest', () => {
    // A fresh job must not reset the clock on one that has been sitting for
    // ten minutes — that is exactly how a stalled queue would hide itself,
    // because the reader keeps adding work to it.
    const state = runnerReadiness([job('queued', 600_000), job('queued', 1_000)], NOW);
    expect(state.kind).toBe('stalled');
    expect(state.detail).toContain('10 minutes');
  });

  it('will not call a project with only finished jobs available', () => {
    const state = runnerReadiness([job('complete', 20 * 60_000), job('failed', 90 * 60_000)], NOW);
    expect(state.kind).toBe('idle');
    expect(state.ahead).toBe(0);
    // It reports the most recent job, and says outright that "now" is unknown.
    expect(state.detail).toContain('20 minutes ago');
    expect(state.detail).toMatch(/unknown/i);
  });

  it('counts a cancelled job as finished, since nothing is holding the node', () => {
    expect(runnerReadiness([job('cancelled', 60_000)], NOW).kind).toBe('idle');
  });
});

describe('durationLabel / agoLabel', () => {
  it('rounds to a unit a last-seen time can actually support', () => {
    expect(durationLabel(10_000)).toBe('less than a minute');
    expect(durationLabel(120_000)).toBe('2 minutes');
    expect(durationLabel(60 * 60_000)).toBe('1 hour');
    expect(durationLabel(48 * 60 * 60_000)).toBe('2 days');
  });

  it('reads the same span as a point in the past', () => {
    expect(agoLabel(10_000)).toBe('just now');
    expect(agoLabel(120_000)).toBe('2 minutes ago');
  });

  /** A clock difference can be negative — the row's timestamp is the server's
   *  and `Date.now()` is the browser's. Neither "in -3 minutes" nor a thrown
   *  error belongs on a status panel. */
  it('does not invent a time from a skewed clock', () => {
    expect(durationLabel(-5_000)).toBe('an unknown time');
    expect(agoLabel(-5_000)).toBe('at an unknown time');
    expect(agoLabel(Number.NaN)).toBe('at an unknown time');
  });
});
