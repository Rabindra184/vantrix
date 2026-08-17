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
  #pos = 0;
  #stringCache = new Map<number, string>();

  constructor(buf: Buffer) { this.#buf = buf; }

  get pos(): number { return this.#pos; }
  get eof(): boolean { return this.#pos >= this.#buf.length; }

  #need(n: number): void {
    const have = this.#buf.length - this.#pos;
    if (have < n) throw new TruncatedError(n, have, this.#pos);
  }

  seek(pos: number): void { this.#pos = pos; }

  /**
   * Appends bytes, keeping `#pos` AND `#stringCache`. The cache is why a
   * streaming decoder cannot simply construct a new reader per chunk: string
   * back-references point at entries defined arbitrarily far upstream.
   */
  append(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
  }

  readByte(): number { this.#need(1); return this.#buf.readInt8(this.#pos++); }
  readBoolean(): boolean { this.#need(1); return this.#buf.readInt8(this.#pos++) !== 0; }
  readInt(): number { this.#need(4); const v = this.#buf.readInt32BE(this.#pos); this.#pos += 4; return v; }
  readLong(): number { this.#need(8); const v = this.#buf.readBigInt64BE(this.#pos); this.#pos += 8; return Number(v); }

  /** 2 bytes, big-endian. Used by the assertion payload's enums and counts. */
  readShort(): number { this.#need(2); const v = this.#buf.readInt16BE(this.#pos); this.#pos += 2; return v; }

  /**
   * 8 bytes, LITTLE-endian — the one quantity in this format that is not
   * big-endian, and only ever inside the assertion payload (PRD §A.10).
   *
   * Worth its own method rather than an inline `readDoubleLE`, because reading
   * it big-endian does not throw: 30000.0 comes back as `2.4887944e-317`, a
   * denormal that looks like a plausible-if-odd number rather than an error.
   */
  readDoubleLE(): number { this.#need(8); const v = this.#buf.readDoubleLE(this.#pos); this.#pos += 8; return v; }

  /** [int len][len bytes][coder byte]. len === 0 means empty AND no coder byte follows. */
  readString(): string {
    const len = this.readInt();
    if (len === 0) return '';
    this.#need(len + 1);                 // +1 for the coder byte; subarray would NOT throw
    const bytes = this.#buf.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
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
      throw new Error(`dangling string back-reference ${-i} at byte ${this.#pos - 4}`);
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
