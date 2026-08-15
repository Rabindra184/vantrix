# Compare Runs (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put two to five runs of the same simulation on one axis — an overlay of any one metric, and a per-request matrix — so a regression can be attributed to a request rather than only observed.

**Architecture:** Entirely client-side. **No new endpoint**: `/series`, `/stats` and `/users` already exist, already have contracts, and are already cached per run, so a reader who has opened one of the selected runs pays nothing to include it. The selection lives in the URL. The overlay plots each run at its own elapsed offsets on a value x-axis.

**Tech Stack:** React 18.3.1, TypeScript, ECharts, TanStack Query, Zod contracts, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-15-cross-run-analysis-and-report-completeness-design.md` §1.3

## Sequencing — read this first

**This branch is cut from `main` and must not start until PR #23 (Trends) merges.** Two hard dependencies on it:

- `trendsQuery` is what lists the cohort, and the cohort is what the run picker offers. Compare cannot know which runs are comparable without it.
- The Compare route is reached from the Trends tab, because a comparison needs a selection and Trends is where the selection is made.

After #23 merges: `git switch feat/compare-runs && git merge main`. Do **not** stack this PR on `feat/trends` — `CLAUDE.md` documents the retarget trap that costs, and there is no reason to pay it when waiting is free.

## The spec is wrong about resampling, and this plan does not do it

§1.3 says: *"the transform must resample every selected run to the coarsest `bucketWidthMs` in the selection"*, on the grounds that overlaying a 1000 ms run on a 2000 ms one "silently misstates the shorter one's rate".

**Both halves of that are wrong, and the second is dangerous.**

**Rates are already normalised.** `transforms/rates.ts:150` computes `const perSecond = series.bucketWidthMs / 1000` and divides by it — a rate is a rate whatever the bucket width, and the contract's own comment on `bucketWidthMs` says this is exactly why the field is sent. There is nothing to correct.

**Percentiles cannot be resampled at all.** Merging two 1000 ms buckets into one 2000 ms bucket is sound for counts, which sum. It is *not* sound for percentiles: the 95th percentile of a union is not the mean, the max, or any function of the two buckets' 95th percentiles — recovering it needs the underlying sketches, and `SeriesBucket` carries quantiles, not sketches. Following the spec here would have produced a number that is wrong by an unbounded amount and looks entirely plausible on screen.

**What this plan does instead.** Each run plots at its own `startOffsetMs`, on a **value x-axis** — the one `ChartXAxis.type` gained in Phase 2 for the percentiles-distribution chart. Runs of different bucket widths become different point *densities* on a shared elapsed-time axis, which is honest and visible, and every point is a real measurement at a real time. Rates divide by each run's own width, exactly as `rates.ts` does.

Update the spec's §1.3 as part of Task 2.

## Global Constraints

- **Use the Node in `.nvmrc` (22).** On Node 20 the unit suite silently skips every jsdom file while printing a confident pass. `nvm use` first.
- **Every new e2e `getByRole(role, { name })` passes `exact: true`** — `ProjectRail` puts a link per project in every authenticated document.
- **No `uppercase` on anything queried by accessible name.**
- **No decorative `<svg>` inside a chart `<figure>`.**
- **Expectations are computed from the payload, never written down.**
- **Null is not zero.** A run absent from a bucket is a gap; a request absent from a run is `—`.
- **Verification gate**: `pnpm typecheck && pnpm lint && pnpm test:unit`, and before the plan is done also `pnpm test:integration && pnpm test:e2e`. Do not run integration immediately after e2e — see `CLAUDE.md`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/routes/compareSelection.ts` | Parse, validate and serialise `?runs=`. Pure. |
| `apps/web/src/charts/transforms/compare.ts` | N runs → one overlay `ChartData`. |
| `apps/web/src/tables/buildCompareMatrix.ts` | N runs' `/stats` → the per-request matrix. |
| `apps/web/src/routes/RunCompare.tsx` | Route: selection, fetching, layout. |
| `apps/web/src/charts/CompareChart.tsx` | The overlay figure and its metric selector. |
| `apps/web/src/tables/CompareMatrix.tsx` | The matrix table. |
| `apps/web/test/compareSelection.test.ts` | |
| `apps/web/test/transforms.compare.test.ts` | |
| `apps/web/test/buildCompareMatrix.test.ts` | |
| `apps/web/e2e/run-compare.spec.ts` | |

**Modified:** `apps/web/src/routes/paths.ts` (`runComparePath`), `apps/web/src/routes/RunTrends.tsx` (the entry point), `apps/web/src/App.tsx` (route).

---

## Task 1: The selection

`?runs=` is the whole state of this page, and it arrives from a URL bar. Pure, and tested before anything renders.

**Files:** create `apps/web/src/routes/compareSelection.ts`, `apps/web/test/compareSelection.test.ts`

**Interfaces:**
- Produces: `MAX_COMPARE = 5`, `parseCompareSelection(raw: string | null, cohort: readonly string[], current: string): string[]`, `serialiseCompareSelection(ids: readonly string[]): string`.

- [ ] **Step 1: Write the failing tests**

Cover, one case each:

1. **`null` yields the current run AND its nearest neighbour** — a page called
   Compare that opens with one run has answered nothing. The cohort is
   newest-first, so the neighbour is the NEXT index (older); the oldest run in
   a cohort falls back to the previous index (newer), because its only
   available comparison is against a later run and "was this ever fixed" is
   why someone opens an old run from a ticket.
2. **Ids outside the cohort are dropped.** A run of a different simulation is not comparable, and the picker never offers it; a hand-typed URL must not bypass that.
3. **The current run is always included, first**, even if `?runs=` omits it — this page is reached *from* a run and must not silently drop it.
4. **Duplicates collapse**, preserving first-seen order.
5. **More than `MAX_COMPARE` truncates** to the first five, and the caller can tell (see step 3's return shape note below — the count dropped is surfaced by the route, not swallowed).
6. **A malformed value falls back to the current run alone** rather than throwing — `safeNext`'s stance in `paths.ts`: the reader asked to compare, and a bad query string is no reason to refuse them.
7. **Round-trip**: `parse(serialise(ids), cohort, current)` is `ids`, for a valid selection.

Assert cohort membership with ids taken from a fixture-derived list, not literals.

- [ ] **Step 2: Run to verify they fail**

`pnpm vitest run apps/web/test/compareSelection.test.ts` — module not found.

- [ ] **Step 3: Write the module**

```ts
/** Five, because the overlay's palette has six hues and the axis needs one. */
export const MAX_COMPARE = 5;

/**
 * `?runs=` → the runs actually drawn.
 *
 * VALIDATED, NEVER TRUSTED. This is the one piece of page state a reader can
 * type, and every id in it is used to fetch. Membership of the cohort is the
 * real control: `/v1/runs/:id/*` is tenant-scoped, so a hostile id cannot read
 * another org's run — but a run of a DIFFERENT simulation is a different
 * question, and overlaying it would answer one nobody asked.
 *
 * A bad value falls back rather than throwing, exactly as `safeNext` does for
 * `?next=`: the reader asked to compare runs, and a malformed query string is
 * no reason to refuse them.
 */
export function parseCompareSelection(
  raw: string | null,
  cohort: readonly string[],
  current: string,
): string[] {
  const asked = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const allowed = new Set(cohort);

  // The current run first and always: this page is reached FROM it, and a URL
  // that omits it would compare a run against a set it is not in.
  const ordered = [current, ...asked];

  const out: string[] = [];
  for (const id of ordered) {
    if (out.length >= MAX_COMPARE) break;
    if (!allowed.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export const serialiseCompareSelection = (ids: readonly string[]): string => ids.join(',');
```

- [ ] **Step 4: Run to verify they pass**, then **Step 5: Commit.**

---

## Task 2: The overlay transform

**Files:** create `apps/web/src/charts/transforms/compare.ts`, `apps/web/test/transforms.compare.test.ts`; modify the spec's §1.3.

**Interfaces:**
- Consumes: `SeriesResponse` per run, plus each run's label.
- Produces: `COMPARE_METRICS` (the selector's options), `type CompareMetric`, and `toCompare(runs: readonly CompareSeries[], metric: CompareMetric): ChartData` where `CompareSeries = { id: string; label: string; series: SeriesResponse }`.

- [ ] **Step 1: Write the failing tests**

1. **One drawn series per run**, named by its label.
2. **Points are `[elapsedMs, value]` pairs** — the value-axis form, so runs of different durations and widths overlay at real times.
3. **A rate divides by that run's own `bucketWidthMs`.** Build two payloads from the same fixture buckets, one relabelled `bucketWidthMs: 2000`, and assert the 2000 ms run's throughput is *half* the 1000 ms run's at the same bucket — the misstatement the spec feared, shown not to occur.
4. **Percentiles are read, never merged.** Assert a point equals `bucket.percentilesOk[key]` exactly, for a bucket taken from the fixture.
5. **A bucket that measured nothing is a gap**, not a zero — keyed on the percentile map exactly as `transforms/percentiles.ts` argues.
6. **Runs of different lengths do not pad.** The shorter run's series simply ends; it must not be extended with zeros to the longer one's width.
7. **The empty selection explains itself.**
8. **A differing bucket width is stated** in `limitation`, since the densities will visibly differ.

- [ ] **Step 2: Verify they fail. Step 3: Write the transform.**

Metrics, and where each comes from — offer only what the payload really carries:

| Metric | Source |
|---|---|
| `p50` / `p95` / `p99` / `max` | `bucket.percentilesOk[key]`, and `maxMs` for max — OK-only, matching `PercentilesChart`'s default and G-22 |
| `throughput` | `(okCount + koCount) / (bucketWidthMs / 1000)` |
| `errors` | `koCount / (bucketWidthMs / 1000)` |

**Concurrent users is deliberately NOT offered.** It lives in `/users`, not `/series`, so including it would make the metric selector change which endpoints the page fetches — a second fetch shape for one option. Gatling offers it; we can add it when someone asks, against a real screen. YAGNI.

- [ ] **Step 4: Verify they pass.**

- [ ] **Step 5: Correct the spec**

Replace §1.3's resampling paragraph with the reasoning at the top of this plan: rates are already normalised by `bucketWidthMs`, percentiles cannot be resampled without the sketches, and the value x-axis is what makes differing widths honest. A spec left saying "resample" is a spec that will be followed next time.

- [ ] **Step 6: Commit.**

---

## Task 3: The per-request matrix

Requests down, runs across. This is what turns "run 7 got slower" into "`GET /cart` got slower in run 7".

**Files:** create `apps/web/src/tables/buildCompareMatrix.ts`, `apps/web/test/buildCompareMatrix.test.ts`

**Interfaces:**
- Produces: `toCompareMatrix(runs: readonly { id: string; label: string; stats: StatsResponse }[], metric: CompareMetric): { requests: string[]; cells: (number | null)[][] }`.

- [ ] **Step 1: Write the failing tests**

1. **Rows are the union of request names across every selected run**, sorted stably.
2. **A request absent from a run is `null`**, which the component renders `—`. It did not take zero milliseconds; it did not run.
3. **A request present in only the newest run still gets a row** — a newly added request is exactly what a reader is looking for.
4. **Cells read the request-scope rows**, not the run-scope total.
5. **Percentile metrics read `percentiles[key]`**; a run whose project configures a different set yields `null` for the missing key rather than a neighbouring percentile.

- [ ] **Step 2: Verify they fail. Step 3: Write it. Step 4: Verify they pass. Step 5: Commit.**

---

## Task 4: The route

**Files:** create `apps/web/src/routes/RunCompare.tsx`, `apps/web/src/charts/CompareChart.tsx`, `apps/web/src/tables/CompareMatrix.tsx`; modify `paths.ts`, `RunTrends.tsx`, `App.tsx`.

- [ ] **Step 1: Path and entry point**

```ts
export function runComparePath(runId: string, runs?: readonly string[]): string {
  const base = `${runPath(runId)}/compare`;
  return runs === undefined || runs.length === 0
    ? base
    : `${base}?runs=${encodeURIComponent(runs.join(','))}`;
}
```

`RunTrends.tsx` gains a **Compare runs** link, shown only when `cohortSize > 1` — a cohort of one has nothing to compare, and a control that is always present but never useful teaches a reader to ignore it.

- [ ] **Step 2: The route**

`useSearchParams` for `?runs=`; `trendsQuery(runId)` for the cohort; `parseCompareSelection` for the selection. Then **per selected run, in parallel**: `useQueries` over `seriesQuery(id)` and `statsQuery(id)`.

**Selection changes go through `setSearchParams`, not component state.** The URL is the state — a comparison someone assembled is a thing they will paste into a review comment, and state that lives only in a component cannot be pasted.

**Say what was dropped.** If the URL asked for more than five, or named ids outside the cohort, the page says so rather than silently drawing fewer runs than the reader requested.

- [ ] **Step 3: The charts**

`CompareChart` renders the metric selector and one `<Chart>` with `xAxis={{ type: 'value', name: 'Elapsed (s)' }}`, `kind="line"`, and no `group` — the axis is elapsed time *within different runs*, so a shared crosshair with a single run's charts would align two things that are not the same clock.

- [ ] **Step 4: Full unit gate. Step 5: Commit.**

---

## Task 5: e2e and the full gate

**Files:** create `apps/web/e2e/run-compare.spec.ts`

Two ingests of the reference bundle into one org give a cohort of two (`seedRunWithData` twice), which is the minimum that proves an overlay.

- [ ] **Step 1: Write the spec**

1. The route is reachable directly by URL, with `?runs=` naming both runs.
2. The overlay figure draws exactly one `<svg>`, and its data table carries a row per bucket.
3. **Two series are drawn** — read the legend, since one series would satisfy "a chart drew".
4. Changing the metric redraws without navigating away.
5. The matrix has a column per selected run and a row per request name.
6. An id outside the cohort in `?runs=` is dropped, and the page says so.

`exact: true` on every name match.

- [ ] **Step 2: The whole gate**

```bash
nvm use
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

Integration **before** e2e, not after — see `CLAUDE.md`.

- [ ] **Step 3: Report actual output.** If anything fails, fix and re-run the whole gate.

---

## Self-Review

**Spec coverage:** §1.3's endpoints-reused → Task 4. Its selection rules → Task 1. Its overlay → Task 2. Its matrix → Task 3. Its resampling requirement → **deliberately not implemented**, with the reasoning above and a spec correction in Task 2 Step 5.

**Deferred with instructions rather than code:** Tasks 3 and 4 give shapes and rules rather than full bodies. Both are mechanical once their tests exist, and both depend on identifiers in files this branch cannot see until `main` is merged in.

**Type consistency:** `CompareMetric` is defined once in `transforms/compare.ts` and imported by the matrix and both components. `CompareSeries` pairs a run id and label with its `SeriesResponse` and never crosses into persistence.

**Open:** the palette caps at six hues and the selection at five runs, so no run goes undrawn. If `MAX_COMPARE` ever rises, `assignPalette`'s cap is the thing that breaks first, and it fails loudly.
