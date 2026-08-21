import { describe, expect, it } from 'vitest';
import type { TrendRun, TrendsResponse } from '@perfportal/contracts';
import { baselineRun } from '../src/routes/runBaseline';

/**
 * `baselineRun` is the one thing on the Overview tab that reads the cohort,
 * and it shipped reading it BY POSITION — `runs[here + 1]`, with
 * `runs[here - 1]` as a fallback. `TrendsResponseSchema`'s own docstring
 * forbids exactly that, and the case that proves why is the fourth one
 * below: the asked-about run is ADDED BACK when it falls outside the newest
 * `limit`, so it lands last with a neighbour it has nothing to do with.
 *
 * Every expectation here is derived from the fixture's own timestamps rather
 * than written down, which is what stops it going stale if the shape moves.
 */
function trendRun(id: string, toolStartedAt: string | null, startedAt: string): TrendRun {
  return {
    id,
    startedAt,
    toolStartedAt,
    durationMs: 1000,
    verdict: 'passed',
    count: 1,
    okCount: 1,
    koCount: 0,
    errorRate: 0,
    minMs: 1,
    maxMs: 2,
    meanMs: 1.5,
    throughputRps: 1,
    percentiles: { p95: 2 },
  };
}

function trends(runs: readonly TrendRun[]): TrendsResponse {
  return {
    runId: runs[0]?.id ?? '',
    simulation: 'example.ParitySimulation',
    cohortSize: runs.length,
    runs: [...runs],
  };
}

// Newest first, which is the order `/v1/runs/:id/trends` documents.
const NEWEST = trendRun('newest', '2026-08-20T10:00:00.000Z', '2026-08-20T11:00:00.000Z');
const MIDDLE = trendRun('middle', '2026-08-19T10:00:00.000Z', '2026-08-19T11:00:00.000Z');
const OLDEST = trendRun('oldest', '2026-08-18T10:00:00.000Z', '2026-08-18T11:00:00.000Z');

describe('baselineRun', () => {
  it('picks the run immediately before this one in time', () => {
    expect(baselineRun(trends([NEWEST, MIDDLE, OLDEST]), 'middle')).toBe(OLDEST);
    expect(baselineRun(trends([NEWEST, MIDDLE, OLDEST]), 'newest')).toBe(MIDDLE);
  });

  it('has no baseline for the oldest run in the window, rather than a newer one', () => {
    // The tiles say "vs previous". The oldest run in the window has no
    // previous, and the run AFTER it is not one — comparing against it under
    // that wording is what the old `runs[here - 1]` fallback did.
    expect(baselineRun(trends([NEWEST, MIDDLE, OLDEST]), 'oldest')).toBeNull();
  });

  /**
   * THE CASE POSITION CANNOT GET RIGHT.
   *
   * `/trends` returns the newest `limit` runs and then adds the asked-about
   * run back when it is older than all of them, so `runs` is
   * newest-first-then-one-outlier and the last two entries are NOT adjacent
   * in time. Read by position, the outlier's "previous" was `runs[here - 1]`
   * — the OLDEST run of the newest-limit window, which is NEWER than it by
   * however long the window spans.
   */
  it('does not treat the added-back run as adjacent to the window above it', () => {
    const outlier = trendRun('outlier', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    const page = trends([NEWEST, MIDDLE, OLDEST, outlier]);

    // Derived, not written down: every other entry is newer than the
    // outlier, so nothing in this payload can be its previous run.
    const everythingElseIsNewer = page.runs
      .filter((run) => run.id !== outlier.id)
      .every((run) => Date.parse(run.toolStartedAt ?? run.startedAt) > Date.parse(outlier.toolStartedAt!));
    expect(everythingElseIsNewer).toBe(true);

    expect(baselineRun(page, 'outlier')).toBeNull();
  });

  it('orders by tool start when present and by ingest time when it is not', () => {
    // The ordering value is COALESCE(tool_started_at, started_at), the same
    // expression RunRepository.list and TRENDS_SQL sort on. These two rows
    // disagree about which is newer depending on which field you read:
    // by `startedAt` alone `ingested` is newest, by the coalesced value it
    // is the oldest thing here.
    const ingested = trendRun('ingested', null, '2026-08-19T12:00:00.000Z');
    const tooled = trendRun('tooled', '2026-08-19T13:00:00.000Z', '2026-08-01T00:00:00.000Z');
    expect(baselineRun(trends([tooled, ingested]), 'tooled')).toBe(ingested);
    expect(baselineRun(trends([tooled, ingested]), 'ingested')).toBeNull();
  });

  it('has no baseline before the cohort has loaded, or for a run outside it', () => {
    expect(baselineRun(undefined, 'middle')).toBeNull();
    expect(baselineRun(trends([NEWEST, MIDDLE]), 'not-in-this-cohort')).toBeNull();
  });

  it('skips a run sharing this one’s instant rather than calling it previous', () => {
    const twin = trendRun('twin', MIDDLE.toolStartedAt, MIDDLE.startedAt);
    expect(baselineRun(trends([NEWEST, MIDDLE, twin]), 'middle')).toBeNull();
  });
});
