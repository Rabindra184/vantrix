import type { CanonicalEvent } from '@perfportal/core';
import { readRunHeader, type RunHeader } from './header.js';
import { BinaryReader, TruncatedError } from './reader.js';
import { readRecord, type DecodeState } from './record-decoder.js';

/**
 * The append-only twin of `parseSimulationLog`.
 *
 * Same decoding, driven by a feed instead of a finished buffer -- both call
 * the same `readRecord` (`record-decoder.ts`) for the per-record switch, so
 * there is one decoder for this format, not two that could drift. It exists
 * because Gatling's log is written as the run proceeds and `file` is the only
 * output modern Gatling OSS still supports -- see the design's section 0.
 *
 * ONE reader for the whole stream, never one per chunk: string back-references
 * point at cache entries defined arbitrarily far upstream, so the cache must
 * outlive every chunk boundary.
 *
 * The loop marks its position before each record and rewinds on
 * TruncatedError. Re-reading a rewound record is safe even though
 * readCachedString mutates the cache on the way through: it re-defines the
 * same index with the same value, which is idempotent.
 */
export class StreamingLogDecoder {
  #reader = new BinaryReader(Buffer.alloc(0));
  #header: RunHeader | null = null;
  #state: DecodeState = { userSeq: 0 };
  #consumed = 0;

  get consumedBytes(): number { return this.#consumed; }

  /** Bytes the decoder is still holding. See `BinaryReader.append`. */
  get bufferedBytes(): number { return this.#reader.bufferedBytes; }

  push(chunk: Buffer): CanonicalEvent[] {
    // `#consumed` doubles as the compaction boundary: it is the end of the
    // last WHOLE record, and the loop below rewinds no further than the
    // record it is currently inside, so nothing before it can ever be read
    // again. Without this the reader kept every byte of the run and paid a
    // full copy of the accumulated buffer per push -- quadratic in total
    // bytes (see BinaryReader.append). It is also why `#consumed` and
    // `BinaryReader.pos` are absolute file offsets rather than indices:
    // they have to survive the bytes underneath them being dropped.
    this.#reader.append(chunk, this.#consumed);
    const out: CanonicalEvent[] = [];

    if (this.#header === null) {
      const mark = this.#reader.pos;
      try {
        this.#header = readRunHeader(this.#reader);
      } catch (err) {
        if (err instanceof TruncatedError) { this.#reader.seek(mark); return out; }
        throw err;
      }
      out.push({
        type: 'meta',
        simulation: this.#header.simulationClassName,
        toolVersion: this.#header.gatlingVersion,
        startedAtMs: this.#header.runStartEpochMs,
        description: this.#header.description || undefined,
        assertions: this.#header.assertions,
      });
      this.#consumed = this.#reader.pos;
    }

    const h = this.#header;
    const base = h.runStartEpochMs;

    for (;;) {
      const mark = this.#reader.pos;
      try {
        if (this.#reader.eof) break;
        const event = readRecord(this.#reader, h, base, this.#state);
        out.push(event);
        this.#consumed = this.#reader.pos;
      } catch (err) {
        if (err instanceof TruncatedError) { this.#reader.seek(mark); break; }
        throw err;
      }
    }
    return out;
  }
}
