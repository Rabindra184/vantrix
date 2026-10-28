import { expect, test, type Locator } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedRunWithWarmup } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

/**
 * ═══ AC-STAT-4: THE WARM-UP BAND IS DRAWN, NOT JUST ASKED FOR ═══
 *
 * `Chart` has emitted a `markArea` over a run's warm-up window since the
 * demarcate-the-warmup-window branch, and no run ever showed one:
 * `charts/echarts.ts` never registered `MarkAreaComponent`, so ECharts threw the
 * option away. Every unit case was green throughout, because `Chart.test.tsx`
 * mocks ECharts and can only see the option it was handed. jsdom lays nothing
 * out either. Only a browser reading the drawn SVG can say the band exists.
 *
 * So this reads the plot's own SVG and asserts GEOMETRY, not presence: a band
 * filled translucently (ECharts writes `itemStyle.opacity` as `fill-opacity`),
 * starting at the plot's left edge, ending where the x axis puts its 00:00:10
 * tick (the run's `warmupMs` is 10 000 on purpose, so the boundary has a label
 * of its own to be compared against), and as tall as the plot. A band at the
 * wrong boundary, or a sliver, fails here; so does no band at all.
 *
 * And the control: the same chart for a run with NO warm-up carries no band
 * and no label, so the first half cannot pass on a shape every chart draws.
 */

const WARMUP_MS = 10_000;

interface Band {
  readonly left: number;
  readonly right: number;
  readonly height: number;
  readonly gridLeft: number;
  readonly gridSpan: number;
  readonly tick: number | null;
}

/** The warm-up band's geometry inside one chart's drawn SVG, or null when it has none. */
function bandOf(chart: Locator): Promise<Band | null> {
  return plot(chart).evaluate((svg) => {
    // The element's GEOMETRY in viewport pixels: `getBBox` mapped through its
    // screen CTM. Not `getBoundingClientRect`, which Firefox inflates for any
    // stroked path — measured, a 1 px gridline reads 4 px tall there, and the
    // band (stroke-width 0, still stroked) 2 px right of the gridlines' edge —
    // so the same SVG measured differently per engine.
    const box = (el: Element) => {
      const g = el as SVGGraphicsElement;
      const b = g.getBBox();
      const m = g.getScreenCTM()!;
      const a = new DOMPoint(b.x, b.y).matrixTransform(m);
      const c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m);
      const left = Math.min(a.x, c.x);
      const top = Math.min(a.y, c.y);
      return { left, top, right: Math.max(a.x, c.x), width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
    };
    const label = Array.from(svg.querySelectorAll('text')).find((t) => t.textContent === 'warm-up');
    const filled = Array.from(svg.querySelectorAll('path')).filter((p) => {
      const opacity = Number(p.getAttribute('fill-opacity') ?? '1');
      const fill = p.getAttribute('fill');
      return fill !== null && fill !== 'none' && opacity > 0 && opacity < 1;
    });
    if (label === undefined || filled.length !== 1) return null;
    const band = box(filled[0]!);
    // The horizontal gridlines span exactly the plot area: a flat, wide,
    // stroked path is one. `box` reads geometry without the stroke, so they
    // are 0 tall in every engine; under 2 px is margin, not a correction.
    const grid = Array.from(svg.querySelectorAll('path'))
      .filter((p) => p.getAttribute('fill') === 'none' && p.getAttribute('stroke') !== null)
      .map(box)
      .filter((r) => r.height < 2 && r.width > 100);
    if (grid.length < 2) return null;
    const tickText = Array.from(svg.querySelectorAll('text')).find((t) => t.textContent === '00:00:10');
    const tick = tickText === undefined ? null : box(tickText).left + box(tickText).width / 2;
    return {
      left: band.left,
      right: band.right,
      height: band.height,
      gridLeft: Math.min(...grid.map((r) => r.left)),
      gridSpan: Math.max(...grid.map((r) => r.top)) - Math.min(...grid.map((r) => r.top)),
      tick,
    };
  });
}

test('a run with a warm-up draws its band over exactly that window; a run without one draws none', async ({ page }) => {
  const admin = await seedAdmin();
  const warmed = await seedRunWithWarmup(admin.orgId, WARMUP_MS);
  const plain = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  await page.goto(runPath(warmed));
  const chart = page.getByTestId('chart-percentiles');
  await expect(plot(chart)).toHaveCount(1);
  // The WHOLE geometry is retried, not just the band's existence: the plot
  // root exists from the instance's first paint, before the band and the axis
  // are laid out, and a second `setOption` (a late query) animates the band's
  // points while the tick labels jump at once — a single read could land
  // mid-transition.
  await expect(async () => {
    const band = await bandOf(chart);
    expect(band, 'the warm-up band was never drawn').not.toBeNull();
    expect(band!.tick, 'the x axis must label 00:00:10 for the boundary to be compared against').not.toBeNull();
    expect(Math.abs(band!.left - band!.gridLeft), 'the band starts at the run start, the plot’s left edge').toBeLessThan(1.5);
    expect(Math.abs(band!.right - band!.tick!), 'the band ends at the warm-up boundary on the drawn axis').toBeLessThan(1.5);
    expect(band!.height, 'the band spans the plot vertically').toBeGreaterThanOrEqual(band!.gridSpan * 0.95);
  }).toPass({ timeout: 10_000 });

  await page.goto(runPath(plain));
  await expect(plot(chart)).toHaveCount(1);
  // The lines are drawn before the absence is read, so a chart that had not
  // finished drawing cannot satisfy it.
  await expect(plot(chart).locator('path[stroke-width="2"]').first()).toBeAttached();
  // The label count is the negative that cannot pass vacuously; `bandOf`
  // answers null for a missing gridline as well as a missing band.
  await expect(plot(chart).locator('text', { hasText: 'warm-up' })).toHaveCount(0);
  expect(await bandOf(chart)).toBeNull();
});
