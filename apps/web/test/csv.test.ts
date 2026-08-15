import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../src/tables/csv';

/**
 * FORMULA INJECTION IS WHY THIS FILE EXISTS.
 *
 * Request names come from the tool's payload, which came from someone's
 * simulation — untrusted input, reaching a file the reader opens in Excel or
 * Sheets. A cell beginning `=`, `+`, `-`, `@`, TAB or CR is EVALUATED on open,
 * and `=cmd|'/c calc'!A1` is the canonical demonstration that this ends in
 * command execution rather than a funny-looking cell.
 */
describe('escapeCsvCell', () => {
  it('quotes every cell', () => {
    expect(escapeCsvCell('GET Home')).toBe('"GET Home"');
  });

  it('doubles an embedded quote, per RFC 4180', () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('keeps an embedded comma inside the quotes rather than splitting a field', () => {
    expect(escapeCsvCell('GET /a,b')).toBe('"GET /a,b"');
  });

  it('keeps an embedded newline inside the quotes', () => {
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
  });

  it.each(['=', '+', '-', '@'])('neutralises a formula beginning %s', (lead) => {
    expect(escapeCsvCell(`${lead}cmd|'/c calc'!A1`)).toBe(`"'${lead}cmd|'/c calc'!A1"`);
  });

  it('neutralises a leading tab and carriage return', () => {
    expect(escapeCsvCell('\tSUM(A1)')).toBe(`"'\tSUM(A1)"`);
    expect(escapeCsvCell('\r=SUM(A1)')).toBe(`"'\r=SUM(A1)"`);
  });

  it('guards the lead character only, leaving an inner = alone', () => {
    // `a=b` is not a formula and must not acquire an apostrophe: over-guarding
    // would put a stray quote in front of ordinary request names.
    expect(escapeCsvCell('a=b')).toBe('"a=b"');
  });

  it('guards a string that merely looks like a negative number', () => {
    // Asserted so the behaviour is DELIBERATE rather than incidental. No column
    // in this table produces a negative — a count, a rate and a duration are
    // all non-negative — so the guard costs nothing here, and a spreadsheet
    // reading '-1 as text is better than one evaluating -1+cmd.
    expect(escapeCsvCell('-1')).toBe(`"'-1"`);
  });

  it('leaves an empty cell empty rather than guarding nothing', () => {
    expect(escapeCsvCell('')).toBe('""');
  });
});

describe('toCsv', () => {
  it('joins records with CRLF, per RFC 4180', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('"a","b"\r\n"1","2"');
  });

  it('emits the header even with no rows', () => {
    expect(toCsv(['a'], [])).toBe('"a"');
  });

  it('escapes header cells too', () => {
    // A percentile column label is derived from a payload key, so the header
    // is no more trusted than the body.
    expect(toCsv(['=evil'], [])).toBe(`"'=evil"`);
  });

  it('writes one record per row, in the order given', () => {
    const csv = toCsv(['n'], [['b'], ['a']]);
    expect(csv.split('\r\n')).toEqual(['"n"', '"b"', '"a"']);
  });
});
