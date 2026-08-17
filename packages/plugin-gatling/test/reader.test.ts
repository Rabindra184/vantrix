import { describe, expect, it } from 'vitest';
import { BinaryReader, TruncatedError } from '../src/reader.js';

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe('BinaryReader primitives', () => {
  it('reads big-endian signed int', () => {
    expect(new BinaryReader(buf(0, 0, 0, 6)).readInt()).toBe(6);
    expect(new BinaryReader(buf(0xff, 0xff, 0xff, 0xfb)).readInt()).toBe(-5);
  });

  it('reads a string as [len][bytes][coder]', () => {
    const b = Buffer.concat([buf(0, 0, 0, 6), Buffer.from('3.15.1', 'latin1'), buf(0)]);
    const r = new BinaryReader(b);
    expect(r.readString()).toBe('3.15.1');
    expect(r.eof).toBe(true);
  });

  it('treats a zero length as empty string with NO trailing coder byte', () => {
    const r = new BinaryReader(buf(0, 0, 0, 0, 0xaa));
    expect(r.readString()).toBe('');
    expect(r.pos).toBe(4);          // the 0xaa must NOT have been consumed
  });
});

describe('cachedString sign discriminator', () => {
  it('non-negative index means a new string follows inline', () => {
    const b = Buffer.concat([buf(0, 0, 0, 3), buf(0, 0, 0, 4), Buffer.from('Cart', 'latin1'), buf(0)]);
    expect(new BinaryReader(b).readCachedString()).toBe('Cart');
  });

  it('negative index is a back-reference to cache[-i]', () => {
    const b = Buffer.concat([
      buf(0, 0, 0, 3), buf(0, 0, 0, 4), Buffer.from('Cart', 'latin1'), buf(0),  // define at index 3
      buf(0xff, 0xff, 0xff, 0xfd),                                              // -3 -> back-ref
    ]);
    const r = new BinaryReader(b);
    expect(r.readCachedString()).toBe('Cart');
    expect(r.readCachedString()).toBe('Cart');
  });

  it('throws a dangling back-reference rather than returning undefined', () => {
    const r = new BinaryReader(buf(0xff, 0xff, 0xff, 0xfd));
    expect(() => r.readCachedString()).toThrow(/back-reference/);
  });
});

describe('BinaryReader truncation', () => {
  it('throws TruncatedError rather than reading a short int', () => {
    const r = new BinaryReader(Buffer.from([0x00, 0x01]));   // 2 bytes; readInt needs 4
    expect(() => r.readInt()).toThrow(TruncatedError);
  });

  it('throws TruncatedError rather than returning a half string', () => {
    // [int len = 5][only 3 of the 5 bytes]
    const buf_data = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(5); return b; })(),
      Buffer.from('abc', 'latin1'),
    ]);
    const r = new BinaryReader(buf_data);
    expect(() => r.readString()).toThrow(TruncatedError);
  });

  it('append lets a read that was truncated succeed', () => {
    const head = Buffer.alloc(2);                 // half an int
    const r = new BinaryReader(head);
    const mark = r.pos;
    expect(() => r.readInt()).toThrow(TruncatedError);

    r.seek(mark);
    r.append(Buffer.from([0x00, 0x07]));          // completes 0x00000007
    expect(r.readInt()).toBe(7);
  });

  it('append preserves the string cache across the boundary', () => {
    const define = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(3); return b; })(),   // cache index 3
      (() => { const b = Buffer.alloc(4); b.writeInt32BE(2); return b; })(),   // len 2
      Buffer.from('hi', 'latin1'),
      Buffer.from([0x00]),                                                      // latin1 coder
    ]);
    const r = new BinaryReader(define);
    expect(r.readCachedString()).toBe('hi');

    // The back-reference arrives only in the next chunk.
    const back = Buffer.alloc(4); back.writeInt32BE(-3);
    r.append(back);
    expect(r.readCachedString()).toBe('hi');
  });
});
