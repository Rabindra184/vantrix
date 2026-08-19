/**
 * ═══ A SYNTHETIC simulation.log ═══
 *
 * Mirrors packages/plugin-gatling/test/records.test.ts's own encoder -- there
 * is no shared WRITER for this format anywhere in the workspace (only the one
 * reader `record-decoder.ts` deliberately keeps, per its own doc comment), so
 * a synthetic log built for a test builds its bytes the same way that file
 * already does rather than importing a test file across a package boundary.
 *
 * NOT a `*.test.ts` file, so neither vitest config collects it: it declares no
 * cases and opens no connections, and importing it from a real test file
 * therefore costs nothing but the functions below.
 *
 * The reference fixture used by most cases in `fold-owner.integration.test.ts`
 * carries a FIXED error rate (~2.7%) and a fixed latency distribution: fine
 * for proving a fold matches a batch parse, wrong for a test that needs to
 * choose exactly how much a run is or is not breaching, or exactly which
 * events a warm-up window swallows. CLAUDE.md's "expectations are computed
 * from the payload" rule is about not re-deriving a fixture's numbers by hand
 * -- it does not forbid choosing the payload in the first place, which is what
 * building it here means: the counts are inputs a test owns, not a real run's
 * output being second-guessed.
 */

/** The synthetic run's own start instant. Every offset below is relative to
 * it, exactly as Gatling's own records are (`record-decoder.ts` adds the
 * header's `runStartMs` to each `readInt`). */
export const RUN_START_MS = 1_700_000_000_000;

/** [int len][len bytes][coder byte]; empty string is just the zero length. */
function encodeString(s: string): Buffer {
  if (s.length === 0) return Buffer.from([0, 0, 0, 0]);
  const str = Buffer.from(s, 'latin1');
  const len = Buffer.alloc(4);
  len.writeInt32BE(str.length, 0);
  return Buffer.concat([len, str, Buffer.from([0])]);
}

function encodeInt(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  return buf;
}

function encodeLong(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(n), 0);
  return buf;
}

/** `[int index][string]` -- always DEFINES the slot inline (`index >= 0`),
 * never a `< 0` back-reference. `BinaryReader.readCachedString`'s own doc
 * comment makes redefinition valid ("i >= 0 defines cache[i] inline"), so a
 * synthetic log that needs no compression can just redefine the same few
 * slots on every record instead of building real back-references. */
function encodeNewCachedString(index: number, value: string): Buffer {
  return Buffer.concat([encodeInt(index), encodeString(value)]);
}

/** RECORD.RUN (see header.ts's `RECORD`): one scenario, no description, no
 * tool assertions -- nothing any caller of this module reads. */
export function buildRunHeader(runStartMs: number): Buffer {
  return Buffer.concat([
    Buffer.from([0]),
    encodeString('3.15.1'),
    encodeString('test.Sim'),
    encodeLong(runStartMs),
    encodeString(''),
    encodeInt(1),
    encodeString('TestScenario'),
    encodeInt(0),
  ]);
}

/** RECORD.REQUEST, zero groups -- every caller asks only run-scope questions,
 * so no group hierarchy is needed for `evaluateRules` to find the run-scope
 * stat (`scope: 'run', name: ''`, `evaluate.ts`'s own target resolution).
 *
 * `durationMs` is a parameter because a warm-up window is only observable
 * through the latencies it excludes: a log whose every request takes 1ms
 * reports the same `max` whether or not the first N seconds were dropped. */
export function buildRequestRecord(tsOffsetMs: number, ok: boolean, durationMs = 1): Buffer {
  return Buffer.concat([
    Buffer.from([1]),
    encodeInt(0), // zero groups
    encodeNewCachedString(1, 'Checkout'),
    encodeInt(tsOffsetMs),
    encodeInt(tsOffsetMs + durationMs),
    Buffer.from([ok ? 1 : 0]),
    encodeNewCachedString(2, ok ? '' : 'status.find.is(200), found 500'),
  ]);
}

/** `count` REQUEST records, all `ok`, starting `startTsOffsetMs` apart by
 * 1ms each -- built as an array and concatenated ONCE (never
 * `Buffer.concat` inside the loop), the same quadratic-copy trap
 * `BinaryReader.append`'s own doc comment documents for the real reader. */
export function buildRequestBatch(
  startTsOffsetMs: number,
  count: number,
  ok: boolean,
  durationMs = 1,
): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) parts.push(buildRequestRecord(startTsOffsetMs + i, ok, durationMs));
  return Buffer.concat(parts);
}
