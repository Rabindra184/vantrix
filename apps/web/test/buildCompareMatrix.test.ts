import type { StatsResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import {
  resolveReference,
  toCompareMatrix,
  type CompareMatrix,
  type CompareStats,
} from '../src/tables/buildCompareMatrix';
import fixture from './fixtures/reference-run.json';

const REFERENCE = fixture.stats as unknown as StatsResponse;

/** Every request name the fixture carries, which is what a full run yields. */
const ALL_REQUESTS = REFERENCE.stats.filter((s) => s.scope === 'request').map((s) => s.name);
const RUN_ROW = REFERENCE.stats.find((s) => s.scope === 'run')!;

function asRun(
  id: string,
  over?: (s: StatsResponse) => StatsResponse,
  exact = true,
  extra: Partial<Pick<CompareStats, 'peakUsers' | 'cpu' | 'stats'>> = {},
): CompareStats {
  return {
    id,
    label: id,
    exact,
    stats: over ? over(REFERENCE) : REFERENCE,
    peakUsers: null,
    cpu: null,
    ...extra,
  };
}

/** A copy of the payload with some request rows removed. */
const without = (names: readonly string[]) => (s: StatsResponse): StatsResponse => ({
  ...s,
  stats: s.stats.filter((row) => !(row.scope === 'request' && names.includes(row.name))),
});

/** A copy with every row's p95 scaled — a known change on every row. */
const scaledP95 = (factor: number) => (s: StatsResponse): StatsResponse => ({
  ...s,
  stats: s.stats.map((row) => ({
    ...row,
    percentiles: { ...row.percentiles, p95: (row.percentiles.p95 ?? 0) * factor },
  })),
});

const labels = (m: CompareMatrix) => m.rows.map((r) => r.label);
const requestRows = (m: CompareMatrix) => m.rows.filter((r) => r.kind === 'request');
const rowNamed = (m: CompareMatrix, label: string) => m.rows.find((r) => r.label === label)!;

describe('toCompareMatrix — columns and the reference', () => {
  it('orders the reference first', () => {
    const m = toCompareMatrix([asRun('a'), asRun('b'), asRun('c')], 'p95', 'b');
    expect(m.columns.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(m.columns.map((c) => c.reference)).toEqual([true, false, false]);
  });

  it('puts a change on every non-reference cell', () => {
    const m = toCompareMatrix(
      [asRun('a'), asRun('b', scaledP95(2)), asRun('c', scaledP95(3))],
      'p95',
      'a',
    );
    for (const row of m.rows) {
      expect(row.cells[0]?.change, row.label).toBeNull();
      const chips = row.cells.filter((cell) => cell?.change != null);
      expect(chips, row.label).toHaveLength(2);
    }
  });

  it('measures each change against the reference cell, from the payload', () => {
    const m = toCompareMatrix([asRun('ref'), asRun('slow', scaledP95(2))], 'p95', 'ref');
    const all = rowNamed(m, 'All requests');
    const [base, cell] = [all.cells[0]!, all.cells[1]!];
    expect(base.value).toBe(RUN_ROW.percentiles.p95);
    expect(cell.change!.absolute).toBeCloseTo(cell.value - base.value, 6);
    expect(cell.change!.percent).toBeCloseTo(((cell.value - base.value) / base.value) * 100, 6);
    // p95 doubling is worse, and the direction comes from the shared rule.
    expect(cell.change!.good).toBe(false);
  });

  it('reads the direction from the metric, so more throughput is good', () => {
    const up = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) => ({ ...row, throughputRps: row.throughputRps * 2 })),
    });
    const m = toCompareMatrix([asRun('ref'), asRun('up', up)], 'throughput', 'ref');
    expect(rowNamed(m, 'Value').cells[1]!.change!.good).toBe(true);
  });

  it('an unchanged figure is neither good nor bad', () => {
    const m = toCompareMatrix([asRun('ref'), asRun('twin')], 'p95', 'ref');
    const change = rowNamed(m, 'All requests').cells[1]!.change!;
    expect(change.absolute).toBe(0);
    expect(change.percent).toBe(0);
    expect(change.good).toBeNull();
  });

  it('a null cell has no change chip', () => {
    // A legacy estimated row that never stored p99.9: its cell is null — not a
    // zero, not a neighbouring rank — and so it carries no change either.
    const m = toCompareMatrix([asRun('ref'), asRun('legacy', undefined, false)], 'p99.9', 'ref');
    const withRank = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) => ({ ...row, percentiles: { ...row.percentiles, 'p99.9': row.maxMs } })),
    });
    const mixed = toCompareMatrix([asRun('ref', withRank), asRun('legacy')], 'p99.9', 'ref');
    for (const row of mixed.rows) expect(row.cells[1], row.label).toBeNull();
    // ...and the reverse: a reference with no value gives the others no change.
    const flipped = toCompareMatrix([asRun('legacy'), asRun('ref', withRank)], 'p99.9', 'legacy');
    for (const row of flipped.rows) {
      expect(row.cells[0], row.label).toBeNull();
      expect(row.cells[1]?.change, row.label).toBeNull();
      expect(row.cells[1]?.value, row.label).not.toBeUndefined();
    }
    // Both null: nothing at all, never a zero.
    for (const row of m.rows) expect(row.cells, row.label).toEqual([null, null]);
  });

  it('a zero reference has an absolute change and no percent', () => {
    const noErrors = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) => ({ ...row, koCount: 0, errorRate: 0 })),
    });
    const m = toCompareMatrix([asRun('clean', noErrors), asRun('now')], 'errors', 'clean');
    const count = rowNamed(m, 'Count').cells[1]!;
    expect(count.change!.percent).toBeNull();
    expect(count.change!.absolute).toBe(RUN_ROW.koCount);
    expect(count.change!.good).toBe(false);
  });

  it('offers no reference and no change when the reference is not among the runs', () => {
    const m = toCompareMatrix([asRun('a'), asRun('b', scaledP95(2))], 'p95', 'gone');
    expect(m.columns.map((c) => c.id)).toEqual(['a', 'b']);
    expect(m.columns.every((c) => !c.reference)).toBe(true);
    for (const row of m.rows) for (const cell of row.cells) expect(cell?.change ?? null).toBeNull();
  });

  it('a run with no figures for the window is null in every row', () => {
    const m = toCompareMatrix(
      [asRun('ref'), asRun('ended', undefined, true, { stats: null, peakUsers: 9 })],
      'users',
      'ref',
    );
    for (const row of m.rows) expect(row.cells[1], row.label).toBeNull();
    const p = toCompareMatrix([asRun('ref'), asRun('ended', undefined, true, { stats: null })], 'p95', 'ref');
    for (const row of p.rows) expect(row.cells[1], row.label).toBeNull();
  });
});

describe('toCompareMatrix — rows per metric', () => {
  it('a percentile has All requests, then every request', () => {
    const m = toCompareMatrix([asRun('a')], 'p95', 'a');
    expect(labels(m)).toEqual(['All requests', ...ALL_REQUESTS]);
    expect(m.rows[0]!.kind).toBe('summary');
    expect(rowNamed(m, 'All requests').cells[0]!.value).toBe(RUN_ROW.percentiles.p95);
  });

  it('max reads maxMs rather than the percentile map', () => {
    const m = toCompareMatrix([asRun('a')], 'max', 'a');
    expect(rowNamed(m, 'All requests').cells[0]!.value).toBe(RUN_ROW.maxMs);
    const first = REFERENCE.stats.find((s) => s.scope === 'request' && s.name === ALL_REQUESTS[0])!;
    expect(rowNamed(m, ALL_REQUESTS[0]!).cells[0]!.value).toBe(first.maxMs);
  });

  it('throughput has Value before the requests', () => {
    const m = toCompareMatrix([asRun('a')], 'throughput', 'a');
    expect(labels(m)).toEqual(['Value', ...ALL_REQUESTS]);
    expect(rowNamed(m, 'Value').cells[0]!.value).toBe(RUN_ROW.throughputRps);
  });

  it('errors has Count and Ratio before the requests', () => {
    const m = toCompareMatrix([asRun('a')], 'errors', 'a');
    expect(labels(m)).toEqual(['Count', 'Ratio', ...ALL_REQUESTS]);
    expect(rowNamed(m, 'Count').cells[0]!.value).toBe(RUN_ROW.koCount);
    expect(rowNamed(m, 'Ratio').cells[0]!.value).toBe(RUN_ROW.errorRate);
    // Per request, the same unit as Count — a count, never a rate.
    const withKo = REFERENCE.stats.find((s) => s.scope === 'request' && s.koCount > 0)!;
    expect(rowNamed(m, withKo.name).cells[0]!.value).toBe(withKo.koCount);
  });

  it('users has a single Max row', () => {
    const m = toCompareMatrix(
      [asRun('a', undefined, true, { peakUsers: 12 }), asRun('b', undefined, true, { peakUsers: 15 })],
      'users',
      'a',
    );
    expect(labels(m)).toEqual(['Max']);
    expect(m.rows[0]!.cells.map((c) => c?.value)).toEqual([12, 15]);
    // Users have no direction: the chip is neutral, never good or bad.
    expect(m.rows[0]!.cells[1]!.change).toEqual({ absolute: 3, percent: 25, good: null });
  });

  it('cpu has Mean and Max', () => {
    const m = toCompareMatrix(
      [
        asRun('a', undefined, true, { cpu: { mean: 20, max: 40 } }),
        asRun('b', undefined, true, { cpu: null }),
      ],
      'cpu',
      'a',
    );
    expect(labels(m)).toEqual(['Mean', 'Max']);
    expect(m.rows.map((r) => r.cells[0]?.value)).toEqual([20, 40]);
    // A run with no CPU recorded is a dash, not a zero.
    expect(m.rows.map((r) => r.cells[1])).toEqual([null, null]);
  });

  it('rows are the union of request names, in first-seen selection order', () => {
    const dropped = ALL_REQUESTS[0]!;
    const m = toCompareMatrix([asRun('a', without([dropped])), asRun('b')], 'p95', 'a');
    expect(new Set(requestRows(m).map((r) => r.label))).toEqual(new Set(ALL_REQUESTS));
    const row = rowNamed(m, dropped);
    expect(row.cells[0]).toBeNull();
    expect(row.cells[1]).not.toBeNull();
  });

  it('moving the reference does not reorder the rows', () => {
    const runs = [asRun('a', without([ALL_REQUESTS[0]!])), asRun('b')];
    expect(labels(toCompareMatrix(runs, 'p95', 'a'))).toEqual(labels(toCompareMatrix(runs, 'p95', 'b')));
  });

  it('never lets a group row become a request row', () => {
    const groups = REFERENCE.stats.filter((s) => s.scope === 'group').map((s) => s.name);
    expect(groups.length).toBeGreaterThan(0);
    const m = toCompareMatrix([asRun('a')], 'p95', 'a');
    for (const group of groups) expect(requestRows(m).map((r) => r.label)).not.toContain(group);
  });

  it('yields null for a percentile this run’s project does not configure', () => {
    const stripped = (s: StatsResponse): StatsResponse => ({
      ...s,
      stats: s.stats.map((row) => ({ ...row, percentiles: { p50: row.percentiles.p50! } })),
    });
    const m = toCompareMatrix([asRun('a', stripped), asRun('b')], 'p99', 'a');
    for (const row of m.rows) {
      expect(row.cells[0], row.label).toBeNull();
      expect(row.cells[1], row.label).not.toBeNull();
    }
  });

  it('is empty, not throwing, for no runs at all', () => {
    const m = toCompareMatrix([], 'p95', null);
    expect(m.columns).toEqual([]);
    expect(m.rows).toEqual([{ label: 'All requests', kind: 'summary', cells: [] }]);
  });
});

describe('toCompareMatrix — which columns are estimates', () => {
  it('marks each run column by its own run', () => {
    const m = toCompareMatrix([asRun('a'), asRun('b', undefined, false)], 'p95', 'a');
    expect(m.columns.map((c) => c.exact)).toEqual([true, false]);
  });

  it('makes no estimate claim for a metric that is not a percentile', () => {
    for (const metric of ['max', 'throughput', 'errors', 'users', 'cpu'] as const) {
      const m = toCompareMatrix([asRun('a', undefined, false), asRun('b', undefined, false)], metric, 'a');
      expect(m.columns.map((c) => c.exact), metric).toEqual([true, true]);
    }
  });
});

describe('resolveReference', () => {
  const runs = [asRun('current'), asRun('second'), asRun('third')];

  it('honours a requested run that is among the runs', () => {
    expect(resolveReference(runs, 'third', 'current')).toBe('third');
    // Pinning the current run itself is allowed: it is a run like any other.
    expect(resolveReference(runs, 'current', 'current')).toBe('current');
  });

  it('falls back when the reference has no stats', () => {
    // A pin naming a run whose statistics failed to load is not among the runs
    // the page hands over, so the default applies — never a missing column.
    expect(resolveReference(runs, 'failed-to-load', 'current')).toBe('second');
    expect(resolveReference(runs, null, 'current')).toBe('second');
  });

  it('is null with nothing to compare against', () => {
    expect(resolveReference([asRun('current')], null, 'current')).toBeNull();
    expect(resolveReference([], 'x', 'current')).toBeNull();
  });
});
