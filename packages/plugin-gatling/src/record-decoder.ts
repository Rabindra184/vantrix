import type { CanonicalEvent } from '@perfportal/core';
import { RECORD, type RunHeader } from './header.js';
import type { BinaryReader } from './reader.js';

/**
 * Decoder state that must survive across records within one run but must NOT
 * be shared between two runs decoding concurrently -- so it is threaded in
 * by the caller rather than closed over as module or instance state.
 * `userSeq` is Gatling's user records carrying no id of their own; we assign
 * one by counting User records in file order, and that counter has to belong
 * to whichever decoder (pull-based or push-based) is doing the counting.
 */
export interface DecodeState {
  userSeq: number;
}

/**
 * Decodes exactly one record, starting at the record-type byte.
 *
 * Shared by `parseSimulationLog` (records.ts, pull-based, reads a finished
 * buffer) and `StreamingLogDecoder` (stream.ts, push-based, reads a feed) so
 * there is exactly ONE decoder for this format rather than two that could
 * drift apart. That is not a style preference: the design this implements
 * (§0) rejected decoding live bytes in a second implementation specifically
 * because "any drift between the two shows up as the live chart
 * contradicting the final report -- the worst available failure for a
 * monitoring product's credibility." A second TypeScript copy of this switch
 * would have reintroduced exactly that risk one language sooner than the
 * design meant to rule out.
 *
 * Throws `TruncatedError` (via `BinaryReader`) if `r` runs out of bytes
 * mid-record. Callers that need to hold back a partial trailing record
 * (the streaming case) catch that and rewind; `parseSimulationLog` never
 * catches it, because its buffer is already complete.
 */
export function readRecord(r: BinaryReader, h: RunHeader, base: number, state: DecodeState): CanonicalEvent {
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
      return { type: 'user', scenario, userId: String(state.userSeq++), kind: isStart ? 'start' : 'end', tsMs };
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
