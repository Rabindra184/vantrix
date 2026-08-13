import {
  DistributionResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
  UsersResponseSchema,
  type DistributionResponse,
  type SeriesResponse,
  type StatsResponse,
  type UsersResponse,
} from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/reference-run.json';

/**
 * The captured payload fixture is FIT FOR THE PURPOSE the later tasks put it
 * to — checked here, once, rather than discovered task by task.
 *
 * `apps/web/test/fixtures/reference-run.json` holds the four raw responses for
 * the reference run, captured from the live API by
 * `scripts/capture-chart-fixture.mjs` (its header documents re-capture). Every
 * transform test in Tasks 5–9 reads it, so it is what those tests mean by "the
 * data" — and a re-capture that produced a degenerate payload would quietly
 * turn several of them into tests that cannot fail.
 *
 * Two things are proved here:
 *
 *   1. The captured bytes still satisfy the CONTRACT schemas. The fixture is
 *      committed and the contracts keep changing (Tasks 1 and 2 both widened
 *      `SeriesResponse`), so a fixture captured before a field existed would
 *      otherwise be found by a transform reading `undefined` and rendering it.
 *
 *   2. The fixture DISCRIMINATES. Each assertion below names the later test it
 *      protects. This is not defensive padding: `percentilesOk.p95` and
 *      `percentiles.p95` are equal in all 62 buckets of this run, so the
 *      OK-only assertion in the plan's Task 8 — written against p95 — cannot
 *      fail here, and its falsification checkpoint would stay green while the
 *      bug it names was present. Task 8 must assert on p50. See the Task 4
 *      report.
 */

const stats = fixture.stats as StatsResponse;
const series = fixture.series as SeriesResponse;
const users = fixture.users as UsersResponse;
const distribution = fixture.distribution as DistributionResponse;

describe('the captured reference-run payloads', () => {
  it('still parse against the contract schemas the app validates with', () => {
    // `parse`, not `safeParse`: a fixture the contract rejects is a fixture
    // the browser could never have received, and the ZodError names the field.
    expect(() => StatsResponseSchema.parse(fixture.stats)).not.toThrow();
    expect(() => SeriesResponseSchema.parse(fixture.series)).not.toThrow();
    expect(() => UsersResponseSchema.parse(fixture.users)).not.toThrow();
    expect(() => DistributionResponseSchema.parse(fixture.distribution)).not.toThrow();
  });

  it('came from ONE run — four payloads about four different runs would be incoherent', () => {
    const ids = new Set([stats.runId, series.runId, users.runId, distribution.runId]);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(fixture._capture.runId);
  });
});

describe('the fixture discriminates, so the tests reading it can fail', () => {
  it('Task 5: the indicator bands are configurable and account for every request', () => {
    expect(stats.configurable).toBe(true);
    const run = stats.stats.find((row) => row.scope === 'run' && row.family === 'response_time');
    expect(run).toBeDefined();
    const { under, between, over, failed } = stats.indicators;
    expect(under + between + over + failed).toBe(run!.count);
    // A donut with no KO slice could not tell a working split from a dropped one.
    expect(run!.koCount).toBeGreaterThan(0);
  });

  it('Task 6: concurrency and arrival rate are different numbers in this run', () => {
    // If maxConcurrent equalled started everywhere, "plots concurrency and
    // arrival rate from DIFFERENT fields" would pass on a transform that read
    // the wrong one.
    const differing = users.total.filter((b) => b.maxConcurrent !== b.started);
    expect(differing.length).toBeGreaterThan(0);
    expect(users.scenarios.length).toBeGreaterThanOrEqual(2);
  });

  it('Task 8: p50 separates the OK-only bands from the combined ones — p95 does NOT', () => {
    const differsAt = (band: string) =>
      series.buckets.filter((b) => b.percentilesOk[band] !== b.percentiles[band]).length;

    // The band Task 8 must assert on. Eight buckets differ in this run.
    expect(differsAt('p50')).toBeGreaterThan(0);

    // Recorded as a fact about this run, not as an aspiration: OK-only and
    // combined p95 are identical in all 62 buckets, because the KO requests
    // are too few to move the 95th. A test written against p95 would pass
    // whichever map the transform read.
    expect(differsAt('p95')).toBe(0);
  });

  it('Task 9: the start-edge split is present, non-trivial, and sums to startedCount', () => {
    expect(series.startedSplitAvailable).toBe(true);
    expect(series.bucketWidthMs).toBeGreaterThan(0);

    // A run with no KO starts would let a transform read the OK counter for
    // both series undetected.
    expect(series.buckets.filter((b) => (b.startedKoCount ?? 0) > 0).length).toBeGreaterThan(0);

    for (const bucket of series.buckets) {
      expect(bucket.startedOkCount).not.toBeNull();
      expect((bucket.startedOkCount ?? 0) + (bucket.startedKoCount ?? 0)).toBe(bucket.startedCount);
    }
  });

  it('Task 7: the distribution has both outcomes and percentages of the combined total', () => {
    expect(distribution.labels.length).toBeGreaterThan(0);
    expect(distribution.koCount.some((n) => n > 0)).toBe(true);
    const total =
      distribution.okPercent.reduce((a, b) => a + b, 0) +
      distribution.koPercent.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 3);
  });
});
