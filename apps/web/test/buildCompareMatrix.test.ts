import type { StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toCompareMatrix, type CompareStats } from '../src/tables/buildCompareMatrix';
import fixture from './fixtures/reference-run.json';

const REFERENCE = fixture.stats as unknown as StatsResponse;

/** Every request name the fixture carries, which is what a full run yields. */
const ALL_REQUESTS = REFERENCE.stats.filter((s) => s.scope === 'request').map((s) => s.name);

function asRun(id: string, over?: (s: StatsResponse) => StatsResponse): CompareStats {
  return { id, label: id, stats: over ? over(REFERENCE) : REFERENCE };
}

/** A copy of the payload with some request rows removed. */
const without = (names: readonly string[]) => (s: StatsResponse): StatsResponse => ({
  ...s,
  stats: s.stats.filter((row) => !(row.scope === 'request' && names.includes(row.name))),
});

describe('toCompareMatrix', () => {
  it('rows are the union of request names across every selected run', () => {
    // A request present in only ONE run still gets a row — a newly added
    // request is exactly what a reader comparing runs is looking for.
    const dropped = ALL_REQUESTS[0]!;
    const m = toCompareMatrix([asRun('a', without([dropped])), asRun('b')], 'p95');

    expect(new Set(m.requests)).toEqual(new Set(ALL_REQUESTS));
  });

  it('a request absent from a run is null, never zero', () => {
    // It did not take zero milliseconds; it did not run. Zero would put it at
    // the top of a sort by speed.
    const dropped = ALL_REQUESTS[0]!;
    const m = toCompareMatrix([asRun('a', without([dropped])), asRun('b')], 'p95');

    const row = m.requests.indexOf(dropped);
    expect(m.cells[row]![0]).toBeNull();
    expect(m.cells[row]![1]).not.toBeNull();
  });

  it('reads the request-scope rows, not the run total', () => {
    const m = toCompareMatrix([asRun('a')], 'p95');
    const first = REFERENCE.stats.find(
      (s) => s.scope === 'request' && s.name === m.requests[0],
    )!;
    expect(m.cells[0]![0]).toBe(first.percentiles.p95);
  });

  it('never lets a group or run row become a request row', () => {
    // `buildTree` and this transform both key on scope; a matrix that included
    // groups would double-count every request underneath them.
    const groups = REFERENCE.stats.filter((s) => s.scope === 'group').map((s) => s.name);
    expect(groups.length).toBeGreaterThan(0);

    const m = toCompareMatrix([asRun('a')], 'p95');
    for (const group of groups) expect(m.requests).not.toContain(group);
  });

  it('yields null for a percentile this run’s project does not configure', () => {
    // The set is per project. A run without p99 must not silently answer with
    // a neighbouring percentile.
    const stripped = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) =>
        row.scope === 'request'
          ? { ...row, percentiles: { p50: row.percentiles.p50! } }
          : row,
      ),
    });

    const m = toCompareMatrix([asRun('a', stripped), asRun('b')], 'p99');
    expect(m.cells[0]![0]).toBeNull();
    expect(m.cells[0]![1]).not.toBeNull();
  });

  it('reads max from maxMs rather than from the percentile map', () => {
    const m = toCompareMatrix([asRun('a')], 'max');
    const first = REFERENCE.stats.find(
      (s) => s.scope === 'request' && s.name === m.requests[0],
    )!;
    expect(m.cells[0]![0]).toBe(first.maxMs);
  });

  it('reports errors as a rate, the same quantity the overlay plots', () => {
    // The selector says "Errors" in both places, so it must mean one thing.
    // A count here and a rate there is exactly the divergence this codebase
    // keeps a single formatter to prevent.
    const m = toCompareMatrix([asRun('a')], 'errors');
    const withKo = REFERENCE.stats.find((s) => s.scope === 'request' && s.koCount > 0)!;
    const row = m.requests.indexOf(withKo.name);
    expect(m.cells[row]![0]).toBeCloseTo(withKo.throughputRps * withKo.errorRate, 9);
  });

  it('keeps one column per selected run, in selection order', () => {
    const m = toCompareMatrix([asRun('first'), asRun('second'), asRun('third')], 'p95');
    expect(m.labels).toEqual(['first', 'second', 'third']);
    for (const row of m.cells) expect(row).toHaveLength(3);
  });

  it('sorts rows stably so two runs of the same payload agree', () => {
    const a = toCompareMatrix([asRun('a')], 'p95');
    const b = toCompareMatrix([asRun('b'), asRun('c')], 'p95');
    // The shared names appear in the same relative order in both.
    const shared = a.requests.filter((n) => b.requests.includes(n));
    expect(shared).toEqual(b.requests.filter((n) => a.requests.includes(n)));
  });

  it('is empty, not throwing, for no runs at all', () => {
    const m = toCompareMatrix([], 'p95');
    expect(m.requests).toEqual([]);
    expect(m.cells).toEqual([]);
  });
});
