import { BinaryReader } from './reader.js';

/** NOTE: Request=1 and User=2 are NOT in declaration order. Guessing corrupts every record. */
export const RECORD = { RUN: 0, REQUEST: 1, USER: 2, GROUP: 3, ERROR: 4 } as const;

export interface RunHeader {
  gatlingVersion: string;
  simulationClassName: string;
  runStartEpochMs: number;
  description: string;
  scenarios: string[];
  assertionCount: number;
}

export function readRunHeader(r: BinaryReader): RunHeader {
  const header = r.readByte();
  if (header !== RECORD.RUN) {
    throw new Error(`expected Run record (0) at byte 0, got ${header}`);
  }
  const gatlingVersion = r.readString();
  const simulationClassName = r.readString();
  const runStartEpochMs = r.readLong();
  const description = r.readString();

  const scenarioCount = r.readInt();
  const scenarios: string[] = [];
  for (let i = 0; i < scenarioCount; i++) scenarios.push(r.readString());

  const assertionCount = r.readInt();
  for (let i = 0; i < assertionCount; i++) {
    // ═══ NOT PROTOBUF ═══
    //
    // This comment used to read "protobuf-serialized assertion; opaque here",
    // and it was wrong on both counts. The payload is Gatling's own tagged
    // binary encoding — decoding it as protobuf yields a field-0 key, which is
    // illegal in protobuf and the first sign the claim was never checked. And
    // it is not opaque: the layout is written down in PRD §A.10, recovered by
    // decoding a corpus simulation that declares one assertion per
    // Path x Target x Condition and reading the bytes back against known
    // meanings.
    //
    // Still SKIPPED rather than decoded, for now. Surfacing them is Appendix A
    // G-05, and that needs more than a decoder: the log carries assertion
    // DEFINITIONS only, so the actual value and the pass/fail verdict have to
    // be computed against this platform's own statistics. That work is scoped
    // separately. What is fixed here is the false description that would have
    // sent the next reader looking for a protobuf schema that does not exist.
    const len = r.readInt();
    for (let k = 0; k < len; k++) r.readByte();
  }

  return { gatlingVersion, simulationClassName, runStartEpochMs, description, scenarios, assertionCount };
}
