import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { apiJson, signIn } from './helpers.js';

/**
 * §13.4 in a real browser. The unit suites pin the lookup and the scoped URLs
 * in jsdom; what only exists here is the MOUNT — that the page fetches, that
 * both families draw, and that a NESTED group's encoded path survives a hard
 * load through the real server.
 */

const NESTED = 'Catalog/Recommendations';

/** Only the field this file reads. Deliberately NOT `@perfportal/contracts` —
 *  see run-tables.spec.ts's own `StatRowJson` for why: a test that re-uses
 *  the app's own types agrees with the app by construction, and what is being
 *  checked here is the wire. */
interface StatRowJson {
  readonly scope: 'run' | 'group' | 'request';
  readonly name: string;
  readonly family: string;
  readonly meanMs: number;
}
interface StatsJson {
  readonly stats: readonly StatRowJson[];
}

test('a nested group page loads from a pasted URL', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // goto, NOT a click: a click is pushState and never reaches the server, so it
  // would pass whether or not %2F survives.
  await page.goto(`/runs/${runId}/groups/${encodeURIComponent(NESTED)}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
  expect(new URL(page.url()).pathname).not.toBe('/runs');
});

test('both families and both distributions are on the page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/groups/Cart`);

  // `exact: true` on BOTH: each family also has a distribution figure and a
  // percentiles figure whose own titles are prefixed with this same family
  // name ("Cumulated response time distribution", "Cumulated response time
  // percentiles over time", "Duration distribution", "Duration percentiles
  // over time") — a non-exact match against either family name is
  // ambiguous by construction, resolving to three headings instead of one.
  await expect(page.getByRole('heading', { name: 'Cumulated response time', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Duration', exact: true })).toBeVisible();

  /*
   * EACH FAMILY'S STATISTICS ARE ITS OWN — not merely present under a heading
   * that happens to say the right thing. Cumulated and duration read from the
   * SAME `Cart` row set but never agree exactly (GroupDetail.tsx's own
   * docstring: 141ms cumulated against 225ms duration on the reference run),
   * so reading each section's mean against the API's own per-family row is
   * what actually pins family to section — a heading-only check would still
   * pass if `FAMILIES`' `title` and `family` fields ever came apart (the
   * title naming one family while the row underneath is the other's).
   */
  const stats = await apiJson<StatsJson>(page, `/v1/runs/${runId}/stats`);
  const cumulatedRow = stats.stats.find(
    (r) => r.scope === 'group' && r.name === 'Cart' && r.family === 'group_cumulated',
  );
  const durationRow = stats.stats.find(
    (r) => r.scope === 'group' && r.name === 'Cart' && r.family === 'group_duration',
  );
  if (cumulatedRow === undefined || durationRow === undefined) {
    throw new Error("the reference run's Cart group is missing one of its two families' stats");
  }
  expect(cumulatedRow.meanMs, "the two families' own means must actually differ, or this check proves nothing").not.toBe(
    durationRow.meanMs,
  );
  const cumulatedSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Cumulated response time', exact: true }),
  });
  const durationSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'Duration', exact: true }),
  });
  await expect(cumulatedSection.getByTestId('request-stat-meanMs')).toHaveAttribute(
    'data-value',
    String(cumulatedRow.meanMs),
  );
  await expect(durationSection.getByTestId('request-stat-meanMs')).toHaveAttribute(
    'data-value',
    String(durationRow.meanMs),
  );

  for (const id of ['indicators', 'distribution-group_cumulated', 'distribution-group_duration']) {
    await expect(page.getByTestId(`chart-${id}`)).toBeVisible();
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // GR-07 does not exist (§A.9 F-4). Asserted by ID, not by title: a rate
  // chart at group scope would be headed like the request page's own
  // ("Number of requests"/"Number of responses", RatesChart's `title` prop),
  // and its data-table columns read "Elapsed (s)", "All", "OK", "KO" — no
  // "per second" text of any kind reaches the DOM. That string only ever
  // appears in the ECharts y-axis name, drawn into the canvas, so a
  // `getByText('per second')` guard would pass against exactly the mistake
  // it exists to catch. The ids are stable across either title.
  await expect(page.getByTestId('chart-requests-per-second')).toHaveCount(0);
  await expect(page.getByTestId('chart-responses-per-second')).toHaveCount(0);
});

test('both percentile charts draw, with independent controls', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/groups/Cart`);

  const cumulated = page.getByTestId('chart-percentiles-group_cumulated');
  const duration = page.getByTestId('chart-percentiles-group_duration');
  await expect(cumulated).toBeVisible();
  await expect(duration).toBeVisible();

  // Each carries its own data table — the parity surface.
  await expect(page.getByTestId('chart-data-percentiles-group_cumulated')).toHaveCount(1);
  await expect(page.getByTestId('chart-data-percentiles-group_duration')).toHaveCount(1);

  // INDEPENDENT, not one control rendered twice: drive one and assert the other
  // did not move. A shared testid would also make these locators ambiguous.
  // The toggle carries aria-pressed={scale === 'log'} and starts on log, so
  // clicking one flips it to "false" while the other stays "true". Asserted on
  // aria-pressed rather than the label ("Log scale"/"Linear scale") because it
  // is the accessible state a screen reader reads, and it cannot drift with
  // copy.
  const cumulatedToggle = page.getByTestId('scale-toggle-percentiles-group_cumulated');
  const durationToggle = page.getByTestId('scale-toggle-percentiles-group_duration');
  await expect(cumulatedToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(durationToggle).toHaveAttribute('aria-pressed', 'true');

  await cumulatedToggle.click();

  await expect(cumulatedToggle).toHaveAttribute('aria-pressed', 'false');
  // THE ASSERTION THIS TEST EXISTS FOR: one control moved, the other did not.
  await expect(durationToggle).toHaveAttribute('aria-pressed', 'true');

  // GR-07 still does not exist (§A.9 F-4).
  await expect(page.getByTestId('chart-requests-per-second')).toHaveCount(0);
  await expect(page.getByTestId('chart-responses-per-second')).toHaveCount(0);
});
