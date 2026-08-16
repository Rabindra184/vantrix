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

function controllerWith(
  offsets: number[],
  split: (number | null)[] = offsets.map(() => 1),
): MetricsController {
  const runs = { findById: async () => RUN } as never;
  const reader = {
    series: async () =>
      offsets.map((startOffsetMs, i) => ({
        startOffsetMs,
        startedCount: 1,
        endedCount: 1,
        okCount: 1,
        koCount: 0,
        // A bucket whose split summed to twice its startedCount would be an
        // impossible row to leave in a fixture later flag tests will extend.
        startedOkCount: split[i] ?? null,
        startedKoCount: split[i] === null ? null : 0,
        minMs: 1,
        maxMs: 1,
        meanMs: 1,
        percentiles: {},
        percentilesOk: {},
        percentilesKo: {},
      })),
  } as never;
  const projects = {} as never;
  // MetricsController's fourth dependency. These bucket-width cases never
  // reach a telemetry handler, so an unpopulated stub is enough — but it has
  // to be PASSED: the constructor has taken four arguments since the
  // telemetry sub-project, and this call site kept compiling on three only
  // because nothing typechecked apps/api/test (see test/tsconfig.json).
  const telemetrySamples = {} as never;
  return new MetricsController(runs, reader, projects, telemetrySamples);
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

/**
 * The reference run is ingested by the current engine, so every one of its
 * buckets carries the split — the integration test can only ever see
 * `startedSplitAvailable === true`. The cases that matter for the flag are the
 * ones it CANNOT produce: a run ingested before the migration (null columns),
 * and a partially-backfilled run. Stubbed here for exactly that reason.
 */
describe('GET /v1/runs/:id/series — startedSplitAvailable', () => {
  it('is true when every bucket carries the start-edge split', async () => {
    const res = await controllerWith([0, 1000, 2000]).series(RUN.id, req, 'run', '');
    expect(res.startedSplitAvailable).toBe(true);
  });

  it('is false for a run ingested before the migration, whose columns are null', async () => {
    const res = await controllerWith([0, 1000, 2000], [null, null, null])
      .series(RUN.id, req, 'run', '');
    expect(res.startedSplitAvailable).toBe(false);
    expect(res.buckets[0]?.startedOkCount).toBeNull();
  });

  it('is false when even one bucket is missing the split, not just when all are', async () => {
    const res = await controllerWith([0, 1000, 2000], [1, null, 1])
      .series(RUN.id, req, 'run', '');
    expect(res.startedSplitAvailable).toBe(false);
  });

  it('is false for a run with no buckets — `every` over [] is vacuously true', async () => {
    const res = await controllerWith([]).series(RUN.id, req, 'run', '');
    expect(res.startedSplitAvailable).toBe(false);
  });
});
