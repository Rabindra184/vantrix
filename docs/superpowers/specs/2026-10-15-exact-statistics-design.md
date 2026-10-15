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
| `gatling_differences` | JSON list: scope, name, figure, gatling value, exact value |
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

- A Java tool (~100 lines, depending only on `com.tdunning:t-digest:3.3`)
  ships in the image that already carries Java 21. It replays response times
  in log order into `AVLTreeDigest(100)` per request, as Gatling's
  `GeneralStatsBuffer`, and outputs Gatling's percentile values.
- CI requires its output to equal Gatling's HTML report exactly on the
  reference fixture, the assertion corpus, and the 2026-10-15
  `BasicSimulation` run (committed as a fixture with its report).
- Differences between its values and the exact values are stored in
  `gatling_differences`.

## 7. User interface

Clean-UI rules apply: marks and labels on screen, detail one click away.

- **Run header mark:** ✓ Verified / Verifying… (muted) / ✕ Verification
  failed (failed colour) / Not verified + ⓘ with the reason.
- **Verification panel** (from the mark): figures checked, verifier version,
  time; raw-log retention date; "Differences from Gatling's report" table
  (Request · Figure · Gatling report · PerfPortal) only when non-empty, with
  one ⓘ sentence: "Gatling's report estimates percentiles with t-digest;
  PerfPortal reports the actual value at that rank."; on mismatch, the
  figures with stored and recomputed values.
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
- Gatling-method tool equals Gatling's HTML report on the three fixtures.
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
