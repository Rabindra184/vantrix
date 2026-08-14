# Parity charts: the global overview — design

**Status:** approved 2026-08-13. First of four sub-projects completing PRD §26 M3's
rendering half.

**Goal.** Render §13.2 elements ③ ④ ⑦ ⑦ᵇ ⑧ ⑨ ⑩ ⑪ on the run detail page, so a
person migrating from the Gatling HTML report finds the overview charts where
they expect them.

---

## 1. Scope

**In:** indicators ③, request-count donut ④, concurrent users ⑦, users started
per second ⑦ᵇ, response-time distribution ⑧, response-time percentiles over
time ⑨, requests per second ⑩, responses per second ⑪ — Appendix A rows
**G-06…G-10, G-18…G-26**.

**Out, and belonging to later sub-projects:**

| Sub-project | Contents |
|---|---|
| 2 | Statistics table ⑤ and errors table ⑥ (G-11…G-17), with rows linking to detail |
| 3 | Request detail page §13.3 (RQ-01…RQ-11), including the saturation scatter |
| 4 | Group and scenario detail §13.4 (GR-01…GR-09, S-01, S-02) |

**Out of scope entirely, and must not appear in any diff:** trend strips,
comparison, regression detection, live monitoring, saved views, custom
dashboards, personalization, i18n mechanics, self-registration, and any RBAC
affordance — `org_member.role` stays write-only until M6.

The latency family (`family: 'latency'`) is **not** rendered. Gatling 3.15.1.2
reports no latency (Appendix A §A.9 F-2), so there is nothing to reach parity
with, and §13.3's latency elements are explicitly marked beyond parity.

## 2. What already exists

All eight charts are served by four endpoints that are already implemented and
parity-tested — 16 distinct `PT-*` assertions run against the real Gatling
reference report. This sub-project renders data that is already proven correct,
with exactly one exception, §3b.

| Endpoint | Feeds |
|---|---|
| `GET /v1/runs/:id/stats` | indicators ③, request-count donut ④ |
| `GET /v1/runs/:id/series` | percentiles over time ⑨, requests/s ⑩, responses/s ⑪ |
| `GET /v1/runs/:id/users` | concurrent users ⑦, users started per second ⑦ᵇ |
| `GET /v1/runs/:id/distribution` | response-time distribution ⑧ |

Four fetches, eight charts.

One exception to "renders data already proven correct" is §3b: requests/s
needs a split the buckets do not currently record.

## 3. One backend change: `bucketWidthMs` on the series response

`SeriesResponse` carries `buckets[].startOffsetMs` but not the bucket width,
and **the width is not always 1000 ms** — `BucketSeries` halves resolution in
place once a run exceeds its bucket cap
(`packages/statistics/src/buckets.ts`). The width is not stored; server-side it
is recovered by `inferBucketWidthMs`, whose own docstring records that it must
take the *smallest positive* gap because empty buckets are absent from the
table.

Requests/s and responses/s are **rates**: `startedCount / (widthMs / 1000)`. A
client that assumes 1000 ms scales every point on both charts by a power of two
for any long run — and because every bucket is scaled equally, the curve's
shape is unchanged and nothing looks wrong. It is a silent, plausible,
wholly-incorrect chart.

**Add `bucketWidthMs: z.number().int().positive()` to `SeriesResponseSchema`,
populated server-side from the existing `inferBucketWidthMs`.** The server
already knows the answer and already has the helper; deriving it a second time
in the browser would be a second definition of a number that must not disagree.
The addition is additive and breaks no existing consumer.

The UI must divide by `bucketWidthMs` and must never hard-code 1000.

## 3b. The requests/s OK/KO split does not exist yet

Appendix A **G-23** requires requests/s to draw **All / OK / KO**.

> **Correction, 2026-08-13.** This section originally claimed the real Gatling
> report draws requests/s as All/OK/KO, citing the reference fixture. That
> citation was mine and it was unreliable — the extraction crossed a chart
> boundary and picked up the neighbouring responses/s chart's series. Task 9's
> implementer examined `RequestsContainerId` more carefully and reports a
> single `All` series there, with the All/OK/KO triple belonging to
> `ResponsesContainerId`.
>
> **The requirement is unaffected**: it rests on Appendix A G-23, which is
> independent of my reading of the fixture, so the migration below and the
> chart that consumes it are both still right. But a future parity diff
> against the reference report will legitimately flag our two extra series,
> and whoever runs it should find this note rather than re-deriving it.

`BucketSeries.record` (`packages/statistics/src/buckets.ts`) increments
`okCount`/`koCount` on the **end** edge only. Those are the split for
**responses**/s (G-24), and the totals confirm it: `okCount + koCount` = 871 +
24 = 895 = the `endedCount` total. Nothing records the outcome split against
the **start** bucket, so requests/s can draw only "All".

The OK/KO *sketches* are fed on the start edge, but `percentiles_ok` is
persisted as `jsonb` of computed percentiles, so the sketch's own count is not
recoverable. There is no cheap derivation.

**Add `started_ok_count` and `started_ko_count` to `run_series_bucket`,
incremented on the start edge**, summed by `#coalesce` alongside the existing
counters, and exposed on the bucket. This is the only new metric computation in
this sub-project, and it exists because parity is the V1 gate.

**Runs ingested before the migration report the split as unavailable, not as
zero.** `SeriesResponse` gains `startedSplitAvailable: boolean`, mirroring
`StatsResponse.configurable` exactly — whose own comment says such runs are
"reported rather than silently pretended". Where it is false the UI draws the
All series alone and says why; it never draws two flat zero lines, which would
read as "no failures" rather than "not recorded".

Backfilling historical runs by reprocessing retained bundles is deliberately
out of scope.

## 4. Deviation D-7: the percentile band set is Gatling's, not §13.2 ⑨'s

> Continues the parity family's deviation numbering, which runs D-1…D-6 in the
> parity-backend spec. It **extends D-6** rather than repeating it: D-6
> established that the per-bucket bands are a *fixed* set, because buckets
> store numbers and no sketch. It did not say which set, nor that §13.2 ⑨
> names two bands that do not exist.


§13.2 ⑨ and §12.4's band selector both list *min, 25th, 50th, 75th, 80th,
85th, 90th, 95th, **98th**, 99th, **99.9th**, max* — twelve bands.

Two of those do not exist:

- `packages/statistics/src/engine.ts` emits
  `BUCKET_PERCENTILES = [25, 50, 75, 80, 85, 90, 95, 99]` per bucket. There is
  no p98 and no p99.9 in `percentilesOk`.
- The real Gatling report draws exactly ten:
  `min, 25%, 50%, 75%, 80%, 85%, 90%, 95%, 99%, max`, read directly out of
  `fixtures/gatling-3.15.1.2/reference-report/index.html`.

The parity target is what Gatling draws. **Render those ten bands.** The PRD
text is over-specified against both the tool and the data, in the same way
Appendix A §A.9 records five matrix rows that were written from expectation and
corrected against a real report. This is D-7 and belongs in that record.

Bands come from `minMs`, `percentilesOk.p25…p99`, and `maxMs`.

**The band selector is in scope.** §13.2 ⑨ requires band selection to be
toggleable and §12.4 specifies a selector; D-6 records that K-04 is a selector
over *stored* bands, which these ten are. Any subset may be toggled, and the
selection is one of the linked states §22.5 requires to be shared across the
page.

## 5. G-22 is OK-only, and that is the easiest thing here to get wrong

`SeriesBucket` carries three percentile maps: `percentiles` (combined),
`percentilesOk`, and `percentilesKo`. Appendix A G-22 and RQ-05 both specify
**OK series only**, and `SeriesBucketSchema`'s own comment says so.

The combined set is a different curve that looks entirely reasonable — higher
in exactly the places a reader expects response times to be higher. Nothing
about the rendered chart reveals the substitution. This is a named
falsification checkpoint in §9.

## 6. Architecture

```
apps/web/src/charts/
  echarts.ts          the ONLY module importing from 'echarts/core'
  theme.ts            token-driven light/dark theme + validated categorical palette
  Chart.tsx           the primitive: SVG render, resize, empty state, crosshair group
  DataTable.tsx       the accessible data table every chart ships with
  transforms/         pure: API payload -> { series, axis, tableRows }
apps/web/src/routes/
  RunDetail.tsx       gains the chart stack below the assertions panel
```

**`echarts.ts`** registers only the chart types and components used, so bundle
cost is auditable in one file rather than spread across eight imports.

**`transforms/`** is pure TypeScript — no React, no ECharts types in the
signatures. Each transform takes a validated contract type and returns plain
data. This is what makes the numbers unit-testable in the node environment
without a DOM.

**`Chart.tsx`** owns everything ECharts-shaped. Charts render with the **SVG
renderer**, not canvas, so marks are real DOM nodes.

### Data flow

One `useQuery` per endpoint under `['run', id, 'stats' | 'series' | 'users' |
'distribution']`, extending the `runQueryKey` convention Task 7 established. A
chart never fetches; it receives already-validated data. Each endpoint's fetch
goes through `apiFetch` with its contract schema — except `/series`, which must
tolerate the same 202/422 branching `fetchRun` handles if it is reachable
before a run completes; charts render only for a `ready` run, so they mount
under the existing `state === 'ready'` branch and this does not arise.

## 7. The accessible data table is the parity surface

Charts are pixels and pixels are not assertable. Every chart therefore renders
a `<table>` containing the exact series values it plots — always present in the
DOM, visually hidden by default, revealed by a per-chart **Show data table**
toggle.

This is one artifact doing two jobs honestly. WCAG 2.2 AA requires a non-visual
route to the same information; parity testing requires an assertable one. Using
the same table for both means a test cannot drift from what a screen-reader
user actually receives — if the table is wrong, both the test and the user are
wrong together, which is the only honest coupling.

Tables carry `data-testid="chart-data-<chartId>"` and are read by tests via
their DOM text regardless of visibility. One separate test proves the toggle
reveals them.

## 8. Testing

Three layers, each proving something the others cannot:

| Layer | Environment | Proves |
|---|---|---|
| Transform unit tests | vitest, node | The numbers. Exhaustive, against a payload fixture captured from the real reference run. |
| Component tests | vitest + jsdom | The data table, empty states, and the toggle — plain React, no ECharts. |
| Playwright | real browser | ECharts actually draws, the crosshair links, the log/linear toggle works, and the rendered tables match the live API. |

**ECharts is deliberately not exercised in jsdom.** `getBoundingClientRect`
returns zeros there, so a chart renders at 0×0 and any assertion about it is
theatre. The table is plain React and tests cleanly; the drawing is proven in a
real browser where it is real.

**The payload fixture** is captured once from the live API for the reference
run by a checked-in script, so unit tests run against the same bytes the
browser receives rather than hand-written approximations.

**The jsdom environment closes a tracked debt.** The previous sub-project left
the run detail polling cap's wiring untested because no DOM environment existed
and adding one for that alone was not justified. It is justified here, and
closing that gap is in scope.

## 9. Falsification checkpoints

Each names a mutation and the test that must go red. A checkpoint that stays
green is a finding, not a formality.

| # | Break this | This must fail |
|---|---|---|
| 1 | `percentilesOk` → `percentiles` in the percentiles-over-time transform | the OK-only band assertion (§5) |
| 2 | `maxConcurrent` → `started` in the concurrent-users transform | concurrency and arrival rate are distinct series (§10) |
| 3 | divide by a hard-coded `1000` instead of `bucketWidthMs` | requests/s matches the API's own rate (§3) |
| 4 | drop the KO series from the distribution transform | distribution shows OK and KO (G-20/G-21) |
| 5 | render indicator bands from frozen values while `configurable` is false | the bands report which bounds produced them (§10) |
| 6 | increment `started_ok_count` on the end edge instead of the start edge | requests/s OK+KO equals startedCount per bucket (§3b) |
| 7 | draw zeroed OK/KO series when `startedSplitAvailable` is false | a pre-migration run says the split is unavailable (§3b) |

## 10. Details that are easy to get wrong

**Concurrency is not arrival rate.** ⑦ plots `maxConcurrent`; ⑦ᵇ plots
`started`. The PRD's own note explains why both exist: a constant arrival rate
produces a *rising* concurrency curve when the service slows, and that
divergence is the signal. Plotting the same field twice destroys it while
producing two charts that each look correct.

**The total users series is a sum of per-scenario maxima.** `UsersResponse`'s
comment records that Gatling's own "All users" series is exactly this sum,
verified across all 63 fixture buckets — even though `max(a+b) ≠ max(a)+max(b)`
in general. Use the `total` array the API provides; do not recompute it.

**Distribution percentages are of the combined OK+KO count**, so the two series
together sum to 100 (Appendix A §A.9 F-8). `okPercent` and `koPercent` are
already correct; do not renormalise.

**`exactValues` and `overflowCount`.** When `exactValues` is true Gatling skips
bucketing and the labels are exact values, not bin midpoints. A non-zero
`overflowCount` means observations exceeded the histogram cap and bins above it
are incomplete — say so on the chart rather than drawing a truncated
distribution silently.

**`configurable: false`** means the run predates the parity migration and has no
histogram, so its bands came from frozen values and will not respond to a
bounds change. Render the bands and state that they are fixed; do not offer a
control that would do nothing.

**Indicator bounds** come from the payload's `bounds`, not from a constant. The
chart labels the bands with the actual millisecond thresholds used.

## 11. §22.4 compliance

- **No dual axes.** Active users is its own time-linked chart sharing one
  crosshair via ECharts `connect`, never an overlay on requests/s. This is the
  PRD's deliberate encoding change from Gatling and Appendix A G-25 records it
  as information parity rather than a gap.
- 2px lines; markers ≥ 8px; hairline gridlines in the gridline token; no chart
  border.
- Legend whenever ≥ 2 series; a single-series chart gets none and the title
  names it.
- Values, labels and legend text wear ink tokens, **never** the series colour.
- Selective direct labels only — never a number on every point.
- Percentile bands default to log Y with a linear toggle; distribution bins are
  log-spaced.
- A chart with no data shows an explanation, not empty axes.

The categorical palette is validated with the `dataviz` skill's
`validate_palette.js` in both light and dark mode before it ships. Palette
correctness is computable, so it is computed rather than judged by eye.

## 12. Dependencies

`echarts`, pinned exactly, imported tree-shaken through `echarts/core`.
`jsdom` and `@testing-library/react`, pinned exactly, dev-only.

No CDN, no runtime-fetched assets. Every dependency is declared by the package
that imports it — `apps/web`'s e2e fixtures already cost this project one
CI-only failure from a package that was imported but never declared.

## 13. Success criteria

A person opens a completed run and sees, below the assertions panel, the eight
charts of the Gatling overview, reading the same numbers Gatling reports.
Charts share one crosshair. Every chart offers its data as a table. The palette
passes the validator in both themes. `pnpm typecheck`, `pnpm lint`, the unit,
integration and Playwright suites are green, and every falsification checkpoint
in §9 has been run and shown to fail as named.
