import {
  DistributionResponseSchema,
  ErrorsResponseSchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatsResponseSchema,
  UsersResponseSchema,
  type DistributionResponse,
  type ErrorsResponse,
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
 * `apps/web/test/fixtures/reference-run.json` holds the five raw responses for
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
const errors = fixture.errors as ErrorsResponse;

describe('the captured reference-run payloads', () => {
  it('still parse against the contract schemas the app validates with', () => {
    // `parse`, not `safeParse`: a fixture the contract rejects is a fixture
    // the browser could never have received, and the ZodError names the field.
    expect(() => StatsResponseSchema.parse(fixture.stats)).not.toThrow();
    expect(() => SeriesResponseSchema.parse(fixture.series)).not.toThrow();
    expect(() => UsersResponseSchema.parse(fixture.users)).not.toThrow();
    expect(() => DistributionResponseSchema.parse(fixture.distribution)).not.toThrow();
    expect(() => ErrorsResponseSchema.parse(fixture.errors)).not.toThrow();
  });

  it('came from ONE run — five payloads about five different runs would be incoherent', () => {
    const ids = new Set([
      stats.runId,
      series.runId,
      users.runId,
      distribution.runId,
      errors.runId,
    ]);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(fixture._capture.runId);
  });

  it('carries a real errors payload, not a hand-written one', () => {
    const parsed = ErrorsResponseSchema.parse(fixture.errors);
    expect(parsed.errors.length).toBeGreaterThan(0);
    // The reference run has 24 KO out of 895; every error must be attributable.
    const total = parsed.errors.reduce((n, e) => n + e.count, 0);
    const run = stats.stats.find((r) => r.scope === 'run')!;
    expect(total).toBe(run.koCount);
  });

  it('carries a scatter payload with points to draw', () => {
    const scatter = ScatterResponseSchema.parse(fixture.scatter);
    expect(scatter.name).toBe('Catalog/List Products');
    // Both axes are counts/milliseconds, never null: a transform that has to
    // defend against a null here is defending against a shape the API cannot
    // produce.
    expect(scatter.ok.length).toBeGreaterThan(0);
    for (const [x, y] of scatter.ok) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });

  it('carries a second scatter payload whose KO series is non-empty', () => {
    // `scatter` above (`Catalog/List Products`) has no failures, so its `ko`
    // is `[]` and cannot discriminate a transform that plots the KO series
    // from a copy of OK. This is the payload that can: a future re-capture
    // that lost its KO points — a different reference bundle, a request that
    // stopped failing, a name that stopped matching — must fail HERE, not
    // silently thin out apps/web/test/transforms.scatter.test.ts's KO
    // assertions back down to the untestable case this fixture replaced.
    const scatterWithFailures = ScatterResponseSchema.parse(fixture.scatterWithFailures);
    expect(scatterWithFailures.name).toBe('Cart/Add To Cart');
    expect(scatterWithFailures.ok.length).toBeGreaterThan(0);
    expect(scatterWithFailures.ko.length).toBeGreaterThan(0);
    // The independence assertion in transforms.scatter.test.ts depends on
    // these being unequal — equal lengths would let a bug that zips the two
    // series by index pass undetected.
    expect(scatterWithFailures.ok.length).not.toBe(scatterWithFailures.ko.length);
    for (const [x, y] of [...scatterWithFailures.ok, ...scatterWithFailures.ko]) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
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
      // `typeof === 'number'`, not `not.toBeNull()`: the latter also passes for
      // `undefined` — a field the capture dropped entirely — and the `?? 0` on
      // the next line would then absorb it and let the sum assertion pass on a
      // fixture that carries no split at all.
      expect(typeof bucket.startedOkCount).toBe('number');
      expect(typeof bucket.startedKoCount).toBe('number');
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
