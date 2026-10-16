import { readFileSync } from 'node:fs';
import type { CanonicalEvent, ErrorEvent, RequestEvent } from '@perfportal/core';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import {
  compare,
  expectedFrom,
  optionsFrom,
  type Expected,
  type ExpectedError,
  type ExpectedErrorBucket,
  type Stored,
  type VerifyOptions,
} from '../src/index.js';

/**
 * `run_error` and `run_error_bucket`, recomputed. Every expectation is written
 * out from the events each case builds — counts tallied by hand, offsets
 * floored by hand — never read back from the verifier and never from an
 * engine run.
 */

const RUN_START = 1_700_000_000_000;

function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return { ...optionsFrom({}, RUN_START), ...over };
}

function req(name: string, startOff: number, endOff: number, ok: boolean, message?: string, groups: string[] = []): RequestEvent {
  const e: RequestEvent = { type: 'request', name, groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, ok };
  if (message !== undefined) e.message = message;
  return e;
}

const ko = (name: string, startOff: number, endOff: number, message?: string, groups: string[] = []): RequestEvent =>
  req(name, startOff, endOff, false, message, groups);

function rec(message: string, off: number): ErrorEvent {
  return { type: 'error', message, tsMs: RUN_START + off };
}

/** One `(scope, name)`'s rows, as `[message, count, isOther]`, ignoring order. */
function rowsOf(e: Expected, scope: string, name: string): [string, number, boolean][] {
  return e.errors
    .filter((r) => r.scope === scope && r.name === name)
    .map((r): [string, number, boolean] => [r.message, r.count, r.isOther])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function bucketsOf(e: Expected): [number, string, number, boolean, number][] {
  return e.errorBuckets
    .map((b): [number, string, number, boolean, number] => [b.startOffsetMs, b.message, b.count, b.isOther, b.bucketWidthMs])
    .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

describe('run_error rows', () => {
  it('labels an absent or empty message "(no message)", for a request and an error record alike', () => {
    const e = expectedFrom([ko('A', 0, 10), ko('A', 20, 30, ''), rec('', 40)], opts());
    expect(rowsOf(e, 'run', '')).toEqual([['(no message)', 3, false]]);
    expect(rowsOf(e, 'request', 'A')).toEqual([['(no message)', 2, false]]);
  });

  it('counts a KO request at run AND request scope, an error record at run scope only, an OK request nowhere', () => {
    const e = expectedFrom(
      [ko('A', 0, 10, 'boom'), ko('B', 0, 10, 'boom', ['G']), rec('session', 50), req('A', 0, 10, true, 'ignored')],
      opts(),
    );
    // run: boom twice (A and G/B), session once; each request: boom once; no
    // row anywhere for the OK request's message, and no request row for the record.
    expect(rowsOf(e, 'run', '')).toEqual([['boom', 2, false], ['session', 1, false]]);
    expect(rowsOf(e, 'request', 'A')).toEqual([['boom', 1, false]]);
    expect(rowsOf(e, 'request', 'G/B')).toEqual([['boom', 1, false]]);
    expect(e.errors.map((r) => `${r.scope}/${r.name}`).sort()).toEqual(['request/A', 'request/G/B', 'run/', 'run/']);
  });

  it('leaves warm-up out: a request by its START, a record by its timestamp', () => {
    const e = expectedFrom(
      [
        ko('A', 1000, 1500, 'early'), // warm-up
        ko('A', 4000, 6000, 'straddles'), // starts in warm-up, ends after: still warm-up
        rec('early-record', 4999), // warm-up
        ko('A', 5000, 5100, 'late'), // 5000 − 0 < 5000 is false: counted
        rec('late-record', 5000),
      ],
      opts({ warmupMs: 5000 }),
    );
    expect(rowsOf(e, 'run', '')).toEqual([['late', 1, false], ['late-record', 1, false]]);
    expect(rowsOf(e, 'request', 'A')).toEqual([['late', 1, false]]);
  });

  it('keeps 200 messages per (scope, name) by count then localeCompare, summing the rest into one other row', () => {
    // 199 records with two hits each fill ranks 1..199. Two KO requests to R,
    // 'apple' and 'Banana', tie at one hit for rank 200. localeCompare puts
    // 'apple' first; a code-unit comparison would put 'Banana' (66) before
    // 'apple' (97). A third, 'cherry', also one hit, sorts after both.
    expect('apple'.localeCompare('Banana')).toBeLessThan(0);
    expect('Banana'.localeCompare('cherry')).toBeLessThan(0);
    const events: CanonicalEvent[] = [];
    const heavy: string[] = [];
    for (let i = 0; i < 199; i += 1) {
      const m = `m${String(i).padStart(3, '0')}`;
      heavy.push(m);
      events.push(rec(m, 10), rec(m, 20));
    }
    events.push(ko('R', 0, 10, 'cherry'), ko('R', 0, 10, 'Banana'), ko('R', 0, 10, 'apple'));
    const e = expectedFrom(events, opts());

    const want: [string, number, boolean][] = [...heavy.map((m): [string, number, boolean] => [m, 2, false]), ['apple', 1, false], ['', 2, true]];
    expect(rowsOf(e, 'run', '')).toEqual(want.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    // R has three messages, well under 200: no cut, no other row.
    expect(rowsOf(e, 'request', 'R')).toEqual([['Banana', 1, false], ['apple', 1, false], ['cherry', 1, false]]);
  });
});

describe('run_error_bucket rows', () => {
  it('attributes a KO request by its END, at the run series width', () => {
    // One request: edges 500 and 2500 → W=1000 (two distinct indexes ≤ 1200).
    const e = expectedFrom([ko('A', 500, 2500, 'x')], opts());
    expect(bucketsOf(e)).toEqual([[2000, 'x', 1, false, 1000]]);
  });

  it('counts KO requests only: never an OK request, never an error record', () => {
    const e = expectedFrom([req('A', 0, 100, true, 'fine'), rec('rec', 1500), ko('A', 200, 300, 'x')], opts());
    expect(bucketsOf(e)).toEqual([[0, 'x', 1, false, 1000]]);
  });

  it('includes warm-up', () => {
    const e = expectedFrom([ko('A', 100, 300, 'w'), ko('A', 9000, 9500, 'x')], opts({ warmupMs: 5000 }));
    expect(bucketsOf(e)).toEqual([[0, 'w', 1, false, 1000], [9000, 'x', 1, false, 1000]]);
    expect(rowsOf(e, 'run', '')).toEqual([['x', 1, false]]);
  });

  it('takes the width of the WHOLE run series, OK requests included, and stores it on every row', () => {
    /*
     * Run series edges (all four requests): -1500 -200 2500 2600 7000 7100 9000 15000.
     * At a cap of 4 the first width with ≤ 4 distinct indexes is 8000 (indexes
     * -1 -1 0 0 0 0 1 1). The one KO request ends at 15000 → index 1 → 8000.
     * Its own two edges alone would fit at W=1000, putting it at 15000.
     */
    const e = expectedFrom(
      [req('A', -1500, -200, true), req('A', 2500, 2600, true), req('A', 7000, 7100, true), ko('A', 9000, 15000, 'slow')],
      opts({ maxBucketsRun: 4 }),
    );
    expect(bucketsOf(e)).toEqual([[8000, 'slow', 1, false, 8000]]);
  });

  it('admits the first 200 distinct messages it sees; a later new one only adds to the other row', () => {
    // 200 messages seen once each, then 'late' ten times: 'late' was never
    // admitted, so it cannot be a top message however often it recurs.
    const events: CanonicalEvent[] = [];
    for (let i = 0; i < 200; i += 1) events.push(ko('A', 0, 10, `m${String(i).padStart(3, '0')}`));
    for (let i = 0; i < 10; i += 1) events.push(ko('A', 0, 10, 'late'));
    const e = expectedFrom(events, opts());
    // Top 5 among the admitted, all tied at one: m000..m004. Other: the 195
    // admitted non-top hits plus the 10 overflow hits.
    expect(bucketsOf(e)).toEqual([
      [0, '', 205, true, 1000],
      [0, 'm000', 1, false, 1000],
      [0, 'm001', 1, false, 1000],
      [0, 'm002', 1, false, 1000],
      [0, 'm003', 1, false, 1000],
      [0, 'm004', 1, false, 1000],
    ]);
  });

  it('keeps rows for the top 5 by RUN-WIDE total (then localeCompare), and an other row only where it is not 0', () => {
    /*
     * Run-wide totals: a 4, b 3, c 2, d 2, e 2, f 2. The top five are a, b
     * and — of the four tied at 2 — c, d, e by localeCompare; f is not top.
     *   bucket 0:    a×3 b×3 c×2 d×2          → no other row
     *   bucket 1000: e×2                       → no other row
     *   bucket 2000: a×1 f×2                   → other 2 (f)
     * A per-bucket ranking would keep f in bucket 2000; the run-wide one does not.
     */
    const at = (off: number, m: string, n: number): RequestEvent[] => Array.from({ length: n }, () => ko('A', off, off + 1, m));
    const e = expectedFrom(
      [...at(0, 'a', 3), ...at(0, 'b', 3), ...at(0, 'c', 2), ...at(0, 'd', 2), ...at(1000, 'e', 2), ...at(2000, 'a', 1), ...at(2000, 'f', 2)],
      opts(),
    );
    expect(bucketsOf(e)).toEqual([
      [0, 'a', 3, false, 1000],
      [0, 'b', 3, false, 1000],
      [0, 'c', 2, false, 1000],
      [0, 'd', 2, false, 1000],
      [1000, 'e', 2, false, 1000],
      [2000, '', 2, true, 1000],
      [2000, 'a', 1, false, 1000],
    ]);
  });

  it('has no error buckets without a KO request', () => {
    expect(expectedFrom([req('A', 0, 10, true), rec('r', 5)], opts()).errorBuckets).toEqual([]);
  });
});

describe('errors on the reference fixture', () => {
  const events = [...parseSimulationLog(readFileSync('fixtures/gatling-3.15.1.2/reference-report/simulation.log'))];
  const meta = events.find((e) => e.type === 'meta')!;
  const e = expectedFrom(events, optionsFrom({}, meta.startedAtMs));
  const kos = events.filter((x): x is RequestEvent => x.type === 'request' && !x.ok).length;
  const records = events.filter((x) => x.type === 'error').length;
  const sum = (rows: { count: number }[]): number => rows.reduce((n, r) => n + r.count, 0);

  it('counts every KO request and every error record at run scope, and only the KO requests per request', () => {
    expect(kos).toBeGreaterThan(0);
    expect(sum(e.errors.filter((r) => r.scope === 'run'))).toBe(kos + records);
    expect(sum(e.errors.filter((r) => r.scope === 'request'))).toBe(kos);
  });

  it('puts every KO request, and nothing else, in the error buckets', () => {
    expect(sum(e.errorBuckets)).toBe(kos);
  });
});

/** A stored copy of what the verifier expects: the shape a faithful engine writes. */
function storedFrom(e: Expected): Stored {
  return structuredClone({ stats: e.stats, series: e.series, errors: e.errors, errorBuckets: e.errorBuckets, users: e.users, run: e.run });
}

describe('compare: errors and error buckets', () => {
  const events: CanonicalEvent[] = [ko('A', 0, 10, 'boom'), ko('A', 1500, 2500, 'bang'), rec('session', 30)];
  const expected = expectedFrom(events, opts());

  function corrupt(mutate: (s: Stored) => void): ReturnType<typeof compare> {
    const stored = storedFrom(expected);
    mutate(stored);
    return compare(expected, stored);
  }

  const errorFigures = (rows: readonly ExpectedError[]): number => rows.reduce((n, r) => n + (r.isOther ? 2 : 1), 0);
  const bucketFigures = (rows: readonly ExpectedErrorBucket[]): number => rows.reduce((n, r) => n + (r.isOther ? 3 : 2), 0);

  it('finds nothing wrong with a faithful copy, and counts every error figure', () => {
    const r = compare(expected, storedFrom(expected));
    expect(r.mismatches).toEqual([]);
    const without = compare(
      { ...expected, errors: [], errorBuckets: [] },
      { ...storedFrom(expected), errors: [], errorBuckets: [] },
    ).figuresChecked;
    // run: boom, bang, session; request A: boom, bang → 5 count figures.
    // Buckets: boom at 0, bang at 2000 → 2 × (count, bucket_width_ms).
    expect(errorFigures(expected.errors)).toBe(5);
    expect(bucketFigures(expected.errorBuckets)).toBe(4);
    expect(r.figuresChecked).toBe(without + 5 + 4);
  });

  it('reports one mismatch for a corrupted run_error count, naming its message', () => {
    const r = corrupt((s) => { s.errors.find((x) => x.scope === 'request' && x.message === 'bang')!.count += 1; });
    expect(r.mismatches).toEqual([
      { scope: 'request', name: 'A', family: 'bang', population: null, bucket: null, table: 'run_error', figure: 'count', stored: 2, recomputed: 1 },
    ]);
  });

  it('reports one mismatch each for a corrupted error-bucket count and bucket width', () => {
    const count = corrupt((s) => { s.errorBuckets.find((x) => x.message === 'bang')!.count = 4; });
    expect(count.mismatches).toEqual([
      { scope: 'run', name: '', family: 'bang', population: null, bucket: 2000, table: 'run_error_bucket', figure: 'count', stored: 4, recomputed: 1 },
    ]);
    const width = corrupt((s) => { s.errorBuckets.find((x) => x.message === 'boom')!.bucketWidthMs = 2000; });
    expect(width.mismatches).toEqual([
      { scope: 'run', name: '', family: 'boom', population: null, bucket: 0, table: 'run_error_bucket', figure: 'bucket_width_ms', stored: 2000, recomputed: 1000 },
    ]);
  });

  it('reports an error row on one side only as one row, carrying its count', () => {
    const missing = corrupt((s) => { s.errors = s.errors.filter((x) => x.message !== 'session'); });
    expect(missing.mismatches).toEqual([
      { scope: 'run', name: '', family: 'session', population: null, bucket: null, table: 'run_error', figure: 'row', stored: null, recomputed: 1 },
    ]);
    const extra = corrupt((s) => { s.errorBuckets.push({ startOffsetMs: 5000, message: 'ghost', isOther: false, count: 3, bucketWidthMs: 1000 }); });
    expect(extra.mismatches).toEqual([
      { scope: 'run', name: '', family: 'ghost', population: null, bucket: 5000, table: 'run_error_bucket', figure: 'row', stored: 3, recomputed: null },
    ]);
  });

  it('never pairs an other row with a real message that happens to be empty, in either table', () => {
    /*
     * 201 distinct messages, all KO requests to A at one second: run_error
     * keeps 200 and puts the 201st in an other row (count 1) at run AND at
     * request scope; the error bucket admits 200, so the 201st is overflow and
     * its other row holds 195 non-top hits plus that 1 = 196. The stored copy
     * claims each of those three is a REAL row whose message is '' instead.
     * Keyed by message alone, each would pair with its expected other row and
     * agree on every figure; keyed with is_other, each is one row missing and
     * one row extra.
     */
    const big: CanonicalEvent[] = [];
    for (let i = 0; i < 201; i += 1) big.push(ko('A', 0, 10, `m${String(i).padStart(3, '0')}`));
    const exp = expectedFrom(big, opts());
    const stored = storedFrom(exp);
    for (const r of stored.errors) if (r.isOther) r.isOther = false;
    for (const b of stored.errorBuckets) if (b.isOther) b.isOther = false;
    expect(compare(exp, stored).mismatches.map((m) => [m.table, m.scope, m.figure, m.stored, m.recomputed]).sort()).toEqual(
      [
        ['run_error', 'request', 'row', 1, null],
        ['run_error', 'request', 'row', null, 1],
        ['run_error', 'run', 'row', 1, null],
        ['run_error', 'run', 'row', null, 1],
        ['run_error_bucket', 'run', 'row', 196, null],
        ['run_error_bucket', 'run', 'row', null, 196],
      ].sort(),
    );
  });

  it('checks an other row’s message is empty', () => {
    const big: CanonicalEvent[] = [];
    for (let i = 0; i < 201; i += 1) big.push(rec(`m${String(i).padStart(3, '0')}`, 10));
    const exp = expectedFrom(big, opts());
    const stored = storedFrom(exp);
    stored.errors.find((x) => x.isOther)!.message = 'not empty';
    expect(compare(exp, stored).mismatches).toEqual([
      { scope: 'run', name: '', family: '', population: null, bucket: null, table: 'run_error', figure: 'message', stored: 'not empty', recomputed: '' },
    ]);
  });
});
