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

  readByte(): number { return this.#buf.readInt8(this.#pos++); }
  readBoolean(): boolean { return this.#buf.readInt8(this.#pos++) !== 0; }
  readInt(): number { const v = this.#buf.readInt32BE(this.#pos); this.#pos += 4; return v; }
  readLong(): number { const v = this.#buf.readBigInt64BE(this.#pos); this.#pos += 8; return Number(v); }

  /** [int len][len bytes][coder byte]. len === 0 means empty AND no coder byte follows. */
  readString(): string {
    const len = this.readInt();
    if (len === 0) return '';
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
