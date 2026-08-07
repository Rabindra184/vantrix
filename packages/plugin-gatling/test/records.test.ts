import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '../src/records.js';
import type { RequestEvent, UserEvent, GroupEvent } from '@perfportal/core';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';
const events = [...parseSimulationLog(readFileSync(FIXTURE))];

describe('parseSimulationLog', () => {
  it('yields meta first', () => {
    expect(events[0]).toMatchObject({ type: 'meta', toolVersion: '3.15.1', simulation: 'example.ParitySimulation' });
  });

  it('decodes exactly the expected record counts', () => {
    const count = (t: string) => events.filter((e) => e.type === t).length;
    expect(count('request')).toBe(895);
    expect(count('user')).toBe(490);
    expect(count('group')).toBe(405);
  });

  it('recovers all seven endpoints', () => {
    const names = new Set(events.filter((e): e is RequestEvent => e.type === 'request').map((e) => e.name));
    expect(names).toEqual(new Set([
      'List Products', 'Product Detail', 'Related Items', 'Search',
      'Add To Cart', 'View Cart', 'Place Order',
    ]));
  });

  it('recovers the nested group hierarchy', () => {
    const hierarchies = new Set(
      events.filter((e): e is GroupEvent => e.type === 'group').map((e) => e.groups.join('/')),
    );
    expect(hierarchies).toEqual(new Set(['Catalog', 'Catalog/Recommendations', 'Cart']));
  });

  it('splits OK and KO correctly and keeps failure messages', () => {
    const reqs = events.filter((e): e is RequestEvent => e.type === 'request');
    expect(reqs.filter((r) => r.ok).length).toBe(871);
    const ko = reqs.filter((r) => !r.ok);
    expect(ko.length).toBe(24);
    expect(ko.filter((r) => r.message === 'status.find.is(200), found 500').length).toBe(15);
    expect(ko.filter((r) => r.message === 'status.find.is(200), found 503').length).toBe(9);
  });

  it('converts relative offsets to absolute epoch timestamps', () => {
    const first = events.find((e): e is RequestEvent => e.type === 'request')!;
    expect(first.startMs).toBeGreaterThan(1_700_000_000_000);
    expect(first.endMs).toBeGreaterThanOrEqual(first.startMs);
  });

  it('emits user start and end events per scenario', () => {
    const users = events.filter((e): e is UserEvent => e.type === 'user');
    expect(new Set(users.map((u) => u.scenario))).toEqual(new Set(['Browse', 'Checkout']));
    expect(users.filter((u) => u.kind === 'start').length).toBe(245);
    expect(users.filter((u) => u.kind === 'end').length).toBe(245);
  });
});
