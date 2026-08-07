import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { IngestError, type CanonicalEvent, type GroupEvent } from '@perfportal/core';

const base = 1_000_000;
const req = (name: string, groups: string[], off: number, dur: number, ok = true): CanonicalEvent => ({
  type: 'request', name, groups, userId: 'u', startMs: base + off, endMs: base + off + dur, ok,
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
    expect(names).toEqual(['A', 'B', 'C']);
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

  it('excludes warm-up from summary stats but keeps it in the series', () => {
    // warmupMs 50 covers only the request starting at offset 0; the others start at 100 and 300.
    const r = runEngine(events, { warmupMs: 50 });
    const run = r.stats.find((s) => s.scope === 'run')!;
    expect(run.count).toBe(2);                               // the 0ms-offset request is warm-up
    const runSeries = r.series.get('run:')!;
    const total = runSeries.reduce((n, b) => n + b.endedCount, 0);
    expect(total).toBe(3);                                   // series still has all three
  });

  it('preserves a request name containing a colon (round-trip must not parse a composite key)', () => {
    const colonEvents: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
      req('GET /v1:users', [], 0, 100),
    ];
    const r = runEngine(colonEvents);
    const ep = r.stats.find((s) => s.scope === 'request')!;
    expect(ep.name).toBe('GET /v1:users');
    // series key must refer to the same endpoint, not a truncated one.
    const seriesEntry = [...r.series.entries()].find(([k]) => k !== 'run:');
    expect(seriesEntry?.[0]).toContain('GET /v1:users');
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
});
