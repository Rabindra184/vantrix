import { expect, test } from '@playwright/test';
import { seedAdmin, seedAdminForEmptyOrg, seedRunsAt, seedRunWithData, renameSimulation } from './fixtures.js';
import { firstRowId, signIn } from './helpers.js';

/**
 * The org run list — the first screen that shows a user their own data.
 *
 * EVERY test here seeds its own admin, and therefore its own org, rather than
 * sharing one from a `beforeAll`. That is not ceremony: these tests want
 * mutually incompatible row sets. The row-count test needs fewer rows than
 * one page, the pagination test needs more, and the ordering test needs a
 * specific pair of runs whose ingest order disagrees with their tool order.
 * A shared org would make each test's assertion depend on what the others
 * seeded, which with `fullyParallel: true` is a race, not a fixture.
 */

/**
 * Mirrors PAGE_SIZE in apps/web/src/api/runs.ts, rather than importing it.
 * This file typechecks under apps/web/e2e/tsconfig.json (`module: NodeNext`),
 * where src/api/runs.ts's own extensionless relative imports (`./fetch`) do
 * not resolve — importing the constant would break `pnpm typecheck` for the
 * sake of one number. Drift is loud rather than silent: if the app's page
 * size ever exceeds this, the pagination test's Next button stays disabled
 * and the click fails.
 */
const PAGE_SIZE = 25;

/**
 * An ISO-8601 UTC instant, the shape `Date.toISOString()` emits and the shape
 * `z.string().datetime()` pins in the contract. Asserting the FORMAT, not
 * merely that a string came back, is what stops the ordering test below
 * passing against a degenerate constant attribute.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

test('lists the org runs in a real table', async ({ page }) => {
  const admin = await seedAdmin();
  // Fewer than one page, so every seeded run is on the first page and the
  // row count is the whole list rather than a page of it.
  const seeded = [
    { startedAt: new Date('2026-05-01T10:00:00Z') },
    { startedAt: new Date('2026-05-02T10:00:00Z') },
    { startedAt: new Date('2026-05-03T10:00:00Z') },
  ];
  await seedRunsAt(admin.orgId, seeded);

  await signIn(page, admin);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(seeded.length + 1); // + header
});

/**
 * Sort and display must agree, or the list reads as mis-sorted.
 *
 * The seed is chosen so that displaying the WRONG field is detectable. Two
 * runs whose `toolStartedAt` merely differs from their `startedAt` are not
 * enough — the two ORDERINGS have to disagree, or a list rendering
 * `startedAt` while the server sorts by the coalesced value still comes out
 * descending and the test cannot tell the difference:
 *
 *   run   startedAt (ingest)   toolStartedAt (tool)   coalesced
 *   A     2026-03-01           2026-01-01             2026-01-01
 *   B     2026-01-01           2026-03-01             2026-03-01
 *
 * Correct descending order is B, A. By `startedAt` it is A, B — reversed. So
 * a list that displays `startedAt` renders [Jan, Mar], which is ascending,
 * and this test fails. C sits well before both, so the assertion has more
 * than a single pair to work with and a tiebreak-free tail.
 */
test('orders by the same value it displays', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunsAt(admin.orgId, [
    { startedAt: new Date('2026-03-01T00:00:00Z'), toolStartedAt: new Date('2026-01-01T00:00:00Z') },
    { startedAt: new Date('2026-01-01T00:00:00Z'), toolStartedAt: new Date('2026-03-01T00:00:00Z') },
    { startedAt: new Date('2025-01-01T00:00:00Z'), toolStartedAt: new Date('2025-01-01T00:00:00Z') },
  ]);

  await signIn(page, admin);
  await expect(page.getByRole('table')).toBeVisible();

  // The `datetime` attribute, not the cell's text: the rendered text is
  // localised ("1 Mar 2026, 00:00") and a lexicographic sort of it means
  // nothing. These are the API's own ISO-8601 UTC strings, which do sort
  // chronologically.
  const shown = await page
    .getByTestId('run-started')
    .locator('time')
    .evaluateAll((els) => els.map((el) => el.getAttribute('datetime')));

  // Three guards, not one, because the ordering assertion below is trivially
  // satisfied by any array equal to its own sort().reverse() — and several
  // broken renders produce exactly that:
  //   - a <time> that lost its datetime attribute yields [null, null, null];
  //   - a constant or malformed attribute yields ['', '', ''] or ['x', 'x', 'x'].
  // Each has length > 1 and each equals its own reverse-sort, so without
  // these the test would report success for a list whose order it cannot
  // observe at all.
  expect(shown.length).toBeGreaterThan(1);
  expect(shown.every((v) => typeof v === 'string' && ISO_8601_UTC.test(v))).toBe(true);
  expect(new Set(shown).size).toBe(shown.length);

  expect(shown).toEqual([...shown].sort().reverse());
});

test('follows the cursor to the next page', async ({ page }) => {
  const admin = await seedAdmin();
  // One more than a page, so there is a second page with exactly one row on
  // it and `nextCursor` on the first page is non-null.
  const base = Date.UTC(2026, 3, 1, 0, 0, 0);
  await seedRunsAt(
    admin.orgId,
    Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({ startedAt: new Date(base + i * 60_000) })),
  );

  await signIn(page, admin);
  const first = await firstRowId(page);
  await page.getByRole('button', { name: 'Next' }).click();
  // Polled, never a single read: the previous page's rows are still on
  // screen at the moment of the click, and `firstRowId` waits only for *a*
  // run-row to be visible — the stale one already is. A bare assertion here
  // would pass or fail on timing rather than on behaviour.
  await expect.poll(() => firstRowId(page)).not.toBe(first);

  /* ═══ AND THE END OF THE LIST SAYS SO WITH THE CONTROL (review 09-13 N04) ═══
   *
   * `PAGE_SIZE + 1` runs means the second page IS the last one, so this case
   * already stands where the end-of-list state renders — it simply never
   * looked at it. The finding asks for "disabled pagination" in place of a
   * sentence, and the sentence ("You have reached the end of the list", later
   * shortened to "No more runs.") is what this branch removed.
   *
   * BOTH HALVES, because either alone passes against the wrong product: a
   * bare absence assertion is satisfied by a page whose controls failed to
   * render at all, and a bare disabled assertion is satisfied by the sentence
   * coming back beside it. */
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeVisible();
  await expect(next).toBeDisabled();

  /* No end-of-list prose, in any of its spellings. `toHaveCount(0)` rather
     than a visibility check is right here because the node is not rendered at
     all — unlike M02's hidden band prose, where `textContent` would have
     found what nobody could see. */
  await expect(page.locator('#no-more-runs')).toHaveCount(0);
  await expect(
    page.getByText(/no more runs|reached the end of the list/i),
  ).toHaveCount(0);
});

test('a badge does not leak its glyph into the row’s accessible name', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  // Chromium, not jsdom: dom-accessibility-api does not consult a descendant's
  // aria-hidden the way a real AT tree does, so this assertion is only
  // meaningful in a browser (CLAUDE.md).
  //
  /* Located by COLUMN rather than by text containing "complete" — a
     regex/substring name match would still find the cell even if the glyph
     leaked into its accessible name, since "complete" would still appear
     somewhere in "● complete".

     THE INDEX IS DERIVED FROM THE HEADER, NOT WRITTEN DOWN. This read
     `.nth(3)` with a comment reciting the column order, and the order changed
     the moment Started and Environment moved behind the triage columns —
     silently picking the Simulation cell, where `toHaveAccessibleName` would
     have failed for a reason that is not this rule. Asking the table which
     column is "Status" is the same relationship the assertion is about, and it
     survives any reorder. `run-charts.spec.ts` records the same lesson for its
     own index-based query: a locator written as the relationship is the one
     that does not rot. */
  const row = page.getByTestId('run-row').first();
  // Awaited before the headers are READ: `allTextContents()` is an immediate
  // query with none of a locator's auto-waiting, so reading it first returns
  // `[]` on a table that simply has not rendered yet.
  await expect(row).toBeVisible();
  const headers = await page.getByRole('columnheader').allTextContents();
  const statusIndex = headers.findIndex((h) => h.trim() === 'Status');
  expect(statusIndex, `the table has a Status column (saw ${JSON.stringify(headers)})`)
    .toBeGreaterThanOrEqual(0);
  const statusCell = row.getByRole('cell').nth(statusIndex);
  await expect(statusCell).toBeVisible();
  // Exact match, not a substring: verified this catches the regression by
  // temporarily removing Badge's aria-hidden and re-running this test, which
  // failed with `Received: "● complete"` against `Expected: "complete"` — a
  // broken aria-hidden fails this exact-equality check instead of quietly
  // satisfying it.
  await expect(statusCell).toHaveAccessibleName('complete');
});

test('an empty org says so instead of showing an empty table', async ({ page }) => {
  const emptyOrgAdmin = await seedAdminForEmptyOrg();

  await signIn(page, emptyOrgAdmin);
  await expect(page.getByText(/no runs yet/i)).toBeVisible();
  // A table with a header row and nothing under it looks like a list that
  // failed to load, which is the confusion the empty state exists to remove.
  await expect(page.getByRole('table')).toHaveCount(0);
  // Nor any page controls: an org with no runs was being told "You have
  // reached the end of the list" beneath "No runs yet" — the end of a list it
  // had never walked. There is nothing to page through, so there is nothing
  // to page with.
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
});

test('a row link is named by the whole run id, not by its visible text', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);       // this suite's existing seed
  await signIn(page, admin);
  await page.goto('/runs');
  // Chromium's real accessibility tree — a <code> inside the link must not
  // pollute or replace the name the aria-label supplies.
  await expect(page.getByRole('link', { name: `View run ${runId}` })).toBeVisible();
});

/**
 * ONE "New project" LINK IN THE DOCUMENT, not two.
 *
 * `ProjectRail` renders on every authenticated page, so when it also carried
 * a "New project" row the `/runs` document held two links with the identical
 * accessible name — the rail's and the run list heading's. Playwright matches
 * `name` as a case-insensitive SUBSTRING and enforces strict mode, so this
 * very query resolved two elements and threw; a screen-reader user heard the
 * same action announced twice in one view.
 *
 * IT HAS TO BE AN E2E ASSERTION. jsdom renders one component at a time, so
 * neither `ProjectRail.test.tsx` nor a run-list unit test can see two
 * components colliding in one document — the unit suite stayed green for the
 * whole life of the bug. This is the same reason CLAUDE.md puts
 * accessible-name assertions in Playwright.
 *
 * `toHaveCount(1)`, never `toBeVisible()`: a duplicate that CSS happens to
 * hide is still in the accessibility tree and still breaks the query, so
 * counting is what actually pins the invariant.
 */
test('offers exactly one New project link on the org-wide list', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  // Paired positive: the rail is present, so this is about a duplicate name
  // rather than about a page that failed to render its chrome.
  await expect(page.getByRole('navigation', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New project' })).toHaveCount(1);

  // And the one that survives is the page heading's, which actually goes to
  // the create form.
  await expect(page.getByRole('link', { name: 'New project' })).toHaveAttribute(
    'href',
    '/projects/_new',
  );
});

/**
 * ═══ THE TRIAGE COLUMNS ARE READABLE WITHOUT SCROLLING ═══
 * (the 09-13 review's acceptance list)
 *
 * "Table-local horizontal scroll is acceptable when row identity, headers, and
 * controls remain usable." The scroll was never the defect — MEASURED, this
 * table wants 1078px and the content column gives it 726 at 768, 858 at 900,
 * 694 at 1024 (the rail opens there and takes ~270), 770 at 1100 and 950 at
 * 1280. It fits at 1440 and nowhere below.
 *
 * The defect was WHICH columns fell off the end. `Started` is 239px — 22% of
 * the table for a timestamp carrying a year and a zone — so p95 and Errors sat
 * at 823 and 889px cumulative and were off every screen narrower than 1440.
 * Those two are what triage turns on; `mobile.spec.ts` says exactly that for
 * the phone layout, one breakpoint down.
 *
 * MEASURED, NOT COUNTED IN COLUMNS, because that is the claim: a reader can
 * see the two numbers without dragging the table sideways. A column-order
 * assertion would pass against a layout that pushed them off anyway.
 */
test('p95 and Errors are on screen without scrolling the table sideways', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  /* EVERY WIDTH THE REVIEW'S ACCEPTANCE LIST NAMES from 768 up, because the
     answer differs at each and 1024 is the one that surprises: the project
     rail opens at exactly that breakpoint and takes ~270px, so the content box
     is 694 there against 858 at 900. Measured after the reorder, p95 ends at
     587px and Errors at 652px at every width below 1440 — inside even the
     narrowest box. Before it, at 768: p95 at 826 and Errors at 892 against 726
     visible, which is the failure this case was written from. */
  for (const width of [768, 900, 1024, 1100, 1280, 1440]) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  const reach = await page.evaluate(() => {
    const table = document.querySelector('table');
    if (table === null) return null;
    const scroller = table.parentElement;
    if (scroller === null) return null;
    const headers = Array.from(table.querySelectorAll('thead th'));
    const right = (name: string): number | null => {
      const th = headers.find((h) => h.textContent?.trim() === name);
      return th === undefined
        ? null
        : Math.round(th.getBoundingClientRect().right - scroller.getBoundingClientRect().left);
    };
    return { visible: Math.round(scroller.clientWidth), p95: right('p95'), errors: right('Errors') };
  });

  expect(reach, 'the run list renders a table at this viewport').not.toBeNull();
  const { visible, p95, errors } = reach!;
  expect(p95, 'the table has a p95 column').not.toBeNull();
  expect(errors, 'the table has an Errors column').not.toBeNull();

  /* The right edge of each, against the width a reader can actually see. Both
     were past it before the reorder — Errors ended at 889px in a 950px box at
     this viewport, and at 694px of box on a 1024 screen it was not close. */
  expect(p95!, `p95 ends at ${p95}px of ${visible}px visible`).toBeLessThanOrEqual(visible);
  expect(errors!, `Errors ends at ${errors}px of ${visible}px visible`).toBeLessThanOrEqual(visible);
  }
});

/**
 * ═══ THE TYPE SCALE FOLLOWS THE READER'S FONT SIZE ═══
 *
 * MEASURED before this was true: doubling the root font size took this page's
 * `<h1>` from 20px to 40px and left the table header at 12px, the row text at
 * 13px and the rail at 13px. Headings used Tailwind's rem-based `text-xl`;
 * everything else used `text-[13px]`, which a root font size cannot reach. So
 * a reader who asks for larger text got bigger titles over unchanged 12px
 * data — the numbers they came for.
 *
 * ONLY A BROWSER CAN ANSWER THIS. jsdom computes no font size at all, so the
 * unit suite guards the SOURCE (`tokens.test.ts` — no absolute-px type
 * utility) and this guards the BEHAVIOUR. Neither is sufficient alone: a
 * source scan cannot see a stylesheet that overrides the utility, and this
 * cannot say where a regression was written.
 *
 * The root is restored before the assertions run on nothing, because Playwright
 * reuses the page across a file and a leaked 32px root would be somebody
 * else's mystery failure.
 */
test('the run list scales with the reader’s font size, not just its headings', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();

  const sizes = () =>
    page.evaluate(() => {
      const px = (sel: string): number => {
        const el = document.querySelector(sel);
        return el === null ? 0 : parseFloat(getComputedStyle(el).fontSize);
      };
      return { heading: px('h1'), header: px('table thead th'), cell: px('[data-testid="run-row"] td') };
    });

  const at16 = await sizes();
  try {
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const at32 = await sizes();

    for (const key of ['heading', 'header', 'cell'] as const) {
      expect(at16[key], `${key} has a size to scale`).toBeGreaterThan(0);
      /* DOUBLED, not merely larger. "Bigger than before" passes against a
         scale that moved by a point, which is not what a reader who doubled
         their font asked for. */
      expect(at32[key], `${key}: ${at16[key]}px -> ${at32[key]}px`).toBeCloseTo(at16[key] * 2, 0);
    }
  } finally {
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
  }
});

/**
 * ═══ A REAL SIMULATION CLASS IS THE WIDEST UNBREAKABLE STRING HERE ═══
 * (the 09-13 review's acceptance list: "many projects/tests and long names")
 *
 * Every geometry case in this file was measured against the reference
 * bundle's `example.ParitySimulation` — 24 characters. A real one is a
 * fully-qualified class: `com.acme.checkout.simulations.CheckoutPeakLoadSimulation`
 * is 56, and it has NO break opportunity, because UAX#14 gives none after a
 * full stop followed by a letter. So it cannot wrap, and whatever width it
 * demands comes out of the columns beside it.
 *
 * THAT IS A DIRECT THREAT TO THE CASE ABOVE, which asserts p95 and Errors are
 * reachable without scrolling and was measured with the short name — p95
 * ending at 587px against only 694px of box at 1024. Nobody had re-measured
 * it with a name a real project would produce.
 *
 * The mobile CARD for the same value already carries `break-all`
 * (`RunList.tsx`'s `RunCard`); the desktop cell did not, and the asymmetry was
 * visible in one file.
 */
test('a real simulation class does not push the triage columns off screen', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await renameSimulation(runId, 'com.acme.checkout.simulations.CheckoutPeakLoadSimulation');

  await signIn(page, admin);

  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/runs');
    await expect(page.getByTestId('run-row').first()).toBeVisible();

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
      return {
        visible: Math.round(scroller.clientWidth),
        errors: rightOf('Errors'),
        docOverflows: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(reach, `a table renders at ${width}`).not.toBeNull();
    const { visible, errors, docOverflows } = reach!;
    expect(errors, `an Errors column exists at ${width}`).not.toBeNull();
    expect(
      errors!,
      `at ${width}px a 56-character class pushed Errors to ${errors}px of ${visible}px visible`,
    ).toBeLessThanOrEqual(visible);

    /* AND THE PAGE ITSELF STILL DOES NOT SCROLL SIDEWAYS. The table is allowed
       to (the review says so); the document is not, and an unbreakable string
       is exactly what breaks that distinction. */
    expect(docOverflows, `the document scrolls sideways at ${width}`).toBe(false);
  }
});
