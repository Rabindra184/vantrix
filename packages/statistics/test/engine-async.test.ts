import type { CanonicalEvent } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { runEngineAsync } from '../src/engine-async.js';

function events(): CanonicalEvent[] {
  const base = 1_700_000_000_000;
  const out: CanonicalEvent[] = [
    { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: base },
  ];
  for (let i = 0; i < 50; i++) {
    out.push({
      type: 'request',
      name: i % 2 === 0 ? 'GET /a' : 'GET /b',
      groups: [],
      userId: String(i),
      startMs: base + i * 10,
      endMs: base + i * 10 + (i % 7) * 100,
      ok: i % 11 !== 0,
      message: i % 11 === 0 ? 'boom' : undefined,
    });
  }
  return out;
}

async function* toAsync(items: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of items) yield e;
}

describe('runEngineAsync', () => {
  it('produces results identical to runEngine on the same events', async () => {
    const sync = runEngine(events());
    const async_ = await runEngineAsync(toAsync(events()));

    // Compare everything except the sketches, which are objects.
    const strip = (r: typeof sync) =>
      r.stats
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .map(({ sketch: _sketch, ...rest }) => rest)
        .sort((a, b) => `${a.scope}${a.name}${a.family}`.localeCompare(`${b.scope}${b.name}${b.family}`));

    expect(strip(async_)).toEqual(strip(sync));
    expect(async_.errors).toEqual(sync.errors);
    expect(async_.users).toEqual(sync.users);
    expect(async_.endpointCount).toEqual(sync.endpointCount);
    expect([...async_.series.keys()].sort()).toEqual([...sync.series.keys()].sort());
  });

  it('propagates an IngestError thrown mid-stream instead of swallowing it', async () => {
    async function* boom(): AsyncIterable<CanonicalEvent> {
      yield { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 1 };
      throw new Error('source exploded');
    }
    await expect(runEngineAsync(boom())).rejects.toThrow('source exploded');
  });
});
