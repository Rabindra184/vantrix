/**
 * Hand a file to the browser — the one place in the app that does.
 *
 * A Blob and an object URL, NOT an `<a download>` carrying a data: URI — data
 * URIs hit length limits a large statistics table will reach, and browsers
 * disagree about whether they honour `download` on one. The object URL is
 * revoked immediately: the click has already been dispatched synchronously, so
 * the browser has what it needs.
 *
 * IT TAKES A `Blob`, NOT A STRING, and that is what makes it shared. The two
 * callers disagree about everything a string signature would have to encode —
 * `text/csv` with a leading BOM for the spreadsheet exports (`tables/csv.ts`),
 * `application/json` with none for the run summary (`routes/runExport.ts`) —
 * and each of those is a decision about the FILE, not about handing it over.
 * They used to be two copies of the six lines below, one of which carried the
 * reasoning and one of which did not; a change to either (an anchor appended
 * to the document for Firefox, a deferred revoke) would have applied to only
 * one of the app's two download paths.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
