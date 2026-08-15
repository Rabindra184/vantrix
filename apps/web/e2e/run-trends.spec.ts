import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath, runTrendsPath } from '../src/routes/paths.js';

/**
 * The Trends tab, in a real browser.
 *
 * ═══ WHY THIS SUITE SEEDS TWO RUNS ═══
 *
 * `seedRunWithData` ingests the reference bundle into the org's shared
 * project, and the worker reads the simulation name out of the run header — so
 * two calls produce two runs of the SAME simulation in the SAME project, which
 * is a cohort of two. Seeding one would exercise only the cohort-of-one
 * branch and prove nothing about the grouping this whole feature is.
 *
 * ═══ AND WHY IT IS A BROWSER TEST AT ALL ═══
 *
 * The unit suite mocks ECharts, so "the chart drew" is unprovable there. Here
 * an `<svg>` inside the figure is the proof, exactly as `run-charts.spec.ts`
 * establishes — and the same rule follows from it: NO DECORATIVE `<svg>`
 * inside a chart `<figure>`, or these counts stop meaning anything.
 */

const CHART_IDS = ['trend-status', 'trend-percentiles', 'trend-throughput'] as const;

function figures(page: Page): Locator {
  return page.locator('figure[data-testid^="chart-trend-"]');
}

async function settled(page: Page): Promise<void> {
  await expect(figures(page).locator('svg')).toHaveCount(CHART_IDS.length);
}

test('the tab is reachable at its own URL and draws every figure', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // Straight to the URL, no clicking: each run section is a real address, and
  // this asserts that rather than only that a link exists.
  await page.goto(runTrendsPath(runId));
  await settled(page);

  // In declaration order, which is the order the three are meant to be read
  // down — status, then latency, then load.
  const rendered = await figures(page).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('data-testid')),
  );
  expect(rendered).toEqual(CHART_IDS.map((id) => `chart-${id}`));

  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-${id}`).locator('svg'), `${id} drew no SVG`).toHaveCount(1);
    // The parity surface: every chart carries its data table unconditionally.
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }
});

test('the Trends tab is named exactly that, and is current only on its own URL', async ({
  page,
}) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto(runPath(runId));
  // `exact: true` because ProjectRail renders a link per project in every
  // authenticated document and Playwright's default name match is a
  // case-insensitive SUBSTRING — without it this can be satisfied by a rail
  // row rather than by the tab.
  const tab = page.getByRole('link', { name: 'Trends', exact: true });
  await expect(tab).toHaveCount(1);
  await expect(tab).not.toHaveAttribute('aria-current', 'page');

  await tab.click();
  await expect(page).toHaveURL(new RegExp(`${runId}/trends$`));
  await expect(page.getByRole('link', { name: 'Trends', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a cohort of two plots both runs, on every figure', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto(runTrendsPath(runId));
  await settled(page);

  // Read off the DATA TABLE rather than the drawing: it is the parity surface,
  // it is what a screen reader gets, and a row per run is the claim being
  // made. Two ingests of the same bundle share a simulation, so both belong.
  for (const id of CHART_IDS) {
    const rows = page.getByTestId(`chart-data-${id}`).locator('tbody tr');
    await expect(rows, `${id} did not plot both runs`).toHaveCount(2);
  }

  // And the "nothing to compare yet" line is absent, because there is.
  await expect(page.getByText('nothing to compare it against yet')).toHaveCount(0);
});

test('a cohort of one draws its point and says there is nothing to compare', async ({ page }) => {
  // One datum is not no data: the charts still draw, and the page says why
  // there is only one point rather than showing an empty state.
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto(runTrendsPath(runId));
  await settled(page);

  await expect(page.getByText('nothing to compare it against yet')).toBeVisible();

  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-data-${id}`).locator('tbody tr')).toHaveCount(1);
  }
});
