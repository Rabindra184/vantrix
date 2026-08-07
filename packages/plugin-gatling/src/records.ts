import type { CanonicalEvent } from '@perfportal/core';
import { BinaryReader } from './reader.js';
import { RECORD, readRunHeader } from './header.js';

/**
 * All record timestamps are int32 offsets in ms from runStart (PRD Appendix A.10),
 * which caps a single run at ~24.8 days. We convert to absolute epoch ms here so
 * nothing downstream needs to know about the encoding.
 */
export function* parseSimulationLog(buf: Buffer): Generator<CanonicalEvent> {
  const r = new BinaryReader(buf);
  const h = readRunHeader(r);
  const base = h.runStartEpochMs;

  yield {
    type: 'meta',
    simulation: h.simulationClassName,
    toolVersion: h.gatlingVersion,
    startedAtMs: base,
    description: h.description || undefined,
  };

  let userSeq = 0;
  while (!r.eof) {
    const type = r.readByte();
    switch (type) {
      case RECORD.REQUEST: {
        const groups = r.readGroups();
        const name = r.readCachedString();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const ok = r.readBoolean();
        const message = r.readCachedString();
        yield { type: 'request', name, groups, userId: '', startMs, endMs, ok, message: message || undefined };
        break;
      }
      case RECORD.USER: {
        const scenarioIndex = r.readInt();
        const isStart = r.readBoolean();
        const tsMs = base + r.readInt();
        const scenario = h.scenarios[scenarioIndex];
        if (scenario === undefined) throw new Error(`unknown scenario index ${scenarioIndex}`);
        yield { type: 'user', scenario, userId: String(userSeq++), kind: isStart ? 'start' : 'end', tsMs };
        break;
      }
      case RECORD.GROUP: {
        const groups = r.readGroups();
        const startMs = base + r.readInt();
        const endMs = base + r.readInt();
        const cumulatedResponseTimeMs = r.readInt();
        const ok = r.readBoolean();
        yield { type: 'group', groups, userId: '', startMs, endMs, cumulatedResponseTimeMs, ok };
        break;
      }
      case RECORD.ERROR: {
        r.readCachedString();
        r.readInt();
        break;                        // standalone error records carry no request context
      }
      default:
        throw new Error(`unknown record type ${type} at byte ${r.pos - 1}`);
    }
  }
}
