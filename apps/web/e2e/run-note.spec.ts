import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData, writeNote } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * The run list's column edges, against the scroller's own visible width —
 * shared between the long-sentence case below and the unbroken-token one,
 * which need the identical `rightOf`/scroller arithmetic and differ only in
 * what they write into the note.
 */
async function listColumns(page: Page): Promise<{ visible: number; p95: number | null; errors: number | null }> {
  return page.evaluate(() => {
    const table = document.querySelector('table');
    if (table === null) return { visible: 0, p95: null, errors: null };
    const scroller = table.parentElement!;
    const ths = Array.from(table.querySelectorAll('thead th'));
    const rightOf = (name: string): number | null => {
      const th = ths.find((h) => h.textContent?.trim() === name);
      return th === undefined
        ? null
        : Math.round(th.getBoundingClientRect().right - scroller.getBoundingClientRect().left);
    };
    return {
      visible: Math.round(scroller.clientWidth),
      p95: rightOf('p95'),
      errors: rightOf('Errors'),
    };
  });
}

/** Whether the DOCUMENT itself — not a table's own internal scroller — has
 *  been forced wider than the viewport. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

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

    // This bound does NOT bind at 768/1024/1440 — measured at 70-183px
    // against a 242.25px 32ch measure, because the table's automatic layout
    // already shrinks this column well below that width (see NoteLine's
    // docstring). Kept anyway: it still proves `max-w-[32ch]` really
    // emitted CSS, which jsdom cannot see at all. The proof this bound CAN
    // fail comes from the phone check below, where the note sits in block
    // layout with no column to shrink it.
    const widthBound = measure32ch + 1;
    expect(
      noteWidth,
      `at ${width}px the note is ${noteWidth}px wide against its own 32ch measure of ${measure32ch}px — past the bound of ${widthBound}px`,
    ).toBeLessThanOrEqual(widthBound);
  }

  // ═══ THE PHONE, WHERE THE 32ch BOUND CAN ACTUALLY BIND ═══
  //
  // Below 768px (`useIsCompact`) this list is CARDS (`RunCards`/`RunCard`),
  // not the table above — block layout, with none of the table's
  // automatic-shrink to hold the note narrow regardless of its own classes.
  // Confirmed below (no `<table>`, and the row is not a `<tr>`) so this
  // check cannot silently end up measuring the table again.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/runs');
  await expect(page.getByTestId('run-note-line').first()).toBeVisible();

  const phone = await page.evaluate(() => {
    const noteLine = document.querySelector<HTMLElement>('[data-testid="run-note-line"]');
    const row = noteLine?.closest('[data-testid="run-row"]') ?? null;
    if (noteLine === null || row === null) return null;

    const lineProbe = noteLine.cloneNode(false) as HTMLElement;
    lineProbe.textContent = 'x';
    noteLine.parentElement!.appendChild(lineProbe);
    const oneLineHeight = lineProbe.getBoundingClientRect().height;
    lineProbe.remove();

    const widthProbe = document.createElement('span');
    widthProbe.style.display = 'inline-block';
    widthProbe.style.width = '32ch';
    noteLine.appendChild(widthProbe);
    const measure32ch = widthProbe.getBoundingClientRect().width;
    widthProbe.remove();

    return {
      hasTable: document.querySelector('table') !== null,
      rowTag: row.tagName,
      noteHeight: noteLine.getBoundingClientRect().height,
      noteWidth: noteLine.getBoundingClientRect().width,
      oneLineHeight,
      measure32ch,
    };
  });

  expect(phone, 'a card row and its note line render at 375px').not.toBeNull();
  const {
    hasTable,
    rowTag,
    noteHeight: phoneHeight,
    noteWidth: phoneWidth,
    oneLineHeight: phoneOneLine,
    measure32ch: phoneMeasure,
  } = phone!;

  expect(hasTable, 'at 375px the runs list must be cards, not the table this case already measures above').toBe(false);
  expect(
    rowTag,
    `at 375px a card row must not be a <tr> (was ${rowTag}) — this check would then silently be measuring the table again`,
  ).not.toBe('TR');

  const phoneTwoLineBound = 2 * phoneOneLine + 1;
  expect(
    phoneHeight,
    `at 375px the note is ${phoneHeight}px tall against a one-line height of ${phoneOneLine}px — past the two-line bound of ${phoneTwoLineBound}px`,
  ).toBeLessThanOrEqual(phoneTwoLineBound);

  const phoneWidthBound = phoneMeasure + 1;
  expect(
    phoneWidth,
    `at 375px the note is ${phoneWidth}px wide against its own 32ch measure of ${phoneMeasure}px — past the bound of ${phoneWidthBound}px`,
  ).toBeLessThanOrEqual(phoneWidthBound);
});

/**
 * ═══ A NOTE WITH NO BREAK OPPORTUNITY AT ALL ═══
 *
 * The case above writes real words, which wrap between them
 * (`[word-break:normal] break-words`, i.e. `overflow-wrap: break-word`) — but
 * that property adds no break opportunity to a box's MIN-CONTENT width; only
 * `overflow-wrap: anywhere` does. A note that is a URL, a stack-trace
 * fragment or a path has no space anywhere in it, so this is the hazard
 * `NoteLine`'s own docstring used to say was "untouched by this pair of
 * classes" — measured here rather than assumed.
 */
test('a note that is one unbroken token does not widen the list or the page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  // A single ~300-character token with NO SPACES — a URL is the realistic
  // shape, and it is 300 characters wide with nowhere in it to break.
  const base = 'https://grafana.internal.example/d/abc123/storage-migration?orgId=1&var-env=staging&from=';
  const token = (base + '1234567890abcdefghij'.repeat(15)).slice(0, 300);
  await writeNote(runId, token);
  await signIn(page, admin);

  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/runs');
    await expect(page.getByTestId('run-note-line').first()).toBeVisible();

    const { visible, p95, errors } = await listColumns(page);
    expect(p95, `a p95 column exists at ${width}`).not.toBeNull();
    expect(errors, `an Errors column exists at ${width}`).not.toBeNull();
    expect(
      p95!,
      `at ${width}px an unbroken note pushed p95 to ${p95}px of ${visible}px visible`,
    ).toBeLessThanOrEqual(visible);
    expect(
      errors!,
      `at ${width}px an unbroken note pushed Errors to ${errors}px of ${visible}px visible`,
    ).toBeLessThanOrEqual(visible);

    expect(
      await scrollsSideways(page),
      `at ${width}px the run list's own page scrolled sideways`,
    ).toBe(false);
  }

  // ═══ THE PHONE, TWO BOXES ═══
  //
  // The cards below 768px, where the note runs in block layout with no
  // column to shrink it (see the long-sentence case's own phone check) — and
  // the run's own page, where RunNote draws the note whole
  // (`whitespace-pre-line break-words`, `RunNote.tsx`), an unbroken token
  // being the same hazard in a different box.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/runs');
  await expect(page.getByTestId('run-note-line').first()).toBeVisible();
  expect(
    await scrollsSideways(page),
    'at 375px the run list card scrolled the page sideways',
  ).toBe(false);

  await page.goto(runPath(runId));
  await expect(page.getByTestId('run-note-text')).toBeVisible();
  expect(
    await scrollsSideways(page),
    'at 375px the run page scrolled sideways with an unbroken note',
  ).toBe(false);
});
