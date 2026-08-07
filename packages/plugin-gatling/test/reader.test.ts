import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/reader.js';

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
