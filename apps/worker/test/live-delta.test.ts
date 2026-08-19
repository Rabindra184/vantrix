import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CanonicalEvent } from '@perfportal/core';
import { LiveDeltaSchema } from '@perfportal/contracts';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import type { EvaluableRule, EvaluatedAssertion } from '@perfportal/sla';
import { bucketLatency, LiveEngine, runEngine, type EngineResult } from '@perfportal/statistics';
import { buildDelta, buildSnapshot, INITIAL_CURSOR, type DeltaCursor, type SlaInput } from '../src/live/delta.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);
const events = () => [...parseSimulationLog(readFileSync(LOG))];

const RUN_ID = '0f9b1d4e-1111-2222-3333-444455556666';

// The overwhelming majority of cases in this file exist to test the
// statistics envelopes, not the SLA one -- this is their `sla` argument, so
// each reads as "the run's stats" rather than "the run's stats, and also
// nothing is breaching, which is irrelevant here". The one case that DOES
// care about `sla` builds its own via `buildDeltaWithSla` below.
const NO_SLA: SlaInput = { assertions: [], breachingSince: new Map() };

/** A rule snapshot for cases that only care about the fields `evaluateRules`
 *  reports back (ruleId/outcome/actualValue/message), not the rule itself. */
const RULE_SNAPSHOT: EvaluableRule = {
  id: 'placeholder', scope: 'run', targetName: null, family: 'response_time',
  metric: 'p95', comparator: 'lte', threshold: 100,
};

/**
 * A thin wrapper over `buildDelta` for cases that only care about the `sla`
 * envelope: fixes the runId/result/cursor so the call reads as one line
 * about assertions and breachingSince, not about the run's statistics.
 */
function buildDeltaWithSla(sla: {
  assertions: readonly Omit<EvaluatedAssertion, 'ruleSnapshot'>[];
  breachingSince: ReadonlyMap<string, number>;
}): ReturnType<typeof buildDelta>['delta'] {
  const assertions: EvaluatedAssertion[] = sla.assertions.map((a) => ({ ...a, ruleSnapshot: RULE_SNAPSHOT }));
  const { delta } = buildDelta(RUN_ID, runEngine([]), INITIAL_CURSOR, { ...sla, assertions });
  return delta;
}

/**
 * Builds an `EngineResult` from bare request shapes, for cases that only care
 * about the run-scope response-time series and don't need a real log fixture.
 * `name`/`groups`/`userId` are irrelevant to that series, so they are fixed.
 */
function engineResultFrom(requests: { startMs: number; endMs: number; ok: boolean }[]): EngineResult {
  const reqEvents: CanonicalEvent[] = requests.map((r, i) => ({
    type: 'request',
    name: 'req',
    groups: [],
    userId: `u${i}`,
    startMs: r.startMs,
    endMs: r.endMs,
    ok: r.ok,
  }));
  return runEngine(reqEvents);
}

/**
 * An `EngineResult` from zero requests, with `errors` overridden to the given
 * rows -- for cases that only care about `buildDelta`'s error-row filtering
 * and don't need a real log fixture to produce failures. Built from
 * `runEngine([])` rather than hand-assembled, so every other field (series,
 * users, errorSeries, ...) is a real, internally-consistent empty result
 * instead of a second, hand-maintained shape of `EngineResult`.
 */
function engineResultWithErrors(errors: EngineResult['errors']): EngineResult {
  return { ...runEngine([]), errors };
}

/**
 * An `EngineResult` whose run-scope response-time series spans `durationMs`
 * at the default 1000ms bucket width, for cases that only care about "many
 * buckets exist" and don't need a real log fixture. One request per bucket
 * is enough to materialise it -- `BucketSeries` only creates a bucket on its
 * first `add` (see `buildDelta`'s own comment on this).
 */
function engineResultSpanning(durationMs: number): EngineResult {
  const requests: { startMs: number; endMs: number; ok: boolean }[] = [];
  for (let ms = 0; ms < durationMs; ms += 1000) {
    requests.push({ startMs: ms, endMs: ms + 10, ok: true });
  }
  return engineResultFrom(requests);
}

describe('buildDelta', () => {
  it('summarises the run from the payload, not from written-down numbers', () => {
    const all = events();
    const { delta } = buildDelta('r1', runEngine(all), INITIAL_CURSOR, NO_SLA);
    const batch = runEngine(all).stats.find((s) => s.scope === 'run' && s.family === 'response_time')!;

    expect(delta.summary.count).toBe(batch.count);
    expect(delta.summary.okCount).toBe(batch.okCount);
    expect(delta.summary.koCount).toBe(batch.koCount);
    expect(delta.summary.errorRate).toBeCloseTo(batch.errorRate, 10);
    expect(delta.seq).toBe(0);
    expect(delta.responseTime.replaces).toBe(true);   // first delta always replaces
  });

  it('emits buckets at or past the cursor on the second call, upserting the frontier bucket', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR, NO_SLA);

    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next, NO_SLA);

    expect(second.delta.seq).toBe(1);
    const firstMax = Math.max(...first.delta.responseTime.buckets.map((b) => b.startOffsetMs));
    // The frontier bucket is upserted, so it must reappear with a (possibly
    // corrected) count. This is deliberately NOT "every bucket is >=
    // firstMax": the lookback window (see the dedicated case below) can
    // legitimately re-send buckets OLDER than the prior frontier too, when
    // the run has shown a response time spanning more than one bucket
    // width. Without this assertion the case would pass just as well under
    // the OLD, strictly-greater filter.
    expect(second.delta.responseTime.buckets.some((b) => b.startOffsetMs === firstMax)).toBe(true);
  });

  it('flags a full replacement when the bucket width changes, independently of the users series', () => {
    const all = events();

    // A tiny cap forces BucketSeries to coalesce partway through. Default
    // maxBucketsUsers is untouched, so the users series has no reason to
    // coalesce at all over this fixture's ~63s duration.
    const engine = new LiveEngine({ maxBucketsRun: 4 });
    const third = Math.floor(all.length / 3);
    for (const e of all.slice(0, third)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR, NO_SLA);

    for (const e of all.slice(third)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next, NO_SLA);

    // Derived, not asserted as a literal: the width MUST have grown for this
    // case to be testing anything, so assert that first.
    expect(second.delta.responseTime.widthMs).toBeGreaterThan(first.delta.responseTime.widthMs);
    expect(second.delta.responseTime.replaces).toBe(true);
    // A replacement carries the WHOLE series, including offset 0.
    expect(Math.min(...second.delta.responseTime.buckets.map((b) => b.startOffsetMs))).toBe(0);

    // The users series coalesces against its OWN cap (maxBucketsUsers,
    // untouched here) on its OWN schedule -- it has no reason to have
    // widened just because the response-time series above did, so its width
    // must still read what it always has. One shared width for both series
    // would fail this assertion by construction.
    expect(second.delta.users.widthMs).toBe(first.delta.users.widthMs);
    expect(second.delta.users.widthMs).toBeLessThan(second.delta.responseTime.widthMs);
  });

  it('does not flag a replacement when the width is unchanged', () => {
    const all = events();
    const engine = new LiveEngine();
    const half = Math.floor(all.length / 2);
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR, NO_SLA);
    for (const e of all.slice(half)) engine.add(e);
    const second = buildDelta('r1', engine.snapshot({ clone: true }), first.next, NO_SLA);

    expect(second.delta.responseTime.widthMs).toBe(first.delta.responseTime.widthMs);
    expect(second.delta.responseTime.replaces).toBe(false);
  });

  it('sends users whole every tick, unaffected by the response-time cursor', () => {
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR, NO_SLA);

    for (const e of all.slice(half)) engine.add(e);
    const finalSnapshot = engine.snapshot({ clone: true });
    const second = buildDelta('r1', finalSnapshot, first.next, NO_SLA);

    // Every bucket of every scenario in the FULL snapshot, on every tick --
    // never filtered by the response-time cursor (`first.next`), and never
    // fewer than what the engine actually holds. Derived from the payload:
    // this is not the fixture's own bucket count written down, it is
    // `finalSnapshot.users` counted the same way `buildDelta` must.
    const expectedCount = finalSnapshot.users.reduce((n, u) => n + u.buckets.length, 0);
    expect(second.delta.users.buckets.length).toBe(expectedCount);
    // Same invariant on the very first call, where "the cursor" is
    // INITIAL_CURSOR rather than a real one -- users ignores it just as it
    // ignores a real one.
    expect(first.delta.users.buckets.length).toBeGreaterThan(0);
  });

  it('reads the response-time width from the engine field, not by inferring gaps between buckets', () => {
    const all = events();
    const result = runEngine(all);
    const runKey = 'run  response_time';
    const real = result.series.get(runKey);
    if (!real) throw new Error('fixture produced no run-scope response-time series');

    // Thin the buckets so the SMALLEST GAP between what remains is wider
    // than the series' true width -- an inference-based reader (the smallest
    // gap between occupied offsets) would report that wider gap as the
    // width; the engine's own `bucketWidthMs` must not be fooled by it.
    const thinned = real.buckets.filter((_, i) => i % 5 === 0);
    // Guard: the fixture must leave more than one bucket, or there is no gap
    // to be wrong about.
    expect(thinned.length).toBeGreaterThan(1);
    const smallestGapAfterThinning = Math.min(
      ...thinned.slice(1).map((b, i) => b.startOffsetMs - (thinned[i]?.startOffsetMs ?? 0)),
    );
    // Guard: thinning must actually have produced a gap wider than the true
    // width, or this test would pass even with the old, wrong, inferring
    // implementation.
    expect(smallestGapAfterThinning).toBeGreaterThan(real.bucketWidthMs);

    const sparseSeries = new Map(result.series);
    sparseSeries.set(runKey, { ...real, buckets: thinned });
    const sparseResult = { ...result, series: sparseSeries };

    const { delta } = buildDelta('r1', sparseResult, INITIAL_CURSOR, NO_SLA);

    expect(delta.responseTime.widthMs).toBe(real.bucketWidthMs);
  });

  it('reduces the users envelope width to the FINEST scenario, not the coarsest', () => {
    // A tiny users cap forces one scenario -- the one with the longer ACTIVE
    // SPAN -- to coalesce, while a short-lived scenario in the SAME run
    // stays at the base width. Span, not event count, is what decides this
    // (see the comment on `UserSeries#sweep` in packages/statistics/src/users.ts),
    // so two events far apart are enough; volume is irrelevant.
    const engine = new LiveEngine({ maxBucketsUsers: 5 });
    const userEvent = (scenario: string, kind: 'start' | 'end', tsMs: number): CanonicalEvent => ({
      type: 'user', scenario, userId: `${scenario}-1`, kind, tsMs,
    });
    engine.add(userEvent('Soak', 'start', 0));
    engine.add(userEvent('Soak', 'end', 10_000));    // long span -> coalesces
    engine.add(userEvent('Quick', 'start', 0));
    engine.add(userEvent('Quick', 'end', 2_000));     // short span -> stays put

    const result = engine.snapshot({ clone: true });
    const soak = result.users.find((u) => u.scenario === 'Soak');
    const quick = result.users.find((u) => u.scenario === 'Quick');
    if (!soak || !quick) throw new Error('expected both scenarios in the snapshot');

    // Derived, not asserted as a literal: the two scenarios MUST actually
    // disagree for this case to be testing anything.
    expect(soak.bucketWidthMs).toBeGreaterThan(quick.bucketWidthMs);

    const { delta } = buildDelta('r1', result, INITIAL_CURSOR, NO_SLA);

    // The FINER width, not the coarser one.
    expect(delta.users.widthMs).toBe(quick.bucketWidthMs);
    expect(delta.users.widthMs).toBeLessThan(soak.bucketWidthMs);
    // Every emitted offset -- from EITHER scenario -- must be a multiple of
    // the declared width, or a consumer indexing buckets by
    // `startOffsetMs / widthMs` collides two distinct offsets into one
    // index and silently drops a bucket. This is exactly what declaring the
    // COARSER width would break: the Soak scenario's own offsets are
    // multiples of its 4000ms+ width, which are also multiples of the finer
    // declared width (a coarser real width is always a whole multiple of a
    // finer one), so this holds for both scenarios only because the
    // reduction picked the minimum.
    for (const b of delta.users.buckets) {
      expect(b.startOffsetMs % delta.users.widthMs).toBe(0);
    }
  });

  it('carries the source UserBucket\'s started/ended counts, not a hard-coded zero', () => {
    // Three starts and one end for 'Checkout', spread across two buckets --
    // enough that both the per-bucket counts and their SUM disagree with 0,
    // so a regression back to the old hard-coded zeros cannot pass by luck.
    const userEvent = (kind: 'start' | 'end', tsMs: number): CanonicalEvent => ({
      type: 'user', scenario: 'Checkout', userId: `u-${tsMs}`, kind, tsMs,
    });
    const engine = new LiveEngine();
    engine.add(userEvent('start', 0));
    engine.add(userEvent('start', 100));
    engine.add(userEvent('start', 1_200));
    engine.add(userEvent('end', 1_300));

    const result = engine.snapshot({ clone: true });
    const source = result.users.find((u) => u.scenario === 'Checkout');
    if (!source) throw new Error('expected a Checkout scenario in the snapshot');

    const { delta } = buildDelta('r1', result, INITIAL_CURSOR, NO_SLA);
    const published = delta.users.buckets.filter((b) => b.scenario === 'Checkout');

    // Derived from the SAME snapshot the delta was built from, never written
    // down: every published bucket's started/ended must equal its source
    // UserBucket's, at every offset the engine produced -- including the
    // gap-filled bucket between the two occupied ones (`UserSeries#sweep`),
    // which carries started: 0, ended: 0 for real, distinct from a value
    // that was never sent at all.
    expect(published.length).toBe(source.buckets.length);
    for (const origin of source.buckets) {
      const match = published.find((b) => b.startOffsetMs === origin.startOffsetMs);
      if (!match) throw new Error(`delta is missing the bucket at offset ${origin.startOffsetMs}`);
      expect(match.started).toBe(origin.started);
      expect(match.ended).toBe(origin.ended);
    }
    // Guard: the fixture must actually exercise a nonzero count, or the
    // equality checks above would pass just as well under the old bug.
    expect(source.buckets.some((b) => b.started > 0)).toBe(true);
    expect(source.buckets.some((b) => b.ended > 0)).toBe(true);
  });

  it('re-emits a response-time bucket whose count grew, even when it is behind the frontier', () => {
    // engine.ts folds a request into BOTH its start and end bucket, and the
    // tool's log is end-time-ordered -- so a slow request's start-edge
    // bucket can still be behind the cursor by the time that request's own
    // (end-time-positioned) log line is processed. Split the real fixture
    // in half exactly like the upsert case above; the reference log's own
    // response times (p99 > 2400ms against 1000ms buckets, per the design
    // doc) are enough to reproduce this without any synthetic data.
    const all = events();
    const half = Math.floor(all.length / 2);

    const engine = new LiveEngine();
    for (const e of all.slice(0, half)) engine.add(e);
    const first = buildDelta('r1', engine.snapshot({ clone: true }), INITIAL_CURSOR, NO_SLA);

    for (const e of all.slice(half)) engine.add(e);
    const secondSnapshot = engine.snapshot({ clone: true });
    const second = buildDelta('r1', secondSnapshot, first.next, NO_SLA);

    const firstByOffset = new Map(first.delta.responseTime.buckets.map((b) => [b.startOffsetMs, b]));
    const secondOffsets = new Set(second.delta.responseTime.buckets.map((b) => b.startOffsetMs));

    const finalRunSeries = secondSnapshot.series.get('run  response_time');
    if (!finalRunSeries) throw new Error('fixture produced no run-scope response-time series');

    // Buckets the FIRST delta already reported, where the FINAL truth
    // (`secondSnapshot`) now disagrees -- i.e. a bucket that kept
    // accumulating startedCount after it was first published. Derived from
    // the payload, not written down: if the fixture has none, this case
    // cannot exercise the hazard, so it fails loudly here rather than
    // passing vacuously below.
    const changedOffsets = finalRunSeries.buckets
      .filter((b) => {
        const reported = firstByOffset.get(b.startOffsetMs);
        return reported !== undefined && reported.startedCount !== b.startedCount;
      })
      .map((b) => b.startOffsetMs);
    expect(changedOffsets.length).toBeGreaterThan(0);

    // Every one of them must be re-sent on the second tick. Under a
    // frontier-only window (`>= since`, no lookback) this fails for any
    // offset behind `first`'s own frontier.
    for (const offset of changedOffsets) {
      expect(secondOffsets.has(offset)).toBe(true);
    }
  });

  it('the built delta parses through LiveDeltaSchema, proving the producer and the wire contract agree', () => {
    const all = events();
    // The schema requires a real UUID; the other cases' 'r1' would be
    // rejected here, which is the point -- this proves the two actually
    // meet, not just that each is internally consistent.
    const { delta } = buildDelta('0f9b1d4e-1111-2222-3333-444455556666', runEngine(all), INITIAL_CURSOR, NO_SLA);

    expect(() => LiveDeltaSchema.parse(delta)).not.toThrow();
  });

  it('publishes the same latency fields the batch writer would persist for the same bucket', () => {
    // Build a run whose buckets are not uniform, so a wrong-bucket bug shows.
    const result = engineResultFrom([
      { startMs: 0, endMs: 120, ok: true },
      { startMs: 100, endMs: 900, ok: true },
      { startMs: 1200, endMs: 1260, ok: false },
    ]);
    const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR, NO_SLA);

    const source = result.series.get('run  response_time')!.buckets;
    for (const published of delta.responseTime.buckets) {
      const origin = source.find((b) => b.startOffsetMs === published.startOffsetMs)!;
      const expected = bucketLatency(origin);
      expect(published.minMs).toBe(expected.minMs);
      expect(published.maxMs).toBe(expected.maxMs);
      expect(published.meanMs).toBe(expected.meanMs);
      expect(published.percentiles).toEqual(expected.percentiles);
      expect(published.percentilesOk).toEqual(expected.percentilesOk);
      expect(published.percentilesKo).toEqual(expected.percentilesKo);
      expect(published.startedOkCount).toBe(origin.startedOkCount);
      expect(published.startedKoCount).toBe(origin.startedKoCount);
    }
  });

  it('carries run-scope error rows, and no per-endpoint rows', () => {
    const result = engineResultWithErrors([
      { scope: 'run', name: '', message: 'connection reset', count: 7 },
      { scope: 'request', name: 'GET /cart', message: 'connection reset', count: 7 },
    ]);
    const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR, NO_SLA);
    expect(delta.errors.rows).toEqual([{ message: 'connection reset', count: 7 }]);
  });

  // ErrorTally folds everything past its cap into one `message: null` row.
  // Dropping it would make the rows fail to sum to summary.koCount, which is
  // the one arithmetic a reader can check by eye.
  it('keeps the folded remainder row rather than dropping it', () => {
    const result = engineResultWithErrors([
      { scope: 'run', name: '', message: 'timeout', count: 3 },
      { scope: 'run', name: '', message: null, count: 11 },
    ]);
    const { delta } = buildDelta(RUN_ID, result, INITIAL_CURSOR, NO_SLA);
    expect(delta.errors.rows).toContainEqual({ message: null, count: 11 });
  });

  it('carries only the breaching rules, and a count of those evaluated', () => {
    // `buildDeltaWithSla` is a thin wrapper you write over `buildDelta`, so the
    // case reads as one call; it does not exist yet.
    const delta = buildDeltaWithSla({
      assertions: [
        { ruleId: 'a', outcome: 'failed', actualValue: 900, message: 'p95 ≤ 100 — actual 900' },
        { ruleId: 'b', outcome: 'passed', actualValue: 20, message: 'p95 ≤ 100 — actual 20' },
        { ruleId: 'c', outcome: 'not_applicable', actualValue: null, message: 'not checked yet' },
      ],
      breachingSince: new Map([['a', 42_000]]),
    });

    expect(delta.sla.breaching).toEqual([
      { ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 42_000 },
    ]);
    // Passed AND failed count as evaluated; not_applicable did not get judged.
    expect(delta.sla.evaluated).toBe(2);
  });
});

describe('buildSnapshot', () => {
  it('a snapshot carries the whole series, not the lookback window', () => {
    const result = engineResultSpanning(60_000); // many buckets
    const advanced: DeltaCursor = { seq: 12, lastPublishedOffsetMs: 50_000, lastBucketWidthMs: 1000 };

    const { delta } = buildDelta(RUN_ID, result, advanced, NO_SLA);
    const snapshot = buildSnapshot(RUN_ID, result, advanced.seq, NO_SLA);

    const all = result.series.get('run  response_time')!.buckets.length;
    expect(delta.responseTime.buckets.length).toBeLessThan(all);
    expect(snapshot.responseTime.buckets).toHaveLength(all);
    expect(snapshot.seq).toBe(12);
    // A seed replaces whatever a client had; it is never an upsert.
    expect(snapshot.responseTime.replaces).toBe(true);
  });
});
