# Errors over time — design

**Status:** proposed
**Date:** 2026-08-15
**Supersedes:** the "errors/s over time" line in
`2026-08-15-cross-run-analysis-and-report-completeness-design.md` § *Out of
scope*, which deferred this pending "ingest, schema and migration work". This
is that work.

**Goal:** a run's failures on a time axis, one series per error message, so a
reader can see *when* a run broke and *what* broke — not only how many times.

---

## 0. The status-code half of the request, closed

This sub-project was asked for as "status codes and errors". Status codes are
**not obtainable from the source we ingest**, and that is a permanent property
of the format rather than a scheduling problem. It is recorded here so it is
not rediscovered a third time.

`packages/plugin-gatling/src/records.ts` decodes a `REQUEST` record as exactly
six fields:

```text
groups, name, startMs, endMs, ok, message
```

and `header.ts` declares the entire record set as
`RUN=0, REQUEST=1, USER=2, GROUP=3, ERROR=4`. No record carries an HTTP status.

The only place a status appears at all is inside the *text* of a failure
message — the reference bundle's are `status.find.is(200), found 500` (×15) and
`status.find.is(200), found 503` (×9). That text exists only when a check
failed. **A successful 200 leaves no trace anywhere in `simulation.log`**, so
"responses per second by status" cannot be built from this source at any effort:
the chart's largest series would always be missing.

Parsing 5xx out of message text would yield a chart that has data only for
failures — a worse-labelled duplicate of the one this spec builds. Gatling
Enterprise draws its by-status chart from its own instrumentation, not from the
log we consume.

**Consequence for the ledger:** "Responses/s by HTTP status" moves from
*missing* to *not derivable from this ingest source*. It becomes available only
if we ingest something else — Gatling's HAR export, or a sidecar the simulation
writes itself — which is a different sub-project with a different input, not a
continuation of this one.

Errors over time has no such problem. Every `REQUEST` record carries `startMs`,
`endMs`, `ok` and `message`. The information is already in the file; the current
`ErrorRollup` simply discards the time dimension by design.

---

## 1. What this builds

One capability, run scope only:

> **Errors per second, one series per error message**, on the run detail page,
> beside the existing errors table (G-17).

Deliberately *not* built here, each for a stated reason:

| Not built | Why |
|---|---|
| Request-scope error series | Row volume. Run scope is bounded by ~6 series × buckets-with-errors; request scope multiplies that by up to `maxEndpoints` (2000). The request detail page keeps its flat scoped errors table (RQ-11). |
| A message picker over more than the drawn set | The palette draws six categorical series and there is no seventh (`MAX_CATEGORICAL_SERIES = CATEGORICAL.length`, six hues). Storing twenty to draw six needs selection UI, and the flat errors table below already lists every message with its total. |
| Group-scope error series | Nothing asks for it, and `ErrorRollup` has never been keyed by group. |

---

## 2. The architectural decision: where the bucket width comes from

Everything else in this design follows from this one choice.

### The problem

`BucketSeries` does not have a fixed width. It starts at 1000 ms and **halves
resolution in place** whenever its count of *occupied* buckets exceeds
`maxBuckets`. Errors are sparse — the reference run has 24 failures occupying
21 of its 62 buckets — so a structure that buckets only errors will halve far
less often than the run's response-time series. On a long run the response
chart could sit at 4000 ms while the errors chart sits at 1000 ms, putting two
charts on one page at two resolutions.

Sparsity breaks the read path too. `inferBucketWidthMs` recovers a width as the
smallest positive gap between offsets, which is right for a dense series and
**systematically wrong for a sparse one**: three errors at 5 s, 40 s and 90 s
infer a width of 35 000 ms.

### Approaches considered

**A — independent series, its own halving.** A new class mirroring
`BucketSeries`, halving on its own occupancy. Rejected: it is exactly the
divergence described above.

**B — slaved to the run series' width.** Bucket errors independently, then
coalesce up to the run-scope `response_time` series' final width before
persisting. **Recommended.**

**C — add `start_offset_ms` to the existing `run_error` table.** Rejected on
two counts. `run_error` is not partitioned, so per-bucket rows would land
somewhere retention cannot drop by partition — the precise reason
`run_series_bucket` and `run_user_bucket` are partitioned (NFR-SC-7). And every
existing consumer of the flat query would have to start aggregating.

### Why B is sound

The property that makes the coalesce safe, stated precisely:

> **The error series' occupied buckets are always a subset of the run series'
> occupied buckets, at every width.**

An error is recorded at the `endMs` of a request event whose `ok` is false. The
run-scope series receives an `add()` at that same `endMs` on its `'end'` edge.
A bucket index is a deterministic function of `(timestamp, width)`, so at any
width `w` the set of error-occupied indices is a subset of the run-occupied
ones.

Halving triggers on `size > maxBuckets`. Given the **same cap**, and since the
error series' occupancy at width `w` never exceeds the run series' occupancy at
width `w` for any prefix of the stream, the error series never halves before
the run series does. Therefore `widthError ≤ widthRun` at the end, always. Both
widths are `1000 × 2ⁿ`, so coalescing the error series up from `widthError` to
`widthRun` merges groups of adjacent buckets and sums their counts — **exact**,
for the same reason `BucketSeries#coalesce` is exact for counts.

Two consequences that must be written into the code, because they are load-
bearing rather than incidental:

- The error series **must use `maxBucketsRun`**, the same cap as the run-scope
  response-time series. A different cap breaks the subset argument and the
  coalesce could be asked to *split*, which is impossible.
- The run-scope response-time series **always exists whenever any error does**,
  because both are fed from the same request event. There is no case where the
  coalesce target is missing; a run with no requests has no errors either.

### And the width is still stored

Belt and braces, for two different failures:

- **Alignment** (the coalesce) is what makes the two charts mean the same thing.
- **Storage** (`bucket_width_ms` on the row) is what stops the read path from
  inferring a width from sparse offsets and getting 35 000 ms.

It is constant per run and denormalised deliberately.

---

## 3. Schema

New table, new migration `20260815180000_run_error_bucket`, mirroring how
`run_user_bucket` was introduced in `20260808120000_parity_backend` — same
partitioning, same twelve 2026 partitions, same comment about a write past the
last partition failing loudly rather than landing somewhere wrong.

```sql
CREATE TABLE "run_error_bucket" (
    "run_started_on"  DATE    NOT NULL,
    "run_id"          UUID    NOT NULL,
    "org_id"          UUID    NOT NULL,
    "project_id"      UUID    NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "message"         TEXT    NOT NULL,
    "is_other"        BOOLEAN NOT NULL,
    "count"           INTEGER NOT NULL,
    "bucket_width_ms" INTEGER NOT NULL,
    CONSTRAINT "run_error_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "start_offset_ms", "message", "is_other")
) PARTITION BY RANGE ("run_started_on");
```

No `scope`/`name`/`family` columns: this table is run scope only (§1), and
columns that only ever hold one value invite a future reader to filter on them
and find the filter silently ignored.

**`is_other` is a real column, not the magic message `'other'`.**
`ErrorRollup.top()` collapses its tail into a row literally messaged `other`,
which collides with a genuine error message of that text — in the flat table,
whose unique key is `(run_id, scope, name, message)`, that is a latent unique
violation that would fail an ingest. The new table does not inherit it. `other`
rows carry `message = ''` and `is_other = true`; a real message is never empty,
because the engine maps a missing one to `'(no message)'`.

**Why `other` is stored rather than derived.** It could be computed at read
time as `koCount(bucket) − Σ(stored)` from `run_series_bucket`, and by §2 the
widths align so the arithmetic would work. Rejected: it needs a second query, it
couples this endpoint to another table, and any disagreement between the two
tables surfaces as a *negative* count rather than as a missing row.

---

## 4. Engine

`packages/statistics/src/errors-series.ts` — a new `ErrorSeries`, beside
`ErrorRollup` rather than inside it. The flat rollup is used by the errors
table and is correct as it stands; giving it a second, differently-scoped
responsibility would make both harder to read.

```ts
class ErrorSeries {
  constructor(opts: { startMs: number; maxBuckets: number });
  add(tsMs: number, message: string): void;
  /** Coalesced to `widthMs`, top `keep` messages by run-wide total, rest folded. */
  finish(widthMs: number, keep: number): {
    bucketWidthMs: number;
    rows: { startOffsetMs: number; message: string | null; count: number }[];
  };
}
```

`message: null` is the folded remainder; the write path maps it to
`('', true)`.

Four decisions inside it:

**Fed at `endMs`.** That is where `koCount` increments, which buys a testable
invariant: within a bucket, the drawn series plus `other` sum to that bucket's
`koCount`. Feeding at `startMs` would put a request that starts at 10.9 s and
fails at 11.2 s in a different bucket from its own KO.

**Fed *before* the warm-up guard**, alongside the other `seriesFor` calls and
unlike the flat `errorsFor` calls, which sit after it. Series include warm-up
(PRD 7.4) and this one must too — otherwise a bucket inside the warm-up window
would show `koCount > 0` on the responses chart and nothing at all on the
errors chart, on the same axis, at the same instant.

The consequence is stated rather than hidden: **with `warmupMs > 0` the chart's
total exceeds the errors table's total**, because `run_error` excludes warm-up.
This is the same divergence that already exists between summed
`run_series_bucket.koCount` and `run_stat.koCount`. `warmupMs` defaults to 0, so
most projects never see it.

**Top-5 plus `other`, filling the palette exactly.**
`ERROR_SERIES_KEEP = 5`, exported from `packages/statistics`. Six hues, no
seventh, so five named messages and one aggregate is what a reader can actually
be shown without `assignPalette` silently dropping a series. Selection is by
**run-wide total**, computed after coalescing — never per bucket, which would
make a series appear and vanish depending on which messages happened to lead in
each bucket.

**The 5 and the palette cannot share a constant, and that gap needs a test.**
`@perfportal/statistics` depends only on `@perfportal/core`, and `apps/web`
only on `@perfportal/contracts` — neither can import the other, and adding a
dependency to carry one integer is not worth it. So the relationship is
enforced from the web side instead: a test asserts
`MAX_CATEGORICAL_SERIES >= 6`, with a comment naming `ERROR_SERIES_KEEP` as the
reason. Shrinking the palette then fails a test that explains itself, rather
than silently dropping the `other` series off the errors chart.

**Distinct messages tracked cap at 200**, matching `ErrorRollup.top(200)`;
beyond that, newly-seen messages fold into `other` on arrival. Without a cap the
structure is `distinct messages × occupied buckets` — the flat rollup carries
the same unbounded map today, but multiplying it by bucket count is what makes
it worth bounding here.

**This makes the top five a bounded approximation, and the spec says so rather
than claiming an exact ranking.** Admission is first-seen, so on a run with more
than 200 distinct messages one that first appears after the cap is reached folds
into `other` however often it then occurs — including when it is the run's most
frequent failure.

The obvious repair is worse. Evicting a weak tracked message and promoting the
newcomer on overtake cannot recover the newcomer's pre-promotion per-bucket
counts, which are already folded; its curve would begin mid-run and understate
its own height. **A series that is consistently absent is honest; a series drawn
at the wrong magnitude is not**, and nothing on the chart tells a reader which
one they are looking at. Exact ranking *with* per-bucket curves needs both to
come from the same tracked set, i.e. tracking everything.

What survives either way: whatever folds still lands in `other`, so a bucket's
drawn total reconciles exactly with its `koCount`, and the errors table beside
the chart still lists every message with its true total. The failures are never
lost — only unattributed.

`EngineResult` gains one field, `errorSeries`, of `finish()`'s return type.

`runEngine` constructs it with **`maxBucketsRun`** — the same cap as the
run-scope response-time series, which §2 shows is what makes `widthError ≤
widthRun` hold and the coalesce a merge rather than an impossible split. Any
other cap breaks the argument.

It then calls `finish()` after the event loop, passing the run-scope
response-time series' final `widthMs`, or 1000 when there is no such series
(which implies no requests and therefore no errors).

**One extraction:** the `e.message && e.message.length > 0 ? e.message :
'(no message)'` normalisation currently sits inline in the request branch. It
moves to a named helper used by both the flat and bucketed paths, so the two can
never drift into labelling the same failure differently.

---

## 5. Persistence

`MetricWriter.persist` gains a fourth `insertBatched` call, following the
existing three exactly — same batching, same column-list style.

`MetricReader.errorSeries(scope, runId, runStartedOn)`. **`runStartedOn` is
required, not optional**, for the same reason it is on `series()` and `users()`:
it is the partition key, and a query filtering on `run_id` alone cannot prune
and scans every partition. The signature is what enforces that.

```sql
SELECT start_offset_ms, message, is_other, count, bucket_width_ms
  FROM run_error_bucket
 WHERE run_started_on = $1 AND run_id = $2 AND org_id = $3 AND project_id = $4
 ORDER BY start_offset_ms ASC, count DESC, message ASC
```

---

## 6. Contract and API

```ts
export const ErrorSeriesResponseSchema = z.object({
  runId: z.string().uuid(),
  bucketWidthMs: z.number().int().positive(),
  /** False only when this run predates the feature — see below. */
  available: z.boolean(),
  series: z.array(z.object({
    /** null is the folded remainder, not a message that happens to be absent. */
    message: z.string().nullable(),
    total: z.number().int(),
    points: z.array(z.object({
      startOffsetMs: z.number().int(),
      count: z.number().int(),
    })),
  })),
});
```

Series-shaped rather than parallel arrays: the chart draws exactly this, and
there is no index alignment to get wrong. The repeated offsets cost nothing at
six series over a sparse axis.

**Endpoint:** `GET /v1/runs/:id/errors/series`, run scope only, taking **no
`scope` or `name` query parameters at all**. That is deliberate — a scoped
metrics call that omits `scope` is silently coerced to the whole run
(`?name=X` without `scope` is ignored), and the safest way not to reproduce
that trap is to have no such parameters.

**`available` distinguishes "ingested before this existed" from "had no
failures", and needs no new column and no extra table:**

| flat `run_error` rows | `run_error_bucket` rows | meaning | `available` |
|---|---|---|---|
| none | none | the run genuinely had no failures | `true` |
| some | none | ingested before this migration | `false` |
| some | some | recorded | `true` |
| none | some | every failure fell inside the warm-up window (§4) | `true` |

That fourth row is not hypothetical — it is exactly what a project with
`warmupMs > 0` produces when its only failures are during the ramp, and it is
why the rule is written as one expression over both counts rather than as a
lookup keyed on the flat table alone:

```ts
const available = bucketRows.length > 0 || flatErrors.length === 0;
```

The flat query is already indexed on `run_id`, and the endpoint can issue both.
`available: false` renders "this run was ingested before errors were recorded
over time" — never an empty chart, which would claim the run succeeded.

---

## 7. Web

- `apps/web/src/api/metrics.ts` — `errorSeriesQuery(runId)`, `staleTime:
  Infinity` like the other per-run metric queries (a completed run's metrics do
  not change; Trends is the deliberate exception because its cohort grows).
- `apps/web/src/charts/transforms/errorSeries.ts` — `toErrorSeries(response)`,
  dividing each count by `bucketWidthMs / 1000` for a per-second rate, exactly
  as `transforms/rates.ts` does. The folded series is labelled `Other errors`.
- `apps/web/src/charts/ErrorsChart.tsx` — renders through `Chart`.
- `apps/web/src/routes/RunDetail.tsx` — placed beside the existing
  `ErrorsTable`, which keeps its full list of every message.

**A value x-axis, not a category axis.** Errors are sparse; a category axis
indexes points by position, so a run with failures at 5 s, 40 s and 90 s would
draw three evenly-spaced points and misplace all of them in time. `Chart`
already supports `xAxis.type === 'value'` from the report-completeness work, and
the compare overlay uses it for the same reason.

**The categorical palette, never `--color-status-failed`.** An errors chart is
the single most tempting place to reach for the status tokens, and there are two
distinct reasons not to.

`--color-status-*` is a **text** palette — labels, badges, `routes/marks.tsx` —
while chart marks come from `--chart-*` via `assignPalette`. Mixing them means a
chart whose hue does not move with the chart theme.

And it is deliberately kept out of `@theme`, so the utility that *looks* right
does not exist: **`text-status-failed` emits no CSS at all, silently**, because
Tailwind v4 generates utilities only from `@theme` declarations and never from a
bare `:root` custom property. The token is reachable — as
`text-[color:var(--color-status-failed)]`, with the `color:` type hint — and
`components/States.tsx` and `Login.tsx` use exactly that form, which is why
`tokens.test.ts` exempts them. Neither form belongs on a chart series.

---

## 8. Testing

| Layer | What it proves |
|---|---|
| `packages/statistics` unit | Bucketing at `endMs`; coalescing to a wider width sums exactly; top-5 selection is by run-wide total, not per bucket; the 200-message cap folds; warm-up is included. |
| `packages/persistence` integration | Round trip; and a plan test asserting **partition pruning**, mirroring the existing one for `series()`. |
| `apps/api` integration | Response shape; `available` false when flat errors exist and bucket rows do not; the sum-to-`koCount` invariant against `/series` on the same run. |
| `apps/web` unit | Rate divides by the response's own width; a sparse axis keeps its gaps; `null` renders as `Other errors`. |
| `apps/web` e2e | The figure contains **exactly one `<svg>`** and the expected series count. |

Constraints this suite inherits, all of them things that have already shipped as
defects here once:

- **Expectations are derived from the payload, never written down.** The
  reference bundle has 24 failures over 2 distinct messages; a test asserting
  `24` breaks on the next re-capture for a reason that is not a defect.
- The fixture's 2 messages exercise the normal path but **not** top-5 overflow
  or the 200-cap. Those get synthetic unit tests; the e2e suite cannot reach
  them.
- **No decorative `<svg>` inside the chart `<figure>`** — nine existing specs
  prove a chart drew by counting SVG elements within the figure.
- **No `uppercase` on anything queried by accessible name.** Playwright applies
  `text-transform` when computing a name; jsdom does not, so the unit suite
  stays green while the e2e suite cannot find the element.
- `getByRole(role, { name })` is **exact** in Testing Library and a
  case-insensitive **substring** in Playwright — `exact: true` on anything that
  could collide, including with the N `ProjectRail` links present in every
  authenticated document.

Gate, in its documented order — integration **before** e2e:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

on the Node in `.nvmrc` (22). A unit run reporting fewer than **76 files / 855
tests** did not run everything — the floor this branch leaves in `CLAUDE.md`,
raised from the 70 / 788 recorded there, which predated Trends and Compare.

---

## 9. Out of scope

Named because they were considered, not forgotten:

- **Responses/s by HTTP status** — see §0. Not deferred; not derivable from
  `simulation.log`. Reopening it means ingesting a different source.
- **Request- and group-scope error series** — §1.
- **Backfill of existing runs.** Re-running ingest over stored bundles is a
  batch job with its own idempotency and rate questions. `available: false`
  tells the reader the truth in the meantime.
- **Automatic partition rollover.** Still a later milestone; this table gets the
  same twelve months and the same loud failure past the end as its two
  neighbours. Adding rollover for one table and not the other two would be worse
  than not adding it.
- **The three telemetry families** (connections, DNS, generator health) and the
  server-side time-window re-aggregation — unchanged from the previous spec.
