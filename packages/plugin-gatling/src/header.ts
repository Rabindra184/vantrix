import type { ToolAssertion } from '@perfportal/core';
import { parseAssertion } from './assertions.js';
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
  /** The tool's own assertions, decoded — Appendix A G-05. Definitions only. */
  assertions: ToolAssertion[];
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
  // ═══ NOT PROTOBUF, AND NO LONGER SKIPPED ═══
  //
  // This loop used to consume the payload and drop it, under a comment reading
  // "protobuf-serialized assertion; opaque here" that was wrong on both counts:
  // decoding the bytes as protobuf yields a field-number-0 key, which protobuf
  // forbids. The real layout is `assertions.ts` and PRD §A.10.
  //
  // These are DEFINITIONS. The result file carries no actual value and no
  // pass/fail — Gatling's own report recomputes both at render time — so
  // Appendix A G-05 is finished by the evaluator, not here.
  const assertions: ToolAssertion[] = [];
  for (let i = 0; i < assertionCount; i++) {
    const len = r.readInt();
    const bytes = Buffer.alloc(len);
    for (let k = 0; k < len; k++) bytes[k] = r.readByte() & 0xff;
    assertions.push(parseAssertion(bytes));
  }

  return {
    gatlingVersion, simulationClassName, runStartEpochMs, description, scenarios,
    assertionCount, assertions,
  };
}
