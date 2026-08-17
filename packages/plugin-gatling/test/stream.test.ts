import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '../src/records.js';
import { StreamingLogDecoder } from '../src/stream.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

describe('StreamingLogDecoder', () => {
  it('one chunk yields exactly what the batch parser yields', () => {
    const buf = readFileSync(LOG);
    const d = new StreamingLogDecoder();
    expect(d.push(buf)).toEqual([...parseSimulationLog(buf)]);
  });

  it('byte-at-a-time yields the same events in the same order', () => {
    const buf = readFileSync(LOG);
    const d = new StreamingLogDecoder();
    const got = [];
    for (const byte of buf) got.push(...d.push(Buffer.from([byte])));
    expect(got).toEqual([...parseSimulationLog(buf)]);
  });

  it('is invariant to where the chunk boundaries fall', () => {
    const buf = readFileSync(LOG);
    const expected = [...parseSimulationLog(buf)];

    // Deterministic pseudo-random splits: a fixed split can miss a boundary
    // landing inside a cached-string back-reference.
    let seed = 20260817;
    const nextCut = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % Math.max(1, max));
    };

    for (let trial = 0; trial < 20; trial++) {
      const d = new StreamingLogDecoder();
      const got = [];
      let at = 0;
      while (at < buf.length) {
        const n = Math.min(nextCut(4096), buf.length - at);
        got.push(...d.push(buf.subarray(at, at + n)));
        at += n;
      }
      expect(got).toEqual(expected);
    }
  });
});
