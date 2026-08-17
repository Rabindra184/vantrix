import type { CanonicalEvent } from '@perfportal/core';
import { RECORD, readRunHeader, type RunHeader } from './header.js';
import { BinaryReader, TruncatedError } from './reader.js';

/**
 * The append-only twin of `parseSimulationLog`.
 *
 * Same decoding, driven by a feed instead of a finished buffer. It exists
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
  #userSeq = 0;
  #consumed = 0;

  get consumedBytes(): number { return this.#consumed; }

  push(chunk: Buffer): CanonicalEvent[] {
    this.#reader.append(chunk);
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
        const event = this.#readRecord(h, base);
        if (event !== null) out.push(event);
        this.#consumed = this.#reader.pos;
      } catch (err) {
        if (err instanceof TruncatedError) { this.#reader.seek(mark); break; }
        throw err;
      }
    }
    return out;
  }

  /**
   * One record. Mirrors `records.ts`'s switch exactly -- the two must stay in
   * step, and `stream.test.ts` asserts they do by comparing against
   * parseSimulationLog over the same bytes.
   */
  #readRecord(h: RunHeader, base: number): CanonicalEvent | null {
    const r = this.#reader;
    const type = r.readByte();
    switch (type) {
      case RECORD.REQUEST: {
        const groups = r.readGroups();
        const name = r.readCachedString();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const ok = r.readBoolean();
        const message = r.readCachedString();
        return { type: 'request', name, groups, userId: '', startMs, endMs, ok, message: message || undefined };
      }
      case RECORD.USER: {
        const scenarioIndex = r.readInt();
        const isStart = r.readBoolean();
        const tsMs = base + r.readInt();
        const scenario = h.scenarios[scenarioIndex];
        if (scenario === undefined) throw new Error(`unknown scenario index ${scenarioIndex}`);
        return { type: 'user', scenario, userId: String(this.#userSeq++), kind: isStart ? 'start' : 'end', tsMs };
      }
      case RECORD.GROUP: {
        const groups = r.readGroups();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const cumulatedResponseTimeMs = r.readInt();
        const ok = r.readBoolean();
        return { type: 'group', groups, userId: '', startMs, endMs, cumulatedResponseTimeMs, ok };
      }
      case RECORD.ERROR: {
        // A failure with no request context — see `ErrorEvent`. It USED TO BE
        // discarded here, on the reasoning that carrying no request meant
        // carrying nothing; that silently cost Appendix A G-17 two rows and 42
        // of 399 errors on the reference run, because Gatling's own errors
        // table counts these beside request failures. It is emitted rather
        // than attributed: `koCount` stays a count of failed REQUESTS.
        const message = r.readCachedString();
        const tsMs = base + r.readInt();
        return { type: 'error', message, tsMs };
      }
      default:
        throw new Error(`unknown record type ${type} at byte ${r.pos - 1}`);
    }
  }
}
