import type { CanonicalEvent } from '@perfportal/core';
import { BinaryReader } from './reader.js';
import { readRunHeader } from './header.js';
import { readRecord, type DecodeState } from './record-decoder.js';

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
    // Decoded, not skipped — see `header.ts`. Definitions only; the verdict is
    // the engine's to recompute.
    assertions: h.assertions,
  };

  const state: DecodeState = { userSeq: 0 };
  while (!r.eof) {
    yield readRecord(r, h, base, state);
  }
}
