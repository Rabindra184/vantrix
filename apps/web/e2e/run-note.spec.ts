import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData, writeNote } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ THE RUN NOTE, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * The unit layer hands RunNote its note and RunList its rows; these prove the
 * seams — a note written through the real form reaching the real API, the
 * cached run, a reload, the run list and its search — and the one property
 * jsdom cannot see: that a long note does not widen the Simulation column
 * past the triage columns.
 */
test('a person writes a note on a run, and it stays, named, listed and searchable', async ({ page }) => {
  const admin = await seedAdmin();
  const noted = await seedRunWithData(admin.orgId);
  const plain = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(noted));

  const region = page.getByRole('region', { name: 'Run note' });
  await region.getByRole('button', { name: 'Add a note' }).click();
  await region.getByLabel('Run note').fill('baseline after the zeppelin cache change');
  await region.getByRole('button', { name: 'Save' }).click();

  await expect(region.getByTestId('run-note-text')).toHaveText('baseline after the zeppelin cache change');
  await expect(region.getByTestId('run-note-attribution')).toContainText('Edited by Admin');

  await page.reload();
  await expect(page.getByTestId('run-note-text')).toHaveText('baseline after the zeppelin cache change');

  await page.goto('/runs');
  const notedRow = page.locator(`[data-testid="run-row"][data-run-id="${noted}"]`);
  await expect(notedRow.getByTestId('run-note-line')).toContainText('baseline after the zeppelin cache change');
  await expect(page.locator(`[data-testid="run-row"][data-run-id="${plain}"]`)).toBeVisible();

  // TWO runs in the org, so a search that returned everything would show two.
  await page.getByLabel('Search runs').fill('zeppelin');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/[?&]q=zeppelin/);
  await expect(page.getByTestId('run-row')).toHaveCount(1);
  await expect(notedRow).toBeVisible();
});

test('a long note does not push p95 and Errors off screen', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  // Real words at the full limit — the widest note a reader can write.
  const sentence = 'Flaky environment during the storage migration, ignore this run for trends. ';
  await writeNote(runId, sentence.repeat(7).slice(0, 500).trim());
  await signIn(page, admin);

  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/runs');
    // The fixture reached the render, or this case measures nothing.
    await expect(page.getByTestId('run-note-line').first()).toBeVisible();

    const reach = await page.evaluate(() => {
      const table = document.querySelector('table');
      if (table === null) return null;
      const scroller = table.parentElement!;
      const ths = Array.from(table.querySelectorAll('thead th'));
      const rightOf = (name: string): number | null => {
        const th = ths.find((h) => h.textContent?.trim() === name);
        return th === undefined
          ? null
          : Math.round(th.getBoundingClientRect().right - scroller.getBoundingClientRect().left);
      };
      return { visible: Math.round(scroller.clientWidth), p95: rightOf('p95'), errors: rightOf('Errors') };
    });

    expect(reach, `a table renders at ${width}`).not.toBeNull();
    const { visible, p95, errors } = reach!;
    expect(p95, `a p95 column exists at ${width}`).not.toBeNull();
    expect(errors, `an Errors column exists at ${width}`).not.toBeNull();
    expect(p95!, `at ${width}px a long note pushed p95 to ${p95}px of ${visible}px visible`).toBeLessThanOrEqual(visible);
    expect(errors!, `at ${width}px a long note pushed Errors to ${errors}px of ${visible}px visible`).toBeLessThanOrEqual(visible);
  }
});
