import { describe, expect, it } from 'vitest';
import { runEngine, BUCKET_PERCENTILES } from '../src/engine.js';
import type { CanonicalEvent } from '@perfportal/core';

describe('engine — parity additions', () => {
  const events = (): CanonicalEvent[] => [
    { type: 'meta', simulation: 'ParitySimulation', toolVersion: '3.15.1', startedAtMs: 1_000, description: 'a run' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'start', tsMs: 1_000 },
    { type: 'user', scenario: 'Checkout', userId: '2', kind: 'start', tsMs: 1_500 },
    { type: 'request', name: 'list', groups: [], scenario: 'Browse', userId: '1', startMs: 1_000, endMs: 1_100, ok: true },
    { type: 'request', name: 'buy', groups: [], scenario: 'Checkout', userId: '2', startMs: 1_500, endMs: 2_400, ok: false, message: 'boom' },
    { type: 'user', scenario: 'Browse', userId: '1', kind: 'end', tsMs: 2_000 },
  ];

  it('no longer discards user events', () => {
    const r = runEngine(events());
    const names = r.users.map((u) => u.scenario);
    expect(names).toEqual(['Browse', 'Checkout']);
    expect(r.users[0]?.buckets[0]?.started).toBe(1);
  });

  it('captures simulation name and description from the meta event', () => {
    const r = runEngine(events());
    expect(r.simulation).toBe('ParitySimulation');
    expect(r.description).toBe('a run');
  });

  it('reports duration as the span from run start to the last response', () => {
    expect(runEngine(events()).durationMs).toBe(1_400);   // 2_400 - 1_000
  });

  it('scopes errors so a request page can show its own', () => {
    const r = runEngine(events());
    expect(r.errors).toContainEqual({ scope: 'run', name: '', message: 'boom', count: 1 });
    expect(r.errors).toContainEqual({ scope: 'request', name: 'buy', message: 'boom', count: 1 });
  });

  it('stores a FIXED per-bucket percentile band set, not the project’s columns', () => {
    // Buckets persist numbers, not sketches, so a configurable per-bucket set
    // would make history depend on ingest-day configuration. p95 in particular
    // must always exist: Gatling's scatter hardcodes quantile(0.95).
    expect(BUCKET_PERCENTILES).toContain(95);
    expect([...BUCKET_PERCENTILES]).toEqual([25, 50, 75, 80, 85, 90, 95, 99]);
  });

  it('no longer returns an indicators field', () => {
    expect('indicators' in runEngine(events())).toBe(false);
  });

  it('still enforces the endpoint cardinality cap', () => {
    const many: CanonicalEvent[] = [];
    for (let i = 0; i < 12; i++) {
      many.push({ type: 'request', name: `r${i}`, groups: [], userId: 'u', startMs: 0, endMs: 1, ok: true });
    }
    expect(() => runEngine(many, { maxEndpoints: 10 })).toThrow(/cardinality/i);
  });
});
