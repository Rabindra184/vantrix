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
   */
  async assemble(runId: string): Promise<Buffer> {
    const keys = await this.#listChunkKeys(runId);
    const parts = await Promise.all(keys.map((key) => this.#blobs.get(key)));
    return Buffer.concat(parts);
  }

  /**
   * Writes the assembled log to `key` and removes the chunk objects.
   *
   * A no-op when the run has no chunks left under its prefix. That state
   * means one of two things — this run never received a byte, or a
   * previous `finalize` call already assembled and deleted them — and
   * `finalize` cannot tell those apart from here (nothing records "already
   * finalized" independently of the chunks themselves). Both are handled
   * the same way: skip the write. That is required for the second case —
   * without the guard, a redelivered close event or a caller retry would
   * re-run `assemble` against an empty prefix, `putStream` an EMPTY buffer
   * to `key`, and silently overwrite the real log the first call already
   * made durable. Whether or not `finalize` gets called twice in practice
   * is up to the caller (§ Task 9's close()); this primitive does not
   * assume it won't.
   */
  async finalize(runId: string, key: string): Promise<void> {
    const keys = await this.#listChunkKeys(runId);
    if (keys.length === 0) return;

    const parts = await Promise.all(keys.map((k) => this.#blobs.get(k)));
    const assembled = Buffer.concat(parts);
    await this.#blobs.putStream(key, Readable.from([assembled]), assembled.length);
    await Promise.all(keys.map((k) => this.#blobs.delete(k)));
  }

  /** Chunk keys for `runId`, sorted — lexicographic order over the
   * zero-padded offsets is numeric order over the real ones. */
  async #listChunkKeys(runId: string): Promise<string[]> {
    const keys = await this.#blobs.list(chunkPrefix(runId));
    return keys.sort();
  }
}
