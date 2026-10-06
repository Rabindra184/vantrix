import { describe, expect, it } from 'vitest';
import { parsePaletteQuery } from '../src/palette/parseQuery.js';

/**
 * What the palette reads out of what a reader typed.
 *
 * The only structure it recognises is a trailing `#N`, which is the one way to
 * say "run N of that test". Everything else is free text, and the rule that
 * matters most is the one a reader would never think to test: a `#N` with
 * nothing in front of it names a run of NO test, and the API refuses that
 * (`NUMBER_NEEDS_TEST`), so the palette must not ask. `#12` alone therefore
 * parses as plain text.
 */
describe('parsePaletteQuery', () => {
  it('reads a trailing #N as a run number of the text before it', () => {
    expect(parsePaletteQuery('checkout #12')).toEqual({
      text: 'checkout #12',
      runNumber: { text: 'checkout', n: 12 },
    });
  });

  it('does not need a space before the #', () => {
    expect(parsePaletteQuery('checkout#12').runNumber).toEqual({ text: 'checkout', n: 12 });
  });

  it('keeps a multi-word test name whole', () => {
    expect(parsePaletteQuery('checkout soak #7').runNumber).toEqual({
      text: 'checkout soak',
      n: 7,
    });
  });

  it('reads a bare #N as plain text, because a run number needs a test (review focus 5)', () => {
    const q = parsePaletteQuery('#12');
    expect(q.runNumber).toBeNull();
    expect(q.text).toBe('#12');
  });

  it('refuses a number the API would refuse: zero, and anything past int4', () => {
    expect(parsePaletteQuery('checkout #0').runNumber).toBeNull();
    expect(parsePaletteQuery('checkout #99999999999').runNumber).toBeNull();
  });

  it('accepts the largest number the API accepts, and not one more', () => {
    expect(parsePaletteQuery('checkout #2147483647').runNumber?.n).toBe(2147483647);
    expect(parsePaletteQuery('checkout #2147483648').runNumber).toBeNull();
  });

  it('only reads a #N at the END of the text', () => {
    expect(parsePaletteQuery('checkout #12 soak').runNumber).toBeNull();
    expect(parsePaletteQuery('checkout #12x').runNumber).toBeNull();
    expect(parsePaletteQuery('checkout #').runNumber).toBeNull();
  });

  it('trims what it returns as text', () => {
    expect(parsePaletteQuery('  rules  ')).toEqual({ text: 'rules', runNumber: null });
    expect(parsePaletteQuery('  checkout #12  ').runNumber).toEqual({ text: 'checkout', n: 12 });
  });

  it('answers an empty or blank query with empty text and no number', () => {
    expect(parsePaletteQuery('')).toEqual({ text: '', runNumber: null });
    expect(parsePaletteQuery('   ')).toEqual({ text: '', runNumber: null });
  });
});
