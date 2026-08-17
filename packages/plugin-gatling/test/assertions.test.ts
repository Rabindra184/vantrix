import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolAssertion } from '@perfportal/core';
import { parseAssertion } from '../src/assertions.js';
import { readRunHeader } from '../src/header.js';
import { BinaryReader } from '../src/reader.js';

/**
 * ═══ THE CORPUS IS THE SPECIFICATION ═══
 *
 * `fixtures/gatling-3.15.1.2/assertion-corpus/` holds a real 805-byte
 * `simulation.log` and the simulation that produced it. That simulation
 * declares one assertion per Path x Target x Condition the Gatling DSL offers,
 * in a fixed order, and runs `atOnceUsers(1)` — assertions are written to the
 * header at start, so the traffic is irrelevant and the fixture stays tiny.
 *
 * The expectations below are that simulation's source, transcribed. That is
 * the ONLY thing in this repo that may be written down rather than derived
 * (cf. CLAUDE.md's "expectations are computed from the payload"): here the
 * declared assertion IS the ground truth, and the bytes are what is under test.
 * Re-capturing the fixture without editing `AssertionCorpus.kt` cannot move any
 * of these.
 *
 * Two entries deserve their own note, because a reader will otherwise think
 * they are wrong:
 *
 *   #25 `around(36, 37)`        -> between(-1, 73)
 *   #26 `deviatesAround(38, .5)` -> between(19, 57)
 *
 * Gatling evaluates those bounds at declaration time and writes a plain
 * `between`. Which DSL call produced a `between` is NOT recoverable, and this
 * decoder does not pretend otherwise.
 */

const LOG = 'fixtures/gatling-3.15.1.2/assertion-corpus/simulation.log';

const rt = (
  stat: 'min' | 'max' | 'mean' | 'stddev' | 'percentile',
  rank?: number,
): ToolAssertion['target'] =>
  rank === undefined ? { kind: 'responseTime', stat } : { kind: 'responseTime', stat, rank };

const global = { kind: 'global' } as const;

const EXPECTED: readonly ToolAssertion[] = [
  // ── paths ──────────────────────────────────────────────────────────────
  { path: global, target: rt('max'), condition: { kind: 'lt', value: 1 } },
  { path: { kind: 'forAll' }, target: rt('max'), condition: { kind: 'lt', value: 2 } },
  { path: { kind: 'details', parts: ['Session'] }, target: rt('max'), condition: { kind: 'lt', value: 3 } },
  { path: { kind: 'details', parts: ['A', 'B'] }, target: rt('max'), condition: { kind: 'lt', value: 4 } },

  // ── response-time statistics ───────────────────────────────────────────
  { path: global, target: rt('min'), condition: { kind: 'lt', value: 10 } },
  { path: global, target: rt('max'), condition: { kind: 'lt', value: 11 } },
  { path: global, target: rt('mean'), condition: { kind: 'lt', value: 12 } },
  { path: global, target: rt('stddev'), condition: { kind: 'lt', value: 13 } },
  // percentile1..4 resolve to their numeric ranks before being written, so the
  // four "configurable" percentiles share one encoding with percentile(x).
  { path: global, target: rt('percentile', 50), condition: { kind: 'lt', value: 14 } },
  { path: global, target: rt('percentile', 75), condition: { kind: 'lt', value: 15 } },
  { path: global, target: rt('percentile', 95), condition: { kind: 'lt', value: 16 } },
  { path: global, target: rt('percentile', 99), condition: { kind: 'lt', value: 17 } },
  { path: global, target: rt('percentile', 99.9), condition: { kind: 'lt', value: 18 } },

  // ── counts, percentages, rate ──────────────────────────────────────────
  { path: global, target: { kind: 'count', status: 'all' }, condition: { kind: 'lt', value: 20 } },
  { path: global, target: { kind: 'percent', status: 'all' }, condition: { kind: 'lt', value: 21 } },
  { path: global, target: { kind: 'count', status: 'ko' }, condition: { kind: 'lt', value: 22 } },
  { path: global, target: { kind: 'percent', status: 'ko' }, condition: { kind: 'lt', value: 23 } },
  { path: global, target: { kind: 'count', status: 'ok' }, condition: { kind: 'lt', value: 24 } },
  { path: global, target: { kind: 'percent', status: 'ok' }, condition: { kind: 'lt', value: 25 } },
  { path: global, target: { kind: 'meanRequestsPerSecond' }, condition: { kind: 'lt', value: 26 } },

  // ── conditions ─────────────────────────────────────────────────────────
  { path: global, target: rt('max'), condition: { kind: 'lt', value: 30 } },
  { path: global, target: rt('max'), condition: { kind: 'lte', value: 31 } },
  { path: global, target: rt('max'), condition: { kind: 'gt', value: 32 } },
  { path: global, target: rt('max'), condition: { kind: 'gte', value: 33 } },
  { path: global, target: rt('max'), condition: { kind: 'between', lo: 34, hi: 35, inclusive: true } },
  { path: global, target: rt('max'), condition: { kind: 'between', lo: -1, hi: 73, inclusive: true } },
  { path: global, target: rt('max'), condition: { kind: 'between', lo: 19, hi: 57, inclusive: true } },
  { path: global, target: rt('max'), condition: { kind: 'is', value: 39 } },
  { path: global, target: rt('max'), condition: { kind: 'in', values: [40, 41, 42] } },
];

describe('parseAssertion — the run header’s assertion payload (PRD §A.10)', () => {
  const header = readRunHeader(new BinaryReader(readFileSync(LOG)));

  it('decodes every assertion the corpus declared, in order', () => {
    expect(header.assertionCount).toBe(EXPECTED.length);
    expect(header.assertions).toEqual(EXPECTED);
  });

  it('consumes the payload exactly, leaving the record stream aligned', () => {
    // The header is followed by real records. If any assertion over- or
    // under-read by a byte, this would decode garbage or throw — the same
    // property the Error-record test asserts for the body.
    const r = new BinaryReader(readFileSync(LOG));
    readRunHeader(r);
    expect(r.eof).toBe(false);
    // The next byte must be a record type, not a fragment of an assertion.
    expect([0, 1, 2, 3, 4]).toContain(r.readByte());
  });

  /**
   * ═══ AN UNKNOWN TAG THROWS, IT DOES NOT DEFAULT ═══
   *
   * A wrong assertion is worse than a missing one: it would be rendered beside
   * exact statistics as if it carried the same authority. R-3's whole point is
   * that a layout change must fail loudly rather than produce plausible wrong
   * numbers.
   */
  it.each([
    ['lead byte', Buffer.from([0x09, 0x01, 0x03, 0x00, 0x01, 0x02, 0x03])],
    ['path tag', Buffer.from([0x00, 0x7f, 0x03, 0x00, 0x01, 0x02, 0x03])],
    ['target tag', Buffer.from([0x00, 0x01, 0x7f, 0x00, 0x01, 0x02, 0x03])],
  ])('rejects an unknown %s rather than guessing', (_what, bytes) => {
    expect(() => parseAssertion(bytes)).toThrow();
  });

  it('rejects a response-time discriminator it has never seen', () => {
    // `00 02` where every observed assertion carries `00 01`. Reading on would
    // take the next byte as a statistic it is not.
    const bytes = Buffer.from([0x00, 0x01, 0x03, 0x00, 0x02, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => parseAssertion(bytes)).toThrow(/discriminator/i);
  });
});
