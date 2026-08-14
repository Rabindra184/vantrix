# Group-scoped time series (GR-04, GR-06) — design

Piece 5 of the parity family. Makes the engine emit per-group time buckets so
the two percentiles-over-time charts on the group detail page can be drawn,
narrowing deviation D-14.

---

## 1. Scope

Two requirements, both currently rendering as stated gaps:

| | Requirement |
|---|---|
| GR-04 | Cumulated response time — percentiles over time, OK series only |
| GR-06 | Duration — percentiles over time, OK series only |

Both are **OK-only**, per §A.9 F-11: Gatling's percentiles-over-time chart is
built from `responseTimePercentilesOverTime(OK, …)` and its rendered title says
so. A combined-series implementation would silently include KO responses
Gatling excludes. The buckets already store `percentilesOk` alongside the
combined set, so this is a matter of reading the right one.

Out of scope: any change to the group page's other five elements, all of which
shipped in piece 4 and are correct.

---

## 2. The series table cannot hold two families under one name

`run_series_bucket`'s primary key is
`(runStartedOn, runId, scope, name, startOffsetMs)` — there is no `family`
column. A group carries two measures under one name, so storing both collides
on that key. This is the whole reason piece 5 exists as its own sub-project
rather than a `seriesFor` call appended to piece 4.

**Add `family TEXT`**, backfilled `'response_time'` for every existing row, then
`NOT NULL`, then into the primary key.

### 2a. Where `family` sits in the key is load-bearing

The initial migration carries this comment, and it constrains the change:

> No secondary index on `(run_started_on, run_id, scope, name)`: those four
> columns are a strict prefix of the primary key above, so the PK's own btree
> already serves equality/range lookups on them. A matching index would be pure
> write and storage overhead, repeated per partition.

So the new key is:

```
(runStartedOn, runId, scope, name, family, startOffsetMs)
```

`family` goes **after `name`, before `startOffsetMs`**. That keeps
`(run_started_on, run_id, scope, name)` a strict prefix, so every existing
series lookup still rides the PK's btree. Placing `family` earlier — after
`scope`, say — silently breaks the prefix and costs each lookup its index,
repeated across twelve partitions, with nothing failing to announce it.

### 2b. The partitioned PK change is the risky step

`run_series_bucket` is range-partitioned monthly (`run_series_bucket_2026_01`
through `_2026_12`, declared in `0001_init`). Dropping and recreating the
primary key cascades across every partition.

**This wants verification against a seeded database, not a green unit suite.**
Specifically: that `SERIES_SQL` still prunes to one partition afterwards. That
query is already shared verbatim with an integration test for exactly this
reason — the `run_started_on = $1` predicate is what makes pruning happen, and
a hand-copied variant in a test would drift from the real one.

`family` also threads through `SERIES_SQL`'s `WHERE`, the writer's column list,
and the series endpoint's query parameters.

---

## 3. Telling an old run from a quiet group

A run ingested before this piece has **no group series rows at all**. The
endpoint returns an empty bucket array — which is exactly what a group with no
traffic returns. Drawing an empty chart would claim the group was measured and
found idle.

The precedent is `started_ok_count`, whose own migration SQL states the
principle:

> Two flat zero lines would read as "no failures"; the truth is "not recorded".

It solved this with a nullable column and a `startedSplitAvailable` flag on the
response. Here the absence is **rows**, not nulls, so the flag derives
differently.

**`groupSeriesAvailable`: does this run have any group-scope series at all?**

- Rows exist → an empty result for one group means that group was quiet.
- No rows → the run predates this piece.

The seemingly ambiguous third case — a run with no groups whatsoever — is
unreachable: a reader arrives at a group page only from a group row in the
statistics table, so a run with no groups has no page to ask from.

Computed once per run on the series response, alongside `startedSplitAvailable`,
which it deliberately mirrors.

---

## 4. The engine change is small; its shape is the point

The group branch calls `rollupFor` twice, once per family. It gains two
matching `seriesFor` calls:

```ts
seriesFor('group', name, 'group_cumulated', maxBucketsGroup).add(…)
seriesFor('group', name, 'group_duration',  maxBucketsGroup).add(…)
```

`seriesFor`'s key gains `family`, exactly as `rollupFor`'s already has it —
the two helpers sit eleven lines apart and should stop differing.

**`BucketSeries` does not change.** It takes one value per event
(`add(tsMs, value, ok, edge)`), so cumulated and duration are two series rather
than one series holding both. A version that widened `Bucket` to carry two
sketches would make every run-scope and request-scope bucket carry an unused
one.

**Groups get their own cap.** `maxBucketsRun` is 1200 and `maxBucketsEndpoint`
300; groups take `maxBucketsGroup`, defaulting to 300. Group cardinality is far
below request cardinality — three groups against seven requests in the
reference run — so this is about bucket count per series, not series count.

---

## 5. D-14 narrows; it does not close

After this piece, GR-04 and GR-06 draw for **newly ingested runs**. Runs
ingested before it keep no group series and keep their stated gap, because
there is no backfill: the buckets cannot be reconstructed without re-parsing
the original bundle.

That is the same decision as D-10's bare request names and
`started_ok_count`'s absent split, and it is recorded rather than quietly
inherited. **D-14 stays in the ledger, narrowed** — from "no run can draw
these" to "runs ingested before 2026-08-14 cannot".

The wording on the stated gap changes accordingly. Today it says the platform
has not recorded per-group series at all; it must become specific to the run,
because the platform now does record them. A page that kept the old sentence
after this ships would be making a false claim about the product.

---

## 6. What the group page does

Each family's `Undrawn` placeholder becomes a real `PercentilesChart` when the
run has group series, and keeps a stated gap when it does not.

`PercentilesChart` takes a `SeriesResponse` and is otherwise unchanged in what
it computes — the same component the run and request pages use. But it must
take its **identity from the caller**, because the group page renders two, and
a component that names itself cannot appear twice. That was true of
`DistributionChart`, `ScopedStatistics` and `IndicatorsChart` in turn; this is
the fourth instance of the same shape and is the rule, not a rediscovery.

**Here it is sharper than a duplicated heading.** `PercentilesChart` hardcodes
`id="percentiles"` and its title, *and* it owns interactive state — a log/value
scale toggle at `data-testid="scale-toggle"` and a percentile-band selector.
Two instances today would give the page two toggles answering to one testid and
two band selectors that a test cannot tell apart. So the prop is not decoration:
every testid the component emits must be derived from the caller's `id`, not
just the figure's.

That also means the e2e must operate **one** chart's toggle and assert the
other's scale is unchanged. Two independent controls that happen to move
together would satisfy any test that only checks one.

---

## 7. Architecture

```
packages/persistence/prisma/migrations/<ts>_series_family/
  migration.sql            add family, backfill, NOT NULL, recreate the PK
packages/persistence/src/metrics/read.ts    SERIES_SQL gains family
packages/persistence/src/metrics/write.ts   family in the column list
packages/statistics/src/engine.ts           seriesFor keyed by family; two group calls
apps/api/src/metrics/metrics.controller.ts  family param; groupSeriesAvailable
packages/contracts/src/metrics.ts           SeriesResponse gains groupSeriesAvailable
apps/web/src/charts/PercentilesChart.tsx    id/title from the caller
apps/web/src/routes/GroupDetail.tsx         two percentile charts, or two stated gaps
```

---

## 8. Testing

Four layers, and the migration is the reason for the third.

- **Engine unit tests**: a group event produces two series under one name,
  distinguished by family, with the cumulated and duration values landing in
  their own.
- **Web unit tests**: the two charts fetch different families and render
  different data; the stated-gap branch still renders when the flag is false.
- **Integration**: the partition-pruning `EXPLAIN` still prunes after the PK
  change, using the shared `SERIES_SQL` rather than a copy. A migration that
  silently cost every series lookup its index would otherwise pass every test
  in this repo.
- **e2e**: both percentile charts draw on a freshly ingested run.

**The fixture must be re-captured**, and the reference run must be re-ingested
to have group series at all — a stale capture would exercise only the
stated-gap branch, which is the state this piece exists to leave behind.

`Catalog/Recommendations` remains unusable for any assertion that the two
families differ: its measures agree to within 1 ms. Use `Cart` (141 vs 225 ms)
or `Catalog` (488 vs 592 ms).

---

## 9. Falsification checkpoints

| # | Break this | This must fail |
|---|---|---|
| 1 | place `family` after `scope` instead of after `name` | `SERIES_SQL` still prunes to one partition and rides the PK btree |
| 2 | read `percentiles` instead of `percentilesOk` | the chart is OK-only (§A.9 F-11) |
| 3 | emit one group series instead of two | cumulated and duration are distinct series |
| 4 | return `groupSeriesAvailable: true` unconditionally | an old run still states its gap rather than drawing empty axes |
| 5 | keep D-14's current wording after the flag lands | the sentence is about this run, not about the platform |
| 6 | give both percentile charts the same `id` | each family's figure — and each family's scale toggle and band selector — is its own |
| 6b | drive one chart's scale toggle and assert the other's is unchanged | the two charts' controls are independent, not one control rendered twice |
| 7 | assert families differ using `Catalog/Recommendations` | **it must still pass** — that group cannot discriminate, which is why 3 uses `Cart` |

Checkpoints 1 and 5 are the non-numeric ones. Checkpoint 1 is the one most
likely to be skipped as an optimisation detail; it is the only test that
catches a migration which works and quietly costs every lookup its index.

---

## 10. Success criteria

A person opens a group on a newly ingested run and sees five drawn containers,
matching Gatling's own group page: response-time ranges, both distributions,
and both percentiles-over-time. The same page on a run ingested before this
piece draws three and states two gaps, naming the run rather than the platform.
`pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration` and
`pnpm test:e2e` are green, and every checkpoint in §9 has been run and shown to
behave as named.

D-14 is narrowed in the ledger, not deleted. §26 M3's rendering half is then
complete against every requirement Appendix A retains.
