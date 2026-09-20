import { expect, test, type Download, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * THE TWO FILES THIS PRODUCT HANDS A READER, SAVED BY A REAL BROWSER.
 *
 * ═══ WHY THIS CANNOT BE A UNIT TEST ═══
 *
 * `downloadBlob` (`src/download.ts`) is six lines and, until this file, was
 * exercised by NOTHING. jsdom implements neither `URL.createObjectURL` nor
 * `URL.revokeObjectURL`, so `StatisticsTable.test.tsx` and
 * `RunDecisionBand.test.tsx` both stub the pair and assert the `Blob` they
 * capture. That proves the CONTENT a component builds and says nothing about
 * whether a browser ever writes it to disk.
 *
 * ═══ AND THE CLAIM IT LEAVES UNTESTED IS A RACE ═══
 *
 * That function revokes the object URL on the line AFTER `anchor.click()`,
 * with a comment asserting "the click has already been dispatched
 * synchronously, so the browser has what it needs". If that were wrong the
 * symptom would be a download that never starts, or one that saves zero
 * bytes — and every unit test would stay green, because the stub never
 * revokes anything. Reading the SAVED FILE is the only assertion that can
 * see it.
 *
 * ═══ BYTES, NOT THE EVENT ═══
 *
 * `waitForEvent('download')` resolving proves a download STARTED. Each case
 * here reads the file back through `download.createReadStream()` and asserts
 * its contents, because a revoked-too-early blob is precisely the failure
 * that fires the event and then delivers nothing.
 */

/** The saved file's bytes — not its filename, not the event. */
async function savedBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Click something that downloads, and hand back the file it produced. */
async function downloadFrom(page: Page, name: string | RegExp): Promise<Download> {
  // Armed BEFORE the click: the download can complete faster than the next
  // statement runs, and a wait attached afterwards would miss it.
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name }).click();
  return pending;
}

async function openRun(page: Page): Promise<void> {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));
}

test('the statistics CSV reaches the disk, with its rows in it', async ({ page }) => {
  await openRun(page);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeVisible();

  const download = await downloadFrom(page, 'Download CSV');
  const bytes = await savedBytes(download);

  // NON-EMPTY FIRST. A revoked-too-early object URL is the failure this file
  // exists for, and it delivers a started download carrying nothing.
  expect(bytes.byteLength).toBeGreaterThan(0);

  // THE BOM IS ASSERTED ON THE BYTES, as the unit suite does — decoding
  // consumes it, so no text-level assertion can ever see one.
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

  const csv = bytes.toString('utf8');
  // The header and the totals row the table renders, read out of the FILE.
  expect(csv).toContain('"Requests"');
  expect(csv).toContain('"All Requests"');
  // CRLF between records, which is what RFC 4180 specifies and `toCsv` writes.
  expect(csv).toContain('\r\n');

  expect(download.suggestedFilename()).toMatch(/^perfportal-.+-statistics\.csv$/);
});

test('the SLA summary JSON reaches the disk, and parses', async ({ page }) => {
  await openRun(page);

  const download = await downloadFrom(page, /Export SLA summary/);
  const bytes = await savedBytes(download);
  expect(bytes.byteLength).toBeGreaterThan(0);

  // NO BOM on this one — `downloadBlob` is shared, and the BOM belongs to the
  // CSV's own `downloadCsv` wrapper rather than to handing a file over. The
  // pair of assertions is what pins that division: a BOM migrating into the
  // shared helper would break `JSON.parse` here and nothing else.
  expect(bytes[0]).not.toBe(0xef);

  const parsed = JSON.parse(bytes.toString('utf8')) as {
    exportedAt: string;
    run: { id: string; status: string };
  };
  expect(parsed.run.id).toBeTruthy();
  expect(parsed.run.status).toBe('complete');
  expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
});
