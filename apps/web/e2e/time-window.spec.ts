import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { apiJson, openTimeWindow, plot, signIn } from './helpers.js';
import { runChartsPath, runComparePath } from '../src/routes/paths.js';

/**
 * ═══ GATLING ENTERPRISE'S TIME CONTROLS, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-26-time-window-gatling-style-design.md)
 *
 * The unit layer hands each component its anchor and its payload; these cases
 * prove the seams no fixture can: a real run's `toolStartedAt` reaching the
 * axes, the mode surviving a reload without entering the URL, a drill-down
 * reached by URL reading the same clock, and Compare refusing it.
 *
 * PINNED TO Asia/Kolkata, a non-zero and DST-free offset: CI runs in UTC,
 * where an anchor read in the wrong zone is invisible. Every case asserts the
 * pin took before anything else.
 */
test.use({ timezoneId: 'Asia/Kolkata' });

const CLOCK = /^\d{2}:\d{2}:\d{2}$/;

/** Every string a chart's canvas drew, in document order. */
async function drawnText(page: Page, testId: string): Promise<string[]> {
  return plot(page.getByTestId(testId)).locator('text').allTextContents();
}

/** The HH:MM:SS labels, which on these charts are the x axis' ticks alone. */
async function clockTicks(page: Page, testId: string): Promise<string[]> {
  return (await drawnText(page, testId)).filter((text) => CLOCK.test(text));
}

async function zonePinned(page: Page): Promise<void> {
  expect(await page.evaluate(() => new Date('2026-08-15T00:00:00Z').getHours())).toBe(5);
}

/** HH:MM:SS on Asia/Kolkata's clock, computed here rather than by the page. */
const kolkataClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const clockMs = (clock: string): number => {
  const [h, m, s] = clock.split(':').map(Number);
  return ((h! * 60 + m!) * 60 + s!) * 1000;
};

test('Datetime relabels the charts to the wall clock, survives a reload, and never touches the URL', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);

  const run = await apiJson<{ toolStartedAt: string }>(page, `/v1/runs/${runId}`);
  const anchorMs = Date.parse(run.toolStartedAt);

  // Offset, the default: elapsed clock time under an axis named Elapsed.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Elapsed');
  const elapsed = await clockTicks(page, 'chart-percentiles');
  expect(elapsed.length).toBeGreaterThanOrEqual(2);

  const url = page.url();
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const mode = page.getByTestId('time-axis-mode');
  await expect(mode.locator('option[value="datetime"]')).toHaveText(`Datetime (${zone} - GMT+5:30)`);
  await mode.selectOption('datetime');

  // The SAME ticks, relabelled: each is the run's own start plus its offset.
  // Polled, because the redraw replaces the labels rather than editing them.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
  await expect
    .poll(() => clockTicks(page, 'chart-percentiles'))
    .toEqual(elapsed.map((tick) => kolkataClock.format(anchorMs + clockMs(tick))));
  expect(page.url()).toBe(url);

  // A reading preference survives a reload and still never reaches the URL.
  await page.reload();
  await expect(mode).toHaveValue('datetime');
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
  expect(page.url()).toBe(url);
});

test('the zoom buttons step by Gatling’s fractions, and zooming out returns to the whole run', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await openTimeWindow(page);

  // An independent oracle: the spec asks the API, never the app's own builder.
  const run = await apiJson<{ durationMs: number }>(page, `/v1/runs/${runId}`);
  const series = await apiJson<{ bucketWidthMs: number }>(
    page,
    `/v1/runs/${runId}/series?scope=run&name=&family=response_time`,
  );
  const span = run.durationMs;
  const resolution = series.bucketWidthMs;

  const zoomIn = page.getByTestId('window-step-zoom-in');
  const zoomOut = page.getByTestId('window-step-zoom-out');
  await expect(zoomOut).toBeDisabled();
  await zoomIn.click();

  await expect(page).toHaveURL(/[?&]from=\d+/);
  const params = new URL(page.url()).searchParams;
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  // A quarter in from each edge, each bound on the navigator's buckets.
  expect(from % resolution).toBe(0);
  expect(to % resolution).toBe(0);
  expect(Math.abs(from - span / 4)).toBeLessThanOrEqual(resolution / 2);
  expect(Math.abs(to - (span * 3) / 4)).toBeLessThanOrEqual(resolution / 2);

  // Zoom out moves each edge OUT by a quarter of the width, so the width
  // grows by half — not double, which is not zoom in's inverse either way.
  const width = to - from;
  await zoomOut.click();
  await expect(page).toHaveURL(new RegExp(`[?&]from=(?!${from}(?!\\d))\\d+`));
  const out = new URL(page.url()).searchParams;
  const outFrom = Number(out.get('from'));
  const outTo = Number(out.get('to'));
  expect(outFrom % resolution).toBe(0);
  expect(outTo % resolution).toBe(0);
  expect(Math.abs(outFrom - (from - width / 4))).toBeLessThanOrEqual(resolution / 2);
  expect(Math.abs(outTo - (to + width / 4))).toBeLessThanOrEqual(resolution / 2);
  // …and the second reaches both ends, which is no window at all.
  await zoomOut.click();
  await expect(page).not.toHaveURL(/[?&]from=/);
  await expect(zoomOut).toBeDisabled();
});

test('a preset longer than the run returns it to the whole run', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await openTimeWindow(page);

  const run = await apiJson<{ durationMs: number }>(page, `/v1/runs/${runId}`);
  // The claim needs a run shorter than the preset; say so rather than assume it.
  expect(run.durationMs).toBeLessThan(5 * 60_000);

  await page.getByTestId('window-step-zoom-in').click();
  await expect(page).toHaveURL(/[?&]from=/);

  await page.getByTestId('window-range').click();
  await page.getByRole('menuitem', { name: 'Last 5 Minutes', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]from=/);
});

test('a request’s own page reads the clock the reader chose', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);
  await page.getByTestId('time-axis-mode').selectOption('datetime');
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');

  const stats = await apiJson<{ stats: { scope: string; name: string }[] }>(page, `/v1/runs/${runId}/stats`);
  const request = stats.stats.find((row) => row.scope === 'request');
  expect(request, 'the seeded run carries no request rows').toBeDefined();

  // A SIBLING of the run route: RunShell's clock cannot reach it.
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(request!.name)}`);
  await zonePinned(page);
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
});

test('Compare stays elapsed while the reader reads wall-clock time elsewhere', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);
  await page.getByTestId('time-axis-mode').selectOption('datetime');
  // A positive control: the mode really took on this page.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');

  await page.goto(runComparePath(runId));
  await expect.poll(() => drawnText(page, 'chart-compare-overlay')).toContain('Elapsed');
  expect((await drawnText(page, 'chart-compare-overlay')).some((text) => text.startsWith('Time ('))).toBe(false);
});
