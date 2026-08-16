# Time-window re-aggregation — design

**Status:** proposed
**Date:** 2026-08-16
**Supersedes:** the "time-window re-aggregation" line in
`2026-08-15-cross-run-analysis-and-report-completeness-design.md` § *Out of
scope*, which deferred this as deserving "its own design, not a paragraph". This
is that design.

**Goal:** narrowing the time range recomputes the report — every statistic, not
just a redrawn axis — the way Gatling Enterprise's brush does.

---

## 0. The behaviour being matched

Observed on `cloud.gatling.io`, 15 Aug 2026. Their Report tab carries a request
timeline scrubber with a resolution indicator ("Resolution: 1s") and zoom
controls. Brushing a 2-minute run down to roughly one minute **recomputed the
statistics table completely**:

| | full run | brushed |
|---|---|---|
| requests | 900 | 455 |
| max | 427 ms | 90 ms |
| std dev | 15 | 6 |

Every chart below followed the same window. This is not a client-side axis
clip — the numbers change, so the aggregation is redone over the sub-range.

That is what makes this expensive, and it is the whole substance of the
feature: **the charts are nearly free to window and the statistics are not.**
A bucketed series narrowed to a range is a `WHERE` on `start_offset_ms`. A
statistics row narrowed to a range has to be recomputed from something.

---

## 1. What was measured, and the decision it forced

The obvious approach is to persist a summariser per bucket and merge it across
the window. The codebase already has two, and choosing between them is the
single decision this design turns on. Both were measured, on this repo's own
classes:

| population | `Sketch` (DDSketch protobuf) | `Histogram` |
|---|---|---|
| 1 observation | 1068 B | **12 B** |
| 20 observations, 40–60 ms band | 1068 B | **51 B** |
| 20 observations, 1–10 000 ms spread | 4139 B | **72 B** |
| 200 observations, 1–10 000 ms spread | 4139 B | **415 B** |
| 1000 observations, 1–2000 ms spread | — | 2015 B |

Two things fall out of that table.

**`Sketch`'s size tracks value SPREAD, not observation count.** 20 values cost
the same as 200 over the same range, and a single observation costs 1068 bytes.
`Sketch#serialize` is `DDSketch#toProto`, whose store is DENSE: it writes every
bin across the occupied index range as a double, zeros included. The ~1 KB
floor is an artifact of that wire format, not an information cost.

**`Histogram` is both smaller and exact.** It is a sparse `Map` of 1 ms bins
with uvarint encoding, so it costs what the data actually occupies — 10× to 25×
less — and its percentiles are exact to a millisecond rather than within
`RELATIVE_ACCURACY` (1%). `merge` is map addition, so merging across a window is
exact for the same reason `BucketSeries#coalesce` is.

**Decision: store a per-bucket `Histogram` pair, not a sketch.**

Rejected, with reasons:

- **Per-bucket `Sketch` using the existing protobuf.** 1–4 KB per bucket row.
  At the endpoint cap (2000 endpoints × 300 buckets) that is over a gigabyte per
  run, for numbers that are *less* accurate than the alternative.
- **A compact custom DDSketch encoding.** `RELATIVE_ACCURACY` never varies in
  this system, so the mapping need not be serialised per bucket and a sparse
  `(index, count)` form would be ~80 B. It works, but it is a new wire format to
  write, version and maintain — and it would still be 1% approximate where the
  histogram is exact. Not worth inventing a format to be less correct.
- **Re-parsing the bundle per window.** Needs the bundle retained forever and
  puts a full ingest on the request path.

### What a merged histogram yields

Every column the statistics table has, with no second summariser and no extra
column:

| column | from the merged histogram |
|---|---|
| count, okCount, koCount | `total` of the OK and KO histograms |
| errorRate | `koCount / count` |
| min, max | `min`, `max` |
| mean | `sum / total` |
| **stddev** | `Σx²·count` from a bin walk — **exact**, no `sum_sq` column |
| **percentiles** | cumulative bin walk — **exact to 1 ms** |
| throughputRps | `count / windowSeconds` |

---

## 2. Schema

```sql
ALTER TABLE "run_series_bucket" ADD COLUMN "histogram_ok" BYTEA;
ALTER TABLE "run_series_bucket" ADD COLUMN "histogram_ko" BYTEA;
```

Nullable, no default — so the ALTER is metadata-only on a partitioned table with
existing rows, and a run ingested before this migration is distinguishable from
one that recorded no traffic. `histogram_kind` is not repeated per bucket;
`run_stat.histogram_kind` already records the format for the run.

**Two histograms, not one**, mirroring `run_stat.histogram_ok` /
`histogram_ko`. A windowed row needs `okCount` and `koCount` separately, and the
percentiles-over-time chart is OK-only (G-22). One combined histogram could not
produce either.

### Storage, honestly

For the reference run — 62 buckets, ~900 requests, so ~15 requests per bucket in
a narrow latency band — a per-bucket OK/KO pair costs on the order of **6 KB for
the whole run-scope series**. A realistic 50-endpoint run at the 300-bucket
endpoint cap lands in the low single-digit megabytes.

The pathological case is the endpoint cardinality cap: 2000 endpoints × 300
buckets × two histograms. A run that reaches it is already producing 600 000
bucket rows today and is the case `ENDPOINT_CARDINALITY_EXCEEDED` exists to
refuse. This design does not raise that risk; it multiplies an existing row's
width by a few hundred bytes.

---

## 3. Engine

`Bucket` gains `histogramOk` and `histogramKo`, filled beside the existing
sketches.

**Fed on the START edge, exactly where the bucket sketches are fed.** This is
not a free choice — it is what makes a windowed table agree with the chart above
it. `BucketSeries#add` already files percentile observations under the start
bucket, matching Gatling's `RequestPercentilesBuffers`, and a windowed p95 drawn
from end-edge histograms would disagree with the percentiles-over-time chart at
the same window, on the same screen.

The consequence is stated rather than hidden: **a windowed statistics row
describes the requests that STARTED in the window.** Summing the stored
`ended_count` over the same range gives a different number, and the two must
never be mixed inside one row.

`#coalesce` merges them alongside the sketches. Merging is exact, so coalescing
stays lossless.

### The invariant this buys

Per bucket, `histogramOk.total` must equal `started_ok_count`, and
`histogramKo.total` must equal `started_ko_count` — the START-edge split added
for G-23. Both are fed on the same edge under the same condition. That makes the
new columns checkable against a column that already exists, at every level:
unit, persistence round-trip, and API.

---

## 4. Statistics package

Two additions to `Histogram`, both exact walks over the sorted-bin iterator it
already exposes:

```ts
/** Nearest-rank, matching Sketch#quantile exactly. */
quantile(q: number): number;
/** Σ(value² × count), for an exact stddev over any merged set. */
sumOfSquares(): number;
```

**`quantile` MUST use the nearest-rank convention `sorted[ceil(q·n) − 1]`**,
which is what `Sketch#quantile` re-expresses its query to hit and what every
ground-truth computation in this repo's tests uses. A histogram quantile using
the linear-interpolation convention would differ by one rank position from the
full-run value on identical data — a discrepancy that looks like a windowing bug
and is not one.

**The overflow bin degrades loudly.** `Histogram` caps at
`DEFAULT_HISTOGRAM_CAP_MS` = 120 000 and `countBelow` already throws rather than
guess when a bound crosses the overflow. `quantile` follows that: a rank landing
in the overflow throws, the API reports that column as unavailable, and nothing
returns a fabricated number. At 120 s — beyond any realistic HTTP timeout — this
is theoretical, which is exactly why it must not be silent.

---

## 5. Persistence

`MetricWriter` writes the two columns beside the existing bucket fields.

`MetricReader` gains a windowed reader. The window predicate composes with the
partition-key predicate rather than replacing it:

```sql
SELECT start_offset_ms, histogram_ok, histogram_ko
  FROM run_series_bucket
 WHERE run_started_on = $1 AND run_id = $2
   AND org_id = $3 AND project_id = $4
   AND scope = $5 AND family = $6
   AND start_offset_ms >= $7 AND start_offset_ms < $8
```

`run_started_on = $1` stays first and stays required, for the reason
`SERIES_SQL`'s docstring gives: it is the partition key, and a query without it
scans every partition. The plan test that asserts pruning must cover this query
too — a new query is a new chance to lose the predicate.

`name` is deliberately absent: a windowed statistics table needs every row at
once, so the reader returns all names for a scope and the caller groups. One
query, not one per endpoint.

---

## 6. API

### The parameter

`?from=<ms>&to=<ms>`, elapsed milliseconds from run start — the same frame as
`start_offset_ms` everywhere else, never absolute timestamps.

Both are independently optional and each is meaningful alone: `from` with no
`to` means "from here to the end", `to` with no `from` means "the start to
here". **Neither is ever silently ignored** — the trap documented for
`?name=` without `scope` — and both are validated:

- non-integer, or negative → 400
- `from >= to` → 400, a caller error rather than an empty window
- beyond the run's extent → clamped to it. The clamp is not announced
  separately: `window` below always reports what was computed, so a caller that
  compares it against what it asked for sees the clamp without a second field.

### The window snaps to bucket boundaries

A brush that cuts a bucket in half cannot be answered exactly at any storage
cost, because the bucket is the finest thing stored. The window therefore snaps
outward to bucket boundaries, and **the response reports the window it actually
computed**:

```ts
window: { fromMs: number; toMs: number; bucketWidthMs: number }
```

so the page header states the range that produced the numbers rather than the
range the reader dragged. Gatling snaps too — their "Resolution: 1s" is the same
admission.

### Which endpoints take a range

`/stats`, `/series`, `/users`, `/distribution`, `/errors/series`, `/scatter`.
Each has per-bucket data behind it at every scope it serves.

**`/errors` — the flat table — deliberately does NOT.** It looks like it should:
`run_error_bucket` exists now and has a time dimension. But it is not a windowed
version of the same table, on two counts. That table is **run scope only**, so a
windowed request-scope call (RQ-11, "errors for this request") could not be
answered at all; and it stores only the top five messages plus a folded
remainder, against the flat table's top two hundred. A brushed errors table that
silently dropped from 200 distinct messages to 5 would be a worse table wearing
the same heading. The errors-over-time chart already windows honestly, and the
table beside it stays whole-run — with the header saying so.

`/trends` and the compare endpoints do not take a range either: their x-axis is
runs, not time.

### A run that predates the columns

`histogram_ok IS NULL` for every bucket of a run ingested before the migration.
Such a run cannot be windowed, and the response must not pretend otherwise.

- `GET /v1/runs/:id` gains `windowable: boolean`, so the UI never offers a brush
  it cannot honour. It is derived from the rows, not from a date comparison
  against the migration — `EXISTS (SELECT 1 FROM run_series_bucket WHERE
  run_started_on = $1 AND run_id = $2 AND histogram_ok IS NOT NULL)`, the same
  one-row shape as `hasGroupSeries` and issued the same way: only on the run
  detail fetch, which is the one reader that needs it.
- A metric endpoint given `from`/`to` for a non-windowable run returns **400
  with a Problem document**, `code: 'WINDOW_UNAVAILABLE'`, remediation naming
  re-ingest.

Returning whole-run numbers under a windowed request would be the
silently-ignored-parameter failure again, in its most damaging form: a table
that looks brushed and is not.

---

## 7. Web

- A brush control above the charts, writing `?from=&to=` into the URL. In the
  URL for the reason `?runs=` is: a window someone selected is a thing they
  paste into a ticket, and component state cannot be pasted.
- Every metric query factory takes the window and **puts it in the query key**.
  `staleTime: Infinity` stays correct and stays unconditional — a completed
  run's metrics *for a given window* still never change. This is the one
  concern the earlier spec raised about this feature, and it dissolves once the
  window is part of the key rather than a mutation of one.
- The statistics table, KPI tiles and every chart read the same window, so the
  page is internally consistent at all times.
- The header states the snapped window and, when clamped, says so.

---

## 8. Three divergences, all stated

Each is real, each is a consequence of a decision above, and each would
otherwise be discovered as a bug.

**A windowed row counts requests that STARTED in the window** (§3), so it will
not equal a sum of `ended_count` over the same range. A request starting at 59 s
and finishing at 61 s belongs to the window containing 59 s.

**A window includes warm-up if warm-up falls inside it.** Series include warm-up
(PRD 7.4) and `run_stat` excludes it, so on a project with `warmupMs > 0` a
window spanning the whole run can report more requests than the unwindowed
table. This is the same divergence already documented between summed
`run_series_bucket.koCount` and `run_stat.ko_count`, and between the errors
chart and the errors table. `warmupMs` defaults to 0, so most projects never see
it.

**Windowed percentiles are exact; unwindowed percentiles are within 1%.**
The unwindowed path reads `run_stat.sketch` (K-03, recomputed at the project's
configured set); the windowed path merges histograms. Brushing to the whole run
can therefore shift a percentile slightly — always within `RELATIVE_ACCURACY`.

Serving the unwindowed path from `run_stat.histogram_ok`/`histogram_ko` instead
would remove this and make every full-run percentile exact. It is deliberately
NOT done here: this sub-project is already a migration, seven endpoints and a UI
control, and changing every existing percentile on every screen at the same time
would make any regression impossible to attribute. Named as a follow-up.

---

## 9. The performance risk, and the budget it must meet

A windowed statistics table at request scope merges up to 300 histograms per
endpoint. At 50 endpoints that is up to 15 000 deserialise-and-merge operations
on one request. Deserialising is uvarint parsing into a `Map` and merging is map
addition — both cheap individually, and 15 000 of them is not obviously cheap.

This is the one part of the design that could fail on contact with a real run,
so it does not get an assumption. The plan must add a benchmark beside
`throughput.bench.test.ts` with a stated budget:

> **A windowed `/stats` over a 50-endpoint run at the 300-bucket cap completes
> server-side in under 500 ms.**

If it misses, the mitigations in preference order are: narrow the query to the
scopes actually rendered; cache the merged result per (run, window) since it is
immutable; or precompute at a coarser window granularity. None is designed here
because none should be built before the number is known.

---

## 10. Testing

| Layer | What it proves |
|---|---|
| `statistics` unit | `quantile` matches `Sketch#quantile`'s convention on identical data; `sumOfSquares` gives an exact stddev; merge is exact; a rank in the overflow bin throws rather than guesses. |
| `statistics` unit | Per bucket, `histogramOk.total === startedOkCount` and `histogramKo.total === startedKoCount` — the new column checked against an existing one. |
| `persistence` integration | Round trip; and partition pruning for the windowed query, asserted against the exported SQL constant rather than a copy. |
| `api` integration | A full-extent window reproduces the unwindowed row within `RELATIVE_ACCURACY`; a half window reports strictly fewer requests and a max no greater; `from >= to` is 400; a non-windowable run is 400 with the right code; the snapped window is reported. |
| `api` bench | The budget in §9. |
| `web` unit | The window is in every query key; the header states the snapped range. |
| `web` e2e | Brushing changes the statistics table's numbers, not just the axis — the assertion that would have caught a client-side clip pretending to be a re-aggregation. |

Expectations are derived from the payload throughout. The e2e case must compare
a brushed count against the same run's unbrushed count from the API, never
against a written-down number.

---

## 11. Out of scope

- **Backfilling historical runs.** Re-running ingest over retained bundles is a
  batch job with its own idempotency and rate questions. `windowable: false`
  tells the reader the truth in the meantime.
- **Unifying the unwindowed percentile path onto histograms** — §8, named as a
  follow-up with its own blast radius.
- **Windowed trends and compare.** Their axis is runs.
- **Gatling's playback controls** (play, step, fast-forward). The window is the
  feature; animating it is not.
- **A compact per-bucket sketch format** — §1, rejected.
- **A windowed flat errors table** — §6. It would need per-bucket error data at
  request scope and at full message fidelity; `run_error_bucket` has neither, by
  its own design.

---

## 12. A note on sequencing

This spec is one feature but three layers, and they are strictly ordered:
storage and engine, then the API's range parameter, then the brush. Each is
independently testable — the columns can be written and asserted before any
endpoint reads them, and the endpoints can be asserted before any control exists
to drive them — so the implementation plan should draw its task boundaries
there rather than by file. The benchmark in §9 belongs at the end of the second
layer, before any UI work rests on a number nobody has measured.
