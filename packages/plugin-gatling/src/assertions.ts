import type {
  AssertionCondition,
  AssertionPath,
  AssertionStatus,
  AssertionTarget,
  ToolAssertion,
} from '@perfportal/core';
import { BinaryReader } from './reader.js';

/**
 * The assertion payload in the run header — PRD §A.10.
 *
 * ═══ IT IS NOT PROTOBUF ═══
 *
 * This was recorded as "protobuf-serialized assertion; opaque here" through two
 * verification passes, and both halves were wrong. Decoding the bytes as
 * protobuf yields a field-number-0 key, which protobuf forbids — the first sign
 * the claim had never been tested against a real file.
 *
 * ═══ RECOVERED BY CORPUS, NOT BY INFERENCE ═══
 *
 * The layout below comes from running one simulation that declares an assertion
 * for every Path x Target x Condition the DSL offers, at `atOnceUsers(1)` —
 * assertions are written at start, so the traffic is irrelevant — and reading
 * the emitted bytes back against known meanings. Three samples would not have
 * been enough to tell a constant from a coincidence.
 *
 * ═══ WHAT THE CORPUS ALSO SETTLED ═══
 *
 * `around(v, d)` and `deviatesAround(v, pct)` do NOT survive as distinct
 * conditions: both are compiled to `between` with the bounds already evaluated
 * (`around(36, 37)` is written as `between(-1.0, 73.0)`). A reader cannot
 * recover which call produced a `between`, and this decoder does not pretend
 * to.
 *
 * ═══ UNKNOWN TAGS THROW ═══
 *
 * Every discriminator below rejects a value it does not know rather than
 * defaulting. A wrong assertion is worse than a missing one: it would be
 * rendered beside exact statistics as though it carried the same authority,
 * which is the failure mode R-3 exists to prevent.
 */

const PATH = { GLOBAL: 1, FOR_ALL: 2, DETAILS: 3 } as const;
const TARGET = { COUNT: 1, PERCENT: 2, RESPONSE_TIME: 3, MEAN_RPS: 4 } as const;
const STAT = { MIN: 1, MAX: 2, MEAN: 3, STDDEV: 4, PERCENTILE: 5 } as const;
const COND = { LTE: 1, GTE: 2, LT: 3, GT: 4, IS: 5, BETWEEN: 6, IN: 7 } as const;

/**
 * The int16 that sits between the response-time tag and its statistic.
 *
 * Constant `1` across every response-time assertion in the corpus, and the DSL
 * offers no way to vary it — `responseTime()` takes no status, unlike
 * `count()`/`percent()`, whose same-shaped int16 IS a status. Treated as a
 * reserved discriminator and REQUIRED to be 1: if a future Gatling starts
 * varying it, this throws and names the value rather than silently reading the
 * next byte as a statistic it is not.
 */
const RESPONSE_TIME_RESERVED = 1;

/**
 * ═══ A 0x00 INTRODUCES EVERY BLOCK OF DOUBLES ═══
 *
 * Observed throughout the corpus, and exactly once per block rather than once
 * per value: `lt` is `03 00 <double>`, a percentile rank is
 * `05 00 <double>`, `between` is `06 00 <double> <double> <bool>` — one pad,
 * two doubles — and `in` is `07 00 <byte n> <double × n>`.
 *
 * WHAT IT MEANS IS NOT KNOWN, and this decoder invents no story for it. Every
 * small integer elsewhere in this payload is written `00 XX`, so the natural
 * guess is the high half of a big-endian int16 — but `lt` has no integer to
 * carry, and `in`'s count follows this byte rather than being it. Both
 * readings fit; nothing in the corpus separates them.
 *
 * Consumed and REQUIRED to be zero either way. If a future Gatling writes
 * something else here the layout has moved, and throwing names the value
 * instead of reading a double from one byte off — which is the failure R-3
 * exists to prevent, and which does not announce itself: read one byte early,
 * `30000.0` comes back as a plausible-looking denormal.
 */
function readPad(r: BinaryReader, where: string): void {
  const pad = r.readByte();
  if (pad !== 0) throw new Error(`unexpected pad byte ${pad} before ${where}`);
}

function statusOf(raw: number): AssertionStatus {
  if (raw === 1) return 'all';
  if (raw === 2) return 'ok';
  if (raw === 3) return 'ko';
  throw new Error(`unknown assertion status ${raw}`);
}

function readPath(r: BinaryReader): AssertionPath {
  const tag = r.readByte();
  if (tag === PATH.GLOBAL) return { kind: 'global' };
  if (tag === PATH.FOR_ALL) return { kind: 'forAll' };
  if (tag === PATH.DETAILS) {
    const count = r.readShort();
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      // A BYTE length and raw UTF-8 — not the header's `string` framing, which
      // is an int length plus a trailing coder byte. The two are different and
      // reading one as the other desynchronises the rest of the payload.
      const len = r.readByte();
      let part = '';
      for (let k = 0; k < len; k++) part += String.fromCharCode(r.readByte());
      parts.push(Buffer.from(part, 'latin1').toString('utf8'));
    }
    return { kind: 'details', parts };
  }
  throw new Error(`unknown assertion path tag ${tag}`);
}

function readTarget(r: BinaryReader): AssertionTarget {
  const tag = r.readByte();
  if (tag === TARGET.COUNT) return { kind: 'count', status: statusOf(r.readShort()) };
  if (tag === TARGET.PERCENT) return { kind: 'percent', status: statusOf(r.readShort()) };
  if (tag === TARGET.MEAN_RPS) return { kind: 'meanRequestsPerSecond' };
  if (tag === TARGET.RESPONSE_TIME) {
    const reserved = r.readShort();
    if (reserved !== RESPONSE_TIME_RESERVED) {
      throw new Error(
        `unexpected response-time discriminator ${reserved} (expected ${RESPONSE_TIME_RESERVED})`,
      );
    }
    const stat = r.readByte();
    if (stat === STAT.MIN) return { kind: 'responseTime', stat: 'min' };
    if (stat === STAT.MAX) return { kind: 'responseTime', stat: 'max' };
    if (stat === STAT.MEAN) return { kind: 'responseTime', stat: 'mean' };
    if (stat === STAT.STDDEV) return { kind: 'responseTime', stat: 'stddev' };
    // The rank follows the tag, so `percentile1()` and `percentile(99.9)` are
    // the same encoding — the four "configurable" percentiles are resolved to
    // their numeric ranks before being written. `readPad` because a double
    // block is always introduced by one, here exactly as after a condition tag.
    if (stat === STAT.PERCENTILE) {
      readPad(r, 'percentile rank');
      return { kind: 'responseTime', stat: 'percentile', rank: r.readDoubleLE() };
    }
    throw new Error(`unknown response-time statistic ${stat}`);
  }
  throw new Error(`unknown assertion target tag ${tag}`);
}

function readCondition(r: BinaryReader): AssertionCondition {
  const tag = r.readByte();

  readPad(r, `the operands of condition ${tag}`);

  if (tag === COND.LTE) return { kind: 'lte', value: r.readDoubleLE() };
  if (tag === COND.GTE) return { kind: 'gte', value: r.readDoubleLE() };
  if (tag === COND.LT) return { kind: 'lt', value: r.readDoubleLE() };
  if (tag === COND.GT) return { kind: 'gt', value: r.readDoubleLE() };
  if (tag === COND.IS) return { kind: 'is', value: r.readDoubleLE() };
  if (tag === COND.BETWEEN) {
    const lo = r.readDoubleLE();
    const hi = r.readDoubleLE();
    return { kind: 'between', lo, hi, inclusive: r.readBoolean() };
  }
  if (tag === COND.IN) {
    const n = r.readByte();
    const values: number[] = [];
    for (let i = 0; i < n; i++) values.push(r.readDoubleLE());
    return { kind: 'in', values };
  }
  throw new Error(`unknown assertion condition tag ${tag}`);
}

/**
 * Decodes one assertion payload.
 *
 * `bytes` is the slice the header's `int len` framed — this function does not
 * read that length, so it can be handed a payload from anywhere.
 */
export function parseAssertion(bytes: Buffer): ToolAssertion {
  const r = new BinaryReader(bytes);
  // A leading 0x00 on every assertion in the corpus. Consumed and required for
  // the same reason `RESPONSE_TIME_RESERVED` is: an unexpected value here means
  // the layout moved, and reading on regardless would produce a confident wrong
  // assertion.
  const lead = r.readByte();
  if (lead !== 0) throw new Error(`unexpected assertion lead byte ${lead}`);
  return { path: readPath(r), target: readTarget(r), condition: readCondition(r) };
}
