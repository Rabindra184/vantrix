import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '../src/records.js';
import type { RequestEvent, UserEvent, GroupEvent, MetaEvent } from '@perfportal/core';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';
const events = [...parseSimulationLog(readFileSync(FIXTURE))];

/** Helper: encode int as 4 bytes big-endian */
function encodeInt(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}

/** Helper: encode long as 8 bytes big-endian */
function encodeLong(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(n), 0);
  return buf;
}

/** Helper: encode string as [int len][len bytes][1 coder byte]; empty string is just [0,0,0,0] */
function encodeString(s: string): Buffer {
  if (s.length === 0) return encodeInt(0);
  const str = Buffer.from(s, 'latin1');
  return Buffer.concat([encodeInt(str.length), str, Buffer.from([0])]);
}

/** Helper: encode cachedString for a new (uncached) definition at index i */
function encodeNewCachedString(index: number, value: string): Buffer {
  return Buffer.concat([encodeInt(index), encodeString(value)]);
}

/** Helper: build a minimal Run header */
function buildRunHeader(gatlingVersion = '3.15.1', simClass = 'test.Sim', runStartMs = 1700000000000, scenarioName = 'TestScenario'): Buffer {
  return Buffer.concat([
    Buffer.from([0]), // RECORD.RUN
    encodeString(gatlingVersion),
    encodeString(simClass),
    encodeLong(runStartMs),
    encodeString(''), // empty description
    encodeInt(1),     // one scenario
    encodeString(scenarioName),
    encodeInt(0),     // zero assertions
  ]);
}

/** Helper: build an Error record */
function buildErrorRecord(message: string, timestampOffset: number): Buffer {
  return Buffer.concat([
    Buffer.from([4]), // RECORD.ERROR
    encodeNewCachedString(0, message),
    encodeInt(timestampOffset),
  ]);
}

/** Helper: build a Request record with groups, name, start/end offsets, ok, and message */
function buildRequestRecord(groups: string[], name: string, startOffset: number, endOffset: number, ok: boolean, message: string): Buffer {
  let buf = Buffer.from([1]); // RECORD.REQUEST
  buf = Buffer.concat([buf, encodeInt(groups.length)]);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group === undefined) throw new Error(`groups[${i}] is undefined`);
    buf = Buffer.concat([buf, encodeNewCachedString(10 + i, group)]);
  }
  buf = Buffer.concat([
    buf,
    encodeNewCachedString(1, name),
    encodeInt(startOffset),
    encodeInt(endOffset),
    Buffer.from([ok ? 1 : 0]),
    encodeNewCachedString(2, message),
  ]);
  return buf;
}

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

  it('maintains stream alignment across Error records', () => {
    // Build a synthetic buffer: Run header + Error record + Request record.
    // This tests that the Error branch consumes exactly the right bytes.
    // If the Error skip is off by even 1 byte, the Request would be garbage or throw.
    const runStartMs = 1700000000000;
    const buf = Buffer.concat([
      buildRunHeader('3.15.1', 'test.Sim', runStartMs, 'TestScenario'),
      buildErrorRecord('Connection timeout', 100),
      buildRequestRecord(['Home'], 'GET /api/users', 200, 300, true, 'OK'),
    ]);

    const parsed = [...parseSimulationLog(buf)];

    // Verify we got meta + 1 request (error is silently consumed)
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toMatchObject({ type: 'meta' });

    const meta = parsed[0] as MetaEvent;
    expect(meta.startedAtMs).toBe(runStartMs);

    // The key assertion: the Request record must be intact and correctly positioned.
    // If Error skip consumed wrong bytes, this would fail or crash.
    const req = parsed[1] as RequestEvent;
    expect(req).toMatchObject({
      type: 'request',
      name: 'GET /api/users',
      groups: ['Home'],
      ok: true,
      message: 'OK',
    });

    // Absolute timestamps must use the header runStartMs as base
    expect(req.startMs).toBe(runStartMs + 200);
    expect(req.endMs).toBe(runStartMs + 300);
  });
});
