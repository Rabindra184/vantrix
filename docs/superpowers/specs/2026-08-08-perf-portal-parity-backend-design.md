# PerfPortal Parity Backend — Service Design

**Date:** 2026-08-08
**Status:** Approved for planning
**Milestone:** PRD §26 M3 (*Parity UI*), data half
**Predecessor:** [Ingest spine](2026-08-07-perf-portal-ingest-spine-service-design.md) — shipped, `origin/main` at `874273b`

---

## 1. Why this is a sub-project and not "the UI"

PRD §26 names M3 "Parity UI" and describes it as pages and charts. Checking each
Appendix A row against the shipped API rather than against the matrix's wording
shows that roughly half of it has no data behind it:

| Appendix A row | State today |
|---|---|
| G-11–G-16 statistics table, all §A.5 columns | Served by `GET /v1/runs/:id/stats` |
| G-22, RQ-05, GR-04, GR-06 percentiles over time | Served by `…/series` |
| G-17 run-level errors table | Served by `…/errors` |
| G-05 assertions table | In `RunResponse.assertions` |
| G-06–G-09 indicator bands | Run scope only — one `IndicatorCounter` per run |
| G-01, G-02, G-04 simulation name, description, duration | Absent from the `run` table |
| G-18, G-19 active users over time | `engine.ts` discards every non-request event |
| G-26 user start rate per second | Same |
| G-20, G-21 response-time distribution | Nothing computes or stores bins |
| RQ-02, GR-09 per-request / per-group indicators | Run scope only |
| RQ-09 response time vs. global RPS | Not computed |
| RQ-11 per-request errors | `ErrorRollup` is one instance per run |
| K-01–K-03 configurable bounds and percentile columns | `project.settings` exists; nothing reads it |

Eleven of twenty-six global rows and five of eight request/group rows cannot be
rendered because the number does not exist. Building the frontend first means
building Run Detail twice — once against a half-empty API, then again when the
missing series arrive with shapes designed without a consumer.

**AC-PARITY-3 is a data test, not a pixel test:** "an automated test asserts each
row against a checked-in reference bundle, and CI fails if any row regresses."
Most of the parity gate can pass before a React component exists.

**No plugin work is required.** The canonical model already carries everything:
`MetaEvent.simulation` / `.description` and `UserEvent{kind:'start'|'end'}`
(`packages/core/src/events.ts`), and the Gatling adapter already emits both
(`packages/plugin-gatling/src/records.ts:16,43`). The gap is engine, persistence,
and read API only.

## 2. Definition of done

Every Appendix A data row has a value behind it and a `PT-*` test asserting that
value against `fixtures/gatling-3.15.1.2/`, **including configurability**
(K-01–K-03 / AC-PARITY-4). When this sub-project is complete, the only thing
between the platform and AC-PARITY-1/2/3 is rendering.

Explicitly **out of scope**: any React code, any chart library decision, any
route or layout. Also out of scope: latency as a metric family and the Scenario
Detail page — both are beyond-parity per §A.8 and neither counts toward the gate.

## 3. Verification findings

Appendix A §A.0 rule 3: verification is element-by-element against a generated
report, and where the report and the matrix disagree, the report wins. Six
findings: two correct Appendix A, two remove work from the design, and two are
constraints that would otherwise have surfaced during implementation. The first
two were settled from Gatling's source at tag `v3.15.1` after the fixture proved
insufficient to decide them.

### F-1 — RQ-09 is not a per-request scatter (matrix wrong)

The fixture's `catalog / list` page renders **61 scatter points for 160 OK
requests** over a 63-second run. It is one point per **second**, not per request.

Empirical elimination across all seven `req_*.html` pages could not identify the
y-value: `p75`, `p80`, `p85`, `p90`, `p95`, `p99` and `max` are **identical on
every page**, because each endpoint sees ~3 requests per second. The fixture
cannot disambiguate them.

Settled from source — `gatling-charts/src/main/scala/io/gatling/charts/stats/LogFileData.scala:213`:

```scala
private def timeAgainstGlobalNumberOfRequestsPerSec(buffer: PercentilesBuffers): Seq[IntVsTimePlot] = {
  val globalCountsByBucket = resultsHolder.getRequestsPerSecBuffer(None, None).counts
  buffer.digests.view.zipWithIndex
    .collect { case (Some(digest), bucketNumber) =>
      val count = globalCountsByBucket(bucketNumber)
      new IntVsTimePlot(toNumberPerSec(count.total), digest.quantile(0.95).toInt)
    }
    .toSeq
    .sortBy(_.time)
}
```

- **x** = global **requests** per second, `getRequestsPerSecBuffer(None, None)`,
  `count.total` — both statuses, not responses. This matches the empirical result
  that x aligns with `RequestsContainerId` and not `ResponsesContainerId`.
- **y** = the request's **p95 in that bucket, truncated to Int** (`.toInt`, not
  rounded).

**Consequences.**

1. Appendix A's "1% relative" tolerance for RQ-09 is correct, but the comparison
   is against ground-truth p95 per bucket (AC-PARITY-2), never Gatling's t-digest
   figure.
2. RQ-09 needs **no new persistence**. x is the run-scope bucket's request count
   and y is the request-scope bucket's p95 — both already stored. It is a
   read-time join.
3. **Per-bucket percentiles must always include p95**, independent of a project's
   configured percentile columns (K-03). Gatling's `0.95` is hardcoded; if a
   project reconfigures its columns to exclude 95, the scatter would break.

### F-2 — the distribution renders percentages, and its bins are not `(max−min)/100` (matrix wrong)

The rendered series are percentages to two decimals (`24.91, 5.25, 11.06…`), not
counts. Appendix A's tolerance says "bin counts exact."

The bin labels also do not follow the obvious rule. With min 28 and max 2503,
`(max−min)/100 = 24.75`, but the observed labels are `28, 53, 78, 103, 128, 153,
178, 203, 227, …, 2491` — twelve gaps of 24 ms among eighty-seven of 25 ms, and
no `floor`/`round`/`ceil` of `28 + 24.75·i` reproduces them.

Settled from `StatsHelper.scala` (whole file, `v3.15.1`):

```scala
def buckets(min: Long, max: Long, step: Double): Array[Int] = {
  val halfStep = step / 2
  val length = math.ceil((max - min) / step).toInt
  Array.tabulate(length)(i => (min + step * i + halfStep).round.toInt)
}

def step(min: Long, max: Long, maxPlots: Int): Double = {
  val range = max - min
  if (range < maxPlots) 1.0 else range / maxPlots.toDouble
}
```

and `LogFileData.scala:112` `distribution(...)`:

```scala
val size = stats.count            // ALL (OK+KO) count — the percent denominator
def percent(s: Int) = s * 100.0 / size
if (max - min <= maxPlots) { /* exact values, one plot per distinct value */ }
else {
  val step = StatsHelper.step(min, max, maxPlots)
  val buckets = StatsHelper.buckets(min, max, step)
  val halfStep = step / 2
  val bucketFunction = (t: Int) => {
    val value = t min (max - 1)
    (value - (value - min) % step + halfStep).round.toInt
  }
  ...
}
```

`maxPlots` is the literal `100`, hardcoded at
`GlobalReportGenerator.scala:80` — it is not configuration.

**The labels are bucket midpoints, and `28` is the first midpoint, not the
minimum.** Solving for the real bounds reproduces the fixture's 100 labels
*exactly*: **min = 16, max = 2503**. Scala's `Double.round` is `floor(x + 0.5)`.

Five rules the platform must reproduce, none of them inferable from the rendered
report alone:

1. `step = range < 100 ? 1.0 : range / 100.0`; `nBins = ceil(range / step)`.
2. Label `i` = `floor(min + step·i + step/2 + 0.5)` — a midpoint.
3. Assignment clamps to `max − 1`, so the maximum observation lands in the last bin.
4. The percent denominator is the **combined OK+KO count** for *both* series, so
   OK and KO percentages sum to 100 across the chart rather than to 100 each.
5. When `max − min ≤ 100` there is **no bucketing at all** — one plot per exact
   distinct value.

`min` and `max` are the **combined OK+KO** min and max, which is why the fixture's
global min is 16 and not the 28 a reader of the chart would assume.

### F-3 — `run_indicator` becomes derivable

With an exact histogram, indicator bands are a read-time fold at any bounds, and
`failed` is `ko_count`, already on `run_stat`. The table is dropped rather than
extended to four scopes. This also retires the "written but never read" defect
recorded in the ingest spine's hardening pass instead of multiplying it.

### F-4 — RQ-09 needs no new storage

Follows from F-1. Stated separately because it removes an entire table from the
design.

### F-5 — the user-series totals are the per-scenario sum

Verified in the report for both charts: `All users` equals `Browse + Checkout` at
every one of 63 buckets, for `MaxConcurrentUsersContainerId` **and**
`UserStartRateContainerId`, with zero mismatches.

This is worth recording because **summing per-scenario maxima is normally a
bug** — `max(a+b) ≠ max(a) + max(b)`. Gatling sums, so parity requires summing.
A reviewer who "fixes" this to a true max-of-sums breaks G-19.

### F-6 — the DDSketch cannot serve the exact rows

DDSketch bins are logarithmic at ~2% width. Bin *counts* are exact but bin
*boundaries* are not placeable at an arbitrary millisecond, so the bin straddling
800 ms cannot be split — indicator bands would be approximate where Appendix A
requires exact. Gatling's equal-width distribution bins do not align with
logarithmic ones either. An exact structure is required alongside the sketch.

## 4. Architecture — storage

### 4.1 The exact histogram

Response times are integer milliseconds, so a 1 ms histogram is **lossless**.
From it, at read time and exactly: indicator bands at any bounds, Gatling's
distribution bins under any binning rule, min, max, and count.

It lives beside the sketch on `run_stat`, under the same
`(run_id, scope, name, family)` unique key, so every scope and every metric
family gets one without a new table or a new join:

```
run_stat  + histogram_ok    Bytes
          + histogram_ko    Bytes
          + histogram_kind  String   -- 'sparse-ms-v1'
```

Two columns, not one. Gatling renders OK and KO as separate series, and *All* is
their merge — histograms are additive, so `All` is exact and free.

**Encoding `sparse-ms-v1`** — a sparse, delta-encoded varint blob:

```
u8    version           = 1
uvarint  minMs          -- first populated bin
uvarint  nEntries
repeat nEntries:
  uvarint keyDelta      -- ms above the previous key (0 for the first)
  uvarint count
uvarint  overflowCount  -- observations above histogramCapMs
uvarint  overflowSum    -- their summed ms, so mean stays exact
uvarint  overflowMax
```

Size is bounded by **distinct observed values**, not by range. The fixture's
895-request run is a few kilobytes.

**Guardrail.** Values above `histogramCapMs` (default 120 000 ms — above any
realistic HTTP timeout) fold into the overflow bin. Count, sum, and max survive,
so mean/min/max/count stay exact; only sub-bin resolution above two minutes is
lost. Worst case below the cap is 120 000 bins ≈ 350 KB; typical is orders of
magnitude smaller. The read API reports a non-zero `overflowCount` explicitly
rather than letting the loss be silent.

### 4.2 Dropped, changed, and new tables

**Dropped:** `run_indicator` (F-3).

**Changed:** `run_error` gains `scope` and `name` (nullable at run scope), unique
on `(run_id, scope, name, message)`, retaining today's top-200-plus-`other` cap
per scope so RQ-11 works without unbounded growth.

**New:** `run_user_bucket`, range-partitioned on `run_started_on` exactly as
`run_series_bucket` is, and for the same reason — retention:

```
run_started_on  Date      -- partition key
run_id          uuid
org_id          uuid
project_id      uuid
scenario        text
start_offset_ms int
started         int       -- users started in this bucket  (G-26)
ended           int
max_concurrent  int       -- peak concurrency in this bucket (G-18)
PRIMARY KEY (run_started_on, run_id, scenario, start_offset_ms)
```

A partitioned table's primary key must contain the partition key, so
`run_started_on` leads — the same constraint the ingest spine hit, and the same
reason Prisma cannot express this and the migration SQL is hand-written.

No stored total row: F-5 proves the total is the per-scenario sum, computed at
read time.

## 5. Architecture — engine

`packages/statistics/src/engine.ts:94` currently reads
`if (e.type !== 'request') continue;  // user scopes: out of scope for Task 11`.
That line is deleted, and the engine gains:

- **Per-scenario session-delta buffers** producing `started`, `ended`, and
  `max_concurrent` per bucket from `UserEvent`.
- **A histogram builder per `(scope, name, family)`**, alongside each existing
  `RollupBuilder`, split by OK/KO.
- **An `ErrorRollup` per `(scope, name)`** instead of one per run.
- **Meta capture** — `simulation` and `description` from `MetaEvent`, joining
  `startedAtMs` which is already read.
- **Removal of the single `IndicatorCounter`** and of `EngineResult.indicators`.
- **A fixed per-bucket percentile set** — `min, 25, 50, 75, 80, 85, 90, 95, 99,
  max` — replacing today's use of the project's configured columns. This is
  exactly the series set Gatling's own percentiles-over-time chart renders
  (verified: the fixture's chart carries `min`, `25%`, `50%`, `75%`, `80%`,
  `85%`, `90%`, `95%`, `99%`, `max`), and it makes p95 unconditionally available
  for the scatter (F-1 consequence 3).

**Why the per-bucket set is fixed while the table's is configurable.** The ingest
spine persists **summary sketches only** — a bucket stores percentiles as plain
numbers, with no sketch to re-query. So a bucket's percentiles can never be
recomputed at read time, and a configurable per-bucket set would silently mean
"whatever the project happened to be configured as on the day it was ingested."
K-03 asks for configurable **statistics-table** percentiles, which come from the
summary sketch and *are* recomputable; K-04 asks for a **band selector** over the
over-time chart, which is a choice among stored series, not a recomputation.
Storing Gatling's full band set satisfies K-04 for every project without making
history depend on configuration.

`EngineOptions.lowerMs` / `.higherMs` are removed from the engine entirely — the
engine no longer counts bands, so it no longer needs bounds.

## 6. Architecture — read API

| Endpoint | Change |
|---|---|
| `GET /v1/runs/:id` | adds `simulation`, `description`, `durationMs` |
| `GET /v1/runs/:id/stats` | adds `scope`/`name`/`family` filters; each row gains `indicators` folded from its histogram at the project's bounds |
| `GET /v1/runs/:id/distribution` | new — `scope`, `name`, `family`; returns Gatling-compatible bins per §3 F-2, plus `overflowCount` |
| `GET /v1/runs/:id/users` | new — per-scenario and total `started` / `max_concurrent` buckets |
| `GET /v1/runs/:id/scatter` | new — `name`, `group`; read-time join, x from run-scope buckets, y from request-scope p95 |
| `GET /v1/runs/:id/errors` | adds `scope`/`name` filters |

Every response shape is a Zod schema in `@perfportal/contracts`, so the OpenAPI
3.1 document regenerates from the contracts as it does today — the frontend
sub-project generates its client from that document rather than hand-writing
types.

The top-level `indicators` object on `StatsResponse` is retained for
compatibility but sourced from the run-scope row's histogram; it is no longer a
separately-stored number.

## 7. Configurability (K-01–K-03 / AC-PARITY-4)

`project.settings` gains:

```jsonc
{
  "indicators":  { "lowerMs": 800, "higherMs": 1200 },
  "percentiles": [50, 75, 95, 99]
}
```

Both are read **at request time**, not frozen at ingest. `percentiles` governs
the **statistics-table columns only** (K-03), computed from the stored summary
sketch. The percentiles-over-time chart draws from the fixed per-bucket band set
in §5, and K-04's band selector chooses among those — see §5 for why that one is
not configurable.

**This deliberately reverses the ingest spine's frozen-`engineOptions` rule for
these two settings, and the justification must be stated because it looks like
backsliding.** The original rule exists so a project changing its configuration
cannot silently reinterpret its own history. That rule still binds anything that
changes *which events are aggregated*. Indicator bounds and percentile columns
are not that: once an exact histogram and a stored sketch exist, both are
**display thresholds applied to complete data at read time**. Recomputing them
per request yields exactly the value a re-ingest would.

**Warm-up stays frozen.** It changes which events enter the summary at all, and
no stored structure recovers that. `engineOptions` therefore keeps `warmupMs`,
`maxEndpoints`, and the bucket caps, and loses `lowerMs` / `higherMs` /
`percentiles`.

A run ingested before this change has no histogram. Such runs serve bands from
their frozen values and report `configurable: false` on the response, rather than
pretending a bounds change applied to them. Backfill is out of scope.

## 8. Parity harness

One test file per Appendix A section, one named case per row — `PT-G-06`,
`PT-RQ-09`, `PT-GR-04` — so a CI failure names the row that regressed rather than
surfacing as an anonymous assertion.

**Tolerances**, restated where §A.0 is wrong:

| Class | Rule |
|---|---|
| Counts, OK/KO, %, min, max, mean, band counts, error counts | Exact against Gatling's displayed value |
| Std dev | 0.1% |
| Percentiles (table, over-time, scatter y) | Within 1% relative of **ground truth from the sorted decoded event set** — never against Gatling's printed figure (AC-PARITY-2) |
| Distribution | Bin **label set** exact; each bin's **percentage** exact to 2 dp, computed as `count · 100 / totalCount` where `totalCount` is OK+KO |
| User series | Exact per bucket, per scenario and total |

**New fixture ground truth** produced by this verification and to be asserted:
global min **16**; scatter y = **truncated p95** against global requests/s;
distribution = 100 midpoint-labelled bins from `floor(min + step·i + step/2 + 0.5)`
with `step = (2503 − 16)/100`, first label 28, last label 2491.

Percentile accuracy assertions use `<=` against 1.000%, never `<` — 1.000% is
reachable and DDSketch guarantees it inclusively. This carries forward from the
ingest spine.

## 9. Cardinality and size

The endpoint cardinality cap (`maxEndpoints`, default 2000) bounds everything
here. Worst case per run: 2000 endpoints × 2 histograms, each typically a few KB
and capped near 350 KB, stored as `bytea` on rows that already exist. Errors are
bounded by 200 distinct messages per `(scope, name)`. `run_user_bucket` is
bounded by scenarios × buckets, which is small.

No new per-event storage is introduced; the histogram is a per-aggregate
structure like the sketch beside it.

## 10. Departures from the PRD

| # | Departure | Reason |
|---|---|---|
| D-1 | Appendix A RQ-09 described as a per-request scatter with 1% tolerance | It is one point per second, y = truncated p95 (F-1). Tolerance survives; the shape does not |
| D-2 | Appendix A G-20/G-21 tolerance "bin counts exact" | Gatling renders percentages of the OK+KO total to 2 dp, over midpoint-labelled bins (F-2) |
| D-3 | `run_indicator` table specified in §18 | Derivable from the histogram; dropped (F-3) |
| D-4 | Indicator bounds and percentile columns frozen in `engineOptions` | Moved to read-time `project.settings`; justified in §7. Warm-up stays frozen |
| D-5 | §26 M3 scoped as "Parity UI" | Split into a data sub-project (this spec) and a rendering sub-project |
| D-6 | K-03 read as making *all* percentiles configurable | Only the statistics-table set is; per-bucket bands are a fixed set, because buckets store numbers and no sketch (§5). K-04 is a selector over stored bands, which this satisfies |

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The histogram is written but never read, like `run_indicator.failed` before it | Every histogram consumer is a `PT-*` parity test asserting a fixture number; a histogram that no endpoint reads fails a test, not a review |
| R-2 | Gatling's `v3.15.1` source differs from the `3.15.1.2` bundle that generated the fixture | Every source-derived rule is *also* asserted against the checked-in report, so a divergence fails a test rather than being trusted |
| R-3 | A reviewer "corrects" the summed per-scenario maxima to a true max-of-sums | F-5 recorded here and as a comment at the summation site |
| R-4 | Percentile columns reconfigured to exclude 95, silently breaking the scatter | p95 is unconditionally present in per-bucket percentiles; a test configures columns without 95 and asserts the scatter still resolves |
| R-5 | Runs ingested before this change render bands that ignore a bounds change | Reported as `configurable: false` rather than silently served; backfill explicitly out of scope |

## 12. Out of scope

React, routing, chart libraries, layout — the rendering sub-project. Latency as a
metric family and the Scenario Detail page (§A.8, beyond parity). Backfilling
histograms onto runs ingested before this change. Live monitoring (M7).
