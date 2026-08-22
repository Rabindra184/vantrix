import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedRunWithTelemetry } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { runTelemetryPath } from '../src/routes/paths.js';

/**
 * `/runs/:runId/load-generators`, Task 10's six host-telemetry charts, in a
 * real browser.
 *
 * ═══ WHY THIS IS A BROWSER TEST AT ALL ═══
 *
 * The unit suite mocks ECharts (`Chart.tsx`'s own docstring: `getBoundingClientRect`
 * returns zeros in jsdom, so a chart lays out at 0×0 and any assertion about
 * what it drew is theatre). An `<svg>` inside the figure is the proof a chart
 * really drew — exactly the invariant `run-charts.spec.ts` and eight other
 * specs already rest on — so NO DECORATIVE `<svg>` may ever land inside one of
 * these figures, or the count stops meaning anything.
 *
 * ═══ `figures()` EXCLUDES THE TIME-WINDOW STRIP, LIKE EVERY SIBLING SPEC ═══
 *
 * `RunShell` mounts `TimeBrush` — itself a `Chart`, `data-testid="chart-time-window"`
 * — ABOVE the tab outlet on every windowable run, on every tab, not only
 * Charts. A bare `page.getByRole('figure')` therefore counts SEVEN figures on
 * this page, not six, and its own data table never narrows with `?from=&to=`
 * because `TimeBrush` deliberately always draws the WHOLE run (it is the
 * control a reader drags to CREATE that window, not a chart that obeys it —
 * see `TimeBrush.tsx`'s own "THE STRIP ALWAYS SHOWS THE WHOLE RUN" docstring).
 * `run-charts.spec.ts` and `run-trends.spec.ts` both already exclude it for
 * exactly this reason; this file follows the same convention by scoping to
 * `telemetry-`-prefixed ids rather than reinventing the exclusion.
 *
 * ═══ ONE ORG PER TEST, NOT A SHARED beforeAll ═══
 *
 * `seedRunWithTelemetry` inserts telemetry scoped to (org, project, time), and
 * `TelemetryStore.forRun` carries no run id in that scope — two runs sharing
 * one org's project would leak samples across each other the instant their
 * windows overlapped, which they always do here: every run comes from the
 * SAME reference bundle, so every run's `toolStartedAt` is identical. Each
 * test therefore mints its own admin/org via `seedAdmin()`, exactly like
 * `group-detail.spec.ts` and `run-trends.spec.ts` already do, rather than
 * trying to reuse one signed-in session across cases that must stay isolated.
 *
 * `exact: true` on every `getByRole(..., { name })` below. Testing Library's
 * name match is EXACT and Playwright's default is a case-insensitive
 * SUBSTRING — the same call reads as a different assertion in `apps/web/test`
 * and here, and `ProjectRail` (every authenticated page: "All runs" plus one
 * link per project) is exactly the kind of extra text a loose match can
 * resolve against instead of the control a spec means to find.
 */

/** The six telemetry figures, in document order — never the time-window strip
 *  above them (see the file docstring). Mirrors `run-charts.spec.ts`'s own
 *  `figures()` helper, scoped to this tab's own chart-id prefix instead. */
function figures(page: Page): Locator {
  return page.locator('figure[data-testid^="chart-telemetry-"]');
}

test.describe('Load generators', () => {
  test('draws six charts for the selected host', async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await seedRunWithTelemetry(admin.orgId);
    await signIn(page, admin);
    await page.goto(runTelemetryPath(runId));

    await expect(page.getByRole('link', { name: 'Load generators', exact: true }))
      .toHaveAttribute('aria-current', 'page');

    const chartFigures = figures(page);
    await expect(chartFigures).toHaveCount(6);

    // ONE SVG PER PLOT. A chart that failed to draw renders its axes and
    // nothing else, and only a mark count catches that. Scoped to the canvas
    // rather than the figure, so header icons do not enter the count.
    for (let i = 0; i < 6; i++) {
      await expect(plot(chartFigures.nth(i))).toHaveCount(1);
    }
  });

  test('the host selector switches which generator is shown', async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await seedRunWithTelemetry(admin.orgId);
    await signIn(page, admin);
    await page.goto(runTelemetryPath(runId));

    const select = page.getByRole('combobox', { name: 'Load generator', exact: true });
    await expect(select).toBeVisible();

    // Derived from the payload: whatever the fixture seeded is what the
    // options are. `seedRunWithTelemetry` seeds exactly two hosts
    // (lg-alpha, lg-bravo), so there are two — never hard-coded here, so a
    // future fixture change that seeds a third host fails this test loudly
    // rather than the assertion quietly staying "2" forever.
    const options = await select.locator('option').allTextContents();
    expect(options.length).toBe(2);

    // `hosts` sorts alphabetically (toTelemetrySeries) and RunTelemetry's
    // default is `hosts[0]`, so the page opens on lg-alpha — a clean climb,
    // no reset — before anything is clicked. Its CPU table must therefore
    // carry no em-dash cell: `telemetryChart` (charts/transforms/telemetry.ts)
    // writes '—' only for a null rate, and lg-alpha's rates are never null.
    const cpuTable = page.getByTestId('chart-data-telemetry-cpu');
    await expect(cpuTable.locator('tbody tr').first()).toBeAttached();
    await expect(cpuTable.getByText('—', { exact: true })).toHaveCount(0);

    // Switching hosts must not lose or duplicate a chart: still exactly six.
    // The STRONGER proof the switch actually took effect, not merely that six
    // figures still happen to be on the page: lg-bravo is the ONLY host this
    // fixture seeds with a mid-run counter reset (seedRunWithTelemetry's
    // RESET_INDEX), and toTelemetrySeries drops that one interval's rate
    // entirely — so its CPU table carries an em-dash cell no host without a
    // reset could ever produce. Finding one here after selecting lg-bravo is
    // what actually distinguishes "the select re-rendered the page" from "the
    // select's onChange silently did nothing and the count matched anyway".
    await select.selectOption(options[1]!);
    await expect(figures(page)).toHaveCount(6);
    await expect(cpuTable.getByText('—', { exact: true })).not.toHaveCount(0);
  });

  test('the brush narrows telemetry with every other chart', async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await seedRunWithTelemetry(admin.orgId);
    await signIn(page, admin);

    await page.goto(runTelemetryPath(runId));
    const firstFigure = figures(page).first();
    // WAIT FOR THE TABLE TO BE POPULATED, not merely present — same reasoning
    // as run-charts.spec.ts's readTable(): the figure and its (collapsed, but
    // present) data table exist from first paint, before the query resolves,
    // so reading `.count()` immediately would race the fetch and could read
    // zero regardless of which window is loaded.
    await expect(firstFigure.locator('tbody tr').first()).toBeAttached();
    const before = await firstFigure.locator('tbody tr').count();

    // The window is a URL parameter, so this is the same narrowing a drag on
    // TimeBrush produces, without depending on a drag's pixel geometry. A
    // fresh `page.goto` (not a client-side navigation) so there is no stale
    // render from the wider window to race against the narrower one's.
    await page.goto(`${runTelemetryPath(runId)}?from=0&to=4000`);
    const afterFigure = figures(page).first();
    await expect(afterFigure.locator('tbody tr').first()).toBeAttached();
    const after = await afterFigure.locator('tbody tr').count();

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  test('a run with no telemetry says so instead of drawing empty axes', async ({ page }) => {
    const admin = await seedAdmin();
    // Plain seedRunWithData: a real, complete run, but this test's org never
    // gets a TelemetryStore.insert call anywhere in this file — so
    // GET /v1/runs/:id/telemetry answers available: false regardless of what
    // window this run's own toolStartedAt implies (RunTelemetry.tsx).
    const runId = await seedRunWithData(admin.orgId);
    await signIn(page, admin);
    await page.goto(runTelemetryPath(runId));

    // This exact phrase is load-bearing: RunTelemetry.tsx's own comment says
    // Task 11's e2e suite matches it, and it is the one sentence on the page
    // that distinguishes "never measured" from "measured and found idle".
    await expect(page.getByText(/no telemetry was recorded/i)).toBeVisible();
    // Zero TELEMETRY figures — not zero figures on the page. This run is
    // ordinarily windowable, so TimeBrush's own scrubber figure is still
    // there; `figures()` excludes it for exactly this reason (see the file
    // docstring), and a bare `getByRole('figure')` here would find that one
    // figure and fail even though the empty state rendered correctly.
    await expect(figures(page)).toHaveCount(0);
  });
});
