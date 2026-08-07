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
    const len = r.readInt();          // protobuf-serialized assertion; opaque here
    for (let k = 0; k < len; k++) r.readByte();
  }

  return { gatlingVersion, simulationClassName, runStartEpochMs, description, scenarios, assertionCount };
}
