import { Readable } from 'node:stream';
import type { BlobStore } from './blobs.js';

/** `live/{runId}/`: every chunk a run has written lives under this prefix. */
function chunkPrefix(runId: string): string {
  return `live/${runId}/`;
}

/**
 * `live/{runId}/{offset padded to 16 digits}.bin`.
 *
 * The padding is load-bearing, not cosmetic. `BlobStore.list` returns keys
 * in S3's lexicographic order, and assembly trusts that order to be byte
 * order. Unpadded, `'1000.bin'` sorts before `'999.bin'` — offset 1000's
 * bytes would be folded in before offset 999's, silently reordering the
 * stream. 16 digits covers any offset a run could reach long before the
 * chunk count itself becomes the bottleneck (2^53 - 1 bytes, safely past
 * what Number can represent exactly).
 */
function chunkKey(runId: string, offset: number): string {
  return `${chunkPrefix(runId)}${String(offset).padStart(16, '0')}.bin`;
}

/** The offset a chunk key encodes. Inverse of `chunkKey`. */
function offsetOf(key: string): number {
  const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.bin$/, '');
  return Number(base);
}

/**
 * Reassembles a live run's byte stream from the per-chunk objects S3 has no
 * append to avoid. `put` lands one object per chunk as it arrives; `assemble`
 * and `finalize` fold them back into the single contiguous `simulation.log`
 * a normal bundle upload would have produced in one piece.
 */
export class LiveChunkStore {
  readonly #blobs: BlobStore;

  constructor(blobs: BlobStore) {
    this.#blobs = blobs;
  }

  /** Lands one chunk as its own object; not durable-ordered relative to
   * concurrent `put` calls for the same run, only relative to `assemble`,
   * which reads whatever has landed by the time it runs. */
  async put(runId: string, offset: number, bytes: Buffer): Promise<void> {
    await this.#blobs.putStream(chunkKey(runId, offset), Readable.from([bytes]), bytes.length);
  }

  /**
   * Every chunk in ascending offset order, concatenated. A run with no
   * chunks yet (or none ever received) resolves to an empty buffer rather
   * than throwing — `#listChunkKeys` returning `[]` makes `Promise.all([])`
   * and `Buffer.concat([])` both no-ops, so there is no empty-run special
   * case to fall out of sync with the real one.
   *
   * Whole-log-in-memory, by the same design choice `bundle.ts`'s
   * `openTarGzBundle` documents for a completed bundle ("In memory by
   * design"): the live-run design doc (§3.5) puts the worst case at
   * ~150-250 MB for the 5M-event target it sizes against, so this buffer
   * and the `Promise.all` fan-out below are both bounded by that figure,
   * not by run length — a live run cannot grow the assembled result past
   * what a bundle upload of the same run would already have produced in
   * one piece. Unlike `openTarGzBundle`, there is no enforced budget
   * constant here: `openTarGzBundle` reads a bundle a caller can make
   * arbitrarily large by uploading a hostile archive, so its cap defends
   * against that input; `assemble` only ever reads back bytes this same
   * run already wrote through `put`, so there is nothing external to
   * bound against — the 250 MB figure is what a real run costs, not a
   * ceiling being enforced. The `get()` fan-out is similarly unbounded in
   * concurrency — at 64 KB chunks, ~250 MB is ~3900 chunk keys, so ~3900
   * concurrent `GetObjectCommand`s in the worst case — but the AWS SDK
   * v3's default Node HTTP handler caps a client at 50 concurrent sockets,
   * so this is throttled by the client itself rather than actually opening
   * thousands of connections. (NFR-SC-4 allows 50 *concurrent live runs*,
   * each with its own `BlobStore`/client — multiplying this per-run figure
   * across all of them is a real capacity question, just not one this one
   * run's `assemble` call can see or bound from in here.)
   */
  async assemble(runId: string): Promise<Buffer> {
    const keys = await this.#listChunkKeys(runId);
    const parts = await Promise.all(keys.map((key) => this.#blobs.get(key)));
    return Buffer.concat(parts);
  }

  /**
   * Chunks whose **start** offset is >= `offset`, concatenated in offset order.
   *
   * The fold owner's read: it holds a byte position and wants everything
   * after it, without re-reading a run's whole history on every tick.
   *
   * `offset` is a FETCH FRONTIER — the highest byte the caller has already
   * retrieved. Callers MUST NOT pass a decode position (e.g. the byte offset
   * of the last whole record decoded, or `StreamingLogDecoder.consumedBytes`).
   * A decoder's `consumedBytes` sits behind its unconsumed tail: a record can
   * straddle chunk boundaries, leaving a partial tail the decoder buffers.
   * Passing `consumedBytes` re-selects chunks already fetched whose start is
   * still >= that position, duplicating them in the fold and corrupting every
   * byte offset thereafter. The decoder's tail retention solves a different
   * problem — the partial record — and does not make re-delivery safe.
   *
   * Filters on the offset PARSED OUT of the key rather than on the key string,
   * even though the padding makes the two orders agree. A string comparison
   * would silently start behaving differently the day an offset needs 17 digits.
   * The parse is what the caller's units actually are.
   */
  async readFrom(runId: string, offset: number): Promise<Buffer> {
    const keys = await this.#listChunkKeys(runId);
    const wanted = keys.filter((k) => offsetOf(k) >= offset);
    return Buffer.concat(await Promise.all(wanted.map((k) => this.#blobs.get(k))));
  }

  /**
   * Writes the assembled log to `key` and removes the chunk objects.
   * See `assemble`'s doc comment for the memory/concurrency shape of the
   * assembly this performs.
   *
   * "Already finalized" is judged by whether `key` already holds
   * content, not by whether any chunks remain — those are NOT
   * interchangeable, and keying the guard on the chunk list is a data-loss
   * bug: a `finalize` call that wrote `key` successfully but was
   * interrupted before finishing chunk cleanup (killed mid-loop, OOM, one
   * `delete` in a settle batch failing while others land) leaves stale
   * chunks behind even though `key` already holds the complete, correct
   * log. A retry keyed on "chunks gone" would not recognize that as done —
   * it would re-assemble only the survivors and overwrite the correct log
   * with a truncated one. Checking `exists(key)` first is what actually
   * recovers from that state: once the destination is written, this method
   * is done writing, regardless of how far its own cleanup got.
   *
   * A run with no chunks AND no `key` yet is the "never received a byte"
   * case — intentionally a no-op that writes nothing. Task 9's `close()`
   * is responsible for detecting a zero-byte run and finalizing it as
   * `incomplete` without a `key` to parse; this primitive does not invent
   * an empty log to paper over that.
   *
   * Chunk cleanup runs every time this method finds chunks under the
   * prefix, whether or not it just wrote `key` — so a retry after a
   * partial cleanup failure still finishes deleting the survivors, it just
   * never touches `key` again once that part is done. `Promise.allSettled`
   * (not `Promise.all`) is deliberate: one delete failing must not abort
   * the batch and must not throw past the correctly-written log, mirroring
   * `putStream`'s own "leave debris for a lifecycle rule to reap" stance on
   * best-effort cleanup after the durable part has already succeeded.
   */
  async finalize(runId: string, key: string): Promise<void> {
    const alreadyWritten = await this.#blobs.exists(key);
    const keys = await this.#listChunkKeys(runId);

    if (!alreadyWritten) {
      if (keys.length === 0) return;
      const parts = await Promise.all(keys.map((k) => this.#blobs.get(k)));
      const assembled = Buffer.concat(parts);
      await this.#blobs.putStream(key, Readable.from([assembled]), assembled.length);
    }

    const deletions = await Promise.allSettled(keys.map((k) => this.#blobs.delete(k)));
    const failures = deletions.filter(
      (d): d is PromiseRejectedResult => d.status === 'rejected',
    );
    if (failures.length > 0) {
      console.error(
        `LiveChunkStore.finalize(${runId}): wrote ${key} but failed to delete ` +
          `${failures.length}/${keys.length} chunk object(s); left for a lifecycle rule to reap`,
        failures.map((f) => f.reason),
      );
    }
  }

  /** Chunk keys for `runId`, sorted — lexicographic order over the
   * zero-padded offsets is numeric order over the real ones. */
  async #listChunkKeys(runId: string): Promise<string[]> {
    const keys = await this.#blobs.list(chunkPrefix(runId));
    return keys.sort();
  }
}
