import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { IngestError, type CanonicalEvent, type GroupEvent } from '@perfportal/core';

const base = 1_000_000;
const req = (name: string, groups: string[], off: number, dur: number, ok = true, message?: string): CanonicalEvent => ({
  type: 'request', name, groups, userId: 'u', startMs: base + off, endMs: base + off + dur, ok, message,
});

describe('runEngine scope fan-out', () => {
  const events: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
    req('A', ['G1'], 0, 100),
    req('B', ['G1'], 100, 200),
    req('C', [], 300, 300, false),
  ];

  it('produces a run scope plus one scope per request name', () => {
    const r = runEngine(events);
    const run = r.stats.find((s) => s.scope === 'run')!;
    expect(run.count).toBe(3);
    expect(run.koCount).toBe(1);
    const names = r.stats.filter((s) => s.scope === 'request').map((s) => s.name).sort();
    expect(names).toEqual(['C', 'G1/A', 'G1/B']);
  });

  it('rejects a run that exceeds the endpoint cardinality cap', () => {
    const many: CanonicalEvent[] = [{ type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base }];
    for (let i = 0; i < 12; i++) many.push(req(`ep-${i}`, [], i, 10));
    expect.assertions(3);
    try {
      runEngine(many, { maxEndpoints: 10 });
    } catch (err) {
      expect(err).toBeInstanceOf(IngestError);
      const e = err as IngestError;
      expect(e.code).toBe('ENDPOINT_CARDINALITY_EXCEEDED');
      expect(e.remediation.length).toBeGreaterThan(0);
    }
  });

  it('counts endpoints by path, so one name under many groups is many endpoints', () => {
    // D-12. The cap exists to bound STORED ROLLUPS. One bare name under twelve
    // groups is twelve rollups; a cap counting bare names would see one and
    // let a run through that the engine then materialises twelve times over.
    const many: CanonicalEvent[] = [{ type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base }];
    for (let i = 0; i < 12; i++) many.push(req('same', [`G${i}`], i, 10));
    expect(() => runEngine(many, { maxEndpoints: 10 })).toThrow(IngestError);
  });

  it('excludes warm-up from summary stats but keeps it in the series', () => {
    // warmupMs 50 covers only the request starting at offset 0; the others start at 100 and 300.
    const r = runEngine(events, { warmupMs: 50 });
    const run = r.stats.find((s) => s.scope === 'run')!;
    expect(run.count).toBe(2);                               // the 0ms-offset request is warm-up
    const runSeries = [...r.series.values()].find((v) => v.scope === 'run')!;
    const total = runSeries.buckets.reduce((n, b) => n + b.endedCount, 0);
    expect(total).toBe(3);                                   // series still has all three
  });

  it('preserves a request name containing a colon (no consumer ever parses a composite key)', () => {
    const colonEvents: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
      req('GET /v1:users', [], 0, 100),
    ];
    const r = runEngine(colonEvents);
    const ep = r.stats.find((s) => s.scope === 'request')!;
    expect(ep.name).toBe('GET /v1:users');
    // series entry must carry the exact, untruncated name via its structured field.
    const seriesEntry = [...r.series.values()].find((v) => v.scope === 'request')!;
    expect(seriesEntry.name).toBe('GET /v1:users');
  });
});

describe('group scopes', () => {
  const grp = (groups: string[], start: number, end: number, cumulated: number): GroupEvent => ({
    type: 'group', groups, userId: 'u', startMs: base + start, endMs: base + end,
    cumulatedResponseTimeMs: cumulated, ok: true,
  });

  it('records cumulated response time and wall-clock duration as separate families', () => {
    const r = runEngine([
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      req('A', ['Catalog'], 0, 100),
      grp(['Catalog'], 0, 500, 300),          // duration 500, cumulated 300 — deliberately different
      grp(['Catalog', 'Recommendations'], 0, 200, 150),
    ]);
    const cumulated = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_cumulated')!;
    const duration = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_duration')!;
    expect(cumulated.maxMs).toBe(300);
    expect(duration.maxMs).toBe(500);
    const nested = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog/Recommendations');
    expect(nested).toBeDefined();
  });

  it('keeps a group name containing the rollup map delimiter distinct (no collision or truncation)', () => {
    // The engine keys its internal rollup map on "<scope> <name> <family>" (space-joined).
    // A group name that itself contains a space, including one that looks like a fake
    // trailing family token, must not collide with — or get truncated into — another
    // entry. This mirrors the colon-in-request-name bug fixed for request scopes above.
    const trickyName = 'Catalog group_duration Weird/Nested group';
    const r = runEngine([
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      grp([trickyName], 0, 500, 111),                    // tricky group: cumulated 111, duration 500
      grp(['Catalog', 'Recommendations'], 0, 999, 222),  // unrelated real nested group: cumulated 222, duration 999
    ]);

    const trickyCumulated = r.stats.find((s) => s.scope === 'group' && s.name === trickyName && s.family === 'group_cumulated');
    const trickyDuration = r.stats.find((s) => s.scope === 'group' && s.name === trickyName && s.family === 'group_duration');
    const realCumulated = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog/Recommendations' && s.family === 'group_cumulated');
    const realDuration = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog/Recommendations' && s.family === 'group_duration');

    expect(trickyCumulated?.name).toBe(trickyName);        // full name preserved, not truncated
    expect(trickyCumulated?.maxMs).toBe(111);
    expect(trickyDuration?.maxMs).toBe(500);
    expect(realCumulated?.maxMs).toBe(222);                // unaffected by the tricky entry
    expect(realDuration?.maxMs).toBe(999);

    // Exactly 4 group rows total (2 names x 2 families) — no entries merged into one.
    const groupRows = r.stats.filter((s) => s.scope === 'group');
    expect(groupRows).toHaveLength(4);
  });

  it('excludes warm-up group events from group rollups, matching the request path', () => {
    // warmupMs 50 covers only the group starting at offset 0; the other starts at 100.
    const r = runEngine([
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      grp(['Catalog'], 0, 200, 100),     // warm-up: start offset 0 < warmupMs 50
      grp(['Catalog'], 100, 400, 250),   // post-warm-up: start offset 100 >= warmupMs 50
    ], { warmupMs: 50 });

    const cumulated = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_cumulated')!;
    const duration = r.stats.find((s) => s.scope === 'group' && s.name === 'Catalog' && s.family === 'group_duration')!;

    expect(cumulated.count).toBe(1);           // only the post-warm-up group counted
    expect(cumulated.maxMs).toBe(250);          // the warm-up group's 100 must not appear
    expect(duration.count).toBe(1);
    expect(duration.maxMs).toBe(300);           // 400 - 100, not the warm-up group's 200
  });

  it('emits a series per family for one group name', () => {
    const r = runEngine([
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      req('A', ['Catalog'], 0, 100),
      grp(['Catalog'], 0, 500, 300),          // duration 500, cumulated 300 — deliberately different
      grp(['Catalog', 'Recommendations'], 0, 200, 150),
    ]);
    const catalog = [...r.series.values()].filter(
      (v) => v.scope === 'group' && v.name === 'Catalog',
    );

    expect(catalog.map((v) => v.family).sort()).toEqual([
      'group_cumulated',
      'group_duration',
    ]);

    // The file's `grp(['Catalog'], 0, 500, 300)` is annotated "duration 500,
    // cumulated 300 — deliberately different", so a single series reused for
    // both families would make these sketches equal.
    const cumulated = catalog.find((v) => v.family === 'group_cumulated')!;
    const duration = catalog.find((v) => v.family === 'group_duration')!;
    const maxOf = (v: typeof cumulated) => Math.max(...v.buckets.map((b) => b.sketch.max));
    expect(maxOf(cumulated)).not.toBe(maxOf(duration));
  });
});

describe('runEngine error accounting', () => {
  it('reconciles the run scope KO count with sum(errors[].count) even when some failures carry no message', () => {
    const events: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base },
      req('A', [], 0, 10, true),
      req('B', [], 10, 10, false, 'timeout'),
      req('C', [], 20, 10, false, 'timeout'),
      req('D', [], 30, 10, false),                // failed, no message at all
      req('E', [], 40, 10, false, ''),             // failed, empty-string message
    ];
    const r = runEngine(events);
    const run = r.stats.find((s) => s.scope === 'run')!;
    const runErrors = r.errors.filter((e) => e.scope === 'run');
    const errorTotal = runErrors.reduce((n, e) => n + e.count, 0);
    expect(run.koCount).toBe(4);
    expect(errorTotal).toBe(run.koCount);      // totals must reconcile, not just both be positive
    const noMessageRow = runErrors.find((e) => e.message === '(no message)');
    expect(noMessageRow?.count).toBe(2);                // the unset-message and empty-message failures
  });
});
