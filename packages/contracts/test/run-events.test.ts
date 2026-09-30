import { describe, expect, it } from 'vitest';
import {
  RunEventSchema,
  RunEventsResponseSchema,
  RunIdentitySchema,
  RunProcessingSchema,
} from '../src/index.js';

/**
 * ═══ A RUN'S LIFECYCLE EVENTS ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * What the Logs tab reads for a run the on-prem runner executed, and the one
 * identity field that tells the run page whether such a run has a tab at all.
 */
const MINIMAL = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-19T16:39:56.406Z',
};
const JOB = '7d9b8c85-1111-4111-8111-111111111111';
const AT = '2026-09-29T11:41:11.113Z';

describe('RunEvent', () => {
  it('carries a message event', () => {
    const event = RunEventSchema.parse({ at: AT, source: 'perfportal', message: 'Start requested.', phase: null });
    expect(event.message).toBe('Start requested.');
    expect(event.phase).toBeNull();
  });

  it('carries a phase separator', () => {
    const event = RunEventSchema.parse({ at: AT, source: 'runner', message: null, phase: 'Injecting' });
    expect(event.phase).toBe('Injecting');
    expect(event.message).toBeNull();
  });

  it('refuses a source nobody writes', () => {
    expect(() => RunEventSchema.parse({ at: AT, source: 'gatling-enterprise', message: 'x', phase: null })).toThrow();
  });

  it('refuses a phase Gatling Enterprise does not have', () => {
    expect(() => RunEventSchema.parse({ at: AT, source: 'runner', message: null, phase: 'Warmup' })).toThrow();
  });

  it('refuses an instant that is not one', () => {
    expect(() => RunEventSchema.parse({ at: 'yesterday', source: 'runner', message: 'x', phase: null })).toThrow();
  });
});

describe('RunEventsResponse', () => {
  it('says whether this run could have recorded anything at all', () => {
    const parsed = RunEventsResponseSchema.parse({ runId: MINIMAL.id, recorded: false, events: [] });
    expect(parsed.recorded).toBe(false);
    expect(parsed.events).toEqual([]);
  });
});

describe('RunIdentity.runnerJobId', () => {
  it('still parses an identity without it — the rolling-deploy guarantee', () => {
    expect(RunIdentitySchema.parse(MINIMAL).runnerJobId).toBeUndefined();
  });

  it('carries the job, or null for a run the runner did not produce', () => {
    expect(RunIdentitySchema.parse({ ...MINIMAL, runnerJobId: JOB }).runnerJobId).toBe(JOB);
    expect(RunIdentitySchema.parse({ ...MINIMAL, runnerJobId: null }).runnerJobId).toBeNull();
  });

  it('refuses a job id that is not a uuid', () => {
    expect(() => RunIdentitySchema.parse({ ...MINIMAL, runnerJobId: 'job-1' })).toThrow();
  });

  it('reaches the 202 body, which is what a live run is read through', () => {
    const parsed = RunProcessingSchema.parse({
      ...MINIMAL,
      status: 'running',
      statusUrl: `/v1/runs/${MINIMAL.id}`,
      runnerJobId: JOB,
    });
    expect(parsed.runnerJobId).toBe(JOB);
  });
});
