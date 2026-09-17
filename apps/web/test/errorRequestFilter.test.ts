import { describe, expect, it } from 'vitest';
import type { StatsResponse } from '@perfportal/contracts';
import { failingRequestNames } from '../src/routes/errorRequestFilter';

/** A stats row with only the fields this derivation reads. */
function row(scope: string, name: string, koCount: number): StatsResponse['stats'][number] {
  return {
    scope,
    name,
    count: koCount + 10,
    okCount: 10,
    koCount,
    minMs: 1,
    maxMs: 2,
    meanMs: 1.5,
    stddevMs: 0,
    percentiles: {},
    errorRate: 0,
    throughputRps: 1,
    family: 'response_time',
    indicators: { under: 0, between: 0, over: 0, failed: koCount },
  } as unknown as StatsResponse['stats'][number];
}

const payload = (rows: readonly StatsResponse['stats'][number][]): StatsResponse =>
  ({ runId: 'r', stats: rows }) as unknown as StatsResponse;

describe('failingRequestNames', () => {
  it('offers only requests that actually failed', () => {
    // The whole point: a request with no failures has no errors to show, so
    // offering it spends the reader's decision to land them on an empty table.
    expect(
      failingRequestNames(
        payload([row('request', 'Search', 0), row('request', 'Place Order', 8), row('request', 'List Products', 0)]),
      ),
    ).toEqual(['Place Order']);
  });

  it('orders by failures descending, so the worst is first', () => {
    expect(
      failingRequestNames(
        payload([row('request', 'Place Order', 8), row('request', 'Add To Cart', 15)]),
      ),
    ).toEqual(['Add To Cart', 'Place Order']);
  });

  it('breaks ties by name, so the list is stable between renders', () => {
    // Without this the order is whatever the engine emitted, and two renders of
    // the SAME payload can disagree — a select whose options reshuffle under
    // the cursor.
    expect(
      failingRequestNames(payload([row('request', 'Zebra', 3), row('request', 'Alpha', 3)])),
    ).toEqual(['Alpha', 'Zebra']);
  });

  it('excludes run and group scopes', () => {
    // `run` is the unfiltered view the control already offers as "All
    // requests", and a group's failures are its requests' failures counted
    // again — offering either would let a reader pick two options that are the
    // same errors under different names.
    expect(
      failingRequestNames(
        payload([row('run', '', 23), row('group', 'Cart', 15), row('request', 'Add To Cart', 15)]),
      ),
    ).toEqual(['Add To Cart']);
  });

  it('returns nothing when no request failed, so the control can withhold itself', () => {
    expect(failingRequestNames(payload([row('request', 'Search', 0), row('run', '', 0)]))).toEqual([]);
  });
});
