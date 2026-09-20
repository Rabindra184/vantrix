import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog, truncateToWholeRecords } from '../src/index.js';

const LOG = readFileSync(
  join(import.meta.dirname, '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log'),
);

/**
 * ═══ WHY THIS FUNCTION EXISTS, IN ONE ASSERTION ═══
 *
 * A run whose producer died mid-write leaves a half-record. The pipeline's
 * pull parser reads a FINISHED buffer and throws on it; the streaming decoder
 * rewinds to the last whole record. Cutting there is what lets an abandoned
 * run be parsed by the same path every other run takes.
 */
describe('truncateToWholeRecords', () => {
  it('makes a partial log readable by the parser that refuses one', () => {
    const half = LOG.subarray(0, Math.floor(LOG.length / 2));

    // THE PROBLEM, asserted rather than described — if this ever stops
    // throwing, this whole function is dead weight and should go.
    expect(() => [...parseSimulationLog(half)]).toThrow();

    const whole = truncateToWholeRecords(half);
    // THE FIX. Not "does not throw": a decoder that silently returned nothing
    // would also not throw, and would lose every measurement.
    const events = [...parseSimulationLog(whole)];
    expect(events.length).toBeGreaterThan(100);
  });

  it('drops only the half-written tail, never a whole record', () => {
    const half = LOG.subarray(0, Math.floor(LOG.length / 2));
    const whole = truncateToWholeRecords(half);

    expect(whole.length).toBeLessThanOrEqual(half.length);
    // The cut is a TAIL, so the surviving bytes are the original's prefix.
    expect(whole.equals(half.subarray(0, whole.length))).toBe(true);
    // And it is a tail, not a haircut: the reference log's own half loses a
    // single byte (18,884 -> 18,883).
    expect(half.length - whole.length).toBeLessThan(64);
  });

  /**
   * THE NORMAL PATH PAYS NOTHING. Every healthy close runs through this too,
   * and a complete log must come back byte-identical — not merely parseable,
   * or a rounding-down bug here would silently shorten every run in the
   * product.
   */
  it('returns a complete log unchanged', () => {
    const whole = truncateToWholeRecords(LOG);
    expect(whole.length).toBe(LOG.length);
    expect(whole.equals(LOG)).toBe(true);
  });
});
