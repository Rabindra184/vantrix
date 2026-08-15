/**
 * CSV for the statistics table.
 *
 * FORMULA INJECTION IS WHY THIS FILE HAS A GUARD AND A TEST SUITE OF ITS OWN.
 *
 * Request names come from the tool's payload, which came from someone's
 * simulation — untrusted input, reaching a file the reader will open in Excel
 * or Sheets. A cell beginning `=`, `+`, `-`, `@`, TAB or CR is EVALUATED on
 * open, and `=cmd|'/c calc'!A1` is the canonical demonstration that this ends
 * in command execution rather than a funny-looking cell. The header is no
 * safer than the body: percentile column labels are derived from payload keys.
 *
 * The fix is one apostrophe, which spreadsheets consume as "the rest of this
 * is text" and which does not appear in the opened sheet.
 */

/**
 * Leading characters a spreadsheet treats as the start of a formula.
 *
 * ANCHORED — the lead character only. `a=b` is an ordinary name and must not
 * acquire an apostrophe; over-guarding would put a stray quote in front of
 * perfectly normal request paths.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One cell: guarded, then quoted.
 *
 * EVERY cell is quoted, not only the ones containing a separator. Conditional
 * quoting is a second rule that has to agree with the first about what a
 * separator is, and there is no reason for this file to hold two.
 */
export function escapeCsvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** CRLF between records, which is what RFC 4180 specifies. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, ...rows].map((record) => record.map(escapeCsvCell).join(',')).join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * A Blob and an object URL, NOT an `<a download>` carrying a data: URI — data
 * URIs hit length limits a large statistics table will reach, and browsers
 * disagree about whether they honour `download` on one. The object URL is
 * revoked immediately: the click has already been dispatched synchronously, so
 * the browser has what it needs.
 *
 * THE BOM IS DELIBERATE. Without it Excel reads the file as the system
 * codepage and mangles any non-ASCII request name — and request names are
 * exactly the column most likely to carry one.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
