import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { MetricsController } from '../src/metrics/metrics.controller.js';

/**
 * The integration test for `bucketWidthMs` asserts against the reference run,
 * whose bucket width IS 1000ms — so it passes just as happily against a
 * hard-coded `bucketWidthMs: 1000`. It proves the field is present; it cannot
 * prove the field is derived.
 *
 * That distinction is the whole point of the field. BucketSeries halves
 * resolution in place once a run exceeds its bucket cap, and requests/s and
 * responses/s divide by this number, so a wrong width scales every point by a
 * power of two while leaving the curve's shape untouched.
 *
 * So: stub the reader with buckets that are demonstrably NOT 1000ms apart,
 * and assert the controller reports what the data says rather than what the
 * common case happens to be.
 */
const RUN = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  startedOn: new Date('2026-08-13T00:00:00Z'),
};

function controllerWith(offsets: number[]): MetricsController {
  const runs = { findById: async () => RUN } as never;
  const reader = {
    series: async () =>
      offsets.map((startOffsetMs) => ({
        startOffsetMs,
        startedCount: 1,
        endedCount: 1,
        okCount: 1,
        koCount: 0,
        minMs: 1,
        maxMs: 1,
        meanMs: 1,
        percentiles: {},
        percentilesOk: {},
        percentilesKo: {},
      })),
  } as never;
  const projects = {} as never;
  return new MetricsController(runs, reader, projects);
}

const req = { tenant: { orgId: RUN.orgId, projectId: RUN.projectId } } as unknown as Request;

describe('GET /v1/runs/:id/series — bucketWidthMs', () => {
  it('reports a coalesced width, not the 1000ms of the common case', async () => {
    const res = await controllerWith([0, 2000, 4000, 6000]).series(RUN.id, req, 'run', '');
    expect(res.bucketWidthMs).toBe(2000);
  });

  it('takes the SMALLEST positive gap, because empty buckets are absent', async () => {
    // A bucket with no observations is never written, so consecutive offsets
    // can be two widths apart. Reading the first gap would report 2000 here.
    const res = await controllerWith([0, 2000, 3000, 4000]).series(RUN.id, req, 'run', '');
    expect(res.bucketWidthMs).toBe(1000);
  });
});
