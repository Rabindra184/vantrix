# Compare Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Compare tab to Gatling Enterprise's behaviour: eleven metrics with GE's table rows, a time-range slider that narrows chart, table and tiles, and a pinnable reference run — every figure exact.

**Architecture:** Two optional `percentiles` query parameters let `/stats` and `/series` answer any rank from the stored histograms. On the web, the overlay takes per-run point lists built from whichever endpoint the metric needs (`/series`, `/users`, `/agent/injectors`, `/telemetry`); the matrix becomes summary rows plus per-request rows with a change chip in every non-reference column; reference and window live in the URL (`ref`, `from`, `to`).

**Tech Stack:** NestJS + node-postgres (API), React 19 + TanStack Query + ECharts (web), zod contracts, vitest (unit + integration), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-03-compare-parity-design.md`

## Global Constraints

- Node 22 (`nvm use`); run every gate by its own exit code (CLAUDE.md "read each gate's own exit code").
- Every figure exact: a rank that cannot be computed is omitted, never guessed or zero.
- `percentiles` parameter: 1–12 finite numbers in the open interval (0, 100), comma-separated; else 400 `INVALID_QUERY` naming `percentiles`. Repeated parameter → `singleValue` refusal.
- Metric order in the selector, exactly: Concurrent users, CPU usage, Errors, p50, p90, p95, p99, p99.9, p99.99, max, Throughput. Default metric stays `p95`.
- URL: `metric`, `runs`, `ref` (run id), `from`/`to` (ms) — written with the page's existing `refine()` (keeps other params, `replace: true`).
- UI word for the reference run is **Reference** (replaces the "Baseline" chip). Pin button accessible name: `Set <run label> as reference`.
- Summary row labels: `All requests`, `Value`, `Count`, `Ratio`, `Max`, `Mean`.
- No new conditional spreads carrying object literals (eslint rule); no `[var(--…)]` utilities outside the token exemptions.
- Red-verify every new test against a mutation from a committed checkpoint (CLAUDE.md).

## Review Focus

1. **A run whose stats failed to load, or a `ref` naming it** — the page must fall back to the default reference, never compute changes against a missing column. (Task 4 test `falls back when the reference has no stats`.)
2. **A legacy estimated run with p99.9 selected** — its cells read `—`, never a sketch guess or zero, and the run's column is still drawn for other metrics. (Task 1 test `omits a rank an estimated row never stored`; Task 4 test `a null cell has no change chip`.)
3. **A window past one run's end** (runs of different lengths) — the shorter run's figures for the window are its own clamped slice, not 400s. (Task 2 test `a window past the run end clamps`; Task 6 test `clamps each run to its own duration`.)
4. **CPU selected and no run recorded it** — the chart says so for each run and draws nothing, the table rows read `—`. (Task 3 test `cpu with no source yields null`; Task 6 test `names every run without CPU`.)
5. **Reference equals the current run** — the summary tiles still state a change (first other selected run against the reference), never a self-comparison of 0%. (Task 5 test `reference is the current run`.)

---

### Task 1: `/stats?percentiles=` — answer any rank from the stored histograms

**Files:**
- Modify: `apps/api/src/common/validation.ts` (add the parser)
- Modify: `apps/api/src/metrics/metrics.controller.ts` (`stats`, `#windowedStats`)
- Modify: `apps/api/src/openapi/document.ts` (document the parameter on `/v1/runs/{id}/stats`)
- Test: `apps/api/test/percentile-list.test.ts` (new, unit), `apps/api/test/compare-percentiles.integration.test.ts` (new)

**Interfaces:**
- Produces: `parsePercentileList(name: string, raw: unknown): number[] | null` in `validation.ts` — `null` when `raw === undefined`; sorted ascending, de-duplicated; throws `badRequest('INVALID_QUERY', …)` otherwise (runs `singleValue` first).
- Produces: `GET /v1/runs/:id/stats?percentiles=90,99.9,99.99` → every row's `percentiles` map holds exactly those ranks (keys `p90`, `p99.9`, `p99.99`, the existing key spelling), unwindowed and windowed.

- [ ] **Step 1: Write the failing unit tests** in `percentile-list.test.ts`:
  - `parsePercentileList('percentiles', undefined)` → `null`
  - `'99.9,90,90'` → `[90, 99.9]`
  - each of `''`, `'0'`, `'100'`, `'abc'`, `'50,'`, thirteen ranks → throws with `code` `INVALID_QUERY` and the message naming `percentiles`
  - `['90','95']` (repeated param) → throws (the `singleValue` refusal)
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/percentile-list.test.ts` — FAIL (not exported).
- [ ] **Step 3: Implement `parsePercentileList`.**
- [ ] **Step 4: Write the failing integration tests** in `compare-percentiles.integration.test.ts` (seed with the reference bundle the way `read.integration.test.ts` does):
  - `answers p99.9 for the run row equal to the histogram's own nearest rank` — `stats?percentiles=99.9`, run row `percentiles['p99.9']` equals `mergedHistogram(ok, ko).percentiles([99.9])[0]` computed from the stored row (read via the persistence reader), and no `p95` key is present
  - `leaves every other field identical` — counts, mean, indicators equal the unparameterised response
  - `applies to a windowed read` — `?from=10000&to=40000&percentiles=90` run row has `p90` and equals the windowed rollup's own p90
  - `omits a rank an estimated row never stored` — flip the run row to a legacy estimated row (as `stored-percentiles` integration does) and assert `p99.9` absent
  - `refuses a malformed list` — `percentiles=0` → 400 `INVALID_QUERY`
- [ ] **Step 5: Run** them — FAIL.
- [ ] **Step 6: Implement:** `stats()` takes `@Query('percentiles') percentiles?: unknown`; `const set = parsePercentileList('percentiles', percentiles) ?? settings.percentiles;` used in place of `settings.percentiles` for `storedPercentiles` and passed to `#windowedStats` (whose `settings` argument gets `{ ...settings, percentiles: set }`). Add the query parameter to the OpenAPI operation (description: "Ranks to answer instead of the project's configured set, computed from the stored histograms").
- [ ] **Step 7: Run** unit + integration file + `apps/api/test/openapi.integration.test.ts` — PASS.
- [ ] **Step 8: Commit** `feat(api): answer any percentile rank on /stats`.

### Task 2: `/series?percentiles=` — extra ranks per bucket

**Files:**
- Modify: `packages/persistence/src/metrics/read.ts` (new SQL + reader method)
- Modify: `apps/api/src/metrics/metrics.controller.ts` (`series`)
- Modify: `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/compare-percentiles.integration.test.ts` (extend), `packages/persistence/test/metrics.integration.test.ts` (one case)

**Interfaces:**
- Consumes: `parsePercentileList` (Task 1).
- Produces: `export const SERIES_HISTOGRAMS_SQL` (same predicate and ordering as `SERIES_SQL`, selecting `start_offset_ms, histogram_ok, histogram_ko`) and `MetricsReader.seriesHistograms(scope: ProjectScope, runId: string, runStartedOn: Date, sel: { scope: string; name: string; family: string }): Promise<Map<number, { ok: Histogram; ko: Histogram } | null>>` (value `null` when either column is null).
- Produces: `GET /v1/runs/:id/series?…&percentiles=99.9,99.99` → each bucket's `percentiles`, `percentilesOk`, `percentilesKo` gain those keys, computed from the merged / OK / KO histogram respectively; stored keys untouched; buckets with a non-exact (`!h.exact`) or missing histogram get no extra keys; an empty population gets no key (never 0).

- [ ] **Step 1: Write failing tests:**
  - persistence: `seriesHistograms returns one entry per stored bucket, keyed by start offset`
  - API: `adds p99.9 to every bucket from its own histograms` (equal to `mergedHistogram(ok, ko).percentiles([99.9])[0]` per bucket); `keeps the stored p95 byte-identical`; `a window past the run end clamps` (`?from=0&to=999999&percentiles=99.9` → 200, buckets = the run's); `a failed-only bucket has KO ranks and no OK rank`
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the SQL, reader method and the controller merge (only query histograms when the parameter is present; use `Histogram#percentiles(set)` once per map).
- [ ] **Step 4: Run** the two files + `repositories.integration.test.ts` (plan guard over `SERIES_SQL` unchanged) — PASS.
- [ ] **Step 5: Commit** `feat(api): answer extra percentile ranks per series bucket`.

### Task 3: Compare metrics and overlay points

**Files:**
- Modify: `apps/web/src/charts/transforms/compare.ts`
- Modify: `apps/web/src/api/metricPaths.ts`, `apps/web/src/api/metrics.ts` (optional `percentiles` on `statsPath/statsQuery` and `seriesPath/seriesQuery`, included in query keys)
- Modify: `apps/web/src/routes/compareSelection.ts` (`parseCompareMetric` accepts the new values)
- Test: `apps/web/test/transforms.compare.test.ts`, `apps/web/test/compareSelection.test.ts`, `apps/web/test/metricPaths.test.ts`

**Interfaces:**
- Produces: `type CompareMetric = 'users' | 'cpu' | 'errors' | 'p50' | 'p90' | 'p95' | 'p99' | 'p99.9' | 'p99.99' | 'max' | 'throughput'`; `COMPARE_METRICS` in the Global Constraints order with labels `Concurrent users`, `CPU usage`, `Errors`, `50th percentile`, `90th percentile`, `95th percentile`, `99th percentile`, `99.9th percentile`, `99.99th percentile`, `Max response time`, `Throughput`.
- Produces: `EXTRA_RANKS: Partial<Record<CompareMetric, number>> = { 'p99.9': 99.9, 'p99.99': 99.99, p90: 90 }` (ranks the matrix must request on `/stats`; per-bucket only `p99.9`/`p99.99` need `/series?percentiles`, since p90 is stored).
- Produces: `compareUnit(metric): string` → `'ms' | '/s' | 'users' | '%'`; `isChangeGood(signedChange, metric): boolean | null` — `null` for `users` and `cpu` (neutral).
- Produces: `type ComparePoint = readonly [offsetMs: number, value: number]`; `interface CompareRun { id: string; label: string; points: readonly ComparePoint[] | null; bucketWidthMs: number | null }` (`points: null` = not recorded for this run).
- Produces: `seriesPoints(series: SeriesResponse, metric: CompareMetric): ComparePoint[]` (today's `valueOf` logic, new percentile keys read the same way); `usersPoints(users: UsersResponse): ComparePoint[]` (`total[].maxConcurrent`); `cpuPoints(injectors: AgentInjectorsResponse | null, telemetry: TelemetryResponse | null): ComparePoint[] | null` (injectors with `machine.available` → `cpuUserPct + cpuSysPct`, buckets where both null skipped; else telemetry hosts' `cpuTotalPct` averaged per `startOffsetMs` over non-null hosts; else `null`).
- Produces: `toCompare(runs: readonly CompareRun[], metric: CompareMetric): ChartData` — a run with `points === null` draws no series and adds `"<metric label> was not recorded for <run label>."` to `limitation`.

- [ ] **Step 1: Failing tests:** `seriesPoints` reads `p99.9` from a bucket map; `usersPoints` maps `maxConcurrent`; `cpuPoints` prefers injectors, falls back to telemetry averaging two hosts (`[10, 30]` → 20), `cpu with no source yields null`; `toCompare` names a run without CPU; `isChangeGood(+5,'users') === null`; `parseCompareMetric('p99.9') === 'p99.9'`, unknown → `'p95'`; `statsPath(id, null, [99.9])` ends with `percentiles=99.9` and `seriesPath(…, [99.9,99.99])` likewise.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement.** Existing `CompareChart` keeps compiling by passing points; update its call sites in Task 6.
- [ ] **Step 4: Run** — PASS. Then update the existing call sites in `RunCompare.tsx`, `buildCompareMatrix.ts` and `compareSummary.ts` just enough for `pnpm typecheck` to exit 0 (Tasks 4–6 replace them properly).
- [ ] **Step 5: Commit** `feat(web): compare metrics for p90, p99.9, p99.99, users and CPU`.

### Task 4: Matrix — GE rows, a change chip per column, a reference

**Files:**
- Modify: `apps/web/src/tables/buildCompareMatrix.ts`, `apps/web/src/tables/CompareMatrix.tsx`
- Test: `apps/web/test/buildCompareMatrix.test.ts`, `apps/web/test/CompareMatrix.test.tsx`

**Interfaces:**
- Consumes: `CompareMetric`, `isChangeGood` (Task 3).
- Produces: `interface CompareStats { id: string; label: string; exact: boolean; stats: StatsResponse | null; peakUsers: number | null; cpu: { mean: number; max: number } | null }` (the two new fields REQUIRED, no default; `stats: null` = the run has no figures for the chosen window, so every cell in its column is `null`).
- Produces: `resolveReference(runs: readonly CompareStats[], requested: string | null, currentRunId: string): string | null` — `requested` if it is a run in `runs`; else the first run whose id ≠ `currentRunId`; else `null`.
- Produces: `interface CompareCell { value: number; change: { absolute: number; percent: number | null; good: boolean | null } | null }`; `interface CompareRow { label: string; kind: 'summary' | 'request'; cells: (CompareCell | null)[] }`; `interface CompareMatrix { columns: { id: string; label: string; exact: boolean; reference: boolean }[]; rows: CompareRow[] }`.
- Produces: `toCompareMatrix(runs: readonly CompareStats[], metric: CompareMetric, referenceRunId: string | null): CompareMatrix` — columns ordered reference first, then the others in selection order; `change` on every non-reference cell whose reference cell exists. Rows per metric:
  - percentiles, `max`: summary `All requests` (run row) + one row per request (union, first-seen order, as today)
  - `throughput`: `Value` (run row `throughputRps`) + per-request `throughputRps`
  - `errors`: `Count` (run `koCount`), `Ratio` (run `errorRate`), + per-request `koCount`
  - `users`: `Max` (`peakUsers`) ; `cpu`: `Mean`, `Max` (`cpu.mean`, `cpu.max`)
- `metricValue(row, metric)` covers the new percentile keys; `figureIsExact`/`ESTIMATED_BY_SKETCH` gain the new metrics (percentiles true; users, cpu false).
- `CompareMatrix` props: `{ matrix: CompareMatrix; metric: CompareMetric; onReference: (id: string) => void }`. Reference column header highlighted (existing accent tint) with text `Reference`; each other header has an icon button (`MapPin` from `components/icons.tsx` — add it if absent) named `Set <label> as reference`. A change chip shows `+7.7%` / `−7.7%` / `=` with an arrow; good → passed tone, bad → failed tone, neutral (`good === null`) → muted. Units in headers as today (`compareUnit`); `Ratio` row formatted as a percentage.

- [ ] **Step 1: Failing tests (builder):** `orders the reference first`; `puts a change on every non-reference cell` (3 runs → 2 chips per row); `errors has Count and Ratio before the requests`; `users has a single Max row`; `cpu has Mean and Max`; `a null cell has no change chip`; `falls back when the reference has no stats` (`resolveReference` with an id not in runs → first non-current); `a zero reference has an absolute change and no percent`.
- [ ] **Step 2: Failing tests (component):** reference header reads `Reference`; pin button `Set Run 1 as reference` calls `onReference` with that id; the reference column has no pin button; neutral chip for `users` carries no good/bad colour class.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `feat(web): compare table with GE rows, per-column changes and a reference`.

### Task 5: Summary tiles follow the reference

**Files:**
- Modify: `apps/web/src/routes/compareSummary.ts`
- Test: `apps/web/test/compareSummary.test.ts`

**Interfaces:**
- Consumes: `CompareStats`, `toCompareMatrix`, `resolveReference` (Task 4).
- Produces: `buildCompareSummary(runs: readonly CompareStats[], currentRunId: string, referenceRunId: string | null, metric: CompareMetric): CompareSummaryModel` — value per run = that run's cell in the matrix's FIRST row (so tiles and table cannot disagree). Subject = current run, unless it IS the reference, in which case the first other selected run. `baselineLabel` keeps its name, holds the reference's label. `deltaGood` uses `isChangeGood` (may be `null`).

- [ ] **Step 1: Failing tests:** `compares the current run against a pinned reference`; `reference is the current run` (subject becomes the first other run, `deltaPercent` ≠ 0 for differing values); `uses the first matrix row` (errors → `Count`); `neutral for users`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): compare summary follows the reference`.

### Task 6: `RunCompare` wiring — metric data, reference, time range

**Files:**
- Modify: `apps/web/src/routes/RunCompare.tsx`, `apps/web/src/charts/CompareChart.tsx`, `apps/web/src/routes/compareSelection.ts`
- Test: `apps/web/test/RunCompare.test.tsx`, `apps/web/test/compareSelection.test.ts`

**Interfaces:**
- Consumes: everything above; `parseWindow`, `serialiseWindow`, `asWindow` from `routes/window.ts`; `Chart`'s `brush` prop; `usersQuery`, `agentInjectorsQuery`, `telemetryQuery`, `peakConcurrentUsers` (`routes/runUsers.ts`).
- Produces: `parseCompareReference(raw: string | null): string | null` (trims, empty → null) in `compareSelection.ts`.
- Behaviour:
  - Extent `extentMs` = max `durationMs` over the selected runs' cohort rows (`TrendRun.durationMs`), ignoring nulls; window = `parseWindow(params.get('from'), params.get('to'), extentMs)`. Each run's queries get the window clamped to its own duration (`parseWindow(from, to, run.durationMs)`), `null` when that yields null.
  - Always fetched per run: `statsQuery(id, window, extraRanks)` where `extraRanks` = `[EXTRA_RANKS[metric]]` when defined, else omitted. Overlay per metric: percentiles/max/throughput/errors → `seriesQuery(id,'run','','response_time',window, metric==='p99.9'||metric==='p99.99' ? [99.9,99.99] : undefined)`; `users` → `usersQuery(id, window)`; `cpu` → `agentInjectorsQuery(id, window)` and `telemetryQuery(id, window)`. Only the selected metric's overlay queries are enabled.
  - `CompareStats.peakUsers` from `usersQuery` (fetched only when metric is `users`, else `null`); `cpu` mean/max from `cpuPoints` values (fetched only when metric is `cpu`, else `null`).
  - `ref` read with `parseCompareReference`, resolved with `resolveReference`; pin writes `ref` via `refine`. Chip label `Reference` replaces `Baseline`.
  - `CompareChart` gains `window: Window | null`, `extentMs: number`, `onWindow: (w: Window | null) => void`; passes `brush={{ value: window, onChange: (f, t) => onWindow(asWindow(f, t, extentMs)) }}` to `Chart`, plus From/To number inputs (seconds) and a `Whole run` button beside the slider, the same controls `TimeBrush` uses (labels `From (s)`, `To (s)`). Writes `from`/`to` via `refine` using `serialiseWindow`.
- [ ] **Step 1: Failing tests (RunCompare):** `selector lists eleven metrics in GE order`; `pinning writes ref and moves the column`; `a ref outside the selection is ignored`; `typing From/To writes from and to and refetches stats with the window` (assert the stats request URL carries `from=` and `to=`); `p99.9 requests percentiles=99.9 on stats and 99.9,99.99 on series`; `names every run without CPU`; `clamps each run to its own duration` — runs of 60 s and 30 s, window 40–60 s: the 30 s run ended before the window, so no stats request is made for it, its column's cells read `—`, and the note `Run N ended before this window.` is shown (never its whole-run figures).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** A run whose own clamped window is empty (`from >= its duration`) gets `stats: null` for the window and is rendered as above. **Step 4: Run** — PASS, plus `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** `feat(web): compare reference, time range and per-metric data`.

### Task 7: Browser proof

**Files:**
- Modify: `apps/web/e2e/run-compare.spec.ts`

- [ ] **Step 1: Write e2e cases** (seed with `cohortOfTwo` as the file does):
  - `p99.9 on Compare equals the run's own /stats p99.9` — choose `99.9th percentile`; the `All requests` row's cell for each run equals `GET /v1/runs/<id>/stats?percentiles=99.9` run-row `p99.9` (fetched in the test with the page's session).
  - `pinning a run moves it first and keeps it in the URL` — click `Set <label> as reference`; first data column header reads that label and `Reference`; URL has `ref=`; reload keeps it.
  - `a time range narrows the table and survives a reload` — type From 10, To 40; URL has `from=10000&to=40000`; the `All requests` p95 differs from the whole-run value for at least one run; reload keeps the window.
- [ ] **Step 2: Run** `pnpm test:e2e apps/web/e2e/run-compare.spec.ts` against the scratch stack — PASS; red-verify each by a mutation (ignore `ref`; drop the window from the stats query; send no `percentiles`).
- [ ] **Step 3: Commit** `test(e2e): compare metrics, reference and time range`.

### Task 8: Record and real check

**Files:**
- Modify: `CLAUDE.md` (new entry at the top of Verification; floors)

- [ ] **Step 1:** Full gate on Node 22, scratch database and Redis index: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e --workers=2`, each by its own exit code; predict each total from per-file deltas first.
- [ ] **Step 2: Real check** (memory `verify-with-real-gatling-runs`): two real `ParitySimulation` runs of one test; open Compare in a browser at the API origin; for p99.9, the `All requests` cell per run equals `/stats?percentiles=99.9`; pin, narrow and reload; CPU shows the runner's figures or the not-recorded note.
- [ ] **Step 3:** Write the CLAUDE.md entry (what changed, rulings, red-verify table, what was run, known and left) and update the floors line.
- [ ] **Step 4: Commit** `docs: record the compare parity branch`.
