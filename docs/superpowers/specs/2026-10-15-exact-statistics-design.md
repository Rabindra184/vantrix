# Exact statistics — design

Sub-project 1 of the enterprise parity programme. Status: approved in
conversation 2026-10-15, written for review.

Inputs: [`docs/superpowers/research/2026-10-15-gatling-enterprise-parity-matrix.md`](../research/2026-10-15-gatling-enterprise-parity-matrix.md).

## 1. Goal and standard

Every figure PerfPortal shows — tiles, tables, charts, trends, compare, CSV,
API, SLA verdicts and the live view — is **exact against the run's raw data**,
and each run proves it.

The standard (decision "D"):

- **Truth** is the raw `simulation.log`: every value computed exactly, with
  nearest-rank percentiles.
- **Gatling's report** is checked against, not copied. Where its method gives a
  different number, the difference is shown and explained.

Measured motivation (same run, 1,718 requests): PerfPortal's sketch
percentiles are within ~1% of exact (p50 206.46 vs 205); Gatling's OSS report
is far off on the tail (p99 7,909 vs 10,417; Session p95 3,320 vs 2,458)
because it estimates percentiles with t-digest 3.3 (`AVLTreeDigest`,
compression 100, in `io.gatling.charts.stats.buffers.GeneralStatsBuffer`).

This overrides PRD §A.9 F-6, which describes percentiles as estimates.

### Decisions

| # | Decision |
|---|---|
| D1 | Standard D, as above |
| D2 | Existing runs are recomputed exactly from their stored raw logs (backfill) |
| D3 | Every run is verified against its raw log; raw logs are retained for a configurable period |
| D4 | Differences from Gatling's report appear only where they occur, in the run's verification details |
| D5 | Live figures are exact |
| D6 | Percentiles display as whole milliseconds |
| D7 | The DDSketch is retired |
| D8 | Approach: exact histograms everywhere (not raw-value storage, not exact-at-finalize only) |

## 2. Calculation rules

One definition per figure, used by every surface.

| Figure | Rule |
|---|---|
| Requests, OK, KO | One per response record. Standalone errors (no request, e.g. a session failure) appear in the errors table but are not requests. Matches Gatling and Gatling Enterprise. |
| Error ratio | KO ÷ requests |
| Min, max | Smallest / largest observed value, whole ms |
| Mean | Σx ÷ n |
| Standard deviation | Population: √(Σx²/n − mean²), as Gatling |
| Percentile p | Nearest rank: the value at 1-based position ⌈p/100 × n⌉ in ascending order; p = 0 → min, p = 100 → max; n = 0 → no value |
| Default population | All responses (OK + KO); OK-only and KO-only available as today |
| Throughput | Requests ÷ the span the data covers (the run's activity span, or the selected window's data span — existing rule) |
| Time buckets | Response-time values attributed to the bucket of the request's **start**; responses/s counted by **end** (existing conventions, now specified and tested) |
| Merging | Histogram counts add, min/max take extremes, sums add; a merge equals the computation over the combined raw data |
| Groups | Same rules for both measures: cumulated response time and group duration |
| SLA rules | Judged on exact values at full precision |

Display: percentiles, min and max are integers by nature and shown as such;
mean, standard deviation, rates and ratios at 2 decimals via the existing
`roundForReading`. CSV, API and verification details carry full precision.
Rounding happens only at display, in one shared function.

## 3. Data model

### `run_stat` (per run × scope × name × family)

- Histograms (`histogram_ok`, `histogram_ko`) become **required and
  authoritative**, in a new uncapped format `sparse-ms-v2` (sparse occupied
  1 ms bins, varint-encoded as today, no overflow bin). `sparse-ms-v1` remains
  decodable.
- Count, OK, KO, error rate, min, max, mean, standard deviation and
  throughput stay as columns (`count`, `ok_count`, `ko_count`, `error_rate`,
  `min_ms`, `max_ms`, `mean_ms`, `stddev_ms`, `throughput_rps`); the first
  five are already exact, and mean and standard deviation are recomputed from
  the histogram so they follow §2 exactly.
- `histogram_kind` records the format per row (`sparse-ms-v1` or
  `sparse-ms-v2`).
- `percentiles` (JSON) stays as a **cache** of exact values for the project's
  configured percentile set, always derived from the histogram.
- `sketch`, `sketch_kind` are dropped in a later migration (PR 5), after
  backfill has completed.

### `run_series_bucket`

- `histogram_ok`, `histogram_ko` required and uncapped; `percentiles`,
  `percentiles_ok`, `percentiles_ko` become exact caches.

### `run`

- New `stats_method`: `estimated` | `exact-v1`. Existing rows default to
  `estimated`; new ingests write `exact-v1`.

### New `run_verification` (one row per run)

| Column | Meaning |
|---|---|
| `run_id` | PK, FK to run, cascade |
| `status` | `pending` / `verified` / `mismatch` / `unverifiable` |
| `checked_at` | When the check finished |
| `verifier_version` | Integer, bumped when rules change |
| `figures_checked` | Count of compared values |
| `mismatches` | JSON list: scope, name, family, population, bucket?, figure, stored, recomputed |
| `gatling_differences` | JSON list: scope, name, population, figure, `gatlingLow`, `gatlingHigh`, exact value — one row per percentile where Gatling's range is not exactly the exact value; `[]` when nothing differs or the method did not run (amended 2026-10-21, §6) |
| `gatling_replays` | Integer, nullable: the seed count the Gatling method ran with, or null when it did not run (amended 2026-10-21) |
| `unverifiable_reason` | `raw_log_deleted` / `raw_log_missing` / null |
| `raw_log_retained_until` | Date, or null for forever |

The row outlives the raw log.

### New `run_verdict_change` (backfill only)

`run_id`, `rule_snapshot`, `old_verdict`, `new_verdict`, `old_value`,
`new_value`, `changed_at`.

### Raw log retention

- The assembled `simulation.log` (upload bundle or live assembly) stays in
  object storage, compressed, for `RAW_LOG_RETENTION_DAYS` (default 90, `0` =
  forever).
- The sweeper deletes logs past retention and sets the verification row's
  `raw_log_retained_until` / reason accordingly.

## 4. Engine and live path

The batch pipeline and the live fold share `LiveEngine`, so one change makes
both exact and keeps them equal.

- `RollupBuilder` and the bucket series (`buckets.ts`, `bucket-latency.ts`)
  hold one uncapped histogram per population (all, OK, KO) instead of three
  sketches.
- New `nearestRank(histogram, p)` is the only percentile function.
  `clampPercentile` (statistics and `apps/web`) and its guard test are
  removed: an observed value cannot leave the observed range.
- `window.ts` merges histograms as today, without an overflow bin.
- Readers that used a sketch move to the histogram: `/stats` with a
  reconfigured percentile set (`metrics.controller`), the SLA evaluator's
  fallback (`packages/sla/src/metrics.ts`), trends and list queries (exact
  `percentiles` cache), `packages/persistence/src/metrics/read.ts`.
- `sketch.ts` is deleted when nothing imports it.
- Live deltas carry computed values only; their schema is unchanged.
- Memory bound: one entry per distinct ms value per histogram. Worst case for
  values spread across 0–30 s is ~30,000 entries (~300 KB) per request name;
  a pathological-spread test pins the bound.
- Group durations above 120 s become exact (previously their percentiles
  were omitted).

## 5. Backfill

- After upgrade the worker enqueues every `stats_method = estimated` run on a
  dedicated `recompute` queue, concurrency 1, lower priority than ingest.
- Operator command: `pnpm recompute [--project <slug>] [--run <id>]`.
- Per run, in one transaction: delete its metric rows (all partitioned metric
  tables), insert the exact ones, set `stats_method = exact-v1`. Idempotent;
  skips runs already `exact-v1`.
- Preserved: identity, run number, note, test, lifecycle timestamps, logs.
- SLA verdicts are re-evaluated with each run's frozen `ruleSnapshot`. A
  changed verdict writes `run_verdict_change` and is shown on the run.
- A run without a raw log stays `estimated`, is labelled as such, and its
  verification is `unverifiable`.
- Admins see progress ("Recomputing exact statistics: 412 of 1,030 runs")
  only while work remains.

## 6. Verifier

- Separate package `packages/verify`; a lint rule forbids importing
  `@perfportal/statistics`.
- Decodes the raw log with the shared decoder, collects every value per
  scope × name × family × population (and per bucket), sorts, and computes
  every figure from §2 directly.
- Compares against stored rows and bucket rows: counts, min, max and
  percentiles exactly; mean, standard deviation and rates within relative
  10⁻⁹.
- Runs as a `verify` job (own queue) after each ingest and each backfilled
  run, while the raw log exists.
- Mismatch: status `mismatch`, error-level log line, listed in
  Administration › Data integrity.

### Gatling's method

- A Java tool (`tools/gatling-method`, depending only on
  `com.tdunning:t-digest:3.3`) ships in the image that already carries Java 21,
  at `/opt/perfportal/gatling-method.jar`, run against the t-digest jar of the
  image's Gatling runtime. Per stats key it adds every value in log order as
  `digest.add((double) v)` to `new AVLTreeDigest(100.0)`, as Gatling's
  `GeneralStatsBuffer`, and a percentile p is
  `Math.round(digest.quantile(p / 100.0))`. Its I/O contract is in
  `tools/gatling-method/README.md`.
- Differences between its values and the exact values are stored in
  `gatling_differences`. A tool failure, or a missing jar, never changes the
  verification status: `gatling_replays` stays null and the list `[]`.

**Amended 2026-10-21, from measurement. The four amendments below replace the
earlier "equal Gatling's report exactly" rule.**

1. **Gatling's report is not deterministic.** `AVLTreeDigest` breaks a tie
   between equidistant centroids with an UNSEEDED `java.util.Random`
   (`gen.nextDouble()` in `add`), so two reports of one log can differ. The
   tool therefore replaces `gen` through reflection with
   `new java.util.Random(seed)` for seeds `0..N-1` and reports each
   percentile's lowest and highest value across those replays — reproducible
   for a given N.
   - Replaying the reference fixture with seeds 0..199, all-requests p99 took
     7 values between 2349 and 2412; the report printed 2369.
   - On the 2026-10-15 `BasicSimulation` run, `Session` p95 ranged 2389–3410
     (the report printed 3320) and p99 10785–13295.
   - Every one of the 40 + 44 percentile cells of the two reports' global
     tables lies inside the replay's set.

   The CI rule is: each report value is one the method produces across 200
   seeds (low ≤ value ≤ high), and it EQUALS it wherever all 200 seeds agree.
   `gatling_differences` stores `gatlingLow` / `gatlingHigh`, not one value;
   a row is written where `gatlingLow ≠ exact` or `gatlingHigh ≠ exact`.
   Production runs `GATLING_METHOD_SEEDS` replays (default 16); CI uses 200.
2. **Group percentiles use the cumulated response time.** Every group cell of
   both reports lies inside the cumulated replay, and outside the duration
   replay for Catalog and Cart. A group's value is its
   `cumulatedResponseTimeMs`.
3. **The assertion corpus is replaced in CI by the `group-assertions` run.**
   The corpus has no Gatling output committed. `group-assertions` records
   `Search: 95th percentile … actual : 1853.0` in
   `gatling-report-assertions.txt`, and CI requires 1853 to lie inside the
   method's `Search` p95 range. CI checks: the reference report, the
   2026-10-15 `BasicSimulation` run (committed with its report as
   `fixtures/gatling-3.15.1.2/basic-simulation-2026-10-15/`) and
   `group-assertions` — `infra/test/gatling-method-fixtures.mjs`, run in the
   `compose` job inside the built image.
4. **The method's population is every request record, warm-up included, at
   Gatling's default percentiles 50, 75, 95 and 99.** Gatling knows no
   warm-up, and the run's own `gatling.conf` is not recorded. The stats keys,
   in log order: every request record feeds the run (all requests) in `all`
   only, and its request (`<groups…>/<name>`, unspaced, as `run_stat.name`
   stores it) in `all` and its status population; every group record feeds its
   group in `all` and its status. The run has no `ok`/`ko` key because
   Gatling's report prints none: its global table's percentile columns are
   Total alone, and no detail page repeats the run (amended after the final
   review: a run OK/KO row named a figure the report never shows). The exact
   value a difference compares against is the nearest-rank value over the same
   values.

## 7. User interface

Clean-UI rules apply: marks and labels on screen, detail one click away.

- **Run header mark:** ✓ Verified / Verifying… (muted) / ✕ Verification
  failed (failed colour) / Not verified + ⓘ with the reason.
- **Verification panel** (from the mark): figures checked, verifier version,
  time; raw-log retention date; "Differences from Gatling's report" table
  (Request · Figure · Gatling's report · PerfPortal) only when non-empty, with
  one ⓘ sentence: "Gatling's report estimates percentiles with t-digest, and
  its estimate can change between two reports of the same run; PerfPortal
  reports the actual value at that rank."; on mismatch, the figures with stored
  and recomputed values. *(Amended 2026-10-21 for §6's variance: the Gatling
  cell shows the replay range, rendered `2389–3410` in the run page's plain
  whole-millisecond digits, or one value where every replay agreed.)*
- **Estimated runs:** percentile figures carry "≈" with ⓘ explaining why.
- **Verdict changed by backfill:** one line under the verdict, ⓘ with rule
  and both values.
- **Removed copy:** every "estimates, accurate to within 1%" caption and ⓘ;
  the glossary's estimate entry is rewritten for nearest rank and the Gatling
  difference.
- **Administration › Data integrity** (admins): backfill progress, failed
  verifications, unverifiable runs, retention setting (read-only).
- **API:** `GET /v1/runs/{id}/verification`, documented in OpenAPI, read
  scope.

## 8. Testing

- Nearest rank vs a sorting oracle over generated datasets: ties, n = 1,
  p = 0/100, values > 120 s, heavy-tailed and bimodal.
- Merge equivalence: arbitrary splits (windows, generators) merged equal the
  whole.
- Live = final: random chunking through the live fold equals batch output.
- Verifier detects a corrupted count, percentile and bucket value, naming each;
  lint test for verifier independence.
- Gatling-method tool reproduces Gatling's HTML report on the three fixtures
  (amended 2026-10-21, §6): every percentile cell of the reference report and
  the 2026-10-15 `BasicSimulation` report — the global table's Total column
  and every request and group page's Total, OK and KO columns — lies inside
  the 200-seed range and equals it wherever every seed agrees, and
  `group-assertions`' `Search` p95 of 1853 lies inside its range. More than 150
  cells, or the check fails. Red-verified with compression 50, `Math.floor`,
  and groups fed their duration.
- Backfill integration: exact rows, idempotent re-run, crash mid-transaction,
  verdict change recorded.
- Browser: verified mark and panel, Gatling difference rows, ≈ label,
  verdict-changed line.
- Real runs (Gradle plugin and on-prem runner) end `verified`.
- Measured and recorded: histogram bytes per bucket on a soak-shaped log;
  backfill runs per minute.
- `CLAUDE.md` test floors updated per PR.

## 9. Delivery

| PR | Content | User-visible result |
|---|---|---|
| 1 Exact engine | `sparse-ms-v2`, `nearestRank`, `stats_method`, sketch reads removed, "within 1%" copy removed | New runs exact |
| 2 Backfill | `recompute` queue and command, `run_verdict_change`, ≈ labels, admin progress | Old runs exact |
| 3 Verifier | `packages/verify`, `run_verification`, retention, mark, panel, Data integrity page, API | Every run verified |
| 4 Gatling method | t-digest tool, CI comparison, difference rows | Differences explained |
| 5 Clean-up | Drop sketch columns | — |

Each PR: branch from `main`, full gates (typecheck, lint, unit, integration,
e2e), real-run verification, `CLAUDE.md` entry, merge commit.

## 10. Out of scope (other sub-projects)

- Load-generator aggregation and multi-generator runs (sub-project 2) — this
  design's merge rule is what makes them exact.
- New data Gatling's log does not contain (status codes per second, TCP/TLS/
  DNS timings, outgoing counts) — sub-project 2 (hook and fork).
- Page parity features (sub-project 4).
