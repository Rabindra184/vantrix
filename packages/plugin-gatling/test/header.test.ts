import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/reader.js';
import { readRunHeader } from '../src/header.js';

const FIXTURE = 'fixtures/gatling-3.15.1.2/reference-report/simulation.log';

describe('readRunHeader', () => {
  it('parses the Run record from the reference fixture', () => {
    const h = readRunHeader(new BinaryReader(readFileSync(FIXTURE)));
    expect(h.gatlingVersion).toBe('3.15.1');
    expect(h.simulationClassName).toBe('example.ParitySimulation');
    expect(h.scenarios).toEqual(['Browse', 'Checkout']);
    expect(h.assertionCount).toBe(3);
    expect(new Date(h.runStartEpochMs).toISOString()).toBe('2026-08-07T05:30:02.171Z');
  });
});
