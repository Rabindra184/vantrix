import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { IngestError, type CanonicalEvent } from '@perfportal/core';

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
