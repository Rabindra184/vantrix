/**
 * The buffer ended mid-record.
 *
 * DISTINCT from a malformed log, and the distinction is the whole point: a
 * streaming caller rewinds and waits for more bytes on this, and gives up on
 * anything else. `subarray` does not throw when it overruns -- it returns a
 * short buffer -- so bounds are checked explicitly below rather than inferred
 * from a failure.
 */
export class TruncatedError extends Error {
  constructor(need: number, have: number, at: number) {
    super(`needed ${need} bytes at ${at}, have ${have}`);
    this.name = 'TruncatedError';
  }
}

/**
 * Gatling binary simulation.log primitives. Format: PRD Appendix A.10,
 * recovered from io.gatling.core.stats.writer.* and io.gatling.charts.stats.LogFileParser.
 */
export class BinaryReader {
  #buf: Buffer;
  /**
   * INDEX INTO `#buf`, not a file offset -- the two stopped being the same
   * number when `append` gained the ability to drop consumed bytes. `#base`
   * is the absolute offset `#buf[0]` sits at, so the absolute position is
   * `#base + #at`; that is what the public `pos` getter and `seek` speak,
   * and every read method below indexes with `#at` alone.
   */
  #at = 0;
  #base = 0;
  #stringCache = new Map<number, string>();

  constructor(buf: Buffer) { this.#buf = buf; }

  /** ABSOLUTE, and stays absolute across a compaction. */
  get pos(): number { return this.#base + this.#at; }
  get eof(): boolean { return this.#at >= this.#buf.length; }

  /** Bytes currently held in memory. See `append`. */
  get bufferedBytes(): number { return this.#buf.length; }

  #need(n: number): void {
    const have = this.#buf.length - this.#at;
    if (have < n) throw new TruncatedError(n, have, this.pos);
  }

  seek(pos: number): void { this.#at = pos - this.#base; }

  /**
   * Appends bytes, keeping the absolute position AND `#stringCache`. The
   * cache is why a streaming decoder cannot simply construct a new reader
   * per chunk: string back-references point at entries defined arbitrarily
   * far upstream.
   *
   * ═══ AND DROPS EVERYTHING BEFORE `keepFrom`, WHICH IS THE POINT ═══
   *
   * This was `Buffer.concat([this.#buf, chunk])` with nothing ever trimmed:
   * `#at` only ever advanced, so the reader held every byte it had ever
   * been given, and the copying was quadratic in the total. At the design's
   * 150-250 MB (§0) and 64 KB chunks that is ~4000 pushes and on the order
   * of half a terabyte of memcpy for one run, with 2x peak resident during
   * each concat. Nothing could see it: the fixture is 37 KB, so every test
   * on this class is too cheap to notice.
   *
   * `keepFrom` is an ABSOLUTE offset, and the caller passes the boundary of
   * the last WHOLE record it decoded (`StreamingLogDecoder`'s `#consumed`).
   * Bytes before it can never be read again -- the decoder rewinds only as
   * far as the record it is in the middle of. Clamped to `#at` regardless,
   * because dropping bytes the reader has not reached would corrupt the
   * next read rather than merely waste memory.
   *
   * ONE ALLOCATION, AND IT COPIES. `subarray` would be cheaper and wrong:
   * it returns a VIEW onto the same ArrayBuffer, so the "dropped" prefix
   * stays reachable and nothing is actually released -- the whole
   * behaviour this exists for. Copying the retained tail costs nothing
   * once the tail IS a tail: it is at most one partial record.
   *
   * The old "adopt the chunk when `#buf` is empty" fast path is gone for
   * the same reason. It was near-unreachable before (only the very first
   * append) and would become the common case here, and adopting means
   * retaining whatever the caller's Buffer is a view of -- a 64 KB chunk
   * cut from a 250 MB read pins all 250 MB.
   */
  append(chunk: Buffer, keepFrom: number = this.#base): void {
    const cut = Math.max(0, Math.min(keepFrom - this.#base, this.#at));
    const kept = this.#buf.length - cut;
    const next = Buffer.allocUnsafe(kept + chunk.length);
    this.#buf.copy(next, 0, cut);
    chunk.copy(next, kept);
    this.#buf = next;
    this.#base += cut;
    this.#at -= cut;
  }

  readByte(): number { this.#need(1); return this.#buf.readInt8(this.#at++); }
  readBoolean(): boolean { this.#need(1); return this.#buf.readInt8(this.#at++) !== 0; }
  readInt(): number { this.#need(4); const v = this.#buf.readInt32BE(this.#at); this.#at += 4; return v; }
  readLong(): number { this.#need(8); const v = this.#buf.readBigInt64BE(this.#at); this.#at += 8; return Number(v); }

  /** 2 bytes, big-endian. Used by the assertion payload's enums and counts. */
  readShort(): number { this.#need(2); const v = this.#buf.readInt16BE(this.#at); this.#at += 2; return v; }

  /**
   * 8 bytes, LITTLE-endian — the one quantity in this format that is not
   * big-endian, and only ever inside the assertion payload (PRD §A.10).
   *
   * Worth its own method rather than an inline `readDoubleLE`, because reading
   * it big-endian does not throw: 30000.0 comes back as `2.4887944e-317`, a
   * denormal that looks like a plausible-if-odd number rather than an error.
   */
  readDoubleLE(): number { this.#need(8); const v = this.#buf.readDoubleLE(this.#at); this.#at += 8; return v; }

  /** [int len][len bytes][coder byte]. len === 0 means empty AND no coder byte follows. */
  readString(): string {
    const len = this.readInt();
    if (len === 0) return '';
    this.#need(len + 1);                 // +1 for the coder byte; subarray would NOT throw
    const bytes = this.#buf.subarray(this.#at, this.#at + len);
    this.#at += len;
    const coder = this.readByte();
    return coder === 0 ? bytes.toString('latin1') : bytes.toString('utf16le');
  }

  /** The SIGN is the discriminator: i >= 0 defines cache[i] inline; i < 0 reads cache[-i]. */
  readCachedString(): string {
    const i = this.readInt();
    if (i >= 0) {
      const s = this.readString();
      this.#stringCache.set(i, s);
      return s;
    }
    const s = this.#stringCache.get(-i);
    if (s === undefined) {
      // Absolute (`pos`), so the offset it names is one a reader can find
      // in the file rather than an index into whatever this happens to
      // still be holding.
      throw new Error(`dangling string back-reference ${-i} at byte ${this.pos - 4}`);
    }
    return s;
  }

  readGroups(): string[] {
    const n = this.readInt();
    const out: string[] = [];
    for (let k = 0; k < n; k++) out.push(this.readCachedString());
    return out;
  }
}
