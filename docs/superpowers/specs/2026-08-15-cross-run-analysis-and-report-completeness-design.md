# Cross-run analysis and report completeness

**Date:** 2026-08-15
**Status:** design, approved in chat, not yet planned
**Sub-projects:** two, implemented in the order below

## Why

A teardown of Gatling Enterprise Cloud (org `ab-123`, Gatling 3.15.0/3.15.1,
walked 2026-08-15) scored 46 reporting capabilities against this product. Nine
are at parity, eight partial, twenty-nine absent. Two clusters account for most
of the value:

- **Cross-run analysis.** Gatling separates the verdict (Summary) from the
  evidence (Report) from the *history* (Trends), and adds a five-run overlay
  (Compare). We have no history view at all. A run report answers "what
  happened"; only a trend answers "is it getting worse", which is the question
  a performance engineer actually has.
- **Report completeness.** Four gaps on the run page whose data we already
  store, so they cost no ingest work.

This spec covers both. **Phase 2 (report completeness) is implemented first**:
it is four small client-side changes that establish the chart patterns Phase 1
then reuses.

## What was verified, and three corrections

The teardown made claims about our own payload that turned out to be wrong.
They are corrected here because the plan depends on them.

| Claim in the teardown | Reality | Consequence |
|---|---|---|
| "`percentilesOk`/`percentilesKo` are in the contract and nothing renders them" | **`percentilesOk` is fully rendered.** `transforms/percentiles.ts` reads it exclusively, and is right to — G-22 / RQ-05 specify the OK-only set, matching Gatling's own chart. Only `percentilesKo` is unrendered in the web app (read solely by `parity.controller.ts` for the scatter KO series). | Item 2.1 is not "render unused data". It is "add the OK / KO / all selector", where **OK is today's behaviour** and the other two are new. |
| "Responses per second by HTTP status is free" | **No status codes exist anywhere in the contract.** `SeriesBucketSchema` carries `okCount`/`koCount` and nothing finer; `ErrorsResponse` is `{ message, count }`. | Out of scope. Needs ingest, schema and migration work. Sequenced with the other ingest work, not here. |
| "Errors per second is free" | **`ErrorsResponse` has no time dimension.** It is a flat total. There are no error buckets to draw. | Out of scope, same reason. |

Verified as genuinely available:

- `SeriesBucketSchema.percentilesKo` — populated, unrendered in the web app.
- `DistributionResponse.okCount[]` / `koCount[]` over `labels[]` (bucket
  midpoints) — a cumulative sum over these *is* a percentile curve, per
  outcome. No server work needed for the percentiles-distribution chart.
- `StatsResponse.stats[]` — every column the CSV needs.
- `RunResponse.simulation` — nullable, the cohort key for Trends.

---

# Phase 2 — report completeness

Four items. All client-side. No contract change, no migration, no ingest change.

## 2.1 OK / KO / all selector on the percentiles chart

Gatling puts a three-way outcome selector on every percentile and distribution
chart. Ours is permanently OK-only.

**Behaviour.** A selector on `PercentilesChart` — the percentiles-*over-time*
figure — with three states. The percentiles-*distribution* figure in 2.2 carries
its own instance of the same control; they are independent, as Gatling's are, so
a reader can put an OK curve beside a KO one.

- **OK** — today's behaviour exactly, reading `percentilesOk`. **The default**,
  so the chart a reader already knows does not change under them.
- **KO** — reads `percentilesKo`.
- **All** — reads `percentiles` (the combined set).

**The bucket-emptiness rule must follow the selection.**
`transforms/percentiles.ts` decides "did this bucket measure anything?" by
`Object.keys(bucket.percentilesOk).length > 0`, and the docstring explains at
length why that is keyed on the percentile map rather than on `okCount` or
`startedOkCount`. That reasoning is about the *start edge* and holds for all
three maps — so the check must become "the selected map is non-empty", not a
hard-coded `percentilesOk`. Getting this wrong draws a KO series as a
continuous line across seconds that recorded no failure.

**A KO series is legitimately sparse.** Most buckets in a healthy run have an
empty `percentilesKo`. Gaps must render as gaps (`null`), never as zero — a
zero-millisecond response time is a measurement, and drawing one is a lie. The
existing transform already returns `null` for an absent band; the change must
not regress that.

**Band set.** `BANDS` is ten entries (`min, p25 … p99, max`) and stays ten. The
per-bucket sketches emit the same keys for all three maps.

## 2.2 Percentiles-distribution chart

Gatling's "Response Time Percentiles Distribution": **percentile on the x-axis,
response time on the y-axis**, with the same OK / KO / all selector. It reads
the tail shape directly, which a time series cannot.

**Derived, not fetched.** `DistributionResponse` gives counts per
response-time bucket. Walking `labels[]` in ascending order and accumulating
`okCount[]` yields, at each bucket, "this many observations were at or below
this response time" — divide by the total and it is a percentile. So:

```
x = 100 * cumulative(counts[0..i]) / total
y = labels[i]
```

A new transform, `transforms/percentileDistribution.ts`, with its own unit
tests. No new endpoint, no new query, no new cache key — it consumes the
`distributionQuery` payload the Charts tab already holds.

**Two honesty constraints, both from fields the contract already carries:**

- **`overflowCount > 0` means the bins are incomplete above the histogram cap.**
  The curve must not be drawn to 100% in that case, because the observations
  above the cap are counted but unplaceable. Truncate the curve at the last
  real bucket and state the overflow, rather than drawing a line that asserts a
  maximum the data does not support.
- **`exactValues`** — when true, Gatling skipped bucketing and the labels are
  exact values rather than midpoints. The transform must not re-interpolate.

**Empty outcome.** A run with no failures has an all-zero `koCount`. The KO
curve is then genuinely empty and must render the existing "nothing to draw"
empty state — not an axis pair implying a measurement of zero.

## 2.3 CSV export of the statistics table

One button on `StatisticsTable`. Columns are exactly the rendered columns,
including whatever percentile set the project has configured, so the file and
the screen cannot disagree.

**Rows are every row the table is currently rendering, in its current sort
order** — including the run-scope total row, first, as the table draws it. Not
the unsorted payload order: a reader who sorted by p99 and then exported
expects the file to match what they were looking at. The tree's expansion state
does **not** filter the export; a collapsed group's children are still rows of
the statistics table and their omission would be silent data loss.

**Formula injection is a real risk and must be handled.** A request named
`=cmd|'/c calc'!A1`, or any name beginning `=`, `+`, `-`, `@`, tab or carriage
return, is executed as a formula by Excel and Sheets on open. Request names
come from the tool's own payload, which came from someone's simulation — this
is untrusted input reaching a file the reader will open in a spreadsheet.
Every cell whose value begins with one of those characters is prefixed with a
single quote before quoting. This gets its own unit test with a hostile name in
it.

**Values come from the same formatter the table uses.** `formatCell`, for the
same reason the tooltip already shares it: two surfaces that round the same
number differently is a defect that is very hard to see.

**Filename** carries the run id, so two exports cannot be confused:
`perfportal-<runId>-statistics.csv`.

**Not a link.** The download is built as a `Blob` and triggered from a
`<button>`. An `<a download>` whose `href` is a data URI hits size limits and
behaves differently across browsers.

## 2.4 Tooltip units and layout

Two changes to `Chart.tsx`'s tooltip, which is the surface a sighted reader
actually reads numbers off — the data table is collapsed until asked for.

**Units.** Ours renders `15` where Gatling renders `15 ms`, and `8` where
Gatling renders `8 RPS`. `formatCell` is pure number formatting and appends
nothing; the unit exists only in the axis title, which is not in the reader's
eye when they are reading a tooltip.

A new optional `unit` prop on `Chart` (`'ms'`, `'RPS'`, `'%'`, or absent),
appended after the formatted value. Per chart, because the chart is what knows
its unit. Charts with a unitless or mixed axis pass nothing and are unchanged.

**Layout at more than eight series.** The percentiles chart draws ten. A ten-row
tooltip is tall enough to run off a laptop viewport near the bottom of a chart.
Gatling splits at thirteen into two columns with the mean promoted above a rule.

The threshold is **strictly greater than eight**: at nine or more the tooltip
lays out in two columns, filling the first column top-to-bottom before the
second, preserving series order down and then across. Eight or fewer stays a
single column, so every chart in the app except the percentile ones is visually
unchanged.

**One formatter, not two.** The tempting implementation — keep `valueFormatter`
for the normal case and add a custom `formatter` for the wide case — creates
two code paths that format the same value, which is precisely the class of bug
the shared `formatCell` was introduced to prevent. Instead: replace
`valueFormatter` with a single `formatter` that always runs, routes every value
through `formatCell` + `unit`, and chooses one or two columns from the series
count. It reuses ECharts' own `param.marker` for the colour swatch rather than
hand-rolling one.

**Constraints on the formatter.** It returns an HTML string, so every
interpolated value — series names above all, which originate in the tool's
payload — must be escaped. Series names are untrusted input; a name containing
`<img onerror>` must not become markup. The pie branch (`trigger: 'item'`) keeps
its current single-value shape.

---

# Phase 1 — cross-run analysis

## 1.1 The cohort question

Gatling trends runs within a **test**. We have `project → runs` and a nullable
`simulation` on `RunResponse`. The approved axis is **project + simulation**.

A run's cohort is: runs in the same project whose `simulation` equals this
run's, with `NULL` treated as its own equivalence class rather than as a
wildcard. Two runs that both lack a simulation name are grouped together
because they match by the same rule — but the UI must say the grouping is by
absence, not claim they are the same test.

## 1.2 API — one new endpoint

```
GET /v1/runs/:id/trends?limit=20
```

Chosen over a project-scoped route (`/v1/projects/:slug/trends?simulation=`)
because it needs no slug resolution and no new authorization reasoning: it sits
in the existing `/v1/runs/:id/*` family and inherits its tenant scoping
verbatim. It also matches how a reader arrives — from a run, wanting that run in
context.

**Response** (`TrendsResponseSchema`, new in `packages/contracts/src/metrics.ts`):

```ts
{
  runId: string,              // the run asked about; always present in `runs`
  simulation: string | null,  // the cohort key
  cohortSize: number,         // total matching runs, may exceed `runs.length`
  runs: [{
    id, startedAt, toolStartedAt, durationMs, verdict,
    count, okCount, koCount, errorRate, throughputRps,
    minMs, maxMs, meanMs, percentiles
  }]
}
```

The per-run body is the **run-scope `StatRow` already stored** plus run
identity. No new aggregation: the server selects the cohort, then reads the
`scope = 'run'` row for each.

**Ordering is newest-first**, matching `/v1/runs`. The chart transform reverses
it, because a trend reads left-to-right in time. Stated in the schema docstring
so the two cannot drift.

**`cohortSize` is not `runs.length`.** A reader looking at twenty of sixty runs
must be told so, rather than being shown a truncated history that looks
complete.

**Only terminal runs join a cohort.** A `pending` or `parsing` run has no stat
row; including it would put a gap in a trend that reads as a regression.

## 1.3 API — Compare reuses what exists

No endpoint. Compare fetches, per selected run (2–5), in parallel:

- `/v1/runs/:id/series` — the overlay
- `/v1/runs/:id/stats` — the per-request matrix
- `/v1/runs/:id/users` — only when the concurrent-users metric is selected

All three already have contracts, tests and `staleTime: Infinity`. Because the
keys stay per-run, that caching stays correct — a completed run's numbers still
never change — and a reader who has already opened one of these runs pays
nothing to include it.

**Bucket widths differ across runs and this is the one real trap.**
`SeriesResponse.bucketWidthMs` "is NOT always 1000: BucketSeries halves
resolution in place once a run exceeds its bucket cap". Overlaying a 1000 ms run
on a 2000 ms run without resampling draws two curves at different densities and
silently misstates the shorter one's rate. The transform must **resample every
selected run to the coarsest `bucketWidthMs` in the selection** before
overlaying, and this gets a unit test built from two fixtures of different
widths.

## 1.4 Web — routes and IA

Two new routes, each its own URL, reachable and bookmarkable:

- `/runs/:id/trends`
- `/runs/:id/compare?runs=<id>,<id>,…`

`RunTabs` gains a fourth tab, **Trends**. It stays links in a `<nav>` with
`aria-current`, not an ARIA tab widget — the existing docstring's reasoning
(real URLs, middle-click, no roving-tabindex contract) is unchanged by adding a
fourth.

Compare is reached from Trends rather than being a fifth tab, because it needs
a selection to be meaningful and Trends is where the selection is made.

**`?runs=` is validated, not trusted.** Ids are parsed as UUIDs, deduplicated,
capped at five, and any id outside the cohort is dropped. A malformed parameter
falls back to the current run alone rather than erroring — the reader asked to
compare, and a bad query string is no reason to refuse them. This mirrors
`safeNext`'s stance in `routes/paths.ts`.

## 1.5 Web — charts

**Trends**, three figures from the single payload:

| Figure | Shape |
|---|---|
| Response status | Stacked OK/KO **percentage** per run |
| Response time percentiles | One series per band across runs |
| Throughput | Requests/s per run, OK/KO split |

**Compare**, two:

| Figure | Shape |
|---|---|
| Metric overlay | One series per run against elapsed offset; metric-selectable |
| Per-request matrix | Requests down, runs across, cells shaded by the metric |

**Metric selector** covers what `series` + `stats` + `users` actually provide:
`p50 / p90 / p95 / p99 / max`, throughput, error count, concurrent users. It
does **not** offer CPU, which Gatling has and we do not collect.

**X-axis on trend charts.** Runs are not evenly spaced in time, so the axis is
**categorical by run**, labelled with a short timestamp, not a time axis that
would imply a rate of change between runs. The tooltip carries the full
timestamp and the run id.

**Matrix cells for a request absent from a run render `—`, never `0`.** A
request that did not run is not a request that took no time. This is the same
distinction `RunTabs` draws for a null error count.

All figures go through `Chart`, so each gets its `DataTable` for free — and
therefore the `<svg>`-count invariant in `run-charts.spec.ts` applies to them:
**no decorative icon inside a chart `<figure>`.**

---

# Testing

TDD throughout: a failing test, then the code that passes it.

**Unit (`vitest`).** New transforms (`percentileDistribution`, the compare
resampler, the trends transform) each get their own suite. Expectations are
**derived from the fixture payload, never hard-coded** — a re-capture of
`reference-run.json` must not break a test for a reason that is not a defect.
The CSV escaper gets a hostile-name case. The tooltip formatter gets an
escaping case.

**Integration (`apps/api/test`).** `/v1/runs/:id/trends`: cohort selection
including the `simulation IS NULL` class, `limit` bounds, `cohortSize` vs
returned length, exclusion of non-terminal runs, tenant isolation (a run in
another org is 404, not 403), and the project-mismatch case the sibling routes
already reason about.

**E2E (`playwright`).** Both new routes reachable directly by URL. Every
`getByRole(role, { name })` passes **`exact: true`** — `ProjectRail` renders
`All runs` plus one link per project in every authenticated document, so a
substring match can be satisfied by a rail row instead of the target. No
`uppercase` on any heading or column header queried by name. The chart
`<svg>`-count assertions extend to the new figures.

**Gate before claiming done**, per `CLAUDE.md` — `test:unit` excludes the other
two suites:

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Integration and e2e need the local stack up and the five environment variables
exported. Never run `test:integration` while `capture-chart-fixture.mjs` is
capturing — that suite truncates every table on setup.

**Fixture naming constraint.** Any new seeded project or simulation name must
not be a case-insensitive substring of a page's own link text, or it will
satisfy a page-scoped link query from the rail. `'beta'` / `'Beta Checkout
Flow'`, never `'beta'` / `'Beta'`.

---

# Out of scope

Named because they were considered and deliberately excluded, not forgotten:

- **Responses/s by HTTP status** and **errors/s over time** — no data. Both
  need ingest, schema and migration work; they belong with the other ingest
  work (connections, DNS, generator health), not here.
- **The time-window re-aggregation.** Gatling's brush is server-side: narrowing
  a 2-minute run to 1 minute recomputed the statistics table completely (900 →
  455 requests, max 427 → 90 ms, std dev 15 → 6). That means every metric
  endpoint taking a range and `staleTime: Infinity` ceasing to be
  unconditionally correct. It deserves its own design, not a paragraph here.
- **Campaign scoring.** Their most differentiated idea and the least portable —
  the three dimensions only mean something if we define them ourselves.
- **Generated analysis.** Its quality is bounded by the metrics available, so
  building it before the ingest work would reproduce exactly the thin, hedged
  commentary Gatling's own tool produces on a one-request run.

# Open questions

1. **Trend depth default.** `limit=20` is a guess. Twenty runs is a readable
   axis; sixty is not. Revisit once there is real data to look at.
2. ~~Cohorts of one.~~ **Decided.** A cohort of one draws the charts with their
   single point — the value is real and hiding it would be worse — with a line
   above them reading that there is nothing to compare against yet. Not the
   empty state, which is for *no* data, and this is one datum. Revisit only if
   the single point reads as noise on a real screen.
