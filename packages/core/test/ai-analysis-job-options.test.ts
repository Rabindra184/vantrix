import { describe, expect, it } from 'vitest';
import { AI_ANALYSIS_JOB_OPTIONS, INGEST_JOB_OPTIONS } from '../src/index.js';

describe('AI_ANALYSIS_JOB_OPTIONS', () => {
  /**
   * The values shipped, pinned: three attempts ten seconds apart and doubling,
   * and BOTH ends removed. The job id is the run id, so a kept failed job would
   * make BullMQ ignore every later `add` for that run — the API's retry and
   * its re-queue of a stale pending row alike — silently.
   */
  it('runs three attempts from ten seconds, and keeps no finished job under the run id', () => {
    expect(AI_ANALYSIS_JOB_OPTIONS).toEqual({
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    });
  });

  it('leaves the ingest queue keeping its failed jobs for an operator to read', () => {
    expect(INGEST_JOB_OPTIONS.removeOnFail).toBe(5000);
  });
});
