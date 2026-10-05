import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedProjectWithRuns, seedTestWithRuns } from './fixtures.js';
import { signIn } from './helpers.js';
import { projectTestPath } from '../src/routes/paths.js';

/**
 * ═══ THE ⌘K PALETTE, IN THE ONLY PLACE ITS HARD CLAIMS CAN BE CHECKED ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * `CommandPalette.test.tsx` and `SearchTrigger.test.tsx` prove every decision
 * the palette makes, in jsdom, against stubbed endpoints. That layer cannot
 * see four things, and each case below is one of them:
 *
 *   1. THE SEAM. A unit case hands the dialog a response of its own making;
 *      here the rows come from `GET /v1/tests` and `GET /v1/runs?number=`
 *      against real rows, and Enter lands on a page the router really draws.
 *   2. THE REAL KEYBOARD. jsdom dispatches the key events a test writes; a
 *      browser decides whether `⌘K` reaches a `window` capture listener, where
 *      focus is when the dialog opens, and whether typing lands in the input.
 *   3. CHROMIUM'S ACCESSIBILITY TREE. `aria-activedescendant`, a named dialog
 *      and options are claims about what a screen reader is handed, and
 *      jsdom's `dom-accessibility-api` is not that computation (CLAUDE.md
 *      records the same for `InfoTip`).
 *   4. LAYOUT. jsdom lays everything out at 0x0, so "a long name cannot widen
 *      the dialog past the screen" is invisible to it — the reason `truncate`
 *      and `m-auto` defects have only ever been found by a browser here.
 *
 * ═══ A PALETTE ASKS THE SERVER AFTER A PAUSE, SO THE TEST WAITS FOR THE ROW ═══
 *
 * Results arrive 150 ms after typing stops, and Enter pressed inside that
 * pause is swallowed on purpose (it would act on the previous query). So every
 * case types, then waits for the option it wants to be on screen AND
 * highlighted, and only then presses Enter — which is what a reader does, and
 * is deterministic where a fixed sleep is not.
 */

/** The dialog by the name a screen reader announces — exact, since a case-insensitive substring would match any heading. */
function paletteDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Search PerfPortal', exact: true });
}

/**
 * Opens the palette the way a keyboard user does, and checks focus landed in
 * its input before anything types — typing with `page.keyboard` rather than
 * `fill()` is what makes this a keyboard-only journey, because `fill()` would
 * focus the field itself and hide a dialog that opened with focus elsewhere.
 *
 * The header's "Search" button is awaited first: it is mounted beside the
 * shortcut's own listener, so its presence is the signal that a keypress now
 * has something to reach. Pressing before the shell has mounted does nothing
 * and reads as a palette that does not open.
 */
async function openWithShortcut(page: Page): Promise<Locator> {
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = paletteDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeFocused();
  return dialog;
}

/** The option inside one group, by the group's own heading. */
function optionIn(dialog: Locator, heading: string): Locator {
  return dialog.getByRole('group', { name: heading, exact: true }).getByRole('option');
}

test('finds a test by name with the keyboard alone', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'nightly-soak',
    name: 'Nightly soak',
    simulationClass: 'com.acme.NightlySoak',
    runs: 3,
  });
  await signIn(page, admin);

  const dialog = await openWithShortcut(page);
  await page.keyboard.type('Nightly soak');

  const option = optionIn(dialog, 'Tests');
  await expect(option).toHaveCount(1);
  await expect(option).toContainText('Nightly soak');
  // Highlighted, not merely present: Enter acts on the highlighted row, and a
  // palette that lists the right row while highlighting another passes every
  // assertion that stops at "is on screen".
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(new RegExp(`${projectTestPath('checkout', 'nightly-soak')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Nightly soak', exact: true })).toBeVisible();
  // Choosing closes it. (Where focus goes afterwards is `SearchTrigger.test.tsx`'s:
  // after a navigation there is no longer an element to hand it back to.)
  await expect(paletteDialog(page)).toHaveCount(0);
});

test('opens a run from "<test> #N"', async ({ page }) => {
  const admin = await seedAdmin();
  await seedTestWithRuns(admin.orgId, {
    slug: 'weekly-sweep',
    name: 'Weekly sweep',
    simulationClass: 'com.acme.WeeklySweep',
    runs: 3,
  });
  await signIn(page, admin);

  const dialog = await openWithShortcut(page);
  await page.keyboard.type('Weekly sweep #2');

  const option = optionIn(dialog, 'Run by number');
  await expect(option).toHaveCount(1);
  await expect(option).toContainText('Run 2');
  await expect(option).toContainText('Weekly sweep');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The page names the TEST in its heading and the RUN in its breadcrumb —
  // Run 2 specifically, not whichever run happened to be first or latest.
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly sweep', exact: true })).toBeVisible();
  await expect(page.getByTestId('run-crumb')).toHaveText('Run 2');
});

/**
 * THE SCREEN-READER PROMISE, MEASURED WHERE A SCREEN READER READS IT.
 *
 * Chromium's own accessibility tree, through CDP — Playwright's role
 * selectors above are its own injected computation, not the browser's.
 * Chromium only (CDP does not exist in Firefox or WebKit); the skip sits
 * inside the body so the other engines still run the file.
 */
test('exposes a named dialog with a combobox and options to assistive technology', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP, and so the real accessibility tree, is Chromium-only');
  const admin = await seedAdmin();
  await signIn(page, admin);

  const dialog = await openWithShortcut(page);
  // The empty state's rows ("All runs", "New project") are real options.
  await expect(dialog.getByRole('option').first()).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const live = nodes.filter((n) => n.ignored !== true);

  const named = live.find((n) => n.role?.value === 'dialog' && n.name?.value === 'Search PerfPortal');
  expect(named, 'a dialog named "Search PerfPortal" is in Chromium’s accessibility tree').toBeDefined();

  const combobox = live.find((n) => n.role?.value === 'combobox');
  expect(combobox, 'the input is a combobox in Chromium’s accessibility tree').toBeDefined();

  const options = live.filter((n) => n.role?.value === 'option');
  expect(options.length, 'the list exposes options').toBeGreaterThanOrEqual(1);

  // The combobox points at the option the highlight is on — what a screen
  // reader announces as the highlight moves. `activedescendant` is a RELATION,
  // so Chromium reports it as a node reference rather than a string.
  const active = combobox?.properties?.find((p) => p.name === 'activedescendant');
  expect(active, 'the combobox names its active option').toBeDefined();
  const target = live.find((n) => n.backendDOMNodeId === active?.value.relatedNodes?.[0]?.backendDOMNodeId);
  expect(target?.role?.value, 'and that node is one of the options').toBe('option');
});

/**
 * REVIEW FOCUS 4: a 56-character class and a 120-character project name, in
 * palette rows, on a phone.
 *
 * BOTH ARE ONE UNBREAKABLE WORD, which is the case that matters: UAX#14 gives
 * no break after a full stop followed by a letter, and the project name has no
 * space at all. A row that let either size itself to its content would widen
 * the dialog and, with it, the page.
 *
 * TWO MEASUREMENTS, BECAUSE ONE OF THEM CANNOT FAIL ALONE. The dialog is
 * `position: fixed`, and a fixed box that outgrows the screen does not make
 * the DOCUMENT scroll — `scrollWidth` would read 375 over a palette half off
 * the screen. So the document is checked (the finding's own claim) AND every
 * part of every row is checked against the dialog's own edges, which is where
 * an overflow actually shows.
 */
test('keeps long names inside the screen at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const admin = await seedAdmin();

  // 8 + 14 x 8 = 120 characters, no break opportunity anywhere in it.
  const longProject = `Checkout${'Platform'.repeat(14)}`;
  expect(longProject).toHaveLength(120);
  const longClass = 'com.acme.checkout.simulations.CheckoutPeakLoadSimulation';
  expect(longClass).toHaveLength(56);

  await seedProjectWithRuns(admin.orgId, 'checkout-platform', longProject, 0);
  await seedTestWithRuns(admin.orgId, {
    slug: 'checkout-peak-load',
    name: longClass,
    simulationClass: longClass,
    runs: 2,
    projectSlug: 'checkout-platform',
  });
  await signIn(page, admin);

  // A phone has no keyboard: the header's icon-only button is how it opens.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = paletteDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill('checkout');

  // One shared word, three groups holding the long names. Waiting on all three
  // (and on the count settling) is what stops the measurement below being
  // taken over a half-drawn list, which would pass for the wrong reason.
  await expect(optionIn(dialog, 'Projects').filter({ hasText: longProject.slice(0, 20) })).toHaveCount(1);
  await expect(optionIn(dialog, 'Tests').filter({ hasText: longClass.slice(0, 20) })).toHaveCount(1);
  await expect(optionIn(dialog, 'Runs').first()).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText(/^\d+ results?$/);

  // WHAT A ROW IS CALLED must survive a long neighbour. A run's label is the
  // short, important part of its row, and the text beside it is far longer
  // than the row: flex shrinks in proportion to each item's unclamped size
  // times its shrink factor, so a short label next to a very long one still
  // lost a share of ITS width — measured, "Run 2" drew as "R…" while the class
  // beside it kept a hundred pixels. jsdom lays nothing out, so only here can
  // that be seen.
  //
  // MEASURED IN FRACTIONS OF A PIXEL, because `scrollWidth` is an integer and
  // an ellipsis is not: the first fix left the label 0.3px short, which
  // `scrollWidth <= clientWidth` rounded away over a row that read "Run…".
  // The text's own width (a Range over its contents) against the box it sits
  // in is the question the ellipsis actually asks.
  const runLabel = optionIn(dialog, 'Runs').first().locator('span').first();
  await expect(runLabel).toHaveText(/^Run \d+$/);
  const label = await runLabel.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return { text: range.getBoundingClientRect().width, box: el.getBoundingClientRect().width };
  });
  expect(label.text, 'the label has a width to measure').toBeGreaterThan(0);
  expect(label.text, 'a run is named in full, not clipped to its first letters').toBeLessThanOrEqual(
    label.box + 0.01,
  );

  const geometry = await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const escaping: string[] = [];
    for (const item of Array.from(el.querySelectorAll('[cmdk-item]'))) {
      for (const part of [item, ...Array.from(item.querySelectorAll('*'))]) {
        const rect = part.getBoundingClientRect();
        if (rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5)) {
          escaping.push(`${part.tagName.toLowerCase()} "${(part.textContent ?? '').slice(0, 30)}"`);
        }
      }
    }
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      left: box.left,
      right: box.right,
      options: el.querySelectorAll('[cmdk-item]').length,
      escaping,
    };
  });

  expect(geometry.innerWidth).toBe(375);
  expect(geometry.scrollWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(375);
  expect(geometry.left, 'the dialog starts on screen').toBeGreaterThanOrEqual(0);
  expect(geometry.right, 'the dialog ends on screen').toBeLessThanOrEqual(375);
  expect(geometry.options, 'the case measured rows, not an empty list').toBeGreaterThanOrEqual(3);
  expect(geometry.escaping, 'no part of a row leaves the dialog').toEqual([]);
});
