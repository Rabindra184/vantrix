import { expect, test, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import {
  enableOrgAi,
  expireLink,
  seedAdmin,
  seedProjectMember,
  seedRunWithData,
  setPublicLinks,
} from './fixtures.js';
import { apiJson, openSection, signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ A PUBLIC RUN LINK, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md)
 *
 * The unit layer hands each piece its state; these prove the seams no jsdom
 * case reaches. A Member's Create reaching the real POST and handing back a
 * secret; a context with NO cookies reading the run through that secret alone;
 * the page staying inside its link and asking only the fifteen reads the API
 * opens to one; a signed-in sharer reading exactly what a stranger reads; and a
 * revoke, the org's switch and an expiry each taking effect on the next read.
 *
 * ONE JOURNEY, FIVE CASES, IN ORDER (`serial`). The link case 1 creates is the
 * one cases 2 to 4 read and revoke, and case 5 needs a link that is NOT revoked
 * — the credential check answers revoked before it looks at the switch or the
 * expiry (`authenticatePublicLink`), so case 5 creates its own. Two contexts
 * live for the whole journey: the Member's, signed in, and the stranger's, with
 * no cookie at all.
 *
 * THE REFERENCE RUN (`seedRunWithData`) has no runner job, so its Logs tab is
 * absent on both pages; it has groups (`Cart` among them) for the Report's
 * picker, and a failing simulation assertion on `Search`, whose bar opens itself
 * on the Summary and names a request — the anchor case 2's guard watches.
 */

/* ======================================================================== *
 * What a link may read, written down
 * ======================================================================== */

/**
 * The fifteen run reads a public link may make, COPIED from
 * `apps/api/test/access-routes.integration.test.ts`' `LINK_READABLE_ROUTES` —
 * where the API's own route walk holds the set of handlers marked
 * `@LinkReadable` EQUAL to it, both ways. Copied rather than imported: the e2e
 * suite does not reach into the API's tests, and this list is what the BROWSER
 * is held to, so a route added there without a matching decision here is a
 * read this page now makes that nobody agreed to.
 *
 * Deliberately absent, as there: `/trends` (the run's whole cohort, other runs'
 * ids and figures included), `/ai-analysis` (no card on the public page) and
 * `/scatter` (the request drill-down, which a link does not reach).
 */
const LINK_READABLE_ROUTES: readonly string[] = [
  'GET /v1/runs/:id',
  'GET /v1/runs/:id/verification',
  'GET /v1/runs/:id/users',
  'GET /v1/runs/:id/stats',
  'GET /v1/runs/:id/series',
  'GET /v1/runs/:id/errors',
  'GET /v1/runs/:id/errors/series',
  'GET /v1/runs/:id/distribution',
  'GET /v1/runs/:id/telemetry',
  'GET /v1/runs/:id/agent',
  'GET /v1/runs/:id/agent/connections',
  'GET /v1/runs/:id/agent/dns',
  'GET /v1/runs/:id/agent/injectors',
  'GET /v1/runs/:id/agent/status',
  'GET /v1/runs/:id/events',
];

/** The one read a link makes that is not about its run: resolving it (`@PublicLinkOnly`). */
const RESOLVE = 'GET /v1/public-link';

/** Spec 6.1's sentence every link-state page adds, verbatim. */
const ASK_FOR_A_NEW_LINK = 'Ask whoever sent it for a new link.';

/* ======================================================================== *
 * Recording what a page asks the API
 * ======================================================================== */

/**
 * Every request a page sends to `/v1/` or `/auth/`, from the moment this is
 * called until `stop()`. Attached to a page the case uses for nothing else —
 * a read the TEST made from the page (`apiJson`) would be recorded beside the
 * page's own and could never be told apart (CLAUDE.md: `page.on('request')`
 * sees the case's own oracle reads).
 */
function recordApiReads(page: Page): { readonly reads: Request[]; stop(): void } {
  const reads: Request[] = [];
  const record = (request: Request): void => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/v1/') || pathname.startsWith('/auth/')) reads.push(request);
  };
  page.on('request', record);
  return { reads, stop: () => page.off('request', record) };
}

/**
 * A request as the allowlist spells a route: its method, then its path with
 * THIS run's id written `:id`. The query string is dropped — the allowlist is
 * about which handler answers, and `?scope=…&group=…` picks within one. A read
 * of any other run keeps its id, so it can never match the list.
 */
function routeOf(request: Request, runId: string): string {
  const { pathname } = new URL(request.url());
  const run = `/v1/runs/${runId}`;
  const path = pathname === run || pathname.startsWith(`${run}/`) ? `/v1/runs/:id${pathname.slice(run.length)}` : pathname;
  return `${request.method()} ${path}`;
}

/**
 * Every recorded read is the link resolving itself or one of the fifteen run
 * reads — and the page really did read through its link, which is the vacuity
 * floor: a page that failed to load asks nothing, and nothing is outside an
 * empty list. The failure names each read outside the allowlist.
 */
function expectOnlyLinkReads(reads: readonly Request[], runId: string): void {
  const routes = reads.map((request) => routeOf(request, runId));
  expect(routes, 'the page resolved its link').toContain(RESOLVE);
  expect(routes, 'the page read its run').toContain('GET /v1/runs/:id');
  expect(routes.length, 'the page asked the API too little for this to prove anything').toBeGreaterThan(5);
  const allowed = new Set([RESOLVE, ...LINK_READABLE_ROUTES]);
  const outside = [...new Set(routes.filter((route) => !allowed.has(route)))];
  expect(outside, 'reads a public link may not make').toEqual([]);
}

/**
 * Every recorded read carried the link and no cookie. The fetch layer decides
 * that from the URL (`withCredential`: `Authorization: PublicLink <secret>`,
 * `credentials: 'omit'`), so a signed-in sharer's session never rides along —
 * which a cookie in a context that HAS one is the only way to see.
 */
async function expectReadThroughTheLink(reads: readonly Request[], secret: string): Promise<void> {
  const wrong: string[] = [];
  for (const request of reads) {
    const authorization = await request.headerValue('authorization');
    const cookie = await request.headerValue('cookie');
    if (authorization !== `PublicLink ${secret}` || cookie !== null) {
      wrong.push(`${request.method()} ${new URL(request.url()).pathname}: authorization ${authorization}, cookie ${cookie === null ? 'none' : 'SENT'}`);
    }
  }
  expect(wrong, 'reads that did not go out as the link alone').toEqual([]);
}

/* ======================================================================== *
 * The pages
 * ======================================================================== */

/** The run's tab strip, on either page. */
const sections = (page: Page): Locator => page.getByRole('navigation', { name: 'Run sections' });

/** The Summary's four headline tiles, in order (`RunStats`). */
const TILES = ['stat-error-rate', 'stat-total-requests', 'stat-peak-users', 'stat-p95'] as const;

/**
 * The four tiles' text, once each holds a number — `/stats` and `/users` both
 * answered — so an immediate read after this compares settled values. Asserts
 * there are exactly four, which is GE's Summary row.
 */
async function settledTiles(page: Page): Promise<string[]> {
  await expect(page.locator('section[aria-label="Run totals"] dd[data-testid^="stat-"]')).toHaveCount(TILES.length);
  const texts: string[] = [];
  for (const id of TILES) {
    const tile = page.getByTestId(id);
    await expect(tile, `${id} holds a number`).toHaveText(/\d/);
    texts.push(((await tile.textContent()) ?? '').trim());
  }
  return texts;
}

/** The Requests section with its pickers drawn, which waits on the whole-run
 *  `/stats` (`useRequestsNarrowing`). */
const groupSelect = (page: Page): Locator =>
  page.getByTestId('requests-group-picker').getByLabel('Group', { exact: true });

async function openRequests(page: Page): Promise<void> {
  await expect(
    page.locator('section#requests').getByRole('button', { name: 'Requests', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(groupSelect(page)).toBeVisible();
}

/**
 * A chart's data table, rows of its label and each cell's `data-value`, or
 * `null` while the chart is not drawn. A `page.evaluate`, not a locator, so it
 * never waits — inside `expect.poll` a chart that never draws fails on the
 * poll's own bound (`report-pickers.spec.ts`' reader, trimmed to the rows).
 */
function readRows(page: Page, chartId: string): Promise<string[][] | null> {
  return page.evaluate((id) => {
    const table = document.querySelector(`[data-testid="chart-data-${id}"]`);
    if (table === null) return null;
    return Array.from(table.querySelectorAll('tbody tr')).map((tr) => [
      tr.querySelector('th')?.textContent ?? '',
      ...Array.from(tr.querySelectorAll('td')).map((td) => td.getAttribute('data-value') ?? td.textContent ?? ''),
    ]);
  }, chartId);
}

/**
 * Every `a[href]` on the page that leaves the link: anything that is not a
 * fragment or `/share/<secret>` itself, a path under it, or it with a query or
 * fragment. `evaluateAll` is an immediate read, so the caller settles the page
 * first. The count is returned for the vacuity floor.
 */
async function anchorsLeavingTheLink(page: Page, secret: string): Promise<{ count: number; leaving: string[] }> {
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''));
  const base = `/share/${secret}`;
  const inside = (href: string): boolean =>
    href.startsWith('#') ||
    href === base ||
    href.startsWith(`${base}/`) ||
    href.startsWith(`${base}?`) ||
    href.startsWith(`${base}#`);
  return { count: hrefs.length, leaving: hrefs.filter((href) => !inside(href)) };
}

/**
 * Creates a link through the share dialog on the run page `page` is on, with
 * 1 week chosen, and returns the full URL from the read-only field — read with
 * `inputValue()`, since it is an input's value and not its text. Closes the
 * dialog afterwards, so the next opening starts from the list.
 */
async function createLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share this run' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Expires', { exact: true }).selectOption({ label: '1 week' });
  await expect(dialog.getByText(/^This link will expire on .+\.$/)).toBeVisible();
  await expect(
    dialog.getByText(
      "Anyone with this link can read this run's Summary, Report and Logs — its project and test names included — without signing in, until it expires or is revoked.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Create link', exact: true }).click();

  const field = dialog.getByTestId('public-link-url');
  await expect(field).toHaveValue(/\/share\/ppl_[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
  await expect(dialog.getByText('This is the only time the full link is shown.', { exact: true })).toBeVisible();
  const url = await field.inputValue();

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return url;
}

/** The link-state page: its sentence, as the `<h1>`, and the line every one adds. */
async function expectLinkState(page: Page, sentence: string | RegExp): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sentence);
  await expect(page.getByText(ASK_FOR_A_NEW_LINK, { exact: true })).toBeVisible();
  // It replaces the page: no run is drawn under it, and the reader is never
  // sent to sign in.
  await expect(page.locator('section[aria-label="Run totals"]')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toMatch(/^\/share\//);
}

/* ======================================================================== *
 * The journey
 * ======================================================================== */

test.describe.serial('a public run link', () => {
  // Two sign-ins' worth of seeding, two contexts, and the Report's charts.
  test.describe.configure({ timeout: 120_000 });

  let runId = '';
  let orgId = '';
  let memberContext: BrowserContext;
  let memberPage: Page;
  let strangerContext: BrowserContext;
  let strangerPage: Page;
  /** The run's app tiles, read on the Member's own page in case 1. */
  let appTiles: string[] = [];
  /** Case 1's link, the one cases 2 to 4 read and revoke. */
  let url = '';
  let secret = '';

  test.beforeAll(async ({ browser }, testInfo) => {
    const admin = await seedAdmin();
    orgId = admin.orgId;
    const member = await seedProjectMember(admin.orgId, admin.projectId, 'member', 'Imogen Vale');
    runId = await seedRunWithData(admin.orgId);
    await setPublicLinks(admin.orgId, true);
    // AI on, so the Member's own run page DRAWS the card: its absence behind
    // the link is then a decision of the public page, not an org without AI.
    await enableOrgAi(admin.orgId);

    const baseURL = testInfo.project.use.baseURL;
    memberContext = await browser.newContext({ baseURL });
    memberPage = await memberContext.newPage();
    await signIn(memberPage, member);
    strangerContext = await browser.newContext({ baseURL });
    strangerPage = await strangerContext.newPage();
  });

  test.afterAll(async () => {
    await memberContext?.close();
    await strangerContext?.close();
  });

  test('a Member creates a link, and a stranger with no cookies reads the run through it', async () => {
    await test.step('the Member’s own run page, which the shared one is held to', async () => {
      const appReads = recordApiReads(memberPage);
      try {
        await memberPage.goto(runPath(runId));
        appTiles = await settledTiles(memberPage);
      } finally {
        appReads.stop();
      }
      // The app page's reads carry the session cookie, and this engine reports
      // it: so the cookie-less reads `expectReadThroughTheLink` asserts later
      // are the link's doing, not a header the harness cannot see.
      const cookies = await Promise.all(appReads.reads.map((request) => request.headerValue('cookie')));
      expect(
        cookies.some((cookie) => cookie !== null),
        'the app page sends its session cookie',
      ).toBe(true);
      // What the public page must NOT have, present here first — so each
      // absence below is the link's, not a page that drew less.
      await expect(memberPage.getByTestId('ai-analysis')).toBeVisible({ timeout: 15_000 });
      await expect(sections(memberPage).getByRole('link', { name: 'Trends', exact: true })).toBeVisible();
      await expect(sections(memberPage).getByRole('link', { name: 'Compare', exact: true })).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    });

    await test.step('Share, 1 week, Create: the URL is in the read-only field', async () => {
      url = await createLink(memberPage);
      secret = new URL(url).pathname.slice('/share/'.length);
      expect(secret).toMatch(/^ppl_[A-Za-z0-9_-]{43}$/);
    });

    await test.step('signed out, the Summary shows its four tiles and no AI card', async () => {
      expect(await strangerContext.cookies(), 'the stranger carries no cookie at all').toEqual([]);
      await strangerPage.goto(url);
      await expect(strangerPage.getByTestId('public-header')).toContainText(/Read-only link · expires .+/);
      expect(await settledTiles(strangerPage), 'the shared tiles are the run page’s own').toEqual(appTiles);
      await expect(strangerPage.getByTestId('ai-analysis')).toHaveCount(0);
      // Summary and Report: Logs is absent because this run has no runner job,
      // and Trends and Compare because they read the run's cohort.
      await expect(sections(strangerPage).getByRole('link')).toHaveText(['Summary', 'Report']);
    });

    await test.step('the Report’s group picker narrows the charts', async () => {
      await sections(strangerPage).getByRole('link', { name: 'Report', exact: true }).click();
      await expect(strangerPage).toHaveURL(new RegExp(`/share/${secret}/report`));
      await openRequests(strangerPage);

      // The run's own percentiles first: the baseline a pick must leave.
      await expect.poll(() => readRows(strangerPage, 'percentiles'), { timeout: 15_000 }).not.toBeNull();
      const whole = await readRows(strangerPage, 'percentiles');
      expect(whole?.length, 'the run’s percentiles chart has rows').toBeGreaterThan(0);

      await groupSelect(strangerPage).selectOption({ label: 'Cart' });
      await expect
        .poll(() => new URL(strangerPage.url()).searchParams.get('requests-group'), { message: 'the pick in the URL' })
        .toBe('Cart');
      // The table changes to the group's — drawn (not null) and not the run's.
      await expect
        .poll(
          async () => {
            const rows = await readRows(strangerPage, 'percentiles');
            return rows !== null && rows.length > 0 && JSON.stringify(rows) !== JSON.stringify(whole);
          },
          { message: 'the percentiles chart narrows to Cart', timeout: 15_000 },
        )
        .toBe(true);
      await expect(
        strangerPage.getByTestId('chart-percentiles').getByRole('button', { name: /^About / }),
      ).toHaveAccessibleDescription(/Narrowed to the group Cart\./);
    });
  });

  test('the page links only inside itself and asks only what a link may read', async () => {
    const recorder = recordApiReads(strangerPage);
    const anchors = { count: 0, leaving: [] as string[] };
    const collect = async (where: string): Promise<void> => {
      const found = await anchorsLeavingTheLink(strangerPage, secret);
      anchors.count += found.count;
      anchors.leaving.push(...found.leaving.map((href) => `${where}: ${href}`));
    };
    try {
      await test.step('the Summary', async () => {
        await strangerPage.goto(url);
        await settledTiles(strangerPage);
        // The simulation-assertions bar holding Search's failure opens itself,
        // and its target names a request: settled before the anchors are read.
        await expect(strangerPage.locator('#simulation-assertions')).toContainText('Search');
        await expect(strangerPage.getByTestId('chart-percentiles')).toBeVisible();
        await collect('Summary');
      });

      await test.step('the Report, every section open, and the Requests table', async () => {
        await sections(strangerPage).getByRole('link', { name: 'Report', exact: true }).click();
        await openRequests(strangerPage);
        for (const [id, title] of [
          ['groups', 'Groups'],
          ['virtual-users', 'Virtual users'],
          ['connections', 'Connections'],
          ['dns', 'DNS'],
          ['load-generators', 'Load generators'],
        ] as const) {
          await openSection(strangerPage, id, title);
        }
        // The sections asked for what they draw — the agent summary and the
        // telemetry the generator sections fall back to — so the allowlist is
        // checked against more than the Summary's reads.
        await expect
          .poll(() => recorder.reads.map((request) => routeOf(request, runId)), { timeout: 15_000 })
          .toEqual(expect.arrayContaining(['GET /v1/runs/:id/agent', 'GET /v1/runs/:id/telemetry']));
        // Groups' names and the Table's rows are links in the app; here they are text.
        await expect(strangerPage.locator('section#groups')).toContainText('Cart');
        await strangerPage.locator('section#requests').getByRole('button', { name: 'Table', exact: true }).click();
        await expect(strangerPage.getByTestId('stat-row-total')).toBeVisible();
        await collect('Report');
      });
    } finally {
      recorder.stop();
    }

    // The tabs alone are two anchors on each page; fewer means the guard read
    // a page that did not render.
    expect(anchors.count, 'anchors counted across the two tabs').toBeGreaterThanOrEqual(4);
    expect(anchors.leaving, 'anchors leading out of the link').toEqual([]);
    expectOnlyLinkReads(recorder.reads, runId);
    await expectReadThroughTheLink(recorder.reads, secret);
  });

  test('the Member opening their own link sees the stranger’s page, read as the link alone', async () => {
    // A fresh page in the Member's own context: their session cookie is right
    // there, and nothing of the app page's earlier reads can land in the record.
    const page = await memberContext.newPage();
    const recorder = recordApiReads(page);
    try {
      await page.goto(url);
      expect(await settledTiles(page), 'the same tiles a stranger reads').toEqual(appTiles);
      await expect(page.getByTestId('ai-analysis')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
      // No edit control: the Member edits the note on their run page, not here.
      await expect(page.getByRole('button', { name: 'Add a note', exact: true })).toHaveCount(0);
      await expect(sections(page).getByRole('link')).toHaveText(['Summary', 'Report']);

      await sections(page).getByRole('link', { name: 'Report', exact: true }).click();
      await openRequests(page);
      await expect.poll(() => readRows(page, 'percentiles'), { timeout: 15_000 }).not.toBeNull();
    } finally {
      recorder.stop();
    }
    expect(await memberContext.cookies(), 'the Member is signed in, so a cookie was there to send').not.toEqual([]);
    expectOnlyLinkReads(recorder.reads, runId);
    await expectReadThroughTheLink(recorder.reads, secret);
    await page.close();
  });

  test('a revoked link reads as revoked on the next load', async () => {
    await memberPage.goto(runPath(runId));
    await memberPage.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = memberPage.getByRole('dialog', { name: 'Share this run' });
    const row = dialog.getByTestId('public-link-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: /^Revoke the link created / }).click();
    await row.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await expect(row.getByTestId('public-link-state')).toContainText('Revoked');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await strangerPage.reload();
    await expectLinkState(strangerPage, 'This link has been revoked.');
  });

  test('the org’s switch suspends a link and restores it; an expiry ends it', async () => {
    // Case 4's link stays revoked whatever the switch says (revoked is answered
    // first), so this case reads a link of its own.
    await memberPage.goto(runPath(runId));
    const second = await createLink(memberPage);
    await strangerPage.goto(second);
    await settledTiles(strangerPage);

    await setPublicLinks(orgId, false);
    await strangerPage.reload();
    await expectLinkState(strangerPage, 'Public links are turned off for this organisation.');

    await setPublicLinks(orgId, true);
    await strangerPage.reload();
    expect(await settledTiles(strangerPage), 'restored, the link reads the run again').toEqual(appTiles);

    const { items } = await apiJson<{ items: { id: string; state: string }[] }>(
      memberPage,
      `/v1/runs/${runId}/public-links`,
    );
    const active = items.filter((link) => link.state === 'active');
    expect(active, 'exactly the second link is active').toHaveLength(1);
    const expiredAt = await expireLink(active[0]!.id);

    await strangerPage.reload();
    // The date is the API's instant in the reader's clock (`formatInstant`);
    // its year is what this can check without restating the format.
    await expectLinkState(strangerPage, /^This link expired on .+\.$/);
    await expect(strangerPage.getByRole('heading', { level: 1 })).toContainText(String(expiredAt.getFullYear()));
  });
});
