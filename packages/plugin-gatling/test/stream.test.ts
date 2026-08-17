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

  it('reports how far it consumed — the last WHOLE record, not how far it was fed', () => {
    // Design §3.1: "A trailing partial record is held in the decoder's
    // buffer until the bytes completing it arrive. The decoder therefore
    // needs a resumable form that reports how far it consumed." That
    // reported number is the whole point of the resumable form, and until
    // this case existed nothing anywhere — not even a test — read it.
    const buf = readFileSync(LOG);

    // Every whole-record boundary in the file, discovered rather than
    // written down: feed one byte at a time and record where the decoder
    // says it stands after each. A boundary is exactly a value
    // consumedBytes ever takes.
    const walker = new StreamingLogDecoder();
    const boundaries = new Set<number>([0]);
    for (let i = 0; i < buf.length; i++) {
      walker.push(buf.subarray(i, i + 1));
      boundaries.add(walker.consumedBytes);
    }
    // The log ends on a record boundary, so a complete feed consumes all of it.
    expect(walker.consumedBytes).toBe(buf.length);

    // The first prefix length that is NOT a boundary: cutting there lands
    // mid-record by construction.
    let midRecord = 1;
    while (boundaries.has(midRecord)) midRecord++;
    expect(midRecord).toBeLessThan(buf.length);

    const decoder = new StreamingLogDecoder();
    decoder.push(buf.subarray(0, midRecord));
    // Strictly behind the feed — the partial tail is held, not counted.
    expect(decoder.consumedBytes).toBeLessThan(midRecord);
    // And exactly the last boundary at or before the cut, never some
    // arbitrary lesser value.
    const lastBoundary = Math.max(...[...boundaries].filter((b) => b <= midRecord));
    expect(decoder.consumedBytes).toBe(lastBoundary);

    // The rest of the record arrives and the cursor moves past the cut,
    // proving the held tail was decoded rather than dropped.
    decoder.push(buf.subarray(midRecord));
    expect(decoder.consumedBytes).toBe(buf.length);
  });

  it('releases consumed bytes: what it holds is bounded by the chunk, not by the run', () => {
    // append was `Buffer.concat([this.#buf, chunk])` with nothing ever
    // trimmed, so the decoder held the entire log resident and the copying
    // was quadratic in total bytes. At the design's 150–250 MB (§0) and
    // 64 KB chunks that is ~4000 pushes and on the order of half a
    // terabyte of memcpy for one run, with 2x peak resident during each
    // concat. The 37 KB fixture makes every other test in this file too
    // cheap to notice.
    const buf = readFileSync(LOG);
    const CHUNK = 512;

    const decoder = new StreamingLogDecoder();
    let peak = 0;
    for (let at = 0; at < buf.length; at += CHUNK) {
      decoder.push(buf.subarray(at, Math.min(at + CHUNK, buf.length)));
      peak = Math.max(peak, decoder.bufferedBytes);
    }

    // The bound is a CONSTANT — one chunk plus at most one record
    // straddling its end — where the old behaviour's was `at`, i.e. every
    // byte ever pushed. Expressed against the payload rather than written
    // down: a quarter of the fixture is far above the real ceiling and far
    // below the whole-log retention it replaces.
    expect(peak).toBeLessThan(buf.length / 4);
    // ...and that comparison only means something because the fixture is
    // many chunks long in the first place.
    expect(buf.length).toBeGreaterThan(CHUNK * 16);
  });
});
