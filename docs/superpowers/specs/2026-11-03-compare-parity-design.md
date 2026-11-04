# Compare parity with Gatling Enterprise — design

Gap #2 of `docs/superpowers/research/2026-11-03-ge-page-parity/README.md`.
Gap #1 (the Report's scenario/group/request pickers) was split off on
2026-11-03: matching Gatling Enterprise there needs new stored figures and a
recompute, so it gets its own design next.

## Why

Compare is where an engineer asks "what changed between these runs, and
where". Gatling Enterprise answers it with more metrics than we offer, lets
the reader narrow the comparison to part of the run, and lets them choose
which run every change is measured against. The user's standing rule is to
copy Gatling Enterprise's measured behaviour where it applies, with every
number exact.

## What Gatling Enterprise does (measured 2026-11-03, test perfportal-parity-basic, runs #1 and #2)

- **Metric list:** Concurrent users, CPU usage, Errors, p50, p90, p95, p99,
  p99.9, p99.99, max, Throughput (requests per second). Default p99.
- **Overlay:** one line per selected run over elapsed time. Y axis by metric:
  Time (ms), Count (users), Percent (CPU), Count/s (errors, throughput).
- **Time-range slider** above the overlay, `00:00:00` to the longest run's
  end. Dragging a handle zooms the chart AND recomputes the table for that
  window (whole run: `*` p99 2383 / 1343; 00:00:46–00:01:31: 365 / 365). Not
  kept in the URL.
- **Table, by metric:**

  | Metric | Rows |
  | --- | --- |
  | p50 … p99.99, max | `*` (all requests), then one row per request (`Cart / Add To Cart`) |
  | Throughput | `Value` |
  | Errors | `Count`, `Ratio` |
  | Concurrent users | `Max` |
  | CPU usage | `Mean`, `Max` |

  The reference run's column is first and highlighted; every other column
  shows its value with a % change chip and an arrow (north-east up,
  south-east down, `=` for equal), coloured good or bad.
- **Pin:** a pin button above each non-reference column, tooltip "Set run #N
  as reference". Clicking it moves that run to the first column and
  recomputes every %. Not kept in the URL.
- Selection of 2–5 runs is not kept in the URL either (ours is: keep it).

## Goals

1. The same eleven metrics, with the same table rows per metric.
2. A time-range slider on the overlay that narrows the chart, the table and
   the summary tiles.
3. A pinnable reference run that the table, the summary tiles and the
   overlay's Baseline label all follow.
4. Every number exact, as everywhere else in PerfPortal.

## Non-goals

- AI run comparison (gap #5, separate).
- Report pickers (gap #1, separate design).
- Changing how runs are chosen (cohort, 2–5 cap, current run always in).

## Anti-goals

- A percentile that is guessed, interpolated from a neighbour, or silently
  missing. A rank that cannot be computed for a run reads as unavailable,
  with the reason.
- Different numbers for the same quantity on Compare and on the run page.
  Whole-run p99 on Compare must equal the run's own p99 for the same window.
- A slider or pin state that a shared link loses. Ours keeps view state in
  the URL (AC-DASH-4); that is where we are ahead of Gatling Enterprise and
  it stays.

## Decisions

### Server: two optional percentile lists

- **`GET /v1/runs/:id/stats?percentiles=90,99.9,99.99`.** When present, the
  response's percentile maps carry exactly these ranks instead of the
  project's configured set, for the unwindowed and the windowed path alike.
  Computed from the stored histograms by the existing exact path
  (`storedPercentiles`, `rollupFromHistograms`). A legacy estimated row
  answers only the ranks it stored, as `storedPercentiles` already does.
  Validation: 1–12 finite numbers in (0, 100), comma-separated; anything
  else is 400 `INVALID_QUERY` naming the parameter. Indicator bands and every
  other field are unchanged.
- **`GET /v1/runs/:id/series?…&percentiles=99.9,99.99`.** Adds the requested
  ranks to each bucket's `percentiles` (and the OK/KO maps), computed from
  that bucket's stored OK and KO histograms. Stored ranks are untouched. A
  bucket whose histogram is not exact (`histogram_kind` other than
  `sparse-ms-v2`) omits the extra ranks. Same validation.
- Both documented in the OpenAPI document; contracts gain no new response
  fields (maps already allow any rank key).

### Metrics

`CompareMetric` gains `p90`, `p99.9`, `p99.99`, `users`, `cpu`. Labels keep
this product's vocabulary (`p99.9 response time`, `Concurrent users`, `CPU
usage`), in Gatling Enterprise's order: Concurrent users, CPU usage, Errors,
p50, p90, p95, p99, p99.9, p99.99, max, Throughput. Default stays **p95**
(ours; changing it would rewrite every existing shared link's meaning).
`isChangeGood`: higher is good for throughput only, as today; users and CPU
are neither good nor bad, so their chips are neutral.

| Metric | Overlay source (per run) | Unit |
| --- | --- | --- |
| p50, p90, p95, p99 | `/series` stored bucket ranks | ms |
| p99.9, p99.99 | `/series?percentiles=99.9,99.99` | ms |
| max | `/series` bucket `maxMs` | ms |
| throughput, errors | `/series` (as today) | /s |
| users | `/users` `total[].maxConcurrent` | users |
| cpu | `/agent/injectors` `cpuUserPct + cpuSysPct`; else `/telemetry` `cpuTotalPct` averaged across hosts per bucket; else not recorded | % |

A run with no CPU source draws no line, and a note under the chart names it
("CPU was not recorded for Run 3"). Only the selected metric's extra queries
are fetched.

### Table

Rows follow Gatling Enterprise's table above, with one addition that keeps
what we already have: **Throughput** and **Errors** keep their per-request
rows below the summary rows (errors per request as a count, the same unit as
the `Count` row). Users and CPU have no per-request value, so only summary
rows. CPU `Mean` and `Max` are over the run's (or window's) samples.

Summary rows are labelled in this product's words: `All requests` for `*`,
`Value`, `Count`, `Ratio`, `Max`, `Mean`.

### Time range

- A slider on the overlay (the existing `Chart` `brush` mode), extent
  `[0, longest selected run's duration]`.
- State in the URL as `from`/`to`, the same parameters the run page uses, so
  the window travels between tabs as it already does and a shared Compare
  link keeps it. A window past one run's end clamps for that run.
- Narrowing refetches each run's `/stats` and `/series` (and users, CPU) with
  the window, so the table, the tiles and the overlay all describe the same
  slice. A "Whole run" control clears it.
- The slider is mouse-only, so From/To inputs beside it (as on the run
  page's `TimeBrush`) give a keyboard path.

### Reference

- URL `?ref=<runId>`. Valid only if the run is selected and its statistics
  loaded; otherwise the current default (first selected run other than the
  current one).
- The reference is the first data column, highlighted. Each other column
  header carries a pin button, accessible name "Set Run N as reference".
- `compareSummary`, `toCompareMatrix` and the chip labels take the reference
  as a parameter (no default), replacing the three separate
  "first other run" expressions.

## Constraints

- Node 22; floors in CLAUDE.md move by whatever this adds, recorded in the
  branch's CLAUDE.md entry.
- `?scope` without `name` rules and the `singleValue` guard apply to the new
  query parameters.
- Red-verify each new test against a mutation, per CLAUDE.md.
- A real check before merge: two real Gatling runs of one test (plugin or
  runner), compared in a browser, with whole-run p99.9 on Compare equal to the
  same figure from `/stats` on each run.

## Left to the builder

- Component structure inside `RunCompare`, how queries are composed, chart
  colours (the existing compare palette), copy of notes and empty states
  within the vocabulary above.
- How the From/To inputs are laid out beside the slider.
