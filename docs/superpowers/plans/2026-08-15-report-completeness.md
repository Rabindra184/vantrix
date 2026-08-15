# Report Completeness (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four run-report gaps whose data this product already stores — an outcome selector on the percentiles chart, a percentiles-distribution chart, CSV export of the statistics table, and tooltips that carry units and stay on screen.

**Architecture:** Entirely client-side. No contract change, no migration, no ingest change, no new endpoint. Every number already arrives in `SeriesResponse`, `DistributionResponse` or `StatsResponse`; three of the four tasks are new pure transforms plus a control, and the fourth is a serialiser. Transforms stay plain TypeScript with no React and no ECharts, so they unit-test in the node environment against the captured fixture — the boundary `charts/types.ts` exists to hold.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4, ECharts, TanStack Query, Zod contracts, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-15-cross-run-analysis-and-report-completeness-design.md`

## Global Constraints

- **No `uppercase` on anything queried by accessible name.** Playwright applies `text-transform` when computing accessible names; jsdom does not. A `<th class="uppercase">Percentage</th>` is named `PERCENTAGE` in Playwright and the unit suite stays green. Applies to column headings (`tables/tableStyles.ts`'s `TH`) and section headings (`components/SectionHeading.tsx`).
- **Every new e2e `getByRole(role, { name })` passes `exact: true`.** `ProjectRail` renders `All runs` plus one link per project in every authenticated document; Playwright's default name match is a case-insensitive substring, so a page-scoped query can be satisfied by a rail row.
- **No decorative `<svg>` inside a chart `<figure>`.** `run-charts.spec.ts` and `request-detail.spec.ts` prove a chart drew by counting SVG elements within the figure (`toHaveCount(1)`, or `0` for a chart with nothing to draw). `Chart` renders `DataTable` inside the figure, so an icon in its toggle breaks both the counts and the invariant.
- **Expectations are computed from the payload, never written down.** A test hard-coding a value that `apps/web/test/fixtures/reference-run.json` supplies breaks on the next re-capture for a reason that is not a defect. Derive it.
- **A token that is not in `@theme` produces no utility, silently.** Tailwind v4 generates utilities only from `@theme` declarations. If a task needs a new colour utility, publish the alias under a *different* name than the runtime token.
- **Null is not zero.** A gap in a series is `null` and draws as a gap. A missing value in a table cell is `—`. Rendering either as `0` states a measurement that was never made.
- **Verification gate**, before any task is called done:
  `pnpm typecheck && pnpm lint && pnpm test:unit`
  and before the *plan* is called done, additionally `pnpm test:integration && pnpm test:e2e` with the local stack up.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/charts/tooltip.ts` | Pure tooltip rendering: escaping, unit-suffixing, one-or-two-column layout. No React, no ECharts imports. |
| `apps/web/src/charts/transforms/percentileDistribution.ts` | `DistributionResponse` → percentile-vs-response-time curve. |
| `apps/web/src/charts/PercentileDistributionChart.tsx` | The figure, with its own outcome selector. |
| `apps/web/src/tables/csv.ts` | RFC 4180 serialisation and formula-injection guarding. |
| `apps/web/test/tooltip.test.ts` | Unit tests for the formatter, including an XSS case. |
| `apps/web/test/transforms.percentileDistribution.test.ts` | Unit tests for the new transform. |
| `apps/web/test/csv.test.ts` | Unit tests for serialisation, including a hostile request name. |

**Modified:**

| File | Change |
|---|---|
| `apps/web/src/charts/Chart.tsx` | `unit` prop; `valueFormatter` replaced by one `formatter`. |
| `apps/web/src/charts/transforms/percentiles.ts` | `outcome` parameter; emptiness rule follows the selection. |
| `apps/web/src/charts/PercentilesChart.tsx` | Outcome selector; passes `unit="ms"`. |
| `apps/web/src/charts/DistributionChart.tsx` | Passes `unit="%"`. |
| `apps/web/src/routes/RunDetail.tsx` | New chart slot in `RunChartsTab`. |
| `apps/web/src/tables/StatisticsTable.tsx` | Export button. |
| `apps/web/e2e/run-charts.spec.ts` | Figure count and the new figure's SVG assertion. |

---

## Task 1: Tooltip units and layout

The tooltip is the surface a sighted reader takes numbers off — the data table is collapsed until asked for. Today it renders `15` where the value is `15 ms`, and a ten-series chart produces a ten-row tooltip tall enough to run off a laptop viewport.

**Files:**
- Create: `apps/web/src/charts/tooltip.ts`
- Create: `apps/web/test/tooltip.test.ts`
- Modify: `apps/web/src/charts/Chart.tsx` (tooltip block, ~line 328–371; props interface)
- Modify: `apps/web/src/charts/PercentilesChart.tsx`, `apps/web/src/charts/DistributionChart.tsx`

**Interfaces:**
- Produces: `escapeHtml(s: string): string`, `formatTooltipValue(value: unknown, unit?: string): string`, `TWO_COLUMN_THRESHOLD: number`, `renderTooltip(title: string, rows: readonly TooltipRow[], unit?: string): string`, `tooltipFormatter(params: unknown, unit?: string): string`, and `interface TooltipRow { marker: string; name: string; value: unknown }`.
- Consumes: `formatCell` from `./DataTable` — the same function the data table uses, so the two surfaces cannot round a value differently.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/tooltip.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TWO_COLUMN_THRESHOLD,
  escapeHtml,
  formatTooltipValue,
  renderTooltip,
  type TooltipRow,
} from '../src/charts/tooltip';

const row = (name: string, value: unknown): TooltipRow => ({
  marker: '<span style="background:#f00"></span>',
  name,
  value,
});

describe('escapeHtml', () => {
  it('neutralises markup in a series name', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`a&b"c'd`)).toBe('a&amp;b&quot;c&#39;d');
  });
});

describe('formatTooltipValue', () => {
  it('appends the unit', () => {
    expect(formatTooltipValue(15, 'ms')).toBe('15 ms');
  });

  it('rounds through formatCell rather than showing raw float noise', () => {
    // formatCell trims to 2dp; the point is that the tooltip and the table
    // agree, so this asserts the shared behaviour rather than a literal.
    expect(formatTooltipValue(122.74516052680153, 'ms')).toBe('122.75 ms');
  });

  it('renders a gap as a dash with no unit', () => {
    expect(formatTooltipValue(null, 'ms')).toBe('—');
    expect(formatTooltipValue(undefined, 'ms')).toBe('—');
  });

  it('omits the unit when none is given', () => {
    expect(formatTooltipValue(15)).toBe('15');
  });

  it('formats a scatter pair component-by-component', () => {
    // String([3, 120]) is "3,120", which on a ms axis reads as three thousand
    // one hundred twenty rather than two measurements.
    expect(formatTooltipValue([3, 120])).toBe('3, 120');
  });
});

describe('renderTooltip', () => {
  it('uses one column at the threshold', () => {
    const rows = Array.from({ length: TWO_COLUMN_THRESHOLD }, (_, i) =>
      row(`s${i}`, i),
    );
    expect(renderTooltip('12', rows)).not.toContain('data-tooltip-column="2"');
  });

  it('uses two columns above the threshold', () => {
    const rows = Array.from({ length: TWO_COLUMN_THRESHOLD + 1 }, (_, i) =>
      row(`s${i}`, i),
    );
    expect(renderTooltip('12', rows)).toContain('data-tooltip-column="2"');
  });

  it('fills the first column before the second, preserving order', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}`, i));
    const html = renderTooltip('12', rows);
    // 10 rows split 5/5: s4 is last in column one, s5 first in column two.
    expect(html.indexOf('s4')).toBeLessThan(html.indexOf('s5'));
    expect(html.indexOf('s0')).toBeLessThan(html.indexOf('s4'));
  });

  it('escapes the title and every series name', () => {
    const html = renderTooltip('<b>t</b>', [row('<script>x</script>', 1)]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>t</b>');
  });

  it('keeps the marker markup, which ECharts supplies', () => {
    expect(renderTooltip('12', [row('a', 1)])).toContain('background:#f00');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/test/tooltip.test.ts`
Expected: FAIL — cannot resolve `../../src/charts/tooltip`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/charts/tooltip.ts`:

```ts
import { formatCell } from './DataTable';

/**
 * The tooltip, as a string of HTML, kept out of `Chart.tsx` so it can be
 * tested without a DOM or a renderer — the same boundary `transforms/*`
 * already has.
 *
 * ECharts wants a `formatter` returning markup. That makes every interpolated
 * value an injection site, and series names are NOT ours: they come from the
 * tool's payload, which came from someone's simulation. Everything except
 * ECharts' own `marker` is escaped.
 */

/**
 * Above EIGHT series the tooltip lays out in two columns.
 *
 * The percentiles chart draws ten, and a ten-row tooltip near the bottom of a
 * chart runs off a laptop viewport — the reader hovers to read a number and
 * the number is off-screen. Eight or fewer stays one column, so every other
 * chart in the app is visually unchanged.
 */
export const TWO_COLUMN_THRESHOLD = 8;

export interface TooltipRow {
  /** ECharts' own colour swatch, already markup. NOT escaped — it is ours. */
  readonly marker: string;
  /** From the payload. Untrusted. */
  readonly name: string;
  readonly value: unknown;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * THE SAME FORMATTING THE DATA TABLE USES, from the same function, for the
 * same reason it always has: the tooltip used to render ECharts' raw values —
 * `122.74516052680153 ms` for a percentile, seventeen significant digits of a
 * number nothing measures to more than two.
 *
 * A SCATTER POINT IS AN ARRAY, not a scalar: `[x, y]` pairs arrive whole, and
 * `String([3, 120])` is `"3,120"`, which on a milliseconds axis reads as three
 * thousand one hundred twenty rather than two separate measurements. Formatted
 * component-by-component and joined by a comma-space no reader mistakes for a
 * digit grouping.
 *
 * A gap takes no unit. "— ms" reads as a measurement that came out empty.
 */
export function formatTooltipValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return '—';
  const one = (v: unknown): string =>
    typeof v === 'number' || typeof v === 'string' ? formatCell(v) : String(v);
  const text = Array.isArray(value) ? value.map(one).join(', ') : one(value);
  return unit === undefined ? text : `${text} ${unit}`;
}

function renderRow(row: TooltipRow, unit?: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">` +
    `${row.marker}` +
    `<span style="flex:1">${escapeHtml(row.name)}</span>` +
    `<span style="font-variant-numeric:tabular-nums;font-weight:600">` +
    `${escapeHtml(formatTooltipValue(row.value, unit))}` +
    `</span></div>`
  );
}

/**
 * ONE FORMATTER, NOT TWO. The tempting shape — keep ECharts' `valueFormatter`
 * for the narrow case and add a custom `formatter` for the wide one — puts two
 * code paths on the same value, which is exactly the class of bug sharing
 * `formatCell` was introduced to prevent. This always runs.
 *
 * Columns fill top-to-bottom then across, so series order reads down the first
 * column and continues down the second — the order the legend and the ramp are
 * both in.
 */
export function renderTooltip(
  title: string,
  rows: readonly TooltipRow[],
  unit?: string,
): string {
  const head = `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(title)}</div>`;

  if (rows.length <= TWO_COLUMN_THRESHOLD) {
    return `${head}<div>${rows.map((r) => renderRow(r, unit)).join('')}</div>`;
  }

  const split = Math.ceil(rows.length / 2);
  const column = (slice: readonly TooltipRow[], n: number): string =>
    `<div data-tooltip-column="${n}">${slice.map((r) => renderRow(r, unit)).join('')}</div>`;

  return (
    `${head}<div style="display:flex;gap:16px">` +
    `${column(rows.slice(0, split), 1)}${column(rows.slice(split), 2)}</div>`
  );
}

/**
 * ECharts hands `axis`-triggered tooltips an ARRAY of params and
 * `item`-triggered ones (the pie) a single object. Normalised here so
 * `renderTooltip` never sees a renderer shape.
 */
export function tooltipFormatter(params: unknown, unit?: string): string {
  const list = Array.isArray(params) ? params : [params];
  const first = list[0] as Record<string, unknown> | undefined;
  if (first === undefined) return '';

  const title = String(first['axisValueLabel'] ?? first['name'] ?? '');

  const rows: TooltipRow[] = list.map((p) => {
    const param = p as Record<string, unknown>;
    return {
      marker: String(param['marker'] ?? ''),
      name: String(param['seriesName'] ?? param['name'] ?? ''),
      value: param['value'],
    };
  });

  return renderTooltip(title, rows, unit);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/web/test/tooltip.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Wire it into `Chart.tsx`**

Add to `Chart.tsx`'s props interface, beside `group`:

```ts
  /**
   * The unit every value in this chart's tooltip carries — `'ms'`, `'%'`,
   * `'req/s'`. Per chart, because the chart is what knows its axis. Omitted
   * where an axis is unitless or mixed.
   */
  readonly unit?: string;
```

Destructure `unit` alongside `group`, and replace the whole `valueFormatter`
block in the `tooltip` option with:

```ts
          formatter: (params: unknown) => tooltipFormatter(params, unit),
```

Import `tooltipFormatter` from `./tooltip`. Add `unit` to the option effect's
dependency array — a missed dependency here leaves the tooltip formatting for
the previous unit after a prop change.

- [ ] **Step 6: Pass the unit on the charts whose axis has one**

`PercentilesChart.tsx` — add `unit="ms"` to its `<Chart>` (its axis is already
`Response time (ms)`).

`DistributionChart.tsx` — add `unit="%"`. It plots `okPercent`/`koPercent`,
which are shares of the combined OK+KO total.

For every other chart, read its existing `yAxis.name` and pass the matching
unit, or nothing where the axis has none. Do not invent a unit that disagrees
with the axis title already on screen.

- [ ] **Step 7: Run the full unit suite**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS. Any chart test asserting old tooltip text will fail here — fix
the assertion, not the formatter.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/charts/tooltip.ts apps/web/test/tooltip.test.ts \
        apps/web/src/charts/Chart.tsx apps/web/src/charts/PercentilesChart.tsx \
        apps/web/src/charts/DistributionChart.tsx
git commit -m "feat(web): a tooltip that carries its unit and stays on screen

The tooltip is where a sighted reader actually takes numbers off - the
data table is collapsed until asked for - and it rendered 15 where the
value is 15 ms, with the unit visible only in the axis title, which is
not in the reader's eye at the time.

Ten percentile bands also produced a ten-row tooltip tall enough to run
off a laptop viewport near the bottom of a chart, so above eight series
it lays out in two columns.

One formatter, not two: keeping valueFormatter for the narrow case and
adding a custom formatter for the wide one would put two code paths on
the same value, which is the bug sharing formatCell exists to prevent.
Series names come from the tool's payload and are escaped."
```

---

## Task 2: Outcome selector on the percentiles chart

Gatling puts an OK / KO / all selector on every percentile chart. Ours is permanently OK-only — correctly, per G-22, but with no way to ask the other two questions. `percentilesKo` is in the payload and nothing in the web app reads it.

**Files:**
- Modify: `apps/web/src/charts/transforms/percentiles.ts`
- Modify: `apps/web/src/charts/PercentilesChart.tsx`
- Modify: `apps/web/test/transforms.percentiles.test.ts` (the existing suite)

**Interfaces:**
- Produces: `export type Outcome = 'ok' | 'ko' | 'all'`, and `toPercentiles(series: SeriesResponse, bands?: readonly Band[], outcome?: Outcome): ChartData` — `outcome` defaults to `'ok'`, so every existing caller is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to the existing percentiles transform suite:

```ts
import { toPercentiles } from '../src/charts/transforms/percentiles';
// `reference` is the captured fixture this suite already loads; reuse its
// existing import rather than adding a second one.

describe('toPercentiles outcome selection', () => {
  // `series` is already declared at the top of this file.

  it('defaults to OK, leaving existing callers unchanged', () => {
    expect(toPercentiles(series)).toEqual(toPercentiles(series, undefined, 'ok'));
  });

  it('reads percentilesKo when KO is selected', () => {
    const koBucket = series.buckets.findIndex(
      (b) => Object.keys(b.percentilesKo).length > 0,
    );
    expect(koBucket).toBeGreaterThanOrEqual(0); // fixture must contain failures

    const data = toPercentiles(series, ['p95'], 'ko');
    const drawn = data.series[0]!.data as readonly (number | null)[];
    expect(drawn[koBucket]).toBe(series.buckets[koBucket]!.percentilesKo.p95);
  });

  it('leaves a bucket with no KO as a gap, not a zero', () => {
    const noKo = series.buckets.findIndex(
      (b) => Object.keys(b.percentilesKo).length === 0,
    );
    expect(noKo).toBeGreaterThanOrEqual(0);

    const data = toPercentiles(series, ['p95'], 'ko');
    expect((data.series[0]!.data as readonly (number | null)[])[noKo]).toBeNull();
  });

  it('reads the combined map when all is selected', () => {
    const i = series.buckets.findIndex((b) => Object.keys(b.percentiles).length > 0);
    const data = toPercentiles(series, ['p95'], 'all');
    const drawn = data.series[0]!.data as readonly (number | null)[];
    expect(drawn[i]).toBe(series.buckets[i]!.percentiles.p95);
  });

  it('names the selected outcome in the deviation note', () => {
    expect(toPercentiles(series, undefined, 'ok').limitation).toContain('OK-only');
    expect(toPercentiles(series, undefined, 'ko').limitation).toContain('KO-only');
  });

  it('still carries all ten bands in the table whatever the outcome', () => {
    // The drawing has a legibility budget; the parity surface does not.
    const data = toPercentiles(series, ['p95'], 'ko');
    expect(data.columns).toHaveLength(1 + BANDS.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/test/transforms.percentiles.test.ts`
Expected: FAIL — `toPercentiles` takes two parameters.

- [ ] **Step 3: Thread the outcome through the transform**

In `transforms/percentiles.ts`, add above `measured`:

```ts
/**
 * Which of `SeriesBucket`'s three percentile maps this chart is reading.
 *
 * `'ok'` is the default and is what G-22 / RQ-05 specify — Gatling's own
 * percentiles-over-time chart is OK-only. The other two exist because Gatling
 * puts a three-way selector on the figure, and `percentilesKo` is in our
 * payload already.
 */
export type Outcome = 'ok' | 'ko' | 'all';

const MAP = {
  ok: 'percentilesOk',
  ko: 'percentilesKo',
  all: 'percentiles',
} as const satisfies Record<Outcome, keyof SeriesResponse['buckets'][number]>;
```

Change `measured` and `bandValue` to take the outcome. The emptiness rule must
follow the selection — its existing docstring reasons about the START edge and
about a map that "cannot be null and cannot disagree with itself", and both
arguments hold for all three maps. Keeping it pinned to `percentilesOk` would
draw a KO series as a continuous line across seconds that recorded no failure:

```ts
function measured(
  bucket: SeriesResponse['buckets'][number],
  outcome: Outcome,
): boolean {
  return Object.keys(bucket[MAP[outcome]]).length > 0;
}

function bandValue(
  bucket: SeriesResponse['buckets'][number],
  band: Band,
  outcome: Outcome,
): number | null {
  if (!measured(bucket, outcome)) return null;
  if (band === 'min') return bucket.minMs;
  if (band === 'max') return bucket.maxMs;
  return bucket[MAP[outcome]][band] ?? null;
}
```

Add the parameter to `toPercentiles`, defaulting to `'ok'`, and pass it at both
`bandValue` call sites and the `unmeasured` filter. Make the two notes
outcome-aware:

```ts
const OUTCOME_NOTE: Record<Outcome, string> = {
  ok: 'min and max are the combined OK+KO extremes; the other bands are OK-only.',
  ko: 'min and max are the combined OK+KO extremes; the other bands are KO-only.',
  all: 'All bands include both OK and KO responses.',
};

const NOTHING_MEASURED: Record<Outcome, string> = {
  ok: 'no successful response',
  ko: 'no failed response',
  all: 'no response',
};
```

and use `NOTHING_MEASURED[outcome]` in the `unmeasured` sentence.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/web/test/transforms.percentiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the control**

In `PercentilesChart.tsx`, add `const [outcome, setOutcome] = useState<Outcome>('ok');`,
pass it to `toPercentiles` (and into the `useMemo` deps), and render a
three-button group beside the existing band selector, matching its markup:

```tsx
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Response outcome</legend>
          {(['ok', 'ko', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={outcome === value}
              data-testid={`outcome-${value}-${id}`}
              onClick={() => setOutcome(value)}
              className={`rounded border px-2 py-0.5 text-sm ${
                outcome === value
                  ? 'border-primary text-primary'
                  : 'border-default text-muted'
              }`}
            >
              {value === 'ok' ? 'OK' : value === 'ko' ? 'KO' : 'All'}
            </button>
          ))}
        </fieldset>
```

`aria-pressed` rather than a radio group, to match the band selector this sits
beside — one interaction idiom on one toolbar.

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/charts/transforms/percentiles.ts \
        apps/web/src/charts/PercentilesChart.tsx \
        apps/web/test/transforms.percentiles.test.ts
git commit -m "feat(web): ask the percentiles chart about failures

percentilesKo has been in the payload since the parity migration and
nothing in the web app read it - only the scatter parity controller.
Gatling puts a three-way outcome selector on this figure; ours was
permanently OK-only, which is right as a DEFAULT (G-22/RQ-05 specify the
OK set) and wrong as the only option.

The emptiness rule had to follow the selection. It was keyed on
percentilesOk being non-empty, for reasons about the start edge that
hold for all three maps - left pinned, a KO series would draw as a
continuous line across seconds that recorded no failure at all."
```

---

## Task 3: Percentiles-distribution chart

Percentile on the x-axis, response time on the y — it reads the tail shape directly, which a time series cannot. Derived from `DistributionResponse`, which the Charts tab already holds: a cumulative sum over counts-per-response-time-bucket *is* a percentile curve.

**Files:**
- Create: `apps/web/src/charts/transforms/percentileDistribution.ts`
- Create: `apps/web/test/transforms.percentileDistribution.test.ts`
- Create: `apps/web/src/charts/PercentileDistributionChart.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx` (`RunChartsTab` slots)
- Modify: `apps/web/e2e/run-charts.spec.ts`

**Interfaces:**
- Consumes: `Outcome` from `./percentiles` — one spelling of the three-way choice across both charts.
- Produces: `toPercentileDistribution(d: DistributionResponse, outcome: Outcome): ChartData`, with `series[0].data` as `[percentile, responseTimeMs]` pairs.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/transforms.percentileDistribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toPercentileDistribution } from '../src/charts/transforms/percentileDistribution';
import fixture from './fixtures/reference-run.json';

const distribution = fixture.distribution as unknown as DistributionResponse;

describe('toPercentileDistribution', () => {
  it('rises monotonically in both axes', () => {
    const points = toPercentileDistribution(distribution, 'ok').series[0]!
      .data as readonly (readonly [number, number])[];

    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]![0]).toBeGreaterThanOrEqual(points[i - 1]![0]);
      expect(points[i]![1]).toBeGreaterThanOrEqual(points[i - 1]![1]);
    }
  });

  it('reaches 100 percent of binned observations when nothing overflowed', () => {
    const d = { ...distribution, overflowCount: 0 };
    const points = toPercentileDistribution(d, 'ok').series[0]!
      .data as readonly (readonly [number, number])[];
    expect(points.at(-1)![0]).toBeCloseTo(100, 6);
  });

  it('plots the payload labels as the y values, never a bin index', () => {
    const points = toPercentileDistribution(distribution, 'ok').series[0]!
      .data as readonly (readonly [number, number])[];
    const ys = points.map((p) => p[1]);
    // Every y must be a label the payload actually carried.
    for (const y of ys) expect(distribution.labels).toContain(y);
  });

  it('says so when observations overflowed the histogram', () => {
    const d = { ...distribution, overflowCount: 7 };
    expect(toPercentileDistribution(d, 'ok').limitation).toContain('7');
  });

  it('is empty, with a reason, for an outcome that recorded nothing', () => {
    const d = { ...distribution, koCount: distribution.koCount.map(() => 0) };
    const data = toPercentileDistribution(d, 'ko');
    expect(data.series).toHaveLength(0);
    expect(data.empty).toBeTruthy();
  });

  it('combines both outcomes when all is selected', () => {
    const okTotal = distribution.okCount.reduce((a: number, b: number) => a + b, 0);
    const koTotal = distribution.koCount.reduce((a: number, b: number) => a + b, 0);
    const rows = toPercentileDistribution(distribution, 'all').rows;
    const counted = rows.reduce((sum, r) => sum + Number(r.values[1]), 0);
    expect(counted).toBe(okTotal + koTotal);
  });

  it('names the label kind so a midpoint is not read as an observation', () => {
    const exact = toPercentileDistribution({ ...distribution, exactValues: true }, 'ok');
    const binned = toPercentileDistribution({ ...distribution, exactValues: false }, 'ok');
    expect(exact.columns[1]).toContain('exact');
    expect(binned.columns[1]).toContain('midpoint');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/test/transforms.percentileDistribution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the transform**

Create `apps/web/src/charts/transforms/percentileDistribution.ts`:

```ts
import type { DistributionResponse } from '@perfportal/contracts';
import type { ChartData, ChartTableRow } from '../types';
import type { Outcome } from './percentiles';

/**
 * Response Time Percentiles Distribution — percentile on the x-axis, response
 * time on the y.
 *
 * DERIVED, NOT FETCHED. `DistributionResponse` already carries counts per
 * response-time bucket, and walking the buckets in ascending order while
 * accumulating those counts answers "what share of observations were at or
 * below this response time" — which is the definition of a percentile. So this
 * chart costs no endpoint, no query and no cache key; it reads the payload the
 * Charts tab is already holding for the histogram.
 *
 * It is worth having beside that histogram rather than instead of it: the
 * histogram shows where the mass is, and this shows the SHAPE OF THE TAIL,
 * which is the question an SLO is written about.
 */

/** The percentage axis, which is the x here and needs naming as such. */
const PERCENTILE_COLUMN = 'Percentile (%)';

function labelColumn(exactValues: boolean): string {
  return exactValues
    ? 'Response time (ms, exact value)'
    : 'Response time (ms, bin midpoint)';
}

/**
 * The counts this outcome is a curve of.
 *
 * `all` sums the two rather than reading a third array, because the payload
 * has no combined series — and the sum is exactly right: `okCount` and
 * `koCount` partition the binned observations.
 */
function countsFor(d: DistributionResponse, outcome: Outcome): readonly number[] {
  if (outcome === 'ok') return d.okCount;
  if (outcome === 'ko') return d.koCount;
  return d.labels.map((_, i) => (d.okCount[i] ?? 0) + (d.koCount[i] ?? 0));
}

const OUTCOME_NOUN: Record<Outcome, string> = {
  ok: 'successful response',
  ko: 'failed response',
  all: 'response',
};

/**
 * Said in prose, because the alternative is drawing a curve to 100% and
 * letting it look complete.
 *
 * An observation above the histogram's cap is counted but lands in no bin, so
 * this curve is a percentile OF THE BINNED OBSERVATIONS and the real tail
 * extends past its right-hand end. The cap itself is not named — it is a
 * server constant the payload does not carry.
 */
function overflowNote(count: number): string {
  const times = count === 1 ? 'response time' : 'response times';
  return (
    `${count} ${times} exceeded the range this histogram records and fall into no bin, so ` +
    'this curve describes only the binned observations and the true tail extends beyond its ' +
    'right-hand end.'
  );
}

export function toPercentileDistribution(
  d: DistributionResponse,
  outcome: Outcome,
): ChartData {
  const columns = [PERCENTILE_COLUMN, labelColumn(d.exactValues), 'Requests at or below'];
  const limitation = d.overflowCount > 0 ? overflowNote(d.overflowCount) : undefined;

  const counts = countsFor(d, outcome);
  const total = counts.reduce((sum, n) => sum + n, 0);

  if (d.labels.length === 0 || total <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns,
      rows: [],
      // Not a flat line at zero, which reads as "every response was instant".
      empty:
        d.labels.length === 0
          ? 'No response times were recorded for this run, so there is no distribution to show.'
          : `This run recorded no ${OUTCOME_NOUN[outcome]}, so there is no curve to draw.`,
      limitation,
    };
  }

  let cumulative = 0;
  const points: [number, number][] = [];
  const rows: ChartTableRow[] = [];

  d.labels.forEach((label, i) => {
    const n = counts[i] ?? 0;
    // A bin nothing landed in adds no point: it would repeat the previous
    // percentile at a higher response time, drawing a horizontal run that
    // claims observations at times nothing was observed at.
    if (n === 0) return;
    cumulative += n;
    const percentile = (cumulative / total) * 100;
    points.push([percentile, label]);
    rows.push({ label: String(percentile), values: [label, cumulative] });
  });

  return {
    series: [{ name: outcome === 'ko' ? 'KO' : outcome === 'ok' ? 'OK' : 'All', data: points }],
    // Empty on purpose: x is a MEASURED QUANTITY here, not a category, so the
    // points carry their own x (see `ChartSeries.data`'s pair form).
    axisLabels: [],
    columns,
    rows,
    limitation,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/web/test/transforms.percentileDistribution.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the chart component**

Create `apps/web/src/charts/PercentileDistributionChart.tsx`, modelled on
`PercentilesChart` — outcome selector with the same markup and `aria-pressed`
idiom, `data-testid={`outcome-${value}-${id}`}` derived from `id`, and:

```tsx
      <Chart
        id={id}
        title={title}
        data={data}
        kind="line"
        xAxis={{ type: 'value', name: 'Percentile (%)' }}
        yAxis={{ name: 'Response time (ms)' }}
        unit="ms"
        roles={[outcome === 'ko' ? 'failed' : 'passed']}
      />
```

No `group` — its x-axis is a percentile, not time, so it must NOT join the
`run-time` crosshair. Gatling's own distribution charts are outside their sync
group for exactly this reason, and joining would drive a crosshair to a
meaningless position on every hover elsewhere.

Check `ChartProps`' `xAxis` accepts `type: 'value'` before writing this; if it
does not, add it the way `yAxis` already carries `type`.

- [ ] **Step 6: Add the slot to the Charts tab**

In `RunDetail.tsx`, beside `DISTRIBUTION`:

```ts
const PERCENTILE_DISTRIBUTION: Slot = {
  id: 'percentile-distribution',
  title: 'Response time percentiles distribution',
};
```

Render it from the same `distributionQuery` the histogram uses — one fetch,
two figures, no second cache key.

- [ ] **Step 7: Update the e2e chart-count spec**

`run-charts.spec.ts` asserts the number of figures and one `<svg>` per figure.
Add the new figure to both. Use `exact: true` on its name, and remember the
figure must contain no decorative `<svg>`.

- [ ] **Step 8: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/charts/transforms/percentileDistribution.ts \
        apps/web/test/transforms.percentileDistribution.test.ts \
        apps/web/src/charts/PercentileDistributionChart.tsx \
        apps/web/src/routes/RunDetail.tsx apps/web/e2e/run-charts.spec.ts
git commit -m "feat(web): the shape of the tail, not just where the mass is

Percentile on the x-axis, response time on the y. The histogram beside
it answers where most requests landed; this answers how bad the worst
ones get, which is the question an SLO is actually written about.

Derived rather than fetched: a cumulative sum over DistributionResponse's
per-bucket counts IS a percentile curve, so this costs no endpoint, no
query and no cache key - it reads the payload the Charts tab already
holds.

Two honesty constraints the payload made available. A bin nothing landed
in adds no point, because repeating a percentile at a higher response
time draws a horizontal run asserting observations that were never made.
And overflowCount > 0 means the curve covers only binned observations,
said in prose rather than drawn to 100% and left looking complete."
```

---

## Task 4: CSV export of the statistics table

The first thing anyone asks a performance tool for. One button, and one real hazard.

**Files:**
- Create: `apps/web/src/tables/csv.ts`
- Create: `apps/web/test/csv.test.ts`
- Modify: `apps/web/src/tables/StatisticsTable.tsx`

**Interfaces:**
- Produces: `escapeCsvCell(value: string): string`, `toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string`, `downloadCsv(filename: string, csv: string): void`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../src/tables/csv';

describe('escapeCsvCell', () => {
  it('quotes every cell', () => {
    expect(escapeCsvCell('GET Home')).toBe('"GET Home"');
  });

  it('doubles an embedded quote, per RFC 4180', () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it.each(['=', '+', '-', '@'])(
    'neutralises a formula beginning %s',
    (lead) => {
      expect(escapeCsvCell(`${lead}cmd|'/c calc'!A1`)).toBe(
        `"'${lead}cmd|'/c calc'!A1"`,
      );
    },
  );

  it('neutralises a leading tab and carriage return', () => {
    expect(escapeCsvCell('\tSUM(A1)')).toBe(`"'\tSUM(A1)"`);
    expect(escapeCsvCell('\r=SUM(A1)')).toBe(`"'\r=SUM(A1)"`);
  });

  it('leaves a negative NUMBER alone once formatted', () => {
    // A value cell is pre-formatted by the table's own formatters; a bare
    // "-1" would be guarded, which is correct and harmless - the guard is on
    // the STRING, and a spreadsheet reading '-1 as text is better than one
    // evaluating -1+cmd. Asserted so the behaviour is deliberate.
    expect(escapeCsvCell('-1')).toBe(`"'-1"`);
  });
});

describe('toCsv', () => {
  it('joins with CRLF, per RFC 4180', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('"a","b"\r\n"1","2"');
  });

  it('emits the header even with no rows', () => {
    expect(toCsv(['a'], [])).toBe('"a"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/test/csv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `apps/web/src/tables/csv.ts`:

```ts
/**
 * CSV for the statistics table.
 *
 * FORMULA INJECTION IS THE REASON THIS FILE HAS A GUARD AND A TEST.
 *
 * Request names come from the tool's payload, which came from someone's
 * simulation — untrusted input, reaching a file the reader will open in Excel
 * or Sheets. A cell beginning `=`, `+`, `-`, `@`, TAB or CR is EVALUATED on
 * open, and `=cmd|'/c calc'!A1` is the canonical demonstration that this ends
 * in code execution rather than a funny-looking cell.
 *
 * The fix is one apostrophe, which spreadsheets consume as "treat the rest as
 * text" and which is invisible in the opened sheet.
 */

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One cell: guarded, then quoted.
 *
 * EVERY cell is quoted, not just the ones containing a comma. Conditional
 * quoting is a second rule that has to agree with the first about what a
 * separator is, and this file would rather have one rule.
 */
export function escapeCsvCell(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** CRLF between records, which is what RFC 4180 specifies. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, ...rows]
    .map((record) => record.map(escapeCsvCell).join(','))
    .join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * A Blob and an object URL, NOT an `<a download>` with a data: URI — data URIs
 * hit length limits a large statistics table will reach, and browsers disagree
 * about whether they honour the download attribute on one. The object URL is
 * revoked immediately; the click has already been dispatched synchronously.
 *
 * The BOM is deliberate: without it Excel reads the file as the system
 * codepage and mangles any non-ASCII request name.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/web/test/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the button into `StatisticsTable`**

Build the header from the same `columns` array the `<thead>` renders, prefixed
by `NAME_COLUMN_LABEL`. Build the rows by mapping **the exact array the
`<tbody>` maps over** — not the unsorted payload — so the file matches what the
reader was looking at, including their sort. Format each value with the
column's own `format`, and render `undefined` as an empty cell.

```tsx
  function exportCsv() {
    const header = [NAME_COLUMN_LABEL, ...columns.all.map((c) => c.label)];
    const records = visibleRows.map((entry) => [
      entry.name,
      ...columns.all.map((c) => {
        const value = c.value(entry.row);
        return value === undefined ? '' : c.format(value);
      }),
    ]);
    downloadCsv(`perfportal-${runId}-statistics.csv`, toCsv(header, records));
  }
```

Substitute `columns.all` and `visibleRows` with this component's real names —
read them before writing. A collapsed group's children must still appear: they
are rows of the statistics table, and omitting them is silent data loss.

The button goes in the table's existing header area beside the other controls,
as a `<button type="button">` with an accessible name of `Download CSV`.
**No icon inside it** if it sits within a chart figure — it does not, but the
same rule applies to anything `Chart` wraps.

- [ ] **Step 6: Add a component test**

In the existing `StatisticsTable.test.tsx`, assert the button exists and is
reachable by role and exact name. Do not assert on a real download in jsdom —
`URL.createObjectURL` is not implemented there. Extract and test `exportCsv`'s
*string* output if you want coverage of the wiring, or stub `downloadCsv`.

- [ ] **Step 7: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/tables/csv.ts apps/web/test/csv.test.ts \
        apps/web/src/tables/StatisticsTable.tsx apps/web/test/StatisticsTable.test.tsx
git commit -m "feat(web): download the statistics table

The first thing anyone asks a performance tool for, and one real hazard
on the way: request names come from someone's simulation and land in a
file the reader opens in Excel. A cell beginning =, +, -, @, tab or CR
is evaluated on open, so every cell is guarded with an apostrophe the
spreadsheet consumes and the reader never sees.

Rows come from the array the tbody maps over, not the payload, so the
file matches the sort the reader was looking at. A collapsed group's
children are still exported - they are rows of the table, and dropping
them would be silent data loss."
```

---

## Task 5: Full verification

- [ ] **Step 1: Bring up the local stack**

```bash
docker compose -f infra/docker-compose.yml up -d
```

- [ ] **Step 2: Export the environment**

```bash
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
```

Confirm no fixture capture is running first — `test:integration` truncates
every table on setup and would delete an org mid-capture.

- [ ] **Step 3: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: PASS. `test:unit` excludes the integration and e2e suites — a change
that passes it can still break `apps/api/test`, which is why this step exists
as its own gate rather than as a line in Task 4.

- [ ] **Step 4: Report**

State the actual command output. If anything fails, fix it and re-run the whole
gate — not just the failing suite.

---

## Self-Review

**Spec coverage:** 2.1 → Task 2. 2.2 → Task 3. 2.3 → Task 4. 2.4 → Task 1. The spec's testing section → the gate in every task plus Task 5. No spec requirement is unimplemented.

**Deliberately deferred to the executor, with instructions rather than code:** the exact identifiers inside `StatisticsTable` (Task 4 Step 5) and the `xAxis.type` capability check (Task 3 Step 5). Both are "read the file, then write" rather than placeholders — the surrounding code is given, and the step says exactly what to look for and why.

**Type consistency:** `Outcome` is defined once in `transforms/percentiles.ts` and imported by `percentileDistribution.ts` and both chart components. `ChartSeries.data`'s pair form is used by Task 3 and is the shape `types.ts` already documents. `formatCell` is imported from `./DataTable` in Task 1 exactly as `Chart.tsx` already imports it.
