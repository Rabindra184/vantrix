import { StreamingLogDecoder } from './stream.js';

/**
 * The longest prefix of a partially-written simulation log that is itself a
 * WHOLE log.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * A run whose producer died mid-write leaves a log ending in a half-record.
 * `parseSimulationLog` — the pull parser the ingest pipeline runs — reads a
 * FINISHED buffer and throws `TruncatedError` on that tail; measured on half
 * of the reference log, `needed 4 bytes at 18884, have 0`. So a partial log
 * cannot be handed to the pipeline as-is.
 *
 * `StreamingLogDecoder` already solves the same problem for the live feed: it
 * decodes what it can and rewinds to the last whole record, reporting that
 * position as `consumedBytes`. Cutting there turns a partial log into a
 * complete one, which the pull parser then reads without knowing anything
 * happened. On the same fixture: 18,884 bytes in, **882 events** decoded,
 * `consumedBytes` 18,883 — one trailing byte dropped.
 *
 * ONE DECODER STILL, WHICH IS THE POINT. This does not re-implement record
 * framing; it asks the decoder that already owns it. A second opinion about
 * where a record ends is precisely the drift `record-decoder.ts`'s own
 * docstring exists to prevent.
 *
 * A COMPLETE LOG IS RETURNED UNCHANGED — `consumedBytes` equals the length,
 * so the slice is the whole buffer and the normal close path pays nothing for
 * this existing.
 */
export function truncateToWholeRecords(buf: Buffer): Buffer {
  const decoder = new StreamingLogDecoder();
  // The events are discarded deliberately: the caller wants BYTES the pull
  // parser can read, not a second decode of the same run. Whoever consumes
  // the result re-decodes it through the one path every other run takes.
  decoder.push(buf);
  const end = decoder.consumedBytes;
  return end >= buf.length ? buf : buf.subarray(0, end);
}
