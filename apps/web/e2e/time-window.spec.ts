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

/**
 * The run page's five time figures, which share one pinned domain. Not the
 * navigator: its slider handles are HH:MM:SS labels too, and they may repeat
 * a tick's text legitimately.
 */
const TIME_CHARTS = [
  'chart-concurrent-users',
  'chart-user-start-rate',
  'chart-requests-per-second',
  'chart-responses-per-second',
  'chart-percentiles',
] as const;

/** A chart's HH:MM:SS labels as drawn: the text, and the centre it sits at. */
async function drawnTicks(page: Page, testId: string): Promise<{ text: string; centre: number }[]> {
  return plot(page.getByTestId(testId)).locator('text').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { text: (node.textContent ?? '').trim(), centre: box.x + box.width / 2 };
      })
      .filter((tick) => /^\d{2}:\d{2}:\d{2}$/.test(tick.text)),
  );
}

/**
 * What is wrong with an axis' labels, or nothing: fewer than two, a repeated
 * text, or a label whose distance from the one before is not the step.
 *
 * SPACING IS MEASURED ON SCREEN, NOT READ OFF THE TEXT. A crowded end reads
 * differently from the tick before it, and on the wall clock a label floors
 * to its second, so an end half a step on can read as a whole step. Where
 * the label sits cannot misstate it. Three pixels absorbs rounding.
 */
function gridProblems(ticks: readonly { text: string; centre: number }[]): string[] {
  const texts = ticks.map((tick) => tick.text);
  const gaps = ticks.slice(1).map((tick, i) => Math.round(tick.centre - ticks[i]!.centre));
  const problems = [
    ticks.length < 2 && `${ticks.length} label(s)`,
    new Set(texts).size !== texts.length && 'a label repeats',
    gaps.some((gap) => Math.abs(gap - gaps[0]!) > 3) && `labels ${gaps.join(', ')} px apart`,
  ].filter((problem): problem is string => problem !== false);
  return problems.length === 0 ? [] : [`${problems.join('; ')}: ${texts.join(' ')}`];
}

/**
 * ═══ AN ELAPSED AXIS LABELS ITS STEP'S GRID, AND ITS END ONLY ON IT ═══
 *
 * With a fixed step, ECharts ticks from the axis' start and then appends the
 * domain's END as one more tick whenever it falls off that grid. Under
 * whole-second notation that label repeated the tick before it, or crowded
 * it: measured here before the fix, a window of 0 to 2.5 s drew
 * `00:00:00 00:00:01 00:00:02 00:00:02`, and one of 7 to 61 s put `00:01:01`
 * 60px after `00:00:57` on a 152px step. jsdom lays out nothing, so only a
 * browser can say where ECharts put them.
 *
 * Both windows are TYPED, the way a reader reaches an end between two ticks.
 */
test('an elapsed axis never repeats or crowds its last tick, in either mode', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);

  /** Waits for each chart to draw `settled`, a string only the new stretch
   *  or mode draws, then checks its labels. */
  const gridded = async (settled: string): Promise<void> => {
    for (const id of TIME_CHARTS) {
      await expect.poll(() => drawnText(page, id), { message: id }).toContain(settled);
      expect(gridProblems(await drawnTicks(page, id)), id).toEqual([]);
    }
  };
  const typeWindow = async (from: string, to: string, toMs: number): Promise<void> => {
    await openTimeWindow(page);
    await page.getByTestId('window-from').fill(from);
    await page.getByTestId('window-to').fill(to);
    await page.getByTestId('window-apply').click();
    await expect(page).toHaveURL(new RegExp(`[?&]to=${toMs}(?!\\d)`));
  };

  // The whole run: the reference bundle's end, 63.161 s, is off a 10 s grid.
  await gridded('00:00:10');

  // An end 4 s past a 10 s grid: distinct text, crowded.
  await typeWindow('7', '61', 61_000);
  await gridded('00:00:17');

  // An end half a second past a 1 s grid: the same text twice.
  await typeWindow('0', '2.5', 2_500);
  await gridded('00:00:01');

  // And on the wall clock, where that end reads as its tick's second again.
  await page.getByTestId('time-axis-mode').selectOption('datetime');
  await gridded('Time (GMT+5:30)');
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
