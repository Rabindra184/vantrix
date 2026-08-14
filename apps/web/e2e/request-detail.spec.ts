import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * §13.3 in a real browser.
 *
 * WHAT ONLY EXISTS HERE. The unit suites pin the transforms and the scoped
 * URLs in jsdom. What they cannot reach is the MOUNT — that the page fetches
 * all five payloads, that the charts draw, and above all that an ENCODED
 * request path survives a hard load through the real server.
 */

const NESTED = 'Catalog/List Products';

test('a nested request page loads from a pasted URL, not just a click', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // goto, NOT a click. A click is pushState and never reaches the server, so it
  // passes whether or not the server preserves %2F. This is the assertion.
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(NESTED)}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
  // The catch-all redirects an unmatched path to /runs, so a normalised %2F
  // shows up precisely here.
  expect(new URL(page.url()).pathname).not.toBe('/runs');
});

test('the row link from the statistics table reaches the same page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // D-10: this request nests, so its row is a CHILD and starts collapsed.
  // Clicking the ROW ITSELF (as the brief originally wrote it) lands on
  // whichever `<td>` the click's center point falls over — the row has no
  // click handler of its own, only the toggle `<button>` inside its `<th>`
  // does — so it never expands. Fixed to match `run-tables.spec.ts`'s own
  // convention: find the toggle by its accessible name and click that.
  await page.getByRole('button', { name: /expand Catalog/i }).click();
  await page.getByRole('link', { name: 'List Products' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
});

test('every §13.3 element is on the page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(NESTED)}`);

  // Located by the same `figure[data-testid^="chart-"]` convention
  // `run-charts.spec.ts:53` uses, and asserted by chart ID — the ids each
  // component passes to `Chart`, which are stable where titles are prose.
  for (const id of ['indicators', 'distribution', 'percentiles', 'scatter']) {
    await expect(page.getByTestId(`chart-${id}`)).toBeVisible();
    // The data table is the parity surface and must be present on every chart.
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // The request page titles its rate charts DIFFERENTLY from the global page,
  // as Gatling's own request pages do.
  //
  // (The scatter's own marks are asserted separately below — being visible and
  // carrying a data table is not the same as having drawn anything.)
  //
  // `getByText` (as the brief originally wrote it) is ambiguous here: each
  // chart's `<figcaption>`-like data-table `<caption>` opens with the same
  // words as the chart's own `<h3>` title ("Number of requests — every value
  // plotted above…", from `DataTable`'s caption), so an un-exact text locator
  // resolves to two elements and Playwright's strict mode rejects it. Scoped
  // to the heading role instead, which is what the title actually is.
  await expect(
    page.getByRole('heading', { name: 'Number of requests', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Number of responses', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Requests per second over time')).toHaveCount(0);

  // RQ-04, RQ-06 and RQ-10 do not exist: Gatling 3.15.1.2 reports no latency
  // (§A.9 F-2). A page that grew one would be beyond parity, not parity.
  await expect(page.getByText(/latency/i)).toHaveCount(0);
});

test('the scatter draws a mark for every point in its data table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(NESTED)}`);

  const chart = page.getByTestId('chart-scatter');
  const svg = chart.locator('svg');
  await expect(svg).toHaveCount(1);

  // WHY THIS IS NOT `path.first()` — the assertion the §13.3 test above and
  // `run-charts.spec.ts:218` share. A chart that drew NOTHING still has paths:
  // ECharts lays out the grid and draws the axis line whether or not any series
  // reached it. The scatter shipped blank behind exactly that assertion — its
  // series type was never registered in `charts/echarts.ts`, so ECharts
  // discarded it silently, leaving two paths of axis furniture, a visible
  // <figure> and a complete data table. Every one of those passed.
  //
  // ONE MARK PER POINT is what distinguishes drawn from merely present, and the
  // count is DERIVED from the table rather than written down: the table is the
  // parity surface, so a re-captured fixture moves both sides together.
  //
  // Asserted as a LOWER BOUND because the furniture is counted too — 62 points
  // draw 88 paths here. That is the honest form of the claim: the failure it
  // exists to catch is zero marks, not an off-by-one, and pinning an exact
  // total would break on an axis gaining a tick.
  const points = await page.getByTestId('chart-data-scatter').locator('tbody tr').count();
  expect(points).toBeGreaterThan(0);
  await expect
    .poll(() => svg.locator('path').count(), { message: 'scatter drew no marks' })
    .toBeGreaterThanOrEqual(points);
});
