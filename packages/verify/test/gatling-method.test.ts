import type { CanonicalEvent, GroupEvent, RequestEvent } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import {
  GATLING_PERCENTILES,
  gatlingDifferences,
  gatlingMethodInput,
  gatlingMethodLines,
  type GatlingKey,
  type GatlingMethodOutput,
} from '../src/index.js';

/**
 * Expectations are written from the events each case builds — a value is an
 * end minus a start, a rank is counted by hand — never read off the builder's
 * own output, which is what is being checked.
 */

const RUN_START = 1_700_000_000_000;

function req(name: string, startOff: number, endOff: number, ok = true, groups: string[] = []): RequestEvent {
  return { type: 'request', name, groups, userId: 'u', startMs: RUN_START + startOff, endMs: RUN_START + endOff, ok };
}

function grp(groups: string[], startOff: number, endOff: number, cumulated: number, ok = true): GroupEvent {
  return {
    type: 'group',
    groups,
    userId: 'u',
    startMs: RUN_START + startOff,
    endMs: RUN_START + endOff,
    cumulatedResponseTimeMs: cumulated,
    ok,
  };
}

/** The opaque key the builder chose for a (scope, name, population), or undefined. */
function keyOf(keys: Map<string, GatlingKey>, scope: string, name: string, population: string): string | undefined {
  for (const [k, v] of keys) if (v.scope === scope && v.name === name && v.population === population) return k;
  return undefined;
}

/** Every line the tool would be sent, read off the chunks gatlingMethodLines renders. */
function wire(input: ReturnType<typeof gatlingMethodInput>, linesPerChunk?: number): string[] {
  const text = [...gatlingMethodLines(input, linesPerChunk)].join('');
  return text === '' ? [] : text.slice(0, -1).split('\n');
}

/** The values a key was sent ON THE WIRE, in the order its lines appear. */
function valuesOf(input: ReturnType<typeof gatlingMethodInput>, key: string): number[] {
  return wire(input)
    .filter((l) => l.startsWith(`${key}\t`))
    .map((l) => Number(l.slice(key.length + 1)));
}

/** A tool row that agrees with `exact` on every percentile. */
function agreeing(key: string, n: number, exact: Record<string, number>): GatlingMethodOutput {
  const p: Record<string, [number, number]> = {};
  for (const q of GATLING_PERCENTILES) p[String(q)] = [exact[String(q)]!, exact[String(q)]!];
  return { key, n, p };
}

/** A tool output that agrees everywhere, built from the input itself. */
function agreeingOutput(input: ReturnType<typeof gatlingMethodInput>): GatlingMethodOutput[] {
  return [...input.keys.keys()].map((k) => agreeing(k, valuesOf(input, k).length, input.exact.get(k)!));
}

describe('gatlingMethodInput', () => {
  it('every request feeds the run in all, and its request key in all and its status, in log order', () => {
    const events: CanonicalEvent[] = [req('X', 0, 10), req('X', 5, 25, false), req('X', 7, 37)];
    const input = gatlingMethodInput(events);

    const described = [...input.keys.values()].map((k) => `${k.scope}|${k.name}|${k.population}`).sort();
    expect(described).toEqual(['run||all', 'request|X|all', 'request|X|ok', 'request|X|ko'].sort());

    // Opaque, first-seen indices — never a name on the wire.
    expect([...input.keys.keys()]).toEqual(['k0', 'k1', 'k2', 'k3']);
    for (const line of wire(input)) expect(line).toMatch(/^k\d+\t\d+$/);

    // Each key's values in log order — the only order the tool's contract keeps.
    const runAll = keyOf(input.keys, 'run', '', 'all')!;
    const reqAll = keyOf(input.keys, 'request', 'X', 'all')!;
    expect(valuesOf(input, runAll)).toEqual([10, 20, 30]);
    expect(valuesOf(input, reqAll)).toEqual([10, 20, 30]);
    expect(valuesOf(input, keyOf(input.keys, 'request', 'X', 'ok')!)).toEqual([10, 30]);
    expect(valuesOf(input, keyOf(input.keys, 'request', 'X', 'ko')!)).toEqual([20]);
  });

  it('a group feeds its cumulated time, never its duration', () => {
    // Duration 500, cumulated 120: only 120 may reach the tool.
    const input = gatlingMethodInput([grp(['Cart'], 0, 500, 120), grp(['Cart'], 600, 1400, 90, false)]);
    const all = keyOf(input.keys, 'group', 'Cart', 'all')!;
    expect(valuesOf(input, all)).toEqual([120, 90]);
    expect(valuesOf(input, keyOf(input.keys, 'group', 'Cart', 'ok')!)).toEqual([120]);
    expect(valuesOf(input, keyOf(input.keys, 'group', 'Cart', 'ko')!)).toEqual([90]);
    expect(wire(input).some((l) => l.endsWith('\t500') || l.endsWith('\t800'))).toBe(false);
    // A group feeds neither the run nor any request key.
    expect([...input.keys.values()].every((k) => k.scope === 'group')).toBe(true);
  });

  /**
   * Gatling's report prints the run's percentiles in its Total column alone:
   * the index's percentile columns are Total only and no detail page repeats
   * the run. A run OK/KO key would put "Gatling's report: X" beside a figure
   * the report never shows, and take a slot under the panel's row cap.
   */
  it('the run is fed in population all only, never by status', () => {
    const input = gatlingMethodInput([req('X', 0, 10), req('X', 5, 25, false), req('Y', 0, 7)]);
    const runKeys = [...input.keys.values()].filter((k) => k.scope === 'run');
    expect(runKeys).toEqual([{ scope: 'run', name: '', population: 'all' }]);
    // While a request still has both.
    expect(keyOf(input.keys, 'request', 'X', 'ok')).toBeDefined();
    expect(keyOf(input.keys, 'request', 'X', 'ko')).toBeDefined();
  });

  it('warm-up is included', () => {
    // An event at 0 ms, which an engine warm-up of 5000 would drop. The input
    // takes no engine options at all, so there is nothing to drop it with.
    expect(gatlingMethodInput.length).toBe(1);
    const input = gatlingMethodInput([req('X', 0, 40)]);
    expect(valuesOf(input, keyOf(input.keys, 'run', '', 'all')!)).toEqual([40]);
  });

  it('a KO-only request has no ok key', () => {
    const input = gatlingMethodInput([req('Y', 0, 30, false), req('Y', 1, 41, false)]);
    expect(keyOf(input.keys, 'request', 'Y', 'ko')).toBeDefined();
    expect(keyOf(input.keys, 'request', 'Y', 'ok')).toBeUndefined();
    expect(keyOf(input.keys, 'run', '', 'ok')).toBeUndefined();
  });

  it('exact uses nearest rank over the same values', () => {
    // Fed out of order: rank is taken over the sorted values.
    const events = Array.from({ length: 100 }, (_, i) => req('X', 0, 100 - i));
    const input = gatlingMethodInput(events);
    const exact = input.exact.get(keyOf(input.keys, 'run', '', 'all')!)!;
    expect(exact).toEqual({ '50': 50, '75': 75, '95': 95, '99': 99 });
  });

  it('values are whole, non-negative milliseconds, as the stored figures are', () => {
    const input = gatlingMethodInput([req('X', 10, 5), { ...req('X', 0, 0), endMs: RUN_START + 12.6 }]);
    expect(valuesOf(input, keyOf(input.keys, 'run', '', 'all')!)).toEqual([0, 13]);
  });

  it('names are the stored identity', () => {
    const input = gatlingMethodInput([req('Add To Cart', 0, 10, true, ['Cart']), grp(['Catalog', 'Search'], 0, 50, 40)]);
    expect(keyOf(input.keys, 'request', 'Cart/Add To Cart', 'all')).toBeDefined();
    expect(keyOf(input.keys, 'group', 'Catalog/Search', 'all')).toBeDefined();
    expect([...input.keys.values()].some((k) => k.name.includes(' / '))).toBe(false);
  });
});

/**
 * ═══ THE TOOL'S STDIN, A CHUNK AT A TIME ═══
 *
 * The input keeps numbers per key, never one string per line; the text is
 * rendered while the runner writes it. These pin what the tool is sent:
 * every value, each key's in arrival order, whole lines only.
 */
describe('gatlingMethodLines', () => {
  /** Interleaved across keys in the log, so key-by-key order is a real reordering. */
  function interleaved(): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    for (let i = 0; i < 25; i += 1) {
      events.push(req('A', 0, 100 + i, i % 7 !== 0), req('B', 0, 900 - i * 3), grp(['G'], 0, 5000, 40 + (i % 5)));
    }
    return events;
  }

  it('carries every value per key, in arrival order, key by key in first-seen order', () => {
    const events = interleaved();
    const input = gatlingMethodInput(events);

    // Each key's values written down from the events, in log order.
    const want = new Map<string, number[]>();
    const add = (scope: string, name: string, population: string, v: number): void => {
      const k = keyOf(input.keys, scope, name, population)!;
      want.set(k, [...(want.get(k) ?? []), v]);
    };
    for (const e of events) {
      if (e.type === 'request') {
        const v = e.endMs - e.startMs;
        add('run', '', 'all', v);
        add('request', e.name, 'all', v);
        add('request', e.name, e.ok ? 'ok' : 'ko', v);
      } else if (e.type === 'group') {
        add('group', e.groups.join('/'), 'all', e.cumulatedResponseTimeMs);
        add('group', e.groups.join('/'), e.ok ? 'ok' : 'ko', e.cumulatedResponseTimeMs);
      }
    }

    const lines = wire(input, 7);
    expect(lines).toHaveLength([...want.values()].reduce((n, vs) => n + vs.length, 0));
    const got = new Map<string, number[]>();
    for (const line of lines) {
      const [k, v] = line.split('\t') as [string, string];
      got.set(k, [...(got.get(k) ?? []), Number(v)]);
    }
    expect(got).toEqual(want);
    // Key by key: a key's lines are contiguous, in first-seen (k0, k1, …) order.
    const runs = lines.map((l) => l.split('\t')[0]!).filter((k, i, all) => k !== all[i - 1]);
    expect(runs).toEqual([...input.keys.keys()]);
  });

  it('chunks are whole lines, at most the chunk size, each ending in a newline', () => {
    const input = gatlingMethodInput(interleaved());
    const chunks = [...gatlingMethodLines(input, 7)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.endsWith('\n')).toBe(true);
      const lines = chunk.slice(0, -1).split('\n');
      expect(lines.length).toBeLessThanOrEqual(7);
      for (const line of lines) expect(line).toMatch(/^k\d+\t\d+$/);
    }
    // Every chunk but the last is full.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.slice(0, -1).split('\n')).toHaveLength(7);
  });

  it('an empty run renders nothing', () => {
    expect([...gatlingMethodLines(gatlingMethodInput([]))]).toEqual([]);
  });

  /**
   * Through a stand-in tool that reads the chunks the way the real one reads
   * stdin — per key, in arrival order — and answers each key's nearest-rank
   * value: Gatling "agrees" everywhere, so nothing is a difference.
   */
  it('round-trips through a stand-in tool reading the chunks', () => {
    const input = gatlingMethodInput(interleaved());
    const seen = new Map<string, number[]>();
    for (const chunk of gatlingMethodLines(input)) {
      for (const line of chunk.split('\n')) {
        if (line === '') continue;
        const tab = line.lastIndexOf('\t');
        const k = line.slice(0, tab);
        seen.set(k, [...(seen.get(k) ?? []), Number(line.slice(tab + 1))]);
      }
    }
    const output: GatlingMethodOutput[] = [...seen].map(([key, vs]) => {
      const sorted = [...vs].sort((a, b) => a - b);
      const p: Record<string, [number, number]> = {};
      for (const q of GATLING_PERCENTILES) {
        const v = sorted[Math.max(0, Math.ceil((q / 100) * sorted.length) - 1)]!;
        p[String(q)] = [v, v];
      }
      return { key, n: vs.length, p };
    });
    expect(gatlingDifferences(input, output)).toEqual([]);
  });
});

describe('gatlingDifferences', () => {
  /** One request X of value 95 — exact is 95 at every percentile. */
  function oneValue(): ReturnType<typeof gatlingMethodInput> {
    return gatlingMethodInput([req('X', 0, 95)]);
  }

  it('a difference row only where low or high differs from exact', () => {
    const input = oneValue();
    const reqAll = keyOf(input.keys, 'request', 'X', 'all')!;

    const withP95 = (range: [number, number]): GatlingMethodOutput[] =>
      agreeingOutput(input).map((r) => (r.key === reqAll ? { ...r, p: { ...r.p, '95': range } } : r));

    expect(gatlingDifferences(input, withP95([95, 95]))).toEqual([]);
    expect(gatlingDifferences(input, withP95([94, 96]))).toEqual([
      { scope: 'request', name: 'X', population: 'all', figure: 'p95', gatlingLow: 94, gatlingHigh: 96, exact: 95 },
    ]);
    expect(gatlingDifferences(input, withP95([96, 96]))).toEqual([
      { scope: 'request', name: 'X', population: 'all', figure: 'p95', gatlingLow: 96, gatlingHigh: 96, exact: 95 },
    ]);
  });

  it('sorts by scope, name, population and figure', () => {
    const input = gatlingMethodInput([
      grp(['G'], 0, 10, 10),
      req('B', 0, 10, false),
      req('A', 0, 10),
    ]);
    const output = agreeingOutput(input).map((r) => ({
      ...r,
      p: { '50': [1, 1] as [number, number], '75': [1, 1] as [number, number], '95': r.p['95']!, '99': r.p['99']! },
    }));
    const rows = gatlingDifferences(input, output).map((d) => `${d.scope}|${d.name}|${d.population}|${d.figure}`);
    expect(rows).toEqual([
      'run||all|p50', 'run||all|p75',
      'request|A|all|p50', 'request|A|all|p75',
      'request|A|ok|p50', 'request|A|ok|p75',
      'request|B|all|p50', 'request|B|all|p75',
      'request|B|ko|p50', 'request|B|ko|p75',
      'group|G|all|p50', 'group|G|all|p75',
      'group|G|ok|p50', 'group|G|ok|p75',
    ]);
  });

  it('throws on an unknown output key', () => {
    const input = oneValue();
    const output = [...agreeingOutput(input), { key: 'k99', n: 1, p: { '50': [1, 1], '75': [1, 1], '95': [1, 1], '99': [1, 1] } }];
    expect(() => gatlingDifferences(input, output as GatlingMethodOutput[])).toThrow(/k99/);
  });

  it('throws on a key the tool left out', () => {
    const input = oneValue();
    const output = agreeingOutput(input);
    const dropped = output.pop()!;
    expect(() => gatlingDifferences(input, output)).toThrow(new RegExp(dropped.key));
  });

  it('throws when a key is answered twice', () => {
    const input = oneValue();
    const output = agreeingOutput(input);
    expect(() => gatlingDifferences(input, [...output, output[0]!])).toThrow(/k0/);
  });

  it('throws when the tool counted a different number of values than were sent', () => {
    const input = oneValue();
    const output = agreeingOutput(input).map((r) => (r.key === 'k0' ? { ...r, n: r.n + 1 } : r));
    expect(() => gatlingDifferences(input, output)).toThrow(/k0/);
  });

  it('throws when a percentile is missing from a row', () => {
    const input = oneValue();
    const output = agreeingOutput(input).map((r) => (r.key === 'k0' ? { ...r, p: { '50': r.p['50']! } } : r));
    expect(() => gatlingDifferences(input, output)).toThrow(/75/);
  });
});
