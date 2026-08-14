# Parity Charts — the Global Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the eight §13.2 overview charts on the run detail page, so a person migrating from the Gatling HTML report finds them where they expect.

**Architecture:** Pure transform functions turn already-validated contract payloads into chart series and table rows. A single `Chart` primitive owns everything ECharts-shaped and renders SVG. Every chart ships an accessible data table holding the exact values it plots, and that table — not the pixels — is what parity assertions read.

**Tech Stack:** ECharts (tree-shaken, SVG renderer), React 18, TanStack Query, Zod contracts, Vitest (node + jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-13-perf-portal-parity-charts-design.md`

## Global Constraints

- Dependencies pinned EXACTLY — no `^`, no `~`, in any package.json. Every dependency is declared by the package that imports it.
- Exactly one `zod` version reachable from app code (`3.25.76`).
- Charts render with ECharts' **SVG renderer**, never canvas.
- **No dual-axis charts, ever** (§22.4). Two measures of different scale become two time-linked charts sharing a crosshair.
- Legend whenever ≥ 2 series; a single-series chart gets none and the title names it.
- Values, labels and legend text wear ink tokens (`--color-text-*`), **never** the series colour.
- Selective direct labels only — never a number on every point.
- A chart with no data shows an explanation, not empty axes.
- Every chart renders a data table with `data-testid="chart-data-<chartId>"`, always in the DOM, visually hidden, revealed by a per-chart toggle.
- The percentile band set is exactly ten: `min, p25, p50, p75, p80, p85, p90, p95, p99, max` (D-7). There is no p98 and no p99.9.
- Percentiles over time uses **`percentilesOk`**, never `percentiles` (G-22).
- Rates divide by `bucketWidthMs` from the payload. **Never hard-code 1000.**
- Out of scope and must not appear in any diff: the statistics table, the errors table, request/group/scenario detail pages, the latency family, trend strips, comparison, regression detection, live monitoring, saved views, custom dashboards, personalization, i18n mechanics, self-registration, and any RBAC affordance.
- Never run `pnpm test:integration` and the e2e suite concurrently — the integration harness truncates the tables the e2e fixtures depend on.
- `pnpm install` needs Node ≥ 22: run `. "$HOME/.nvm/nvm.sh" && nvm use` first.
- The e2e harness needs these in the shell (there is no `.env`):
  `DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal`, `REDIS_URL=redis://localhost:6380`, `S3_ENDPOINT=http://localhost:9000`, `S3_ACCESS_KEY=perfportal`, `S3_SECRET_KEY=perfportal123`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/metrics.ts` | `bucketWidthMs`, `startedSplitAvailable`, `startedOkCount`/`startedKoCount` added to the series contract |
| `packages/statistics/src/buckets.ts` | records the start-edge OK/KO split |
| `packages/persistence/src/metrics/{read,write}.ts` | persists and reads the two new counters |
| `apps/api/src/metrics/metrics.controller.ts` | populates `bucketWidthMs` and `startedSplitAvailable` |
| `apps/web/src/charts/echarts.ts` | the ONLY module importing `echarts/core`; registers what is used |
| `apps/web/src/charts/theme.ts` | token-driven light/dark theme + validated categorical palette |
| `apps/web/src/charts/Chart.tsx` | SVG render, resize, empty state, crosshair group, table slot |
| `apps/web/src/charts/DataTable.tsx` | the accessible data table + its toggle |
| `apps/web/src/charts/transforms/*.ts` | pure: contract payload → `{ series, axis, tableRows }` |
| `apps/web/src/charts/*Chart.tsx` | one component per chart, composing a transform with `Chart` |
| `apps/web/src/api/metrics.ts` | the four fetchers and their query keys |
| `apps/web/src/routes/RunDetail.tsx` | mounts the chart stack below the assertions panel |

**Shared types**, defined in Task 4 and used by every chart task:

```ts
export interface ChartTableRow { readonly label: string; readonly values: readonly (string | number)[]; }
export interface ChartData {
  readonly series: readonly { name: string; data: readonly (number | null)[] | readonly [number, number][] }[];
  readonly axisLabels: readonly (string | number)[];
  readonly columns: readonly string[];
  readonly rows: readonly ChartTableRow[];
  readonly empty?: string;
}
```

Every transform returns `ChartData`. `rows` and `columns` are what `DataTable` renders and what the parity tests read.

---

### Task 1: `bucketWidthMs` on the series response

**Files:**
- Modify: `packages/contracts/src/metrics.ts`
- Modify: `apps/api/src/metrics/metrics.controller.ts:145-160`
- Test: `apps/api/test/parity-endpoints.integration.test.ts`

**Interfaces:**
- Produces: `SeriesResponse.bucketWidthMs: number`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/parity-endpoints.integration.test.ts` (follow the file's existing setup for ingesting a run and getting a read token):

```ts
it('reports the bucket width, so a client never assumes 1000ms', async () => {
  const res = await request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}/series?scope=run&name=`)
    .set('Authorization', `Bearer ${ctx.readToken}`);

  expect(res.status).toBe(200);
  expect(res.body.bucketWidthMs).toBe(1000);

  // The width must be the SMALLEST positive gap, not the first: a bucket with
  // no observations is absent, so consecutive offsets can be two widths apart.
  const offsets: number[] = res.body.buckets.map((b: { startOffsetMs: number }) => b.startOffsetMs);
  const gaps = offsets.slice(1).map((o, i) => o - (offsets[i] as number)).filter((g) => g > 0);
  expect(res.body.bucketWidthMs).toBe(Math.min(...gaps));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `DATABASE_URL=... pnpm test:integration -- -t 'reports the bucket width'`
Expected: FAIL — `bucketWidthMs` is `undefined`.

- [ ] **Step 3: Add the contract field**

In `packages/contracts/src/metrics.ts`, inside `SeriesResponseSchema`:

```ts
  /**
   * The width of every bucket in this response. NOT always 1000: BucketSeries
   * halves resolution in place once a run exceeds its bucket cap, and the
   * width is not stored, so the server recovers it with inferBucketWidthMs.
   *
   * Sent because requests/s and responses/s are RATES. A client that assumed
   * 1000ms would scale every point by a power of two on a long run — and
   * because every bucket scales equally, the curve's shape is unchanged and
   * nothing looks wrong.
   */
  bucketWidthMs: z.number().int().positive(),
```

- [ ] **Step 4: Populate it**

In `apps/api/src/metrics/metrics.controller.ts`, import `inferBucketWidthMs` from `@perfportal/statistics` (already imported in `parity.controller.ts`, same package) and return:

```ts
    return {
      runId: run.id,
      scope: scope as SeriesResponse['scope'],
      name,
      bucketWidthMs: inferBucketWidthMs(buckets.map((b) => b.startOffsetMs)),
      buckets,
    };
```

- [ ] **Step 5: Run the test and the whole integration suite**

Run: `pnpm test:integration`
Expected: PASS, and no other test broken — the field is additive.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics.ts apps/api/src/metrics/metrics.controller.ts apps/api/test/parity-endpoints.integration.test.ts
git commit -m "feat(api): report the series bucket width so clients never assume 1000ms"
```

---

### Task 2: the requests/s OK/KO split

**Files:**
- Modify: `packages/statistics/src/buckets.ts`
- Modify: `packages/persistence/prisma/schema.prisma:156-177`
- Create: `packages/persistence/prisma/migrations/20260813120000_started_status_counts/migration.sql`
- Modify: `packages/persistence/src/metrics/write.ts`, `packages/persistence/src/metrics/read.ts`
- Modify: `packages/contracts/src/metrics.ts`, `apps/api/src/metrics/metrics.controller.ts`
- Test: `packages/statistics/test/buckets.test.ts`, `apps/api/test/parity-endpoints.integration.test.ts`

**Interfaces:**
- Consumes: `SeriesResponse.bucketWidthMs` (Task 1)
- Produces: `SeriesBucket.startedOkCount`/`startedKoCount` (`number`), `SeriesResponse.startedSplitAvailable: boolean`

Read spec §3b first. `okCount`/`koCount` are the **end**-edge split and belong to responses/s. Requests/s needs the **start**-edge split, which nothing records.

- [ ] **Step 1: Write the failing unit test**

Add to `packages/statistics/test/buckets.test.ts`:

```ts
it('splits started requests by outcome on the START edge, not the end', () => {
  const s = new BucketSeries({ startMs: 0, maxBuckets: 64 });
  // Starts in bucket 0, ends in bucket 1 — Gatling files it under bucket 0.
  s.add(900, 120, false, 'start');
  s.add(1100, 120, false, 'end');
  s.add(100, 50, true, 'start');
  s.add(150, 50, true, 'end');

  const b = s.buckets();
  expect(b[0]!.startedCount).toBe(2);
  expect(b[0]!.startedOkCount).toBe(1);
  expect(b[0]!.startedKoCount).toBe(1);
  // The KO ENDED in bucket 1, so the end-edge split must not have moved.
  expect(b[0]!.koCount).toBe(0);
  expect(b[1]!.koCount).toBe(1);
});
```

The API is `add(tsMs, value, ok, edge)` on a `BucketSeries({ startMs, maxBuckets })`,
and `buckets()` returns the array — see `packages/statistics/test/buckets.test.ts`
for the established calling pattern (one `add()` per edge, same value/ok on both).

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:unit -- -t 'splits started requests by outcome'`
Expected: FAIL — `startedOkCount` is `undefined`.

- [ ] **Step 3: Record the split**

In `packages/statistics/src/buckets.ts`: add `startedOkCount: number; startedKoCount: number;` to the bucket type, `startedOkCount: 0, startedKoCount: 0` to the initialiser, and in the `edge === 'start'` branch, beside `b.startedCount++`:

```ts
      // The START-edge split. okCount/koCount below are the END-edge split and
      // belong to responses/s; requests/s is bucketed by start time, exactly
      // like the sketches immediately below (G-23).
      if (ok) b.startedOkCount++; else b.startedKoCount++;
```

Add both to `#coalesce`'s summation beside `target.okCount += b.okCount`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm test:unit -- -t 'splits started requests by outcome'`
Expected: PASS.

- [ ] **Step 5: Migrate, persist and read**

`schema.prisma`, in `RunSeriesBucket`:

```prisma
  startedOkCount Int? @map("started_ok_count")
  startedKoCount Int? @map("started_ko_count")
```

`migrations/20260813120000_started_status_counts/migration.sql`:

```sql
-- Appendix A G-23 requires requests/s to draw All/OK/KO, and the real Gatling
-- report does. ok_count/ko_count are incremented on the END edge, so they are
-- the responses/s split; nothing recorded the outcome against the START
-- bucket.
--
-- Nullable, following percentiles_ok/percentiles_ko: rows written before this
-- migration have no start-edge split, and the reader reports it as unavailable
-- rather than as zero. Two flat zero lines would read as "no failures"; the
-- truth is "not recorded".
ALTER TABLE "run_series_bucket" ADD COLUMN "started_ok_count" INTEGER;
ALTER TABLE "run_series_bucket" ADD COLUMN "started_ko_count" INTEGER;
```

Write both columns in `write.ts` beside `started_count`. In `read.ts`, return them as-is (`null` stays `null`).

- [ ] **Step 6: Surface availability on the response**

`packages/contracts/src/metrics.ts` — in `SeriesBucketSchema`:

```ts
  /** START-edge outcome split (G-23). Null for runs ingested before the
   *  migration that added it; see startedSplitAvailable. */
  startedOkCount: z.number().int().nullable(),
  startedKoCount: z.number().int().nullable(),
```

and in `SeriesResponseSchema`:

```ts
  /**
   * False for runs ingested before the start-edge split existed. Their
   * requests/s chart draws the All series alone and says why — it never draws
   * two zero lines, which would read as "no failures" rather than "not
   * recorded". Mirrors StatsResponse.configurable.
   */
  startedSplitAvailable: z.boolean(),
```

In the controller, derive it from the data rather than a guess:

```ts
      startedSplitAvailable: buckets.length > 0 && buckets.every((b) => b.startedOkCount !== null),
```

- [ ] **Step 7: Write the integration test**

```ts
it('splits started requests by outcome, and the split sums to startedCount', async () => {
  const res = await request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}/series?scope=run&name=`)
    .set('Authorization', `Bearer ${ctx.readToken}`);

  expect(res.body.startedSplitAvailable).toBe(true);
  for (const b of res.body.buckets as { startedCount: number; startedOkCount: number; startedKoCount: number }[]) {
    expect(b.startedOkCount + b.startedKoCount).toBe(b.startedCount);
  }
});
```

- [ ] **Step 8: Migrate and run everything**

```bash
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
pnpm test:unit && pnpm test:integration
```
Expected: all green.

- [ ] **Step 9: Falsification checkpoint**

Move `if (ok) b.startedOkCount++; else b.startedKoCount++;` into the `else` (end-edge) branch. Re-run.
Expected: **"splits started requests by outcome, and the split sums to startedCount" FAILS.** Paste the output. Restore and verify byte-identical.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(statistics): record the start-edge outcome split for requests/s"
```

---

### Task 3: a DOM test environment, proven by closing a known gap

**Files:**
- Modify: `apps/web/package.json`, `vitest.config.ts`
- Create: `apps/web/test/RunDetail.polling.test.tsx`

**Interfaces:**
- Produces: `*.test.tsx` under `apps/web/test/` runs in jsdom with `@testing-library/react`.

The previous sub-project left the run detail polling cap's wiring untested because no DOM environment existed. It exists now, so close it — and closing a *known, currently-failing-to-be-covered* gap is how we prove the environment actually works, rather than asserting it does.

- [ ] **Step 1: Add the dependencies (exact pins)**

In `apps/web/package.json` `devDependencies`, and then `. "$HOME/.nvm/nvm.sh" && nvm use && pnpm install`:

```json
    "@testing-library/react": "16.3.0",
    "jsdom": "26.1.0",
```

Use whatever exact versions `pnpm view <pkg> version` reports at implementation time; record them in the report. No `^`, no `~`.

- [ ] **Step 2: Route `.tsx` tests to jsdom**

In `vitest.config.ts`, extend `test.include` to `['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx']` and add:

```ts
    environmentMatchGlobs: [['apps/web/test/**/*.test.tsx', 'jsdom']],
```

Node stays the default, so the 218 existing tests are untouched.

- [ ] **Step 3: Write the failing test**

`apps/web/test/RunDetail.polling.test.tsx` — the cap UI must appear once `POLL_CAP_MS` elapses:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POLL_CAP_MS } from '../src/api/run.js';
import RunDetail from '../src/routes/RunDetail.js';

vi.mock('../src/api/run.js', async (orig) => ({
  ...(await orig<typeof import('../src/api/run.js')>()),
  // A run that never settles, so the cap is the only thing that can stop it.
  fetchRun: vi.fn(async () => ({
    state: 'processing' as const,
    run: { id: RUN_ID, status: 'pending' as const, statusUrl: `/v1/runs/${RUN_ID}` },
  })),
}));

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes><Route path="/runs/:runId" element={<RunDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('stops polling and says so once the cap elapses', async () => {
  renderDetail();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.queryByText(/stopped checking automatically/i)).toBeNull();

  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_CAP_MS + 1); });
  expect(screen.getByText(/stopped checking automatically/i)).not.toBeNull();
});
```

Read `apps/web/src/routes/RunDetail.tsx` and `apps/web/src/api/run.ts` first and
match the real export names, the real cap copy, and whether `POLL_CAP_MS` is
exported — export it if it is not. If the component's default export differs,
follow the file, not this snippet.

Read `apps/web/src/routes/RunDetail.tsx` for the real copy and export shape, and mock `fetchRun` to resolve `{ state: 'processing', run: { id, status: 'pending', statusUrl } }`. Match the assertion text to what the component actually renders.

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm test:unit -- RunDetail.polling`
Expected: FAIL — the cap copy is absent, because the effect that sets `capReached` is what this test exists to cover.

- [ ] **Step 5: Make it pass**

The production code is already correct — the test should pass once rendering works. If it does not, fix the test, not the component, unless you find a real defect; if you do, report it.

- [ ] **Step 6: Falsification checkpoint**

Delete the `useEffect` that sets `capReached` in `RunDetail.tsx`. Re-run.
Expected: **the new test FAILS.** This is the assertion the previous sub-project could not write. Paste the output, restore, verify byte-identical.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml vitest.config.ts apps/web/test/RunDetail.polling.test.tsx
git commit -m "test(web): a DOM environment, and the polling cap's wiring finally covered"
```

---

### Task 4: chart foundation

**Files:**
- Create: `apps/web/src/charts/echarts.ts`, `theme.ts`, `Chart.tsx`, `DataTable.tsx`, `types.ts`
- Create: `apps/web/src/api/metrics.ts`
- Create: `scripts/capture-chart-fixture.mjs`, `apps/web/test/fixtures/reference-run.json`
- Test: `apps/web/test/DataTable.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` and `ProblemError` from `apps/web/src/api/fetch.ts`; `runQueryKey` from `apps/web/src/api/run.ts`
- Produces: `ChartData`/`ChartTableRow` (see File Structure); `<Chart id title data group? yAxis? />`; `statsQuery/seriesQuery/usersQuery/distributionQuery` options factories

- [ ] **Step 1: Add ECharts (exact pin) and register only what is used**

`apps/web/src/charts/echarts.ts`:

```ts
// The ONLY module importing from echarts/core. Registration is centralised so
// the bundle cost of a new chart type is one visible line in one diff.
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent, AxisPointerComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, AxisPointerComponent, SVGRenderer]);
export { echarts };
```

SVG, not canvas: marks become real DOM nodes.

- [ ] **Step 2: Build the palette and VALIDATE it**

`apps/web/src/charts/theme.ts` exports `CATEGORICAL` and a `chartTheme(mode)` reading ink/grid tokens from `tokens.css`. Start from the Okabe–Ito set, which is colourblind-safe by construction:

```ts
export const CATEGORICAL = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00'] as const;
```

Then **run the validator** — do not judge this by eye:

```bash
node ~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/dataviz/scripts/validate_palette.js \
  "#0072B2,#E69F00,#009E73,#CC79A7,#56B4E9,#D55E00" --mode light
# then --mode dark
```

Fix anything that FAILs and re-run. Paste both reports into the task report. Add the passing values to `tokens.css` as `--chart-1…--chart-6` for light and dark, and read them from there.

- [ ] **Step 3: Write the failing DataTable test**

`apps/web/test/DataTable.test.tsx`:

```tsx
it('renders every plotted value, and the toggle reveals it', async () => {
  render(<DataTable id="demo" columns={['t', 'ok']} rows={[{ label: '0', values: [0, 12] }]} />);
  const table = screen.getByTestId('chart-data-demo');
  // Always in the DOM — this is the parity surface, readable whether or not
  // it is visible, and the same numbers a screen-reader user receives.
  expect(table.textContent).toContain('12');
  expect(table).not.toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /show data table/i }));
  expect(table).toBeVisible();
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm test:unit -- DataTable`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `DataTable` and `Chart`**

`DataTable.tsx`: a real `<table>` with `<caption>` and `<th scope="col">`, wrapped in an element that is visually hidden until toggled, carrying `data-testid={`chart-data-${id}`}`.

`Chart.tsx`: takes `{ id, title, data, group?, yAxis? }`, renders `<figure>` with an `<h3>` title, the ECharts container, and `<DataTable/>`. It must:
- render `data.empty` as an explanation instead of an empty chart when set;
- register `group` via `echarts.connect(group)` so time-linked charts share one crosshair;
- show a legend only when `data.series.length >= 2`;
- resize with a `ResizeObserver`, disposing on unmount.

- [ ] **Step 6: Add the four query factories**

`apps/web/src/api/metrics.ts` — one per endpoint, e.g.:

```ts
export const seriesQueryKey = (id: string, scope = 'run', name = '') => ['run', id, 'series', scope, name] as const;
export const seriesQuery = (id: string) => ({
  queryKey: seriesQueryKey(id),
  queryFn: () => apiFetch(SeriesResponseSchema, `/v1/runs/${id}/series?scope=run&name=`),
});
```

Same shape for `statsQuery`, `usersQuery`, `distributionQuery`.

- [ ] **Step 7: Capture the payload fixture**

`scripts/capture-chart-fixture.mjs` ingests the reference bundle, then writes the four raw payloads to `apps/web/test/fixtures/reference-run.json`. Transform unit tests read that file, so they run against the same bytes the browser receives rather than hand-written approximations. Document in the script header how to re-capture it.

- [ ] **Step 8: Verify green**

Run: `pnpm test:unit && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): chart foundation — ECharts SVG, validated palette, data tables"
```

---

### Task 5: indicators and the request-count donut

**Files:**
- Create: `apps/web/src/charts/transforms/indicators.ts`, `apps/web/src/charts/IndicatorsChart.tsx`, `RequestCountChart.tsx`
- Test: `apps/web/test/transforms.indicators.test.ts`

**Interfaces:**
- Consumes: `ChartData`, `Chart`, `statsQuery`
- Produces: `toIndicators(stats: StatsResponse): ChartData`, `toRequestCounts(stats: StatsResponse): ChartData`

G-06…G-09 are the four bands; G-10 is the OK/KO donut with totals.

- [ ] **Step 1: Write the failing tests**

```ts
import fixture from './fixtures/reference-run.json';

it('labels the bands with the bounds that produced them', () => {
  const d = toIndicators(fixture.stats as StatsResponse);
  expect(d.columns).toEqual(['Band', 'Count', 'Percent']);
  expect(d.rows.map((r) => r.label)).toEqual([
    't < 800 ms', '800 ms <= t < 1200 ms', 't >= 1200 ms', 'failed',
  ]);
});

it('says so when the bands are not configurable, instead of offering a control that would do nothing', () => {
  const d = toIndicators({ ...(fixture.stats as StatsResponse), configurable: false });
  expect(d.empty ?? d.rows[0]!.label).toBeDefined();
  expect(JSON.stringify(d)).toMatch(/fixed|not configurable/i);
});

it('the four bands account for every request', () => {
  const s = fixture.stats as StatsResponse;
  const total = s.indicators.under + s.indicators.between + s.indicators.over + s.indicators.failed;
  const run = s.stats.find((r) => r.scope === 'run')!;
  expect(total).toBe(run.count);
});
```

Band labels come from `stats.bounds.lowerMs`/`higherMs` — never from a constant.

- [ ] **Step 2: Run and confirm they fail.** `pnpm test:unit -- transforms.indicators`

- [ ] **Step 3: Implement the transforms and both components**

Indicators: a horizontal stacked bar plus counts and percentages, band colours from the status tokens (`passed`/`pending`/`failed`), never from `CATEGORICAL`. Donut: OK vs KO with totals and percentage.

- [ ] **Step 4: Verify green.** `pnpm test:unit -- transforms.indicators`

- [ ] **Step 5: Falsification checkpoint**

Hard-code the band labels to `800`/`1200` instead of reading `stats.bounds`, and run against a fixture whose bounds differ.
Expected: **"labels the bands with the bounds that produced them" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): indicator bands and the request-count donut"
```

---

### Task 6: concurrent users and users started per second

**Files:**
- Create: `apps/web/src/charts/transforms/users.ts`, `apps/web/src/charts/UsersChart.tsx`
- Test: `apps/web/test/transforms.users.test.ts`

**Interfaces:**
- Produces: `toConcurrentUsers(u: UsersResponse): ChartData`, `toUserStartRate(u: UsersResponse): ChartData`

⑦ plots `maxConcurrent`. ⑦ᵇ plots `started`. They are different questions: a constant arrival rate produces a *rising* concurrency curve when the service slows, and that divergence is the signal. Plotting the same field twice destroys it while producing two charts that each look right.

- [ ] **Step 1: Write the failing tests**

```ts
it('plots concurrency and arrival rate from DIFFERENT fields', () => {
  const u = fixture.users as UsersResponse;
  const conc = toConcurrentUsers(u);
  const rate = toUserStartRate(u);
  // Series order is [...scenarios, total], so the total is always last.
  const total = (d: ChartData) => d.series.at(-1)!.data as readonly (number | null)[];
  // Not merely "not deepEqual": these must come from maxConcurrent and started
  // respectively, and the fixture has buckets where those differ.
  expect(total(conc)).toEqual(u.total.map((b) => b.maxConcurrent));
  expect(total(rate)).toEqual(u.total.map((b) => b.started));
  expect(total(conc)).not.toEqual(total(rate));
});

it('uses the API total rather than recomputing it', () => {
  // Gatling's own "All users" series is the SUM of per-scenario maxima,
  // verified across all 63 fixture buckets — even though max(a+b) != max(a)+max(b).
  const u = fixture.users as UsersResponse;
  expect(toConcurrentUsers(u).series.at(-1)!.data).toEqual(u.total.map((b) => b.maxConcurrent));
});

it('draws one series per scenario plus the total', () => {
  const u = fixture.users as UsersResponse;
  expect(toConcurrentUsers(u).series).toHaveLength(u.scenarios.length + 1);
});
```

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement both transforms and the component.**

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

In `toConcurrentUsers`, read `started` instead of `maxConcurrent`.
Expected: **"plots concurrency and arrival rate from DIFFERENT fields" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): concurrent users and user arrival rate as distinct charts"
```

---

### Task 7: response time distribution

**Files:**
- Create: `apps/web/src/charts/transforms/distribution.ts`, `apps/web/src/charts/DistributionChart.tsx`
- Test: `apps/web/test/transforms.distribution.test.ts`

**Interfaces:**
- Produces: `toDistribution(d: DistributionResponse): ChartData`

- [ ] **Step 1: Write the failing tests**

```ts
it('draws OK and KO as distinct series', () => {
  const d = toDistribution(fixture.distribution as DistributionResponse);
  expect(d.series.map((s) => s.name)).toEqual(['OK', 'KO']);
});

it('keeps the API percentages, which are of the COMBINED total', () => {
  const src = fixture.distribution as DistributionResponse;
  const d = toDistribution(src);
  // okPercent and koPercent together sum to 100 (A.9 F-8). Renormalising
  // either one independently would make each series sum to 100 instead.
  const sum = src.okPercent.reduce((a, b) => a + b, 0) + src.koPercent.reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(100, 1);
  expect(d.rows[0]!.values).toContain(src.okPercent[0]);
});

it('says when bins are incomplete rather than drawing a truncated distribution', () => {
  const d = toDistribution({ ...(fixture.distribution as DistributionResponse), overflowCount: 7 });
  expect(JSON.stringify(d)).toMatch(/exceeded|incomplete|overflow/i);
});
```

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement.** Labels are bucket **midpoints**; when `exactValues` is true they are exact values and the axis must say so.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

Drop the KO series from the transform.
Expected: **"draws OK and KO as distinct series" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): response time distribution, OK and KO"
```

---

### Task 8: response time percentiles over time

**Files:**
- Create: `apps/web/src/charts/transforms/percentiles.ts`, `apps/web/src/charts/PercentilesChart.tsx`
- Test: `apps/web/test/transforms.percentiles.test.ts`

**Interfaces:**
- Consumes: `SeriesResponse`
- Produces: `BANDS` (the ten), `toPercentiles(s: SeriesResponse, bands?: readonly string[]): ChartData`

- [ ] **Step 1: Write the failing tests**

`transforms/percentiles.ts` exports the band list; the test imports it rather
than restating it, so a change to the set cannot leave a stale copy asserting
the old one:

```ts
import { BANDS, toPercentiles } from '../src/charts/transforms/percentiles.js';
// BANDS = ['min','p25','p50','p75','p80','p85','p90','p95','p99','max']

it('draws exactly the ten bands Gatling draws (D-7)', () => {
  const d = toPercentiles(fixture.series as SeriesResponse);
  expect(d.series.map((s) => s.name)).toEqual([...BANDS]);
  // The PRD names a 98th and a 99.9th; neither exists in the data or in the
  // real Gatling report.
  expect(d.series.map((s) => s.name)).not.toContain('p98');
});

it('uses the OK-ONLY percentiles (G-22)', () => {
  const src = fixture.series as SeriesResponse;
  const d = toPercentiles(src);

  // p50, NOT p95. MEASURED against the captured fixture: percentilesOk and
  // percentiles are IDENTICAL in all 62 buckets at p95 and p99 — 24 KO out of
  // 895 requests never move the 95th — so an assertion on p95 passes just as
  // happily against the combined set, and falsification checkpoint 1 would
  // stay green with the bug present. p50 differs in 8 of 62 buckets.
  //   p25: 3   p50: 8   p75: 3   p80: 3   p85: 1   p90: 1   p95: 0   p99: 0
  const p50 = d.series.find((s) => s.name === 'p50')!.data;
  expect(p50).toEqual(src.buckets.map((b) => b.percentilesOk.p50 ?? null));
  // The combined set is a different, entirely plausible-looking curve.
  expect(p50).not.toEqual(src.buckets.map((b) => b.percentiles.p50 ?? null));

  // The discrimination above is only load-bearing while the fixture actually
  // contains buckets where the two disagree. If it is ever recaptured from a
  // run without failures, this says so instead of going quietly vacuous.
  const disagreeing = src.buckets.filter((b) => b.percentilesOk.p50 !== b.percentiles.p50);
  expect(disagreeing.length).toBeGreaterThan(0);
});

it('honours a band subset, for the selector', () => {
  const d = toPercentiles(fixture.series as SeriesResponse, ['p50', 'p95']);
  expect(d.series.map((s) => s.name)).toEqual(['p50', 'p95']);
});
```

If the fixture's OK-only and combined p95 happen to be equal in every bucket, the second test cannot discriminate — assert on a bucket where they differ, and if none exists, say so in the report rather than leaving a test that cannot fail.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement**, plus the component with a **log Y default and a linear toggle**, and the band selector over the ten bands.

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoint**

Change `percentilesOk` to `percentiles` in the transform.
Expected: **"uses the OK-ONLY percentiles (G-22)" FAILS.** Paste, restore, verify.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): response time percentiles over time, OK-only, log scale"
```

---

### Task 9: requests/s and responses/s

**Files:**
- Create: `apps/web/src/charts/transforms/rates.ts`, `apps/web/src/charts/RatesChart.tsx`
- Test: `apps/web/test/transforms.rates.test.ts`

**Interfaces:**
- Consumes: `SeriesResponse.bucketWidthMs` (Task 1), `startedOkCount`/`startedKoCount`/`startedSplitAvailable` (Task 2)
- Produces: `toRequestRate(s: SeriesResponse): ChartData`, `toResponseRate(s: SeriesResponse): ChartData`

Requests/s is bucketed by **start** time and splits via `startedOkCount`/`startedKoCount`. Responses/s is bucketed by **end** time and splits via `okCount`/`koCount`. Do not cross them.

- [ ] **Step 1: Write the failing tests**

```ts
it('divides by the reported bucket width, never a hard-coded 1000', () => {
  const src = { ...(fixture.series as SeriesResponse), bucketWidthMs: 2000 };
  const d = toRequestRate(src);
  expect(d.series[0]!.data[0]).toBeCloseTo((src.buckets[0]!.startedCount) / 2, 6);
});

it('splits requests/s on the START edge and responses/s on the END edge', () => {
  const src = fixture.series as SeriesResponse;
  const req = toRequestRate(src);
  const res = toResponseRate(src);
  expect(req.series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);
  expect(res.series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);
  const w = src.bucketWidthMs / 1000;
  expect(req.series[1]!.data[0]).toBeCloseTo((src.buckets[0]!.startedOkCount ?? 0) / w, 6);
  expect(res.series[1]!.data[0]).toBeCloseTo(src.buckets[0]!.okCount / w, 6);
});

it('draws All alone and explains, when the split was never recorded', () => {
  const src = { ...(fixture.series as SeriesResponse), startedSplitAvailable: false };
  const d = toRequestRate(src);
  expect(d.series.map((s) => s.name)).toEqual(['All']);
  // Two flat zero lines would read as "no failures"; the truth is "not recorded".
  expect(JSON.stringify(d)).toMatch(/not recorded|unavailable/i);
});
```

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement both transforms and the component.**

- [ ] **Step 4: Verify green.**

- [ ] **Step 5: Falsification checkpoints (two)**

(a) Divide by a hard-coded `1000`. Expected: **"divides by the reported bucket width" FAILS.**
(b) Return zeroed OK/KO series when `startedSplitAvailable` is false. Expected: **"draws All alone and explains" FAILS.**
Paste both, restore each, verify byte-identical.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): requests/s and responses/s, split on the correct edge"
```

---

### Task 10: assemble the page, link the crosshair, prove it in a browser

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx`
- Create: `apps/web/e2e/run-charts.spec.ts`

**Interfaces:**
- Consumes: every chart component and query factory from Tasks 4–9

- [ ] **Step 1: Write the failing e2e tests**

```ts
import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData, seedPendingRun } from './fixtures.js';
import { signIn } from './helpers.js';

const CHART_IDS = [
  'indicators', 'request-counts', 'concurrent-users', 'user-start-rate',
  'distribution', 'percentiles', 'request-rate', 'response-rate',
] as const;

test('a completed run shows the eight overview charts', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  for (const id of CHART_IDS) {
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }
});

test("the rendered tables carry the API's own numbers", async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // Fetch through the page's own session, so this reads exactly what the
  // browser read — not a second request with different credentials.
  const series = await page.evaluate(async (id) => {
    const r = await fetch(`/v1/runs/${id}/series?scope=run&name=`, { credentials: 'same-origin' });
    return r.json();
  }, runId);

  await page.goto(`/runs/${runId}`);
  const table = page.getByTestId('chart-data-request-rate');
  await expect(table).toHaveCount(1);

  const perSecond = series.buckets[0].startedCount / (series.bucketWidthMs / 1000);
  // The table is the parity surface: the number a screen-reader user hears is
  // the number asserted here.
  expect(await table.textContent()).toContain(String(perSecond));
});

test('the time-linked charts share one crosshair', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  const users = page.getByTestId('chart-concurrent-users');
  await expect(users.locator('.echarts-axis-pointer, [class*="axisPointer"]')).toHaveCount(0);

  // Hovering requests/s must move the pointer on concurrent users too — that
  // linkage is why active users is its own chart rather than a second axis.
  await page.getByTestId('chart-request-rate').hover({ position: { x: 200, y: 60 } });
  await expect
    .poll(async () => users.locator('.echarts-axis-pointer, [class*="axisPointer"]').count())
    .toBeGreaterThan(0);
});

test('a chart with no data explains itself rather than showing empty axes', async ({ page }) => {
  const admin = await seedAdmin();
  // A pending run no worker will ever pick up: no series rows exist for it.
  const runId = await seedPendingRun(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByText(/no data|not been recorded|still processing/i).first()).toBeVisible();
});
```

If the axis-pointer selector above does not match what ECharts' SVG renderer
emits at the pinned version, find the real one by inspecting the rendered DOM
and use it — do not weaken the assertion to something that passes without the
linkage, which is the whole point of the test.

- [ ] **Step 2: Run and confirm they fail.**

```bash
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 \
       S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
npx playwright test --grep 'overview charts'
```

- [ ] **Step 3: Mount the chart stack**

In `RunDetail.tsx`, below `<Assertions/>`, render the eight charts in §13.2 order: indicators ③, request counts ④, concurrent users ⑦, user start rate ⑦ᵇ, distribution ⑧, percentiles ⑨, requests/s ⑩, responses/s ⑪. Give the four time-axis charts the same `group` so `echarts.connect` links them.

- [ ] **Step 4: Verify green** — the whole suite, sequentially.

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
npx playwright test
```

- [ ] **Step 5: Accessibility pass**

Confirm by inspection and record in the report: every chart has a `<figure>` with a title; legend present only for ≥ 2 series; no text wears a series colour; every chart's data table is reachable by its toggle; charts with no data explain themselves.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(web): the Gatling overview charts on the run detail page"
```

---

## Verification

**Definition of done:** a person opens a completed run and sees, below the assertions panel, the eight charts of the Gatling overview, reading the same numbers Gatling reports. The four time-axis charts share one crosshair. Every chart offers its data as a table. The palette passes the validator in both light and dark. `pnpm typecheck`, `pnpm lint`, the unit, integration and Playwright suites are all green.

**The falsification checkpoints are the point of this plan.** Each names a mutation and the test that must go red:

| Task | Break this | This must fail |
|---|---|---|
| 2 | record the started split on the end edge | the split sums to `startedCount` |
| 3 | delete the `capReached` effect | the polling cap test |
| 5 | hard-code the indicator band labels | bands are labelled with their bounds |
| 6 | plot `started` as concurrency | concurrency and arrival rate differ |
| 7 | drop the KO series | distribution draws OK and KO |
| 8 | use `percentiles` instead of `percentilesOk` | percentiles are OK-only |
| 9 | divide by a hard-coded 1000 | rates use the reported bucket width |
| 9 | zero the OK/KO series when unavailable | the chart says "not recorded" |

A checkpoint that stays green is a finding, not a formality. This project has shipped assertions that could not fail — including two guard shapes written by the controller — so break the code and watch the named test go red, every time.

**Out of scope, and must not appear in any diff:** the statistics table, the errors table, request/group/scenario detail pages, the latency family, trend strips, comparison, regression detection, live monitoring, saved views, custom dashboards, personalization, i18n mechanics, self-registration, and any RBAC affordance.
