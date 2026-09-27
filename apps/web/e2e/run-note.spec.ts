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

test('a long note stays two lines, no wider than its measure, and does not push p95 and Errors off screen', async ({ page }) => {
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

    const measured = await page.evaluate(() => {
      const table = document.querySelector('table');
      const noteLine = document.querySelector<HTMLElement>('[data-testid="run-note-line"]');
      if (table === null || noteLine === null) return null;
      const scroller = table.parentElement!;
      const ths = Array.from(table.querySelectorAll('thead th'));
      const rightOf = (name: string): number | null => {
        const th = ths.find((h) => h.textContent?.trim() === name);
        return th === undefined
          ? null
          : Math.round(th.getBoundingClientRect().right - scroller.getBoundingClientRect().left);
      };

      // One line's own height, measured on a sibling carrying the identical
      // classes — never parsed from `line-height`, which the arbitrary
      // `text-[0.75rem]` may leave at `normal`.
      const lineProbe = noteLine.cloneNode(false) as HTMLElement;
      lineProbe.textContent = 'x';
      noteLine.parentElement!.appendChild(lineProbe);
      const oneLineHeight = lineProbe.getBoundingClientRect().height;
      lineProbe.remove();

      // 32ch in the note's own font, measured rather than assumed — this
      // also proves the arbitrary `max-w-[32ch]` utility really emitted
      // CSS, which jsdom cannot see at all.
      const widthProbe = document.createElement('span');
      widthProbe.style.display = 'inline-block';
      widthProbe.style.width = '32ch';
      noteLine.appendChild(widthProbe);
      const measure32ch = widthProbe.getBoundingClientRect().width;
      widthProbe.remove();

      return {
        visible: Math.round(scroller.clientWidth),
        p95: rightOf('p95'),
        errors: rightOf('Errors'),
        noteHeight: noteLine.getBoundingClientRect().height,
        noteWidth: noteLine.getBoundingClientRect().width,
        oneLineHeight,
        measure32ch,
      };
    });

    expect(measured, `a table and its note line render at ${width}`).not.toBeNull();
    const { visible, p95, errors, noteHeight, noteWidth, oneLineHeight, measure32ch } = measured!;
    expect(p95, `a p95 column exists at ${width}`).not.toBeNull();
    expect(errors, `an Errors column exists at ${width}`).not.toBeNull();
    expect(p95!, `at ${width}px a long note pushed p95 to ${p95}px of ${visible}px visible`).toBeLessThanOrEqual(visible);
    expect(errors!, `at ${width}px a long note pushed Errors to ${errors}px of ${visible}px visible`).toBeLessThanOrEqual(visible);

    const twoLineBound = 2 * oneLineHeight + 1;
    expect(
      noteHeight,
      `at ${width}px the note is ${noteHeight}px tall against a one-line height of ${oneLineHeight}px — past the two-line bound of ${twoLineBound}px`,
    ).toBeLessThanOrEqual(twoLineBound);

    const widthBound = measure32ch + 1;
    expect(
      noteWidth,
      `at ${width}px the note is ${noteWidth}px wide against its own 32ch measure of ${measure32ch}px — past the bound of ${widthBound}px`,
    ).toBeLessThanOrEqual(widthBound);
  }
});
