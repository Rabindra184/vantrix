# Run lifecycle strip

**Status:** design approved in chat 2026-09-26, section by section; this
written spec awaits review. Backlog item #2 of the Gatling Enterprise
comparison. Contract-widening (four optional `RunIdentity` fields) plus one
new run-page component; no migration.

## The change

The run page gains a strip that walks the run's journey through PerfPortal in
time order — each step with its outcome and how long it took — with a "Step
times" disclosure holding each step's start and end to the second. It sits in
its own row between the header and the decision band, and the band gives up
its Execution row, whose two sentences the strip now states with timings.

## Why

A reader asking "where did the time go" or "did this fail at ingest or at the
gate" has today one status word, one verdict word, and the Started and
Duration chips. PerfPortal already stores every timestamp the answer needs —
received, processing started and ended, the stream's last chunk, the moment a
dead stream was given up on, and for on-prem runs when the job was queued —
and publishes two of them. It is the run-list shape again: the data exists and
the contract throws it away.

## What Gatling Enterprise does, observed

On cloud.gatling.io the run page opens with
`Build successful ❯ Deployed · 14s ❯ Assertions failed · 2m 00s`: its own
pipeline in order, each step with an outcome and a duration. Expanded, each
step becomes a bar carrying an outcome colour, a duration, and its own start
and end wall-clock times. Its Logs tab separates the same phases
(`---| Deploying |---`, `Injecting`, `Ending`).

PerfPortal's steps are not Gatling's — it neither builds nor deploys — so the
SHAPE is copied (ordered steps, outcome and duration each, expandable to
start/end times) and the steps are PerfPortal's own.

## The steps

Derived from stored timestamps only; nothing is estimated. A run shows only
the steps its path has:

| Path | Steps |
|---|---|
| On-prem runner | Queued ❯ Load test ❯ Processing ❯ Verdict |
| Live stream (Gradle plugin) | Load test ❯ Processing ❯ Verdict |
| Uploaded bundle | Load test ❯ Received ❯ Processing ❯ Verdict |

A run is STREAMED when `streamUpdatedAt` is set (or it is `running`), came
from the RUNNER when `queuedAt` is set, and was UPLOADED otherwise.

- **Queued** — the runner job's `created_at` until the runner opened the run
  (`startedAt`). Runner runs only, and always done by the time a run page
  exists: the run is created at the moment the runner opens it.
- **Load test** — the test's own start (`toolStartedAt`) plus
  `activityMs ?? durationMs`, the expression `RunHeader`'s Duration chip
  computes, so the page shows one number under one word.
  - Streaming: the active step, "streaming · 42s", measured from the run's
    open (`startedAt`) to its last accepted chunk (`streamUpdatedAt`) —
    advancing with each identity refresh (every 5 s), never by a client clock.
  - A stream the sweeper gave up on (`streamAbandonedAt`) ends "stopped early".
  - An upload's test ran before PerfPortal saw anything; until the bundle is
    parsed the step cannot know its span and reads "known once processed".
- **Received** — uploads only: the instant the bundle arrived (`startedAt`).
  Once the bundle is parsed and the test's span is known, it also says how
  long after the test's end that was — the gap that makes the Started chip
  (ingest time) differ from the test's own start.
- **Processing** — `parsingStartedAt` to `ingestedAt`, ending "processed" or
  "failed: <error code>".
  - An upload the worker has not picked up yet (status `pending`, no
    `parsingStartedAt`) reads "waiting for a worker since 22:10" — the
    "stuck at pending and nothing on screen says why" state
    `running-perfportal-locally` warns about.
  - For a streamed run, `parsingStartedAt` is stamped at close
    (`claimForClose`), so the step starts when the stream ended.
- **Verdict** — one word, from `RunDecisionBand`'s own word function (passed,
  failed, not configured, not evaluated), exported for it, so the strip and
  the band can never describe one verdict in two vocabularies.

**States.** Each step is done, active, pending (not reached yet) or failed.
After a failure the later steps stay pending, drawn muted. The strip renders
for every run status, live included.

## The contract

`RunIdentitySchema` gains four fields, all `.nullable().optional()`: the
browser drops any body that fails its schema, so a required field would blank
the run page for a whole rolling deploy (the argument `activityMs` and `sla`
already make).

| Field | From | Null when |
|---|---|---|
| `parsingStartedAt` | `run.parsing_started_at` | not yet processing |
| `streamUpdatedAt` | `run.stream_updated_at` | an upload, or a stream with no chunk yet |
| `streamAbandonedAt` | `run.stream_abandoned_at` | the producer was never judged gone |
| `queuedAt` | the runner job's `created_at`, joined on `run_id` (`runner_job_run_id_idx`) | the run did not come from the on-prem runner |

`startedAt` (received) and `ingestedAt` (processing ended) are already on the
wire and unchanged.

**Both identity builders send all four**: `runs.service.ts`'s terminal
identity and the hand-written 202 projection in `runs.controller.ts` that a
pending, parsing or running run gets. A field reaching only the first would be
missing exactly while a run is live — the defect CLAUDE.md records for
`warmupMs`, fixed then by one shared helper (`warmupMsOf`). The runner lookup
is likewise shared so neither builder can drift.

**Nothing is derived server-side.** The OpenAPI schema follows from zod, and
the document's "every response validates" sweep covers the new fields.

**Not added:** separate claimed and starting times for runner jobs. The job
keeps only `created_at` and an overwritten `updated_at`; Queued stays one step
rather than earning a column and a migration.

## On the page

- **Two units.** `apps/web/src/routes/lifecycle.ts` is a pure function from a
  run's identity to its ordered steps (name, state, outcome word, start, end,
  duration) — the way `window.ts` holds the time window's math.
  `apps/web/src/routes/RunLifecycle.tsx` draws them. `RunShell` mounts it
  between `RunHeader` and `RunDecisionBand` for every status.
- **The strip** is an ordered list (`<ol>`; the order is a real sequence)
  inside `<section aria-label="Run lifecycle">`. **No heading**: the Overview
  tab's heading outline is asserted as an exact list and shell chrome must not
  add to it. Each step's state is carried by its outcome word and a mark from
  `marks.tsx`, never by colour alone; colours are the status tokens, applied
  the way the repo already does. Durations use `formatDuration`.
- **Step times** is a `<details>` beside the strip holding a small table of
  each step's start, end and duration: times of day to the second in the
  viewer's zone, with the date and zone stated once in the table's caption
  (the range line's `formatInstantSeconds` supplies both). The list stays
  OUTSIDE the `<summary>`, whose contents lose their semantics for a screen
  reader. The times are absolute; the Offset/Datetime axis mode does not
  touch them.
- **The decision band drops its Execution row.** Its sentences move into the
  strip rather than disappearing: "could not be processed" becomes the failed
  Processing step, "the stream stopped early" the Load test's outcome.
- **Compact viewports** (below 768 px) show the last step reached, followed
  by the verdict once there is one — `Processed ❯ Gates failed`, or
  `Load test · streaming 42s` while live — with every step in the
  disclosure.

## Edge cases

- **A run crossing midnight**: a Step times cell whose date differs from the
  caption's carries its own date, so the wrap is never ambiguous.
- **Clock-skewed stamps** (a step ending before it starts, from two clocks):
  the duration is shown as unavailable rather than negative.
- **Legacy rows** (processed before a column existed, so a stamp is null): the
  step reads what it can, and a missing start or end shows as a dash in Step
  times rather than a guessed value.
- **A runner job that failed before opening a run** has no run page, so the
  strip never has to draw a Queued step with no run after it.

## Testing

Unit, every case red-verified before it is trusted:

- `lifecycle.ts` across each path and each state, including a stream in
  progress, an abandoned stream, processing failed with its code, an upload
  waiting for a worker, and an upload not yet parsed — pinned to
  `Asia/Kolkata` with the pin asserted, and also run under `TZ=UTC`.
- Agreement rather than literals: the Verdict word equals the band's own word
  for each verdict, and the Load test's duration equals the Duration chip's
  number.
- `RunLifecycle`: list semantics, no heading, outcome as text and mark, Step
  times outside the `<summary>`, the compact variant.
- The band's two Execution tests re-pointed at the strip, not deleted.
- The contract: an identity without the new fields still parses.

Integration: the four fields read through the real API on both builders — a
running live run on the 202, a finished upload, an abandoned stream, and a
runner run's `queuedAt`. Red-verified by dropping them from the 202
projection.

End to end: a seeded run shows the strip and its Step times, and the band has
no Execution row; `run-list.spec.ts`'s incomplete-run case re-pointed to the
strip's "stopped early"; the fold bounds re-measured — the run totals above
900 px at 1440x900 (`run-tables.spec.ts`, y690 today) and within 812 px at
375x812 (`mobile.spec.ts`, 802 today).

Real runs: the strip checked on the developer database's real Gatling runs
(live and uploaded paths), plus one real on-prem runner run for the Queued
step.

## Deliberately out of scope

- Runner claim and start timestamps (a migration; see "Not added").
- A Logs tab (backlog item #6, which needs a scope decision first).
- Showing the lifecycle on the run list.
- Changing the header's Started and Duration chips.
